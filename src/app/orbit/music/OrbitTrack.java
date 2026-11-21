package app.orbit.music;

import android.content.Context;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.Image;

import java.io.File;
import java.net.URI;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Canonical track model shared by the JavaScript bridge, player, and downloader. */
final class OrbitTrack {
    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final Pattern RAW_VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");

    private OrbitTrack() {
    }

    static JSONObject fromJson(Context context, JSONObject input) throws JSONException {
        if (input == null) throw new JSONException("track is required");
        String source = input.optString("source", "").trim().toLowerCase(Locale.US);
        JSONObject out = new JSONObject();

        if ("youtube".equals(source)) {
            String videoId = input.optString("videoId", "").trim();
            if (!VIDEO_ID.matcher(videoId).matches()) {
                String rawId = input.optString("id", "").trim();
                if (rawId.startsWith("youtube:")) rawId = rawId.substring("youtube:".length());
                videoId = youtubeVideoId(rawId);
            }
            if (!VIDEO_ID.matcher(videoId).matches()) {
                throw new JSONException("invalid YouTube video id");
            }
            out.put("id", "youtube:" + videoId);
            out.put("videoId", videoId);
            out.put("source", "youtube");
            out.put("title", cleanText(input.optString("title", ""), "YouTube " + videoId));
            out.put("originalTitle", cleanText(input.optString("originalTitle", out.optString("title")), out.optString("title")));
            out.put("artist", cleanText(input.optString("artist", ""), "YouTube"));
            out.put("duration", Math.max(0L, input.optLong("duration", 0L)));
            putOptionalHttps(out, "artworkUrl", input.optString("artworkUrl", ""));
            copyYouTubeAudioFormat(out, input);
            // YouTube media URLs are deliberately not persisted.
            return out;
        }

        if ("demo".equals(source)) {
            String id = input.optString("id", "");
            String name = id.startsWith("demo:") ? id.substring(5) : id;
            name = name.toLowerCase(Locale.US);
            if (!"moon".equals(name) && !"peach".equals(name)
                    && !"cloud".equals(name) && !"after".equals(name)) {
                throw new JSONException("unknown demo track");
            }
            out.put("id", "demo:" + name);
            out.put("source", "demo");
            out.put("title", cleanText(input.optString("title", ""), name));
            out.put("originalTitle", cleanText(input.optString("originalTitle", out.optString("title")), out.optString("title")));
            out.put("artist", cleanText(input.optString("artist", ""), "Orbit"));
            out.put("duration", Math.max(0L, input.optLong("duration", 24L)));
            putOptionalHttps(out, "artworkUrl", input.optString("artworkUrl", ""));
            out.put("audioUrl", "assets/" + name + ".wav");
            return out;
        }

        if ("local".equals(source) || "import".equals(source)) {
            String localUri = input.optString("localUri", "").trim();
            if (!isAllowedLocalUri(context, localUri)) {
                throw new JSONException("invalid local URI");
            }
            String id = input.optString("id", "");
            if (!id.startsWith("local:")) id = "local:" + shortHash(localUri);
            out.put("id", id);
            out.put("source", "local");
            out.put("title", cleanText(input.optString("title", ""), "Imported audio"));
            out.put("originalTitle", cleanText(input.optString("originalTitle", out.optString("title")), out.optString("title")));
            out.put("artist", cleanText(input.optString("artist", ""), "Unknown artist"));
            out.put("duration", Math.max(0L, input.optLong("duration", 0L)));
            putOptionalHttps(out, "artworkUrl", input.optString("artworkUrl", ""));
            out.put("localUri", localUri);
            return out;
        }

        if ("direct".equals(source)) {
            String audioUrl = input.optString("audioUrl", "").trim();
            Uri uri = Uri.parse(audioUrl);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
                throw new JSONException("direct audio URL must use HTTPS");
            }
            String id = input.optString("id", "");
            if (!id.startsWith("direct:")) id = "direct:" + shortHash(audioUrl);
            out.put("id", id);
            out.put("source", "direct");
            out.put("title", cleanText(input.optString("title", ""), "Direct audio"));
            out.put("originalTitle", cleanText(input.optString("originalTitle", out.optString("title")), out.optString("title")));
            out.put("artist", cleanText(input.optString("artist", ""), "Unknown artist"));
            out.put("duration", Math.max(0L, input.optLong("duration", 0L)));
            putOptionalHttps(out, "artworkUrl", input.optString("artworkUrl", ""));
            out.put("audioUrl", audioUrl);
            String extension = inferExtension(audioUrl);
            if (!extension.isEmpty()) out.put("audioExtension", extension);
            return out;
        }

        throw new JSONException("unsupported track source");
    }

    static JSONObject demo(String name, String title, String artist) throws JSONException {
        JSONObject item = new JSONObject();
        item.put("id", "demo:" + name);
        item.put("source", "demo");
        item.put("title", title);
        item.put("originalTitle", title);
        item.put("artist", artist);
        item.put("duration", 24L);
        item.put("audioUrl", "assets/" + name + ".wav");
        return item;
    }

    static JSONObject copy(JSONObject item) throws JSONException {
        return new JSONObject(item.toString());
    }

    static String youtubeVideoId(String value) {
        String input = value == null ? "" : value.trim();
        if (input.isEmpty()) return "";

        if (input.startsWith("youtube:")) input = input.substring("youtube:".length()).trim();
        else if (input.startsWith("yt:")) input = input.substring("yt:".length()).trim();
        if (RAW_VIDEO_ID.matcher(input).matches()) return input;

        Uri uri;
        try {
            uri = Uri.parse(input);
        } catch (Exception ignored) {
            return "";
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return "";
        host = host.toLowerCase(Locale.US);
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return "";

        String path = uri.getPath() == null ? "" : uri.getPath();
        if ("youtu.be".equals(host)) {
            String candidate = path.startsWith("/") ? path.substring(1) : path;
            candidate = candidate.split("/", 2)[0];
            return VIDEO_ID.matcher(candidate).matches() ? candidate : "";
        }
        if (!host.equals("youtube.com") && !host.endsWith(".youtube.com")
                && !host.equals("youtube-nocookie.com") && !host.endsWith(".youtube-nocookie.com")) {
            return "";
        }
        if (path.startsWith("/watch/")) {
            String candidate = path.substring("/watch/".length());
            return VIDEO_ID.matcher(candidate).matches() ? candidate : "";
        }
        if (path.startsWith("/shorts/") || path.startsWith("/embed/")
                || path.startsWith("/live/") || path.startsWith("/v/")) {
            List<String> segments = uri.getPathSegments();
            String candidate = segments.size() > 1 ? segments.get(1) : "";
            return VIDEO_ID.matcher(candidate).matches() ? candidate : "";
        }
        String candidate = uri.getQueryParameter("v");
        return candidate != null && VIDEO_ID.matcher(candidate).matches() ? candidate : "";
    }

    static boolean isYoutubeVideo(String value) {
        return !youtubeVideoId(value).isEmpty();
    }

    static String canonicalYoutubeUrl(String videoId) {
        return "https://www.youtube.com/watch?v=" + videoId;
    }

    static String bestArtwork(List<Image> images) {
        if (images == null || images.isEmpty()) return "";
        Image best = images.get(0);
        for (Image image : images) {
            if (image.getHeight() > best.getHeight()) best = image;
        }
        return best.getUrl();
    }

    private static void copyYouTubeAudioFormat(JSONObject out, JSONObject input) throws JSONException {
        String format = input.optString("audioFormat", "").trim().toUpperCase(Locale.US);
        if ("M4A".equals(format)) {
            out.put("audioFormat", "M4A");
            out.put("audioExtension", "m4a");
            out.put("audioMimeType", "audio/mp4");
        } else if ("MP3".equals(format)) {
            out.put("audioFormat", "MP3");
            out.put("audioExtension", "mp3");
            out.put("audioMimeType", "audio/mpeg");
        }
    }

    private static String inferExtension(String url) {
        try {
            String path = Uri.parse(url).getPath();
            if (path == null) return "";
            int slash = path.lastIndexOf('/');
            String name = slash >= 0 ? path.substring(slash + 1) : path;
            int dot = name.lastIndexOf('.');
            if (dot < 0 || dot == name.length() - 1) return "";
            String extension = name.substring(dot + 1).toLowerCase(Locale.US);
            return extension.matches("[a-z0-9]{1,5}") ? extension : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void putOptionalHttps(JSONObject out, String key, String value) throws JSONException {
        String clean = value == null ? "" : value.trim();
        if (clean.startsWith("https://")) out.put(key, clean);
    }

    private static String cleanText(String value, String fallback) {
        if (value == null) return fallback;
        String clean = value.trim();
        return clean.isEmpty() ? fallback : clean.substring(0, Math.min(clean.length(), 140));
    }

    private static boolean isAllowedLocalUri(Context context, String value) {
        if (value == null || value.isEmpty()) return false;
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        if ("content".equalsIgnoreCase(scheme)) return true;
        if (!"file".equalsIgnoreCase(scheme)) return false;
        try {
            File file = new File(URI.create(value));
            String canonical = file.getCanonicalPath();
            return isInside(canonical, context.getFilesDir())
                    || isInside(canonical, context.getCacheDir())
                    || isInside(canonical, context.getExternalFilesDir(null));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isInside(String path, File parent) {
        if (parent == null) return false;
        try {
            String root = parent.getCanonicalPath();
            return path.equals(root) || path.startsWith(root + File.separator);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String shortHash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes("UTF-8"));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 8 && i < bytes.length; i++) {
                out.append(String.format(Locale.US, "%02x", bytes[i] & 0xff));
            }
            return out.toString();
        } catch (Exception ignored) {
            return Integer.toHexString(value.hashCode());
        }
    }
}
