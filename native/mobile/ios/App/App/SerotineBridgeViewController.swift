import Capacitor
import UniformTypeIdentifiers
import WebKit

// Capacitor's generic HTTP, cookie, and WebView plugins are deliberately not
// exposed. Disabling their JS patches alone does not remove native methods.
final class SerotineBridgeViewController: CAPBridgeViewController {
    private var guardedMessages: TrustedBridgeMessages?
    private var guardedUI: TrustedWebUI?

    override func capacitorDidLoad() {
        guard let webView,
              let messages = webView.navigationDelegate as? WKScriptMessageHandler,
              let ui = webView.uiDelegate else { fatalError("Native bridge unavailable") }
        let gate = TrustedBridgeMessages(target: messages, webView: webView)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        webView.configuration.userContentController.add(gate, name: "bridge")
        guardedMessages = gate
        let uiGate = TrustedWebUI(target: ui)
        webView.uiDelegate = uiGate
        guardedUI = uiGate
        bridge?.registerPluginInstance(SerotineNativePlugin())
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // Identity/history are persisted by our encrypted native store. WebKit
        // caches, cookies, and temporary previews must not form a second backup.
        configuration.websiteDataStore = .nonPersistent()
        return configuration
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Replace Capacitor's local file/proxy handler before creating WebKit.
        // Renderer requests can read bundled assets only, never app-private files.
        configuration.setURLSchemeHandler(nil, forURLScheme: "capacitor")
        configuration.setURLSchemeHandler(BundledAssets(), forURLScheme: "capacitor")
        return super.webView(with: frame, configuration: configuration)
    }
}

func isTrustedSerotineURL(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "capacitor" && url.host == "localhost" && url.port == nil
        && url.user == nil && url.password == nil && !url.path.hasPrefix("/_capacitor_")
}

private final class BundledAssets: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, isTrustedSerotineURL(url),
              let root = Bundle.main.url(forResource: "public", withExtension: nil),
              !url.path.contains("\\"), !url.path.contains("%"),
              !url.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            task.didFailWithError(URLError(.unsupportedURL)); return
        }
        let path = url.pathExtension.isEmpty ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else {
            task.didFailWithError(URLError(.unsupportedURL)); return
        }
        do {
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(URLError(.fileDoesNotExist)) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

private final class TrustedBridgeMessages: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    private weak var webView: WKWebView?
    private let methods: Set<String> = [
        "getInfo", "readSnapshot", "writeSnapshot", "resetStorage", "request", "saveFile",
        "openBackup", "openExternal", "addListener", "removeListener", "removeAllListeners"
    ]

    init(target: WKScriptMessageHandler, webView: WKWebView) {
        self.target = target
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              isTrustedSerotineURL(message.frameInfo.request.url),
              isTrustedSerotineURL(webView?.url),
              let body = message.body as? [String: Any],
              body["type"] as? String == "message",
              body["pluginId"] as? String == "SerotineNative",
              let method = body["methodName"] as? String, methods.contains(method) else { return }
        target?.userContentController(controller, didReceive: message)
    }
}

private final class TrustedWebUI: NSObject, WKUIDelegate {
    private weak var target: WKUIDelegate?

    init(target: WKUIDelegate) { self.target = target }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (target?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { target }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        // Capacitor has a second, synchronous cookie bridge through JS prompt.
        // Answer its feature detection, and never forward cookie reads/writes.
        guard frame.isMainFrame, isTrustedSerotineURL(frame.request.url), isTrustedSerotineURL(webView.url),
              let data = prompt.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              type == "CapacitorCookies.isEnabled" || type == "CapacitorHttp" else {
            completionHandler(nil)
            return
        }
        completionHandler("false")
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // External navigation is handled exclusively by the validated
        // SerotineNative.openExternal API; no automatic shell URL dispatch.
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let trusted = frame.isMainFrame && isTrustedSerotineURL(frame.request.url)
            && isTrustedSerotineURL(webView.url) && origin.protocol == "capacitor" && origin.host == "localhost"
        decisionHandler(trusted ? .prompt : .deny)
    }
}
