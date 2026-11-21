package app.orbit.music;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ListExtractor.InfoItemsPage;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamExtractor;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** YouTube Music search and Android-compatible audio resolution through NewPipeExtractor. */
final class OrbitYouTube {
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(2);
    private static final int MAX_RESULTS = 40;
    private static boolean initialized;

    interface Callback {
        void onSuccess(JSONObject result);

        void onError(String message);
    }

    private OrbitYouTube() {
    }

    private static synchronized void initialize() {
        if (initialized) return;
        NewPipe.init(new OrbitDownloader());
        initialized = true;
    }

    static void searchAsync(final Context context, final String query, final Callback callback) {
        EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    callback.onSuccess(search(context, query));
                } catch (Throwable error) {
                    callback.onError(readableError(error));
                }
            }
        });
    }

    static void resolveAsync(final Context context, final JSONObject track, final Callback callback) {
        final JSONObject requestTrack;
        try {
            requestTrack = OrbitTrack.copy(track);
        } catch (JSONException error) {
            callback.onError(readableError(error));
            return;
        }
        EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    callback.onSuccess(resolve(context, requestTrack));
                } catch (Throwable error) {
                    callback.onError(readableError(error));
                }
            }
        });
    }

    private static JSONObject search(Context context, String query) throws Exception {
        initialize();
        String cleanQuery = query == null ? "" : query.trim();
        if (cleanQuery.isEmpty()) throw new JSONException("Search query is empty");

        if (OrbitTrack.isYoutubeVideo(cleanQuery)) {
            String videoId = OrbitTrack.youtubeVideoId(cleanQuery);
            JSONObject pasted = new JSONObject();
            pasted.put("id", "youtube:" + videoId);
            pasted.put("videoId", videoId);
            pasted.put("source", "youtube");
            pasted.put("title", "YouTube " + videoId);
            pasted.put("originalTitle", "");
            pasted.put("artist", "YouTube");
            pasted.put("duration", 0L);
            JSONObject resolved = resolve(context, pasted);
            JSONObject tracks = new JSONObject();
            tracks.put("tracks", new JSONArray().put(resolved));
            return tracks;
        }

        List<InfoItem> items = fetchSearch(cleanQuery, true);
        if (items.isEmpty()) items = fetchSearch(cleanQuery, false);

        JSONArray tracks = new JSONArray();
        for (InfoItem item : items) {
            if (!(item instanceof StreamInfoItem)) continue;
            StreamInfoItem stream = (StreamInfoItem) item;
            String videoId = OrbitTrack.youtubeVideoId(stream.getUrl());
            if (videoId.isEmpty()) continue;

            JSONObject track = new JSONObject();
            track.put("id", "youtube:" + videoId);
            track.put("videoId", videoId);
            track.put("source", "youtube");
            String title = safe(stream.getName(), "YouTube " + videoId);
            track.put("title", title);
            track.put("originalTitle", title);
            track.put("artist", safe(stream.getUploaderName(), "YouTube"));
            track.put("duration", Math.max(0L, stream.getDuration()));
            String artwork = OrbitTrack.bestArtwork(stream.getThumbnails());
            if (artwork.startsWith("https://")) track.put("artworkUrl", artwork);
            tracks.put(track);
            if (tracks.length() >= MAX_RESULTS) break;
        }

        JSONObject result = new JSONObject();
        result.put("tracks", tracks);
        return result;
    }

    private static List<InfoItem> fetchSearch(String query, boolean music) throws Exception {
        List<String> filters = music
                ? Collections.singletonList("music_songs")
                : Collections.singletonList("videos");
        SearchExtractor extractor = ServiceList.YouTube.getSearchExtractor(query, filters, "");
        extractor.fetchPage();
        InfoItemsPage<InfoItem> page = extractor.getInitialPage();
        return page.getItems() == null ? new ArrayList<InfoItem>() : page.getItems();
    }

    private static JSONObject resolve(Context context, JSONObject input) throws Exception {
        initialize();
        JSONObject track = OrbitTrack.fromJson(context, input);
        String videoId = track.optString("videoId", "");
        if (!OrbitTrack.isYoutubeVideo(videoId)) {
            throw new JSONException("Track does not contain a valid YouTube video id");
        }

        StreamExtractor extractor = ServiceList.YouTube.getStreamExtractor(
                OrbitTrack.canonicalYoutubeUrl(videoId));
        extractor.fetchPage();

        String extractedTitle = safe(extractor.getName(), "YouTube " + videoId);
        String oldTitle = track.optString("title", "");
        if (oldTitle.isEmpty() || oldTitle.equals("YouTube " + videoId)) {
            track.put("title", extractedTitle);
            track.put("originalTitle", extractedTitle);
        }
        try {
            track.put("artist", safe(extractor.getUploaderName(), track.optString("artist", "YouTube")));
        } catch (Exception ignored) {
        }
        try {
            track.put("duration", Math.max(0L, extractor.getLength()));
        } catch (Exception ignored) {
        }
        try {
            String artwork = OrbitTrack.bestArtwork(extractor.getThumbnails());
            if (artwork.startsWith("https://")) track.put("artworkUrl", artwork);
        } catch (Exception ignored) {
        }

        AudioStream selected = selectAndroidAudio(extractor.getAudioStreams());
        MediaFormat format = selected.getFormat();
        track.put("audioUrl", selected.getContent());
        track.put("audioFormat", format.name());
        track.put("audioExtension", format.suffix);
        track.put("audioMimeType", format.mimeType);
        return track;
    }

    private static AudioStream selectAndroidAudio(List<AudioStream> streams) throws JSONException {
        if (streams == null || streams.isEmpty()) {
            throw new JSONException("YouTube returned no audio streams");
        }
        final List<AudioStream> candidates = new ArrayList<AudioStream>();
        for (AudioStream stream : streams) {
            if (!stream.isUrl()) continue;
            String content = stream.getContent();
            if (content == null || !content.startsWith("https://")) continue;
            MediaFormat format = stream.getFormat();
            if (format == MediaFormat.M4A || format == MediaFormat.MP3) {
                candidates.add(stream);
            }
        }
        if (candidates.isEmpty()) {
            throw new JSONException("No Android 6+ compatible M4A or MP3 audio stream was returned");
        }
        Collections.sort(candidates, new Comparator<AudioStream>() {
            @Override
            public int compare(AudioStream left, AudioStream right) {
                MediaFormat leftFormat = left.getFormat();
                MediaFormat rightFormat = right.getFormat();
                if (leftFormat == MediaFormat.M4A && rightFormat != MediaFormat.M4A) return -1;
                if (rightFormat == MediaFormat.M4A && leftFormat != MediaFormat.M4A) return 1;
                return Integer.compare(right.getAverageBitrate(), left.getAverageBitrate());
            }
        });
        return candidates.get(0);
    }

    private static String safe(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static String readableError(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) message = error.getClass().getSimpleName();
        if (message.toLowerCase().contains("429") || message.toLowerCase().contains("rate-limit")) {
            return "YouTube rate-limited this request (HTTP 429). Wait, then retry.";
        }
        if (message.toLowerCase().contains("premium")) {
            return "This YouTube track requires YouTube Music Premium and cannot be played anonymously.";
        }
        if (message.toLowerCase().contains("sign in") || message.toLowerCase().contains("bot")) {
            return "YouTube temporarily blocked anonymous extraction from this network. Retry later.";
        }
        return message;
    }

    private static final class OrbitDownloader extends Downloader {
        @Override
        public Response execute(Request request) throws IOException {
            URL url = new URL(request.url());
            String method = request.httpMethod();
            byte[] body = request.dataToSend();
            for (int redirects = 0; redirects <= 5; redirects++) {
                if (!"https".equalsIgnoreCase(url.getProtocol())) {
                    throw new IOException("Extractor requests must use HTTPS");
                }
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                try {
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(20000);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod(method);
                    connection.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36");
                    for (Map.Entry<String, List<String>> header : request.headers().entrySet()) {
                        List<String> values = header.getValue();
                        if (values == null || values.isEmpty()) continue;
                        connection.setRequestProperty(header.getKey(), values.get(0));
                        for (int i = 1; i < values.size(); i++) {
                            connection.addRequestProperty(header.getKey(), values.get(i));
                        }
                    }
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    if (body != null && !"GET".equals(method) && !"HEAD".equals(method)) {
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(body.length);
                        try (OutputStream output = connection.getOutputStream()) {
                            output.write(body);
                        }
                    }
                    int status = connection.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = connection.getHeaderField("Location");
                        if (location == null) throw new IOException("Extractor redirect has no destination");
                        url = new URL(url, location);
                        if (status == 303 || ((status == 301 || status == 302) && "POST".equals(method))) {
                            method = "GET";
                            body = null;
                        }
                        continue;
                    }
                    if (status == 429) throw new IOException("YouTube returned HTTP 429");
                    String text = "";
                    if (!"HEAD".equals(method)) {
                        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                        if (input != null) {
                            try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                                byte[] buffer = new byte[16384];
                                int count;
                                while ((count = stream.read(buffer)) != -1) {
                                    if (output.size() + count > 16 * 1024 * 1024) {
                                        throw new IOException("Extractor response exceeds 16 MB");
                                    }
                                    output.write(buffer, 0, count);
                                }
                                text = output.toString("UTF-8");
                            }
                        }
                    }
                    return new Response(status, connection.getResponseMessage(),
                            connection.getHeaderFields(), text, url.toString());
                } finally {
                    connection.disconnect();
                }
            }
            throw new IOException("Too many extractor redirects");
        }
    }
}
