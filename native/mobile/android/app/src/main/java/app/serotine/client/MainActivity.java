package app.serotine.client;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import androidx.activity.OnBackPressedCallback;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.*;
import java.io.ByteArrayInputStream;
import java.util.Set;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SerotineNativePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        WebView view = bridge.getWebView();
        // Require the origin-aware, main-frame bridge. Never fall back to addJavascriptInterface.
        java.util.regex.Matcher engine = java.util.regex.Pattern.compile("Chrome/(\\d+)\\.").matcher(view.getSettings().getUserAgentString());
        if (!engine.find() || Integer.parseInt(engine.group(1)) < 120 || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            view.stopLoading(); view.getSettings().setJavaScriptEnabled(false); view.loadData("Update Android System WebView to use Serotine safely.", "text/plain", "UTF-8"); return;
        }
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        view.removeJavascriptInterface("androidBridge");
        view.removeJavascriptInterface("CapacitorHttpAndroidInterface");
        view.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        RestrictedMessages messages = new RestrictedMessages(bridge, view);
        // MessageHandler's constructor installs its default listener. Replace it immediately.
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        view.removeJavascriptInterface("androidBridge");
        WebViewCompat.addWebMessageListener(view, "androidBridge", Set.of("https://localhost"), (webView, message, origin, mainFrame, reply) -> {
            if (mainFrame && SerotineNativePlugin.trusted(origin) && SerotineNativePlugin.trusted(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) messages.postMessage(message.getData());
        });
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        view.getSettings().setSupportMultipleWindows(false);
        view.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (!SerotineNativePlugin.trusted(request.getOrigin())) { request.deny(); return; }
                for (String resource : request.getResources()) {
                    if (!resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return; }
                }
                super.onPermissionRequest(request);
            }
        });
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public void onPageStarted(WebView webView, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(webView, url, favicon);
                if (SerotineNativePlugin.trusted(Uri.parse(url))) {
                    PluginHandle handle = bridge.getPlugin("SerotineNative");
                    if (handle != null) ((SerotineNativePlugin) handle.getInstance()).onNewDocument();
                }
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (SerotineNativePlugin.trusted(uri) && uri.getPath() != null && uri.getPath().startsWith("/_capacitor_")) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", java.util.Map.of(), new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(webView, request);
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                // History can contain a single replaceState entry at startup.
                // Back at the inbox/login leaves the task without destroying its
                // activity or persistent data. Detail screens use the app router.
                String script = "['/','/index.html','/login','/chat'].includes(window.location.pathname)";
                view.evaluateJavascript(script, atRoot -> {
                    if ("true".equals(atRoot)) { moveTaskToBack(true); return; }
                    PluginHandle handle = bridge.getPlugin("SerotineNative");
                    if (handle != null) ((SerotineNativePlugin) handle.getInstance()).onBack();
                    else moveTaskToBack(true);
                });
            }
        });
    }
    static final class RestrictedMessages extends MessageHandler {
        private static final Set<String> METHODS = Set.of("getInfo", "readSnapshot", "writeSnapshot", "request", "saveFile", "openBackup", "openExternal", "resetStorage", "addListener", "removeListener", "removeAllListeners");
        RestrictedMessages(Bridge bridge, WebView view) { super(bridge, view, null); }
        @Override public void postMessage(String raw) {
            try {
                if (raw == null || raw.length() > 96 * 1024 * 1024) return;
                JSObject message = new JSObject(raw);
                if (message.has("type") || !"SerotineNative".equals(message.getString("pluginId")) || !METHODS.contains(message.getString("methodName"))) return;
                if ("addListener".equals(message.getString("methodName"))) {
                    String event = message.getJSObject("options", new JSObject()).getString("eventName");
                    if (!Set.of("lifecycle", "back").contains(event)) return;
                }
                super.postMessage(raw);
            } catch (Exception ignored) { /* Reject malformed bridge messages without logging user data. */ }
        }
    }
}
