package app.orbit.music;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.MediaMetadataRetriever;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.DisplayMetrics;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Orbit: a secure WebView shell for native music playback, downloads, and imports.
 */
public class MainActivity extends Activity {

    private static final int REQ_MEDIA = 1001;
    private static final int REQ_LOCATION = 1002;
    private static final int REQ_FILE = 1003;
    private static final int REQ_NOTIFY = 1004;
    private static final int REQ_DOWNLOAD = 1005;
    private static final int REQ_ORBIT_IMPORT = 1006;
    private static final int REQ_PLAY_NOTIFY = 1007;

    private static final String CHANNEL_ID = "orbit_default";
    private static final String PREFS = "orbit_prefs";
    private static final String ORBIT_ORIGIN = "https://orbit.invalid";
    private static final String ORBIT_HOST = "orbit.invalid";

    private WebView webView;

    private PermissionRequest pendingMediaRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private ValueCallback<Uri[]> fileCallback;

    private String pendingNotifyTitle;
    private String pendingNotifyBody;

    private String pendingDownloadUrl;
    private String pendingOrbitImportRequestId;
    private boolean notificationPermissionRequested;
    private boolean orbitReceiverRegistered;
    private boolean downloadReceiverRegistered;
    private final ExecutorService orbitExecutor = Executors.newSingleThreadExecutor();

    private final BroadcastReceiver orbitReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (OrbitPlaybackService.ACTION_RESPONSE.equals(intent.getAction())) {
                String requestId = intent.getStringExtra(OrbitPlaybackService.EXTRA_REQUEST_ID);
                String raw = intent.getStringExtra(OrbitPlaybackService.EXTRA_RESULT);
                try {
                    deliverOrbitResult(requestId, new JSONObject(raw == null ? "{}" : raw));
                } catch (Exception ignored) {
                }
            } else if (OrbitPlaybackService.ACTION_EVENT.equals(intent.getAction())) {
                String raw = intent.getStringExtra(OrbitPlaybackService.EXTRA_EVENT);
                try {
                    deliverOrbitEvent(new JSONObject(raw == null ? "{}" : raw));
                } catch (Exception ignored) {
                }
            }
        }
    };

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                handleDownloadCompletion(intent);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = (WebView) findViewById(R.id.web);

        // Lets you inspect debug builds from chrome://inspect on your desktop.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setGeolocationEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setBackgroundColor(0xFF15131B);
        webView.addJavascriptInterface(new Bridge(), "Native");
        webView.setWebChromeClient(new ChromeClient());
        registerOrbitReceiver();
        registerDownloadReceiver();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request == null || request.getUrl() == null
                        ? true : handleNavigation(request.getUrl().toString());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return null;
                if (request.isForMainFrame() && (!isTrustedHttps(request.getUrl(), ORBIT_HOST)
                        || !"GET".equals(request.getMethod()))) return notFoundResponse(false);
                return interceptOrbitAsset(request.getUrl().toString());
            }
        });

        webView.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                // API 23-28: writing to public Download/ is a runtime permission.
                if (Build.VERSION.SDK_INT <= 28
                        && !has(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                    pendingDownloadUrl = url;
                    requestPermissions(
                            new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_DOWNLOAD);
                    return;
                }
                enqueueDownload(url);
            }
        });

        webView.loadUrl(ORBIT_ORIGIN + "/index.html");
    }

    // ---------------------------------------------------------------- helpers

    private void registerOrbitReceiver() {
        if (orbitReceiverRegistered) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(OrbitPlaybackService.ACTION_RESPONSE);
        filter.addAction(OrbitPlaybackService.ACTION_EVENT);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(orbitReceiver, filter, OrbitPlaybackService.INTERNAL_PERMISSION,
                    null, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(orbitReceiver, filter, OrbitPlaybackService.INTERNAL_PERMISSION, null);
        }
        orbitReceiverRegistered = true;
    }

    private void registerDownloadReceiver() {
        if (downloadReceiverRegistered) return;
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }
        downloadReceiverRegistered = true;
    }

    private boolean handleNavigation(String url) {
        try {
            Uri uri = Uri.parse(url);
            if (ORBIT_HOST.equalsIgnoreCase(uri.getHost())) {
                return !isTrustedHttps(uri, ORBIT_HOST);
            }
            if ("about".equalsIgnoreCase(uri.getScheme())) return true;
            openExternal(uri);
        } catch (Exception ignored) {
        }
        return true;
    }

    private boolean isTrustedHttps(Uri uri, String expectedHost) {
        if (uri == null || expectedHost == null) return false;
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (!expectedHost.equalsIgnoreCase(uri.getHost())) return false;
        int port = uri.getPort();
        if (port != -1 && port != 443) return false;
        return uri.getUserInfo() == null;
    }

    /**
     * Serves bundled files from a trusted virtual HTTPS origin. This keeps DOM storage
     * consistent and lets the ui-sdk CDN tags resolve without a frontend build step.
     */
    private WebResourceResponse interceptOrbitAsset(String url) {
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost();
            if (host == null || !"https".equalsIgnoreCase(uri.getScheme())) return null;
            host = host.toLowerCase(java.util.Locale.US);

            String decodedPath = Uri.decode(uri.getEncodedPath() == null ? "" : uri.getEncodedPath());
            String assetPath;
            boolean sdkRequest = false;
            if (ORBIT_HOST.equals(host) && isTrustedHttps(uri, ORBIT_HOST)) {
                if (decodedPath.isEmpty() || "/".equals(decodedPath)) decodedPath = "/index.html";
                assetPath = decodedPath.startsWith("/") ? decodedPath.substring(1) : decodedPath;
            } else if ("ui-sdk.dev".equals(host) && isTrustedHttps(uri, "ui-sdk.dev")) {
                if ("/web.js".equals(decodedPath)) assetPath = "ui-sdk/web.js";
                else if ("/web.css".equals(decodedPath)) assetPath = "ui-sdk/web.css";
                else if (decodedPath.startsWith("/web/")) {
                    assetPath = "ui-sdk" + decodedPath;
                } else {
                    return null;
                }
                sdkRequest = true;
            } else {
                return null;
            }

            if (!isSafeAssetPath(assetPath)) return notFoundResponse(sdkRequest);
            InputStream stream;
            try {
                stream = getAssets().open(assetPath);
            } catch (Exception missing) {
                return notFoundResponse(sdkRequest);
            }
            String mime = mimeType(assetPath);
            String encoding = isTextAsset(assetPath) ? "utf-8" : null;
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-store");
            headers.put("Content-Security-Policy", "frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
            if (sdkRequest) headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean isSafeAssetPath(String path) {
        if (path == null || path.isEmpty() || path.indexOf('\0') >= 0) return false;
        if (path.startsWith("/") || path.contains("\\")) return false;
        String[] parts = path.split("/");
        for (String part : parts) {
            if ("..".equals(part)) return false;
        }
        return true;
    }

    private WebResourceResponse notFoundResponse(boolean cors) {
        Map<String, String> headers = new HashMap<String, String>();
        if (cors) headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private String mimeType(String path) {
        String lower = path.toLowerCase(java.util.Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        return "application/octet-stream";
    }

    private boolean isTextAsset(String path) {
        String lower = path.toLowerCase(java.util.Locale.US);
        return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".js")
                || lower.endsWith(".mjs") || lower.endsWith(".css") || lower.endsWith(".json")
                || lower.endsWith(".map") || lower.endsWith(".svg") || lower.endsWith(".txt");
    }

    private JSONObject normalizeServicePayload(String method, JSONObject payload) throws JSONException {
        JSONObject normalized = new JSONObject(payload.toString());
        if ("play".equals(method) && !normalized.has("queue")) {
            JSONObject track = trackFromFlatPayload(normalized);
            normalized.put("queue", new JSONArray().put(track));
            normalized.put("index", 0);
        }
        if ("download".equals(method) && !normalized.has("track")) {
            normalized.put("track", trackFromFlatPayload(normalized));
        }
        if ("enqueue".equals(method) && !normalized.has("track")) {
            normalized.put("track", trackFromFlatPayload(normalized));
        }
        if ("rename".equals(method) && !normalized.has("id") && normalized.has("trackId")) {
            normalized.put("id", nativeTrackId(normalized.getString("trackId")));
        }
        if ("removeDownload".equals(method) && normalized.has("id")) {
            normalized.put("id", nativeTrackId(normalized.getString("id")));
        }
        if ("control".equals(method) && "play".equals(normalized.optString("action", ""))) {
            normalized.put("action", "resume");
        }
        return normalized;
    }

    private JSONObject trackFromFlatPayload(JSONObject payload) throws JSONException {
        JSONObject track = new JSONObject();
        String id = payload.optString("trackId", payload.optString("id", ""));
        String videoId = payload.optString("videoId", "").trim();
        if (!videoId.isEmpty() && !OrbitTrack.isYoutubeVideo(videoId)) videoId = "";
        if (videoId.isEmpty() && id.startsWith("yt:")) {
            String candidate = id.substring(3);
            if (OrbitTrack.isYoutubeVideo(candidate)) videoId = candidate;
        }
        if (videoId.isEmpty() && id.startsWith("youtube:")) {
            String candidate = id.substring(8);
            if (OrbitTrack.isYoutubeVideo(candidate)) videoId = candidate;
        }

        if (!videoId.isEmpty()) {
            track.put("id", "youtube:" + videoId);
            track.put("videoId", videoId);
            track.put("source", "youtube");
        } else if (id.startsWith("demo:")) {
            track.put("id", id);
            track.put("source", "demo");
        } else if ("local".equals(payload.optString("source", ""))
                || "import".equals(payload.optString("source", ""))) {
            if (!payload.has("localUri")) {
                throw new JSONException("Imported audio requires the native document picker");
            }
            track.put("id", id);
            track.put("source", "local");
            track.put("localUri", payload.getString("localUri"));
        } else if (payload.has("url") && payload.optString("url", "").startsWith("https://")) {
            track.put("id", id.isEmpty() ? "direct:imported" : id);
            track.put("source", "direct");
            track.put("audioUrl", payload.getString("url"));
        } else {
            throw new JSONException("Track payload has no playable source");
        }
        track.put("title", payload.optString("title", "Orbit track"));
        track.put("artist", payload.optString("artist", "Unknown artist"));
        track.put("duration", Math.max(0L, payload.optLong("duration", 0L)));
        String artwork = payload.optString("artworkUrl", "");
        if (artwork.startsWith("https://")) track.put("artworkUrl", artwork);
        return track;
    }

    private String nativeTrackId(String id) {
        if (id != null && id.startsWith("yt:")) return "youtube:" + id.substring(3);
        return id == null ? "" : id;
    }

    private void deliverOrbitResult(final String requestId, final JSONObject result) {
        if (requestId == null || requestId.isEmpty()) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.OrbitNative && window.OrbitNative.onResult("
                        + JSONObject.quote(requestId) + "," + result + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void deliverOrbitEvent(final JSONObject event) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.OrbitNative && window.OrbitNative.onEvent(" + event + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void handleDownloadCompletion(Intent intent) {
        final long managerId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (managerId < 0L) return;
        orbitExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONArray downloads = OrbitDownloadStore.refreshAndList(MainActivity.this);
                    for (int i = 0; i < downloads.length(); i++) {
                        JSONObject download = downloads.optJSONObject(i);
                        if (download == null
                                || download.optLong("downloadManagerId", -1L) != managerId) {
                            continue;
                        }
                        deliverOrbitEvent(createDownloadEvent(download));
                    }
                } catch (Exception ignored) {
                }
            }
        });
    }

    private JSONObject createDownloadEvent(JSONObject download) throws JSONException {
        JSONObject event = new JSONObject();
        event.put("type", "download");
        event.put("id", download.optString("id"));
        JSONObject track = download.optJSONObject("track");
        event.put("track", track == null ? JSONObject.NULL : track);
        if (track != null) {
            String[] fields = {"title", "originalTitle", "artist", "source",
                    "videoId", "duration", "artworkUrl"};
            for (String field : fields) {
                if (track.has(field)) event.put(field, track.get(field));
            }
        }
        event.put("status", download.optString("status", "queued"));
        event.put("progress", download.optInt("progress", 0));
        if (download.has("downloadedBytes")) {
            event.put("downloadedBytes", download.optLong("downloadedBytes", 0L));
        }
        if (download.has("totalBytes")) {
            event.put("totalBytes", download.optLong("totalBytes", 0L));
        }
        if (download.has("localUri")) event.put("localUri", download.optString("localUri"));
        if (download.has("error")) event.put("error", download.optString("error"));
        return event;
    }

    private boolean has(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPlaybackNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33
                || has(Manifest.permission.POST_NOTIFICATIONS)
                || notificationPermissionRequested) {
            return;
        }
        notificationPermissionRequested = true;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PLAY_NOTIFY);
    }

    private void enqueueDownload(String url) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, "orbit-" + System.currentTimeMillis());
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(req);
            toast("Download queued");
        } catch (Exception e) {
            toast("Download failed: " + e.getMessage());
        }
    }

    /** {"error": "..."} so the web layer can show why a bridge call failed. */
    private static String errorJson(Exception e) {
        try {
            JSONObject o = new JSONObject();
            o.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            return o.toString();
        } catch (Exception ignored) {
            return "{\"error\":\"unknown\"}";
        }
    }

    private void toast(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                showToast(message);
            }
        });
    }

    /**
     * Real Toast, but with our own icon and text. Some vendor ROMs substitute the
     * default Android robot for the app icon in system toasts, which made the
     * bridge look unbranded. A custom view is only honoured while the app is in
     * the foreground (Android 11+), which is exactly when this bridge fires.
     */
    private void showToast(String message) {
        try {
            Toast t = new Toast(this);
            View v = getLayoutInflater().inflate(R.layout.toast_custom, null);
            ((ImageView) v.findViewById(R.id.toast_icon)).setImageResource(R.mipmap.ic_launcher);
            ((TextView) v.findViewById(R.id.toast_text)).setText(message);
            t.setView(v);
            t.setDuration(Toast.LENGTH_SHORT);
            t.show();
        } catch (Exception e) {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        }
    }

    private void emitToJs(final String js) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    /**
     * Opens a link, preferring a real app handler (WhatsApp, Telegram, Maps,
     * YouTube ...) over a browser. Android resolves every https link to a
     * browser, so a plain ACTION_VIEW would send https://wa.me/... to Chrome.
     * Here we skip packages that are registered for generic web links.
     */
    private void openExternal(Uri uri) {
        // intent://some.deep/link#Intent;scheme=xyz;package=com.foo;end
        if ("intent".equals(uri.getScheme())) {
            try {
                Intent parsed = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                parsed.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(parsed);
                return;
            } catch (Exception ignored) {
                // fall through to normal handling
            }
        }

        Intent direct = new Intent(Intent.ACTION_VIEW, uri);
        direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        // Some installs don't publish verified App Links, so nudge the known app
        // directly before falling back to generic resolution.
        String[] prefer = preferredPackages(uri.getHost());
        if (prefer != null) {
            for (String pkg : prefer) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.setPackage(pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY) != null) {
                        startActivity(i);
                        return;
                    }
                } catch (Exception ignored) {
                    // try the next package
                }
            }
        }

        List<String> browsers = browserPackages();
        List<ResolveInfo> candidates = getPackageManager().queryIntentActivities(direct, 0);
        if (candidates != null) {
            for (ResolveInfo ri : candidates) {
                if (ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (browsers.contains(pkg) || getPackageName().equals(pkg)) continue;
                Intent appIntent = new Intent(Intent.ACTION_VIEW, uri);
                appIntent.setPackage(pkg);
                appIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    startActivity(appIntent);
                    return;
                } catch (Exception ignored) {
                    // try the next candidate
                }
            }
        }
        startActivity(direct);
    }

    /** Apps that should get a link even if their App Links aren't verified. */
    private static String[] preferredPackages(String host) {
        if (host == null) return null;
        String h = host.toLowerCase(java.util.Locale.US);
        if (h.equals("wa.me") || h.equals("api.whatsapp.com") || h.endsWith(".whatsapp.com")) {
            return new String[]{"com.whatsapp", "com.whatsapp.w4b"};
        }
        if (h.equals("t.me") || h.equals("telegram.me") || h.equals("telegram.org")
                || h.endsWith(".telegram.org")) {
            return new String[]{"org.telegram.messenger", "org.telegram.messenger.web"};
        }
        return null;
    }

    /** Packages that claim to open a plain web link, i.e. browsers and web wrappers. */
    private List<String> browserPackages() {
        List<String> out = new ArrayList<String>();
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"));
        List<ResolveInfo> list = getPackageManager().queryIntentActivities(probe, 0);
        if (list != null) {
            for (ResolveInfo ri : list) {
                if (ri.activityInfo != null) out.add(ri.activityInfo.packageName);
            }
        }
        return out;
    }

    // ------------------------------------------------------- WebChromeClient

    private class ChromeClient extends WebChromeClient {

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pendingMediaRequest = request;
                    List<String> need = new ArrayList<String>();
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                                && !has(Manifest.permission.CAMERA)) {
                            need.add(Manifest.permission.CAMERA);
                        }
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                                && !has(Manifest.permission.RECORD_AUDIO)) {
                            need.add(Manifest.permission.RECORD_AUDIO);
                        }
                    }
                    if (need.isEmpty()) {
                        request.grant(request.getResources());
                        pendingMediaRequest = null;
                    } else {
                        requestPermissions(need.toArray(new String[0]), REQ_MEDIA);
                    }
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            pendingMediaRequest = null;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       GeolocationPermissions.Callback callback) {
            if (has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingGeoCallback = callback;
            pendingGeoOrigin = origin;
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQ_LOCATION);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
                return true;
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Native alert")
                    .setMessage(message)
                    .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        @Override
                        public void onCancel(DialogInterface d) {
                            result.cancel();
                        }
                    })
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Native confirm")
                    .setMessage(message)
                    .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("Cancel", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.cancel();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        @Override
                        public void onCancel(DialogInterface d) {
                            result.cancel();
                        }
                    })
                    .show();
            return true;
        }
    }

    // ------------------------------------------------------------- results

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_ORBIT_IMPORT) {
            handleOrbitImportResult(resultCode, data);
            return;
        }
        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(results);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void handleOrbitImportResult(int resultCode, Intent data) {
        final String requestId = pendingOrbitImportRequestId;
        pendingOrbitImportRequestId = null;
        if (requestId == null) return;
        if (resultCode != RESULT_OK || data == null) {
            deliverOrbitResult(requestId, errorObject("Import cancelled"));
            return;
        }

        final ArrayList<Uri> uris = new ArrayList<Uri>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            deliverOrbitResult(requestId, errorObject("No audio files were selected"));
            return;
        }

        for (Uri uri : uris) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
        }

        orbitExecutor.execute(new Runnable() {
            @Override
            public void run() {
                JSONArray tracks = new JSONArray();
                for (Uri uri : uris) {
                    try {
                        tracks.put(readImportedTrack(uri));
                    } catch (Exception ignored) {
                    }
                }
                try {
                    JSONObject result = new JSONObject();
                    if (tracks.length() == 0) {
                        result.put("error", "No readable audio metadata was found");
                    } else {
                        result.put("tracks", tracks);
                    }
                    deliverOrbitResult(requestId, result);
                } catch (Exception error) {
                    deliverOrbitResult(requestId, errorObject(error.getMessage()));
                }
            }
        });
    }

    private JSONObject readImportedTrack(Uri uri) throws Exception {
        String title = "Imported audio";
        String artist = "Unknown artist";
        long duration = 0L;
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(this, uri);
            String metadataTitle = retriever.extractMetadata(
                    MediaMetadataRetriever.METADATA_KEY_TITLE);
            String metadataArtist = retriever.extractMetadata(
                    MediaMetadataRetriever.METADATA_KEY_ARTIST);
            String metadataDuration = retriever.extractMetadata(
                    MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (metadataTitle != null && !metadataTitle.trim().isEmpty()) title = metadataTitle.trim();
            if (metadataArtist != null && !metadataArtist.trim().isEmpty()) artist = metadataArtist.trim();
            if (metadataDuration != null) {
                try {
                    duration = Math.max(0L, Long.parseLong(metadataDuration) / 1000L);
                } catch (NumberFormatException ignored) {
                }
            }
        } finally {
            retriever.release();
        }

        String id = "local:" + UUID.nameUUIDFromBytes(
                uri.toString().getBytes("UTF-8")).toString().replace("-", "");
        JSONObject track = new JSONObject();
        track.put("id", id);
        track.put("source", "local");
        track.put("title", title);
        track.put("originalTitle", title);
        track.put("artist", artist);
        track.put("duration", duration);
        track.put("localUri", uri.toString());
        return track;
    }

    private JSONObject errorObject(String message) {
        try {
            JSONObject error = new JSONObject();
            error.put("error", message == null || message.isEmpty()
                    ? "Native request failed" : message);
            return error;
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_MEDIA) {
            if (pendingMediaRequest != null) {
                boolean allGranted = grantResults.length > 0;
                for (int g : grantResults) {
                    if (g != PackageManager.PERMISSION_GRANTED) allGranted = false;
                }
                if (allGranted) {
                    pendingMediaRequest.grant(pendingMediaRequest.getResources());
                } else {
                    pendingMediaRequest.deny();
                }
                pendingMediaRequest = null;
            }
            return;
        }

        if (requestCode == REQ_LOCATION) {
            if (pendingGeoCallback != null) {
                boolean granted = grantResults.length > 0
                        && grantResults[0] == PackageManager.PERMISSION_GRANTED;
                pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
                pendingGeoCallback = null;
            }
            return;
        }

        if (requestCode == REQ_DOWNLOAD) {
            String url = pendingDownloadUrl;
            pendingDownloadUrl = null;
            if (url == null) return;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                enqueueDownload(url);
            } else {
                toast("Storage permission denied - download cancelled");
            }
            return;
        }

        if (requestCode == REQ_NOTIFY) {
            if (pendingNotifyTitle != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                showNotification(pendingNotifyTitle, pendingNotifyBody);
            } else {
                toast("Notification permission denied");
            }
            pendingNotifyTitle = null;
            pendingNotifyBody = null;
            return;
        }

        if (requestCode == REQ_PLAY_NOTIFY) {
            if (grantResults.length == 0 || grantResults[0] != PackageManager.PERMISSION_GRANTED) {
                toast("Playback notifications are off", "System media controls remain available.");
            }
            return;
        }

        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // ------------------------------------------------------------- bridge

    private class Bridge {

        @JavascriptInterface
        public String deviceInfo() {
            try {
                DisplayMetrics dm = getResources().getDisplayMetrics();
                JSONObject o = new JSONObject();
                o.put("manufacturer", Build.MANUFACTURER);
                o.put("brand", Build.BRAND);
                o.put("model", Build.MODEL);
                o.put("device", Build.DEVICE);
                o.put("android", Build.VERSION.RELEASE);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("app", getString(R.string.app_name));
                o.put("package", getPackageName());
                o.put("version", getPackageManager()
                        .getPackageInfo(getPackageName(), 0).versionName);
                o.put("density", dm.density);
                o.put("screenPx", dm.widthPixels + "x" + dm.heightPixels);
                o.put("locale", java.util.Locale.getDefault().toString());
                return o.toString();
            } catch (Exception e) {
                return "{\"error\":\"" + e.getMessage() + "\"}";
            }
        }

        @JavascriptInterface
        public void toastMsg(String message) {
            toast(message);
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) {
                toast("No vibrator");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(ms);
            }
        }

        @JavascriptInterface
        public void copyText(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("Orbit", text));
                toast("Copied to clipboard");
            }
        }

        @JavascriptInterface
        public String readClipboard() {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null) return "";
            ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
            CharSequence t = item.coerceToText(MainActivity.this);
            return t == null ? "" : t.toString();
        }

        @JavascriptInterface
        public void shareText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "Share via"));
                }
            });
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        openExternal(Uri.parse(url));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "No app to open this link",
                                Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void setValue(String key, String value) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public String getValue(String key) {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString(key, "");
        }

        @JavascriptInterface
        public String storageDump() {
            try {
                JSONObject o = new JSONObject();
                Map<String, ?> all = getSharedPreferences(PREFS, MODE_PRIVATE).getAll();
                for (Map.Entry<String, ?> e : all.entrySet()) {
                    o.put(e.getKey(), String.valueOf(e.getValue()));
                }
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String batteryInfo() {
            try {
                BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
                JSONObject o = new JSONObject();
                o.put("percent", bm == null ? -1
                        : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
                o.put("charging", bm != null && bm.isCharging());
                return o.toString();
            } catch (Exception e) {
                return errorJson(e);
            }
        }

        @JavascriptInterface
        public String networkInfo() {
            try {
                JSONObject o = new JSONObject();
                ConnectivityManager cm =
                        (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                Network n = cm == null ? null : cm.getActiveNetwork();
                NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
                o.put("online", caps != null);
                o.put("wifi", caps != null
                        && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
                o.put("cellular", caps != null
                        && caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
                o.put("metered", cm != null && cm.isActiveNetworkMetered());
                return o.toString();
            } catch (Exception e) {
                // Missing ACCESS_NETWORK_STATE ends up here as a SecurityException.
                return errorJson(e);
            }
        }

        @JavascriptInterface
        public String notifyUser(final String title, final String body) {
            if (Build.VERSION.SDK_INT >= 33 && !has("android.permission.POST_NOTIFICATIONS")) {
                pendingNotifyTitle = title;
                pendingNotifyBody = body;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        requestPermissions(
                                new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
                    }
                });
                return "asking-permission";
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showNotification(title, body);
                }
            });
            return "shown";
        }

        @JavascriptInterface
        public void printPage() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        String job = "Orbit-" + System.currentTimeMillis();
                        if (pm != null) {
                            pm.print(job, webView.createPrintDocumentAdapter(job), null);
                        }
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Print failed: " + e.getMessage(),
                                Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public String saveFile(String name, String content) {
            try {
                if (name == null || name.trim().isEmpty() || name.length() > 120
                        || name.contains("/") || name.contains("\\") || name.indexOf('\0') >= 0
                        || ".".equals(name) || "..".equals(name)) return "failed: invalid file name";
                byte[] bytes = content.getBytes("UTF-8");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    // Avoid referencing the API 29 MediaStore.Downloads class on older devices.
                    Uri collection = Uri.parse("content://media/external/downloads");
                    Uri uri = getContentResolver().insert(collection, cv);
                    if (uri == null) return "failed: could not create file";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "failed: no output stream";
                    os.write(bytes);
                    os.close();
                    return "Download/" + name;
                }
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) return "failed: no external dir";
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, name);
                if (!f.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) {
                    return "failed: invalid file path";
                }
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(bytes);
                fos.close();
                return f.getAbsolutePath();
            } catch (Exception e) {
                return "failed: " + e.getMessage();
            }
        }

        /**
         * Orbit's guarded async API. Every call returns through window.OrbitNative.onResult().
         */
        @JavascriptInterface
        public void orbitRequest(final String method, final String payloadJson,
                                 final String requestId) {
            if (method == null || requestId == null || requestId.isEmpty()
                    || requestId.length() > 160) {
                deliverOrbitResult(requestId, errorObject("Invalid native request"));
                return;
            }
            final JSONObject payload;
            try {
                payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
            } catch (Exception error) {
                deliverOrbitResult(requestId, errorObject("Invalid JSON payload"));
                return;
            }

            if ("search".equals(method)) {
                String query = payload.optString("query", "").trim();
                if (query.isEmpty()) {
                    deliverOrbitResult(requestId, errorObject("Search query is empty"));
                    return;
                }
                OrbitYouTube.searchAsync(MainActivity.this, query, new OrbitYouTube.Callback() {
                    @Override
                    public void onSuccess(JSONObject result) {
                        deliverOrbitResult(requestId, result);
                    }

                    @Override
                    public void onError(String message) {
                        deliverOrbitResult(requestId, errorObject(message));
                    }
                });
                return;
            }

            if ("state".equals(method)) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        deliverOrbitResult(requestId,
                                OrbitPlaybackService.stateSnapshot(MainActivity.this));
                    }
                });
                return;
            }

            if ("downloads".equals(method)) {
                orbitExecutor.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            JSONObject result = new JSONObject();
                            JSONArray downloads = OrbitDownloadStore.refreshAndList(MainActivity.this);
                            result.put("tracks", downloads);
                            result.put("downloads", downloads);
                            deliverOrbitResult(requestId, result);
                            for (int i = 0; i < downloads.length(); i++) {
                                JSONObject download = downloads.optJSONObject(i);
                                if (download == null) continue;
                                deliverOrbitEvent(createDownloadEvent(download));
                            }
                        } catch (Exception error) {
                            deliverOrbitResult(requestId, errorObject(error.getMessage()));
                        }
                    }
                });
                return;
            }

            if ("import".equals(method)) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (pendingOrbitImportRequestId != null) {
                            deliverOrbitResult(requestId,
                                    errorObject("Another import is already open"));
                            return;
                        }
                        pendingOrbitImportRequestId = requestId;
                        try {
                            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                            picker.addCategory(Intent.CATEGORY_OPENABLE);
                            picker.setType("audio/*");
                            picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                            picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                            startActivityForResult(picker, REQ_ORBIT_IMPORT);
                        } catch (Exception error) {
                            pendingOrbitImportRequestId = null;
                            deliverOrbitResult(requestId, errorObject(error.getMessage()));
                        }
                    }
                });
                return;
            }

            if ("play".equals(method) || "control".equals(method) || "queue".equals(method)
                    || "enqueue".equals(method) || "download".equals(method)
                    || "removeDownload".equals(method) || "rename".equals(method)) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            if ("play".equals(method)) requestPlaybackNotificationPermission();
                            JSONObject servicePayload = normalizeServicePayload(method, payload);
                            OrbitPlaybackService.sendCommand(MainActivity.this, method,
                                    servicePayload, requestId);
                        } catch (Exception error) {
                            deliverOrbitResult(requestId, errorObject(error.getMessage()));
                        }
                    }
                });
                return;
            }

            deliverOrbitResult(requestId, errorObject("Unsupported native method: " + method));
        }

        /**
         * Async round-trip demo: native work off the UI thread, then a JS callback.
         */
        @JavascriptInterface
        public void ping(final String payload, final String callbackId) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    long start = System.currentTimeMillis();
                    String reversed = new StringBuilder(payload).reverse().toString();
                    try {
                        Thread.sleep(350);
                    } catch (InterruptedException ignored) {
                    }
                    try {
                        JSONObject result = new JSONObject();
                        result.put("echo", payload);
                        result.put("reversed", reversed);
                        result.put("nativeMs", System.currentTimeMillis() - start);
                        result.put("thread", Thread.currentThread().getName());
                        emitToJs("window.Silicon && window.Silicon.onNative("
                                + JSONObject.quote(callbackId) + ", " + result + ")");
                    } catch (Exception ignored) {
                    }
                }
            }).start();
        }
    }

    // --------------------------------------------------------- notifications

    private void showNotification(String title, String body) {
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "Orbit", NotificationManager.IMPORTANCE_DEFAULT);
                nm.createNotificationChannel(ch);
            }

            Intent open = new Intent(this, MainActivity.class);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                    Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setSmallIcon(R.drawable.ic_stat_orbit)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            nm.notify((int) (System.currentTimeMillis() % 10000), b.build());
            toast("Notification posted");
        } catch (Exception e) {
            toast("Notification failed: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------- lifecycle

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            switch (keyCode) {
                case KeyEvent.KEYCODE_BACK:
                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        finish();
                    }
                    return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (orbitReceiverRegistered) {
            try {
                unregisterReceiver(orbitReceiver);
            } catch (Exception ignored) {
            }
            orbitReceiverRegistered = false;
        }
        if (downloadReceiverRegistered) {
            try {
                unregisterReceiver(downloadReceiver);
            } catch (Exception ignored) {
            }
            downloadReceiverRegistered = false;
        }
        orbitExecutor.shutdownNow();
        super.onDestroy();
    }
}
