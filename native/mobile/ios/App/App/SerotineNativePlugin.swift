import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit
import UniformTypeIdentifiers
import WebKit

private let snapshotLimit = 64 * 1024 * 1024
private let requestLimit = 8 * 1024 * 1024
private let responseLimit = 16 * 1024 * 1024
private let fileLimit = 64 * 1024 * 1024

private enum NativeFailure: Error { case invalidInput, unavailable, corrupted, keyUnavailable }

@objc(SerotineNativePlugin)
public final class SerotineNativePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "SerotineNativePlugin"
    public let jsName = "SerotineNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]
    private let disk = DispatchQueue(label: "app.serotine.snapshot")
    private let store = EncryptedSnapshotStore()
    private var observers: [NSObjectProtocol] = []
    private var pickerCall: CAPPluginCall?
    private var exporting = false
    private var stagedURL: URL?
    private let resetLock = NSLock()
    private var resetting = false
    private var resetFinished = false
    private var resetPromptOpen = false // Main thread only.

    public override func load() {
        for (name, active) in [(UIApplication.didBecomeActiveNotification, true),
                               (UIApplication.willResignActiveNotification, false)] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.notifyListeners("lifecycle", data: ["active": active])
            })
        }
        // Remove staging left by a killed export. No user documents are removed.
        try? FileManager.default.removeItem(at: exportDirectory())
    }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        // Applies to every frame, including target=_blank. Message handling also
        // checks the actual source frame; checking only the current URL is not enough.
        let trusted = isTrustedSerotineURL(navigationAction.request.url)
        if trusted && navigationAction.targetFrame?.isMainFrame == true {
            resetLock.lock()
            // Resume only for a fresh document after the complete explicit reset.
            if resetFinished { resetting = false; resetFinished = false }
            resetLock.unlock()
        }
        return NSNumber(value: !trusted)
    }

    private var isResetting: Bool {
        resetLock.lock(); defer { resetLock.unlock() }
        return resetting
    }

    private func trusted(_ call: CAPPluginCall, allowResetRetry: Bool = false) -> Bool {
        guard allowResetRetry || !isResetting else {
            call.reject("Local storage has been reset or is being reset. Reload Serotine before continuing.")
            return false
        }
        let valid = Thread.isMainThread ? isTrustedSerotineURL(webView?.url)
            : DispatchQueue.main.sync { isTrustedSerotineURL(self.webView?.url) }
        guard valid else {
            call.reject("Native actions require the packaged Serotine app.")
            return false
        }
        guard (try? relayOrigin()) != nil else {
            call.reject("The bundled interface does not match this native build. Install a correctly configured Serotine build.")
            return false
        }
        return true
    }

    @objc public func getInfo(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        do {
            let origin = try relayOrigin()
            call.resolve(["platform": "ios", "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                          "relayOrigin": origin.absoluteString, "backgroundSync": false])
        } catch { call.reject("This build does not have a valid HTTPS relay configuration.") }
    }

    @objc public func readSnapshot(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        disk.async {
            guard !self.isResetting else { call.reject("Local storage is being reset."); return }
            do {
                if let value = try self.store.read() { call.resolve(["value": value]) }
                else { call.resolve(["value": NSNull()]) }
            } catch {
                call.reject("Local encrypted data is unavailable. Unlock this device and retry. Do not clear app data; restore an encrypted backup if the data remains unavailable.")
            }
        }
    }

    @objc public func writeSnapshot(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        guard let value = call.getString("value"), value.utf8.count <= snapshotLimit else {
            call.reject("Local data exceeds the supported storage limit.")
            return
        }
        disk.async {
            guard !self.isResetting else { call.reject("Local storage is being reset."); return }
            do { try self.store.write(value); call.resolve() }
            catch { call.reject("Could not safely save local data. Free device storage or unlock the device and retry; existing data has not been intentionally removed.") }
        }
    }

    @objc public func resetStorage(_ call: CAPPluginCall) {
        guard trusted(call, allowResetRetry: true) else { return }
        guard call.getString("confirmation") == "DELETE LOCAL DATA" else {
            call.reject("Type DELETE LOCAL DATA to request a local storage reset.")
            return
        }
        DispatchQueue.main.async {
            guard !self.resetPromptOpen, self.pickerCall == nil,
                  let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else {
                call.reject("Finish the current native dialog first.")
                return
            }
            self.resetPromptOpen = true
            let alert = UIAlertController(title: "Delete all local Serotine data?",
                message: "This permanently deletes this app's local identity, messages, files, drafts, settings, and encryption key. It does not delete server data or backups you exported. You will need an encrypted backup to restore your identity. This cannot be undone.",
                preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                self.resetPromptOpen = false
                call.resolve(["reset": false])
            })
            alert.addAction(UIAlertAction(title: "Delete Local Data", style: .destructive) { _ in
                self.resetLock.lock()
                self.resetting = true
                self.resetFinished = false
                self.resetLock.unlock()
                // Serializing with snapshot I/O lets an already-running atomic
                // save finish, then rejects queued/new saves before deletion.
                self.disk.async {
                    do {
                        try self.store.resetAfterConfirmation()
                        let exports = try self.exportDirectory()
                        if FileManager.default.fileExists(atPath: exports.path) {
                            try FileManager.default.removeItem(at: exports)
                        }
                        DispatchQueue.main.async {
                            guard let dataStore = self.webView?.configuration.websiteDataStore else {
                                self.resetPromptOpen = false
                                call.reject("Native data was deleted, but WebKit data could not be cleared. Retry the reset.")
                                return
                            }
                            dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: Date.distantPast) {
                                self.resetLock.lock()
                                self.resetFinished = true
                                self.resetLock.unlock()
                                self.resetPromptOpen = false
                                call.resolve(["reset": true])
                            }
                        }
                    } catch {
                        DispatchQueue.main.async { self.resetPromptOpen = false }
                        call.reject("The local reset could not finish. No new identity has been created. Unlock the device and retry the reset.")
                    }
                }
            })
            presenter.present(alert, animated: true)
        }
    }

    @objc public func request(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        do {
            let origin = try relayOrigin()
            let allowed: [String: Set<String>] = [
                "/api/relay": ["POST"], "/api/groups": ["POST"], "/api/files": ["GET", "POST", "PUT"],
                "/api/calls": ["POST"], "/api/direct": ["POST"], "/api/retention": ["POST"],
                "/api/plugins/summary": ["POST"], "/api/giphy/config": ["GET"]
            ]
            guard let path = call.getString("path"), let method = call.getString("method"),
                  allowed[path]?.contains(method) == true,
                  let url = URL(string: origin.absoluteString + path) else { throw NativeFailure.invalidInput }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
            request.httpMethod = method
            request.httpShouldHandleCookies = false
            let permittedHeaders: Set<String> = ["content-type", "accept", "x-serotine-events", "x-serotine-file-request"]
            for (name, raw) in call.getObject("headers") ?? [:] {
                guard permittedHeaders.contains(name.lowercased()), let value = raw as? String,
                      value.utf8.count <= 32768, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                    throw NativeFailure.invalidInput
                }
                request.setValue(value, forHTTPHeaderField: name)
            }
            // Keep the hosted relay's existing Origin/ownership checks intact.
            // JavaScript cannot override these headers or select another host.
            request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
            if let encoded = call.getString("bodyBase64") {
                guard method != "GET", encoded.utf8.count <= ((requestLimit + 2) / 3) * 4,
                      let bytes = Data(base64Encoded: encoded), bytes.count <= requestLimit else { throw NativeFailure.invalidInput }
                request.httpBody = bytes
            }
            guard !isResetting else { throw NativeFailure.unavailable }
            BoundedRelayRequest(call: call).start(request)
        } catch { call.reject("Invalid native relay request or relay configuration.") }
    }

    @objc public func openExternal(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        guard let value = call.getString("url"), value.utf8.count <= 4096,
              let url = URL(string: value), ["https", "http"].contains(url.scheme ?? ""),
              url.host != nil, url.user == nil, url.password == nil else {
            call.reject("Only HTTP or HTTPS links can be opened externally.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("The system could not open this link.") }
            }
        }
    }

    @objc public func saveFile(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        guard let name = call.getString("name"), !name.isEmpty, name.utf8.count <= 180,
              !name.contains("/"), !name.contains("\\"), name != ".", name != "..",
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let encoded = call.getString("dataBase64"), encoded.utf8.count <= ((fileLimit + 2) / 3) * 4,
              let bytes = Data(base64Encoded: encoded), bytes.count <= fileLimit else {
            call.reject("Invalid file name or unsupported export size.")
            return
        }
        DispatchQueue.main.async {
            guard self.pickerCall == nil, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else { call.reject("Finish the current file selection first."); return }
            do {
                var directory = try self.exportDirectory()
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.protectionKey: FileProtectionType.complete])
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                try directory.setResourceValues(values)
                var file = directory.appendingPathComponent(name, isDirectory: false)
                try bytes.write(to: file, options: [.atomic, .completeFileProtection])
                try file.setResourceValues(values)
                self.stagedURL = file
                self.exporting = true
                self.pickerCall = call
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                picker.delegate = self
                presenter.present(picker, animated: true)
            } catch { self.finishPicker(error: "The export could not be staged safely.", fallback: call) }
        }
    }

    @objc public func openBackup(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        DispatchQueue.main.async {
            guard self.pickerCall == nil, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else { call.reject("Finish the current file selection first."); return }
            self.pickerCall = call
            self.exporting = false
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json, .data], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerCall?.resolve(exporting ? ["saved": false] : ["cancelled": true])
        finishPicker()
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickerCall else { return }
        if exporting { call.resolve(["saved": true]); finishPicker(); return }
        guard urls.count == 1, let url = urls.first else { finishPicker(error: "Select one encrypted backup."); return }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() }; finishPicker() }
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, let size = values.fileSize, size <= fileLimit else { throw NativeFailure.invalidInput }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let bytes = try handle.read(upToCount: fileLimit + 1) ?? Data()
            guard bytes.count <= fileLimit else { throw NativeFailure.invalidInput }
            // Password validation and identity-switch confirmation remain in the
            // shared client. Picking a file never activates an identity here.
            call.resolve(["name": url.lastPathComponent, "dataBase64": bytes.base64EncodedString()])
        } catch { call.reject("The backup could not be read or exceeds the supported size.") }
    }

    private func finishPicker(error: String? = nil, fallback: CAPPluginCall? = nil) {
        if let error { (pickerCall ?? fallback)?.reject(error) }
        if let stagedURL { try? FileManager.default.removeItem(at: stagedURL) }
        stagedURL = nil
        pickerCall = nil
        exporting = false
    }

    private func exportDirectory() throws -> URL {
        try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("SerotineExports", isDirectory: true)
    }

    private func relayOrigin() throws -> URL {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "SerotineRelayOrigin") as? String,
              let url = URL(string: value), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty, url.port == nil || url.port == 443 else { throw NativeFailure.invalidInput }
        guard let asset = Bundle.main.url(forResource: "native-config", withExtension: "json", subdirectory: "public"),
              let config = try? JSONDecoder().decode(BundledConfiguration.self, from: Data(contentsOf: asset)),
              config.relayOrigin == value,
              config.version == Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            throw NativeFailure.invalidInput
        }
        #if DEBUG
        guard config.development, Bundle.main.bundleIdentifier == "app.serotine.client.dev" else { throw NativeFailure.invalidInput }
        #else
        guard !config.development, Bundle.main.bundleIdentifier == "app.serotine.client" else { throw NativeFailure.invalidInput }
        #endif
        return url
    }
}

private struct BundledConfiguration: Decodable {
    let relayOrigin: String
    let version: String
    let development: Bool
}

private final class EncryptedSnapshotStore {
    private let magic = Data("SRT1".utf8)
    private var ready = false
    private var keyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "app.serotine.client") + ".snapshot",
         kSecAttrAccount as String: "aes-gcm-v1", kSecAttrSynchronizable as String: false]
    }

    private func folder() throws -> URL {
        var url = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Serotine", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return url
    }

    private func existingKey() throws -> SymmetricKey? {
        var query = keyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data, bytes.count == 32 else { throw NativeFailure.keyUnavailable }
        return SymmetricKey(data: bytes)
    }

    private func createKey() throws -> SymmetricKey {
        let key = SymmetricKey(size: .bits256)
        var item = keyQuery
        item[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NativeFailure.keyUnavailable }
        return key
    }

    func read() throws -> String? {
        ready = false
        let directory = try folder()
        let file = directory.appendingPathComponent("snapshot.aesgcm")
        let marker = directory.appendingPathComponent("initialized")
        let key = try existingKey()
        guard FileManager.default.fileExists(atPath: file.path) else {
            // A key surviving uninstall, an initialized marker, or a vanished
            // snapshot is data loss, never a signal to silently replace identity.
            guard key == nil, !FileManager.default.fileExists(atPath: marker.path) else { throw NativeFailure.corrupted }
            ready = true
            return nil
        }
        guard let key else { throw NativeFailure.keyUnavailable }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let encrypted = try handle.read(upToCount: snapshotLimit + 33) ?? Data()
        guard encrypted.count <= snapshotLimit + 32, encrypted.starts(with: magic) else { throw NativeFailure.corrupted }
        let sealed = try AES.GCM.SealedBox(combined: encrypted.dropFirst(magic.count))
        let plaintext = try AES.GCM.open(sealed, using: key, authenticating: magic)
        guard plaintext.count <= snapshotLimit, let value = String(data: plaintext, encoding: .utf8) else { throw NativeFailure.corrupted }
        ready = true
        return value
    }

    func write(_ value: String) throws {
        guard ready, let bytes = value.data(using: .utf8), bytes.count <= snapshotLimit else { throw NativeFailure.unavailable }
        let directory = try folder()
        let file = directory.appendingPathComponent("snapshot.aesgcm")
        let marker = directory.appendingPathComponent("initialized")
        let key: SymmetricKey
        if let current = try existingKey() { key = current }
        else {
            guard !FileManager.default.fileExists(atPath: file.path), !FileManager.default.fileExists(atPath: marker.path) else { throw NativeFailure.keyUnavailable }
            key = try createKey()
        }
        guard let sealed = try AES.GCM.seal(bytes, using: key, authenticating: magic).combined else { throw NativeFailure.corrupted }
        var destination = file
        try (magic + sealed).write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try destination.setResourceValues(values)
        if !FileManager.default.fileExists(atPath: marker.path) {
            var initialized = marker
            try Data([1]).write(to: initialized, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try initialized.setResourceValues(values)
        }
    }

    // Called only after the exact bridge phrase and destructive native alert.
    // There is deliberately no automatic corruption-recovery deletion path.
    func resetAfterConfirmation() throws {
        ready = false
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                    appropriateFor: nil, create: false)
            .appendingPathComponent("Serotine", isDirectory: true)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        // Delete only this app/bundle's named key, never the whole Keychain.
        let status = SecItemDelete(keyQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeFailure.keyUnavailable }
    }
}

private final class BoundedRelayRequest: NSObject, URLSessionDataDelegate {
    private let call: CAPPluginCall
    private var session: URLSession?
    private var response: HTTPURLResponse?
    private var bytes = Data()
    private var finished = false

    init(call: CAPPluginCall) { self.call = call }

    func start(_ request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 120
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        fail("Relay redirects are not allowed.")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Only normal system TLS trust; no stored credentials or HTTP auth UI.
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
                          ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, !(300..<400).contains(http.statusCode),
              response.expectedContentLength <= Int64(responseLimit) else {
            completionHandler(.cancel)
            fail("The relay returned an unsupported response.")
            return
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished, bytes.count <= responseLimit - data.count else { fail("The relay response exceeds the supported size."); return }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        guard error == nil, let response else { fail("The relay is unavailable. Retry when your connection improves."); return }
        finished = true
        var headers: [String: String] = [:]
        let allowed: Set<String> = ["content-type", "content-length", "retry-after"]
        for (rawName, rawValue) in response.allHeaderFields {
            guard let name = rawName as? String, allowed.contains(name.lowercased()) else { continue }
            headers[name.lowercased()] = String(describing: rawValue)
        }
        call.resolve(["status": response.statusCode, "headers": headers, "bodyBase64": bytes.base64EncodedString()])
        session.finishTasksAndInvalidate()
        self.session = nil
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        finished = true
        call.reject(message)
        session?.invalidateAndCancel()
        session = nil
    }
}
