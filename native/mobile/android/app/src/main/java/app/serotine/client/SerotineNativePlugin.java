package app.serotine.client;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import org.json.JSONObject;

@CapacitorPlugin(name = "SerotineNative")
public class SerotineNativePlugin extends Plugin {
    private final ExecutorService storageQueue = Executors.newSingleThreadExecutor();
    private final ExecutorService networkQueue = Executors.newFixedThreadPool(4);
    private final Semaphore requests = new Semaphore(8);
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES).cache(null).callTimeout(120, TimeUnit.SECONDS).connectTimeout(20, TimeUnit.SECONDS).build();
    private EncryptedSnapshot storage;
    private String relay;
    private boolean pickerActive;
    private volatile boolean resetting;
    private volatile boolean resetFinished;
    @Override public void load() {
        try {
            storage = new EncryptedSnapshot(getContext());
            try (InputStream stream = getContext().getAssets().open("serotine-config.json")) {
                JSONObject config = new JSONObject(new String(readBounded(stream, 4096), StandardCharsets.UTF_8));
                String configured = NativePolicy.relayOrigin(config.getString("relayOrigin"));
                try (InputStream rendererStream = getContext().getAssets().open("public/native-config.json")) {
                    JSONObject renderer = new JSONObject(new String(readBounded(rendererStream, 4096), StandardCharsets.UTF_8));
                    if (!configured.equals(renderer.getString("relayOrigin")) || renderer.getBoolean("development") != BuildConfig.DEBUG
                        || !BuildConfig.VERSION_NAME.replace("-dev", "").equals(renderer.getString("version"))) throw new IOException("Build configuration mismatch");
                }
                relay = configured;
            }
        } catch (Exception ignored) { /* getInfo/read fail closed, without logging contents. */ }
    }
    static boolean trusted(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }
    private boolean ready(PluginCall call) {
        // Main-frame and actual source-origin checks are enforced by MainActivity's message listener.
        if (resetting) { call.reject("Local storage reset is in progress"); return false; }
        if (relay == null || storage == null) { call.reject("Native configuration or protected storage unavailable"); return false; }
        return true;
    }
    @PluginMethod public void getInfo(PluginCall call) {
        if (!ready(call)) return;
        call.resolve(new JSObject().put("platform", "android").put("version", BuildConfig.VERSION_NAME).put("relayOrigin", relay).put("backgroundSync", false));
    }
    @PluginMethod public void readSnapshot(PluginCall call) {
        if (!ready(call)) return;
        storageQueue.execute(() -> { try {
            if (resetting) throw new IOException();
            String value = storage.read(); call.resolve(new JSObject().put("value", value == null ? JSONObject.NULL : value));
        } catch (Exception ignored) { call.reject("Local history could not be read. Do not clear app data; restore an encrypted backup if needed."); } });
    }
    @PluginMethod public void writeSnapshot(PluginCall call) {
        if (!ready(call)) return;
        String value = call.getString("value");
        if (value == null || value.length() > NativePolicy.SNAPSHOT_LIMIT) { call.reject("Invalid or oversized local snapshot"); return; }
        storageQueue.execute(() -> { try { if (resetting) throw new IOException(); storage.write(value); call.resolve(); }
            catch (Exception ignored) { call.reject("Local history could not be saved. Free device storage and retry before closing the app."); } });
    }
    @PluginMethod public void request(PluginCall call) {
        if (!ready(call)) return;
        final Request request;
        try {
            String method = call.getString("method"), path = call.getString("path");
            NativePolicy.request(path, method);
            JSObject headers = call.getObject("headers", new JSObject());
            Request.Builder builder = new Request.Builder().url(relay + path);
            Iterator<String> keys = headers.keys(); int headerBytes = 0;
            while (keys.hasNext()) {
                String key = keys.next(), value = headers.getString(key);
                NativePolicy.header(key, value); headerBytes += key.length() + value.length();
                if (headerBytes > 40000) throw new IllegalArgumentException();
                builder.header(key, value);
            }
            builder.header("Origin", relay).header("Cache-Control", "no-store");
            String base64 = call.getString("bodyBase64"); byte[] body = null;
            if (base64 != null) { NativePolicy.encodedSize(base64, NativePolicy.REQUEST_LIMIT); body = Base64.decode(base64, Base64.NO_WRAP); }
            if (body != null && body.length > NativePolicy.REQUEST_LIMIT || "GET".equals(method) && body != null) throw new IllegalArgumentException();
            builder.method(method, "GET".equals(method) ? null : RequestBody.create(body == null ? new byte[0] : body, (MediaType) null));
            request = builder.build();
        } catch (Exception ignored) { call.reject("Unsupported relay request"); return; }
        if (!requests.tryAcquire()) { call.reject("Too many pending requests; retry shortly"); return; }
        networkQueue.execute(() -> { if (resetting) { requests.release(); call.reject("Local storage is being reset"); return; } try (Response response = http.newCall(request).execute()) {
            if (response.code() >= 300 && response.code() < 400) throw new IOException("Redirect refused");
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > NativePolicy.RESPONSE_LIMIT) throw new IOException("Invalid response");
            byte[] bytes; try (InputStream stream = body.byteStream()) { bytes = readBounded(stream, NativePolicy.RESPONSE_LIMIT); }
            JSObject headers = new JSObject();
            for (String key : List.of("content-type", "content-length", "retry-after")) {
                String value = response.header(key); if (value != null && value.length() < 1024) headers.put(key, value);
            }
            call.resolve(new JSObject().put("status", response.code()).put("headers", headers).put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        } catch (Exception ignored) { call.reject("Relay request failed. Check the connection and retry."); }
        finally { requests.release(); } });
    }
    @PluginMethod public void saveFile(PluginCall call) {
        if (!ready(call)) return;
        if (pickerActive) { call.reject("Close the existing file picker first"); return; }
        try {
            String name = NativePolicy.filename(call.getString("name"));
            NativePolicy.encodedSize(call.getString("dataBase64"), NativePolicy.SNAPSHOT_LIMIT);
            pickerActive = true;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, intent, "saveResult");
        } catch (Exception ignored) { pickerActive = false; call.reject("The file could not be prepared for saving"); }
    }
    @ActivityCallback private void saveResult(PluginCall call, ActivityResult result) {
        pickerActive = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("saved", false)); return;
        }
        Uri uri = result.getData().getData();
        storageQueue.execute(() -> { try {
            if (!"content".equals(uri.getScheme())) throw new IOException();
            byte[] data = Base64.decode(call.getString("dataBase64"), Base64.NO_WRAP);
            if (data.length > NativePolicy.SNAPSHOT_LIMIT) throw new IOException();
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (stream == null) throw new IOException(); stream.write(data); stream.flush();
            }
            call.resolve(new JSObject().put("saved", true));
        } catch (Exception ignored) { call.reject("The selected file could not be saved; choose another location and retry"); } });
    }
    @PluginMethod public void openBackup(PluginCall call) {
        if (!ready(call)) return;
        if (pickerActive) { call.reject("Close the existing file picker first"); return; }
        pickerActive = true;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        try { startActivityForResult(call, intent, "openResult"); }
        catch (Exception ignored) { pickerActive = false; call.reject("File picker unavailable"); }
    }
    @ActivityCallback private void openResult(PluginCall call, ActivityResult result) {
        pickerActive = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true)); return;
        }
        Uri uri = result.getData().getData();
        storageQueue.execute(() -> { try {
            if (!"content".equals(uri.getScheme())) throw new IOException();
            String name = "serotine-backup.json";
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex) && cursor.getLong(sizeIndex) > NativePolicy.SNAPSHOT_LIMIT) throw new IOException();
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameIndex >= 0) { try { name = NativePolicy.filename(cursor.getString(nameIndex)); } catch (Exception ignored) {} }
                }
            }
            byte[] bytes;
            try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) { if (stream == null) throw new IOException(); bytes = readBounded(stream, NativePolicy.SNAPSHOT_LIMIT); }
            call.resolve(new JSObject().put("name", name).put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        } catch (Exception ignored) { call.reject("The selected backup could not be read or exceeds the 64 MiB installed-app limit"); } });
    }
    @PluginMethod public void resetStorage(PluginCall call) {
        if (!"DELETE LOCAL DATA".equals(call.getString("confirmation")) || pickerActive) {
            call.reject("Confirm deletion and close any file picker first"); return;
        }
        pickerActive = true;
        getActivity().runOnUiThread(() -> new androidx.appcompat.app.AlertDialog.Builder(getActivity())
            .setTitle("Delete Serotine data on this device?")
            .setMessage("This permanently removes this app's identity, messages, files and settings. Only your separately saved encrypted backup can restore them. Other devices are unchanged.")
            .setNegativeButton("Cancel", (dialog, which) -> { pickerActive = false; call.resolve(new JSObject().put("reset", false)); })
            .setOnCancelListener(dialog -> { pickerActive = false; call.resolve(new JSObject().put("reset", false)); })
            .setPositiveButton("Delete local data", (dialog, which) -> {
                resetting = true; resetFinished = false; http.dispatcher().cancelAll();
                storageQueue.execute(() -> { try {
                    EncryptedSnapshot.reset(getContext()); storage = new EncryptedSnapshot(getContext());
                    getActivity().runOnUiThread(() -> {
                        android.webkit.WebStorage.getInstance().deleteAllData();
                        getBridge().getWebView().clearCache(true);
                        android.webkit.CookieManager.getInstance().removeAllCookies(removed -> {
                            android.webkit.CookieManager.getInstance().flush(); resetFinished = true; pickerActive = false;
                            call.resolve(new JSObject().put("reset", true));
                        });
                    });
                } catch (Exception ignored) { pickerActive = false; call.reject("Local data could not be fully removed. Reopen the app and retry recovery."); } });
            }).show());
    }
    @PluginMethod public void openExternal(PluginCall call) {
        if (!ready(call)) return;
        try {
            String value = call.getString("url"); if (value == null || value.length() > 2048) throw new IllegalArgumentException();
            Uri uri = Uri.parse(value);
            if (!Set.of("https", "http").contains(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalArgumentException();
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); call.resolve();
        } catch (Exception ignored) { call.reject("This link cannot be opened"); }
    }
    @Override public Boolean shouldOverrideLoad(Uri uri) { return !trusted(uri) || uri.getPath() == null || uri.getPath().startsWith("/_capacitor_"); }
    @Override protected void handleOnResume() { notifyListeners("lifecycle", new JSObject().put("active", true)); }
    @Override protected void handleOnPause() { notifyListeners("lifecycle", new JSObject().put("active", false)); }
    public void onNewDocument() { if (resetFinished) { resetting = false; resetFinished = false; } }
    public void onBack() { notifyListeners("back", new JSObject()); }
    @Override protected void handleOnDestroy() { http.dispatcher().cancelAll(); networkQueue.shutdown(); storageQueue.shutdown(); }
    static byte[] readBounded(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[32768]; int count, total = 0;
        while ((count = stream.read(buffer)) != -1) { total += count; if (total > limit) throw new IOException("Data exceeds limit"); output.write(buffer, 0, count); }
        return output.toByteArray();
    }
}
