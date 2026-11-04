package com.godhex.watchparty;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.WebViewListener;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * The app's own parts of HexTV:
 *  - window.HexAndroid for the site (js/inapp.js): the app version, and direct video playback.
 *    Browsers can't send the Referer/Origin the video CDN insists on, so the website plays through
 *    the Vercel relay. The app adds those headers itself and plays straight from the CDN.
 *  - Invite links (https://.../r/...) open in the app.
 *  - Real fullscreen for the room: the phone turns to landscape and the system bars hide, so the
 *    keyboard and everything else follow (the website can only rotate the player with CSS).
 */
@CapacitorPlugin(name = "HexAndroid")
public class HexPlugin extends Plugin {
    static final String SITE_HOST = "streamtogether-pi.vercel.app";
    private static final String[] MEDIA_DOMAINS = { "hakunaymatata.com", "aoneroom.com" };
    private static final Map<String, String> ALLOWED_HEADERS = new HashMap<>();
    static {
        ALLOWED_HEADERS.put("referer", "Referer");
        ALLOWED_HEADERS.put("origin", "Origin");
        ALLOWED_HEADERS.put("user-agent", "User-Agent");
    }

    private final Map<String, Map<String, String>> mediaHeaders = new ConcurrentHashMap<>();   // host -> headers

    @Override
    public void load() {
        final Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();
        webView.addJavascriptInterface(new Js(), "HexAndroid");
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse media = fetchMedia(request);
                return media != null ? media : super.shouldInterceptRequest(view, request);
            }
        });
        // Leaving a page (back button, a link) never leaves the phone stuck sideways
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView view) { setFullscreen(false); }
        });
        // Opened from an invite link: go there once the app has started
        final String start = linkFrom(getActivity().getIntent());
        if (start != null) webView.post(() -> bridge.getWebView().loadUrl(start));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        final String url = linkFrom(intent);
        if (url != null) getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }

    private void setFullscreen(boolean on) {
        final Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            a.setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
            bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (on) bars.hide(WindowInsetsCompat.Type.systemBars());
            else bars.show(WindowInsetsCompat.Type.systemBars());
        });
    }

    private static String linkFrom(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri u = intent.getData();
        if (u == null || !"https".equals(u.getScheme()) || !SITE_HOST.equals(u.getHost())) return null;
        return u.toString();
    }

    private static boolean isMediaHost(String host) {
        if (host == null) return false;
        for (String d : MEDIA_DOMAINS) if (host.equals(d) || host.endsWith("." + d)) return true;
        return false;
    }

    /** Video requests to a host the page registered: fetched here with the CDN's headers. */
    private WebResourceResponse fetchMedia(WebResourceRequest request) {
        Uri u = request.getUrl();
        if (!"https".equals(u.getScheme()) || !"GET".equals(request.getMethod())) return null;
        Map<String, String> extra = mediaHeaders.get(u.getHost());
        if (extra == null) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u.toString()).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                String k = h.getKey().toLowerCase();
                if (k.equals("range") || k.equals("accept")) c.setRequestProperty(h.getKey(), h.getValue());
            }
            for (Map.Entry<String, String> h : extra.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            int status = c.getResponseCode();
            if (status >= 400) { c.disconnect(); return null; }   // the page sees the CDN refuse and goes back to the relay
            Map<String, String> out = new HashMap<>();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                if (h.getKey() == null || h.getValue().isEmpty()) continue;
                String k = h.getKey().toLowerCase();
                if (k.equals("content-range") || k.equals("content-length") || k.equals("accept-ranges")
                        || k.equals("last-modified") || k.equals("etag")) out.put(h.getKey(), h.getValue().get(0));
            }
            out.put("Access-Control-Allow-Origin", "*");
            String type = c.getContentType();
            String mime = type != null ? type.split(";")[0].trim() : "video/mp4";
            String reason = c.getResponseMessage();
            InputStream body = c.getInputStream();
            return new WebResourceResponse(mime, null, status, reason == null || reason.isEmpty() ? "OK" : reason, out, body);
        } catch (Exception e) {
            if (c != null) c.disconnect();
            return null;
        }
    }

    private class Js {
        /** The room's fullscreen button: landscape with the system bars hidden, or back to normal. */
        @JavascriptInterface
        public void fullscreen(boolean on) { setFullscreen(on); }

        @JavascriptInterface
        public String version() { return BuildConfig.VERSION_NAME; }

        /** The page asks to play a CDN URL directly; true means requests to that host get the headers. */
        @JavascriptInterface
        public boolean allowMedia(String url, String headersJson) {
            try {
                Uri u = Uri.parse(url);
                if (!"https".equals(u.getScheme()) || !isMediaHost(u.getHost())) return false;
                JSONObject j = new JSONObject(headersJson);
                Map<String, String> h = new HashMap<>();
                for (Iterator<String> it = j.keys(); it.hasNext(); ) {
                    String k = it.next();
                    String name = ALLOWED_HEADERS.get(k.toLowerCase());
                    String v = j.optString(k, "");
                    if (name != null && !v.isEmpty() && v.length() < 300) h.put(name, v);
                }
                if (h.isEmpty()) return false;
                mediaHeaders.put(u.getHost(), h);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
