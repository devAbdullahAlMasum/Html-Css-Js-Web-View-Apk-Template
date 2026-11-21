package app.orbit.music;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.Executors;

/** Foreground media service owning Orbit playback, queue state, and download commands. */
public final class OrbitPlaybackService extends Service {
    public static final String ACTION_COMMAND = "app.orbit.music.action.COMMAND";
    public static final String ACTION_RESPONSE = "app.orbit.music.action.RESPONSE";
    public static final String ACTION_EVENT = "app.orbit.music.action.EVENT";
    public static final String INTERNAL_PERMISSION = "app.orbit.music.permission.INTERNAL";
    public static final String EXTRA_METHOD = "method";
    public static final String EXTRA_PAYLOAD = "payload";
    public static final String EXTRA_REQUEST_ID = "requestId";
    public static final String EXTRA_RESULT = "result";
    public static final String EXTRA_EVENT = "event";

    private static final String TAG = "OrbitPlayback";
    private static final String CHANNEL_ID = "orbit_playback";
    private static final int NOTIFICATION_ID = 4101;
    private static final String PREFS = "orbit_playback";
    private static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 10) Orbit/1.0";
    private static final Random RANDOM = new Random();

    private static volatile OrbitPlaybackService instance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService lookupWorker = Executors.newSingleThreadExecutor();
    private final ArrayList<JSONObject> queue = new ArrayList<JSONObject>();
    private final HashSet<String> shufflePlayed = new HashSet<String>();
    private final HashSet<String> pendingDownloadTokens = new HashSet<String>();
    private final ConcurrentHashMap<String, String> downloadTokens = new ConcurrentHashMap<String, String>();
    private AudioManager.OnAudioFocusChangeListener focusListener;
    private int audioFocusEpoch;
    private boolean audioFocusOwned;

    private MediaPlayer player;
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private Object audioFocusRequest;
    private boolean resumeAfterFocusGain;
    private int currentIndex = -1;
    private boolean playing;
    private boolean loading;
    private boolean playerPrepared;
    private boolean shuffle;
    private String repeatMode = "off";
    private String playbackError = "";
    private int generation;
    private volatile boolean destroyed;
    private boolean foregroundStarted;
    private int lastStartId;
    private Runnable sleepRunnable;
    private long sleepEndsAt;
    private long sleepDeadline;
    private int sleepMinutes;
    private final AtomicInteger pendingDownloadOperations = new AtomicInteger();

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                pauseInternal(false);
                updateMediaState();
                publishState();
            }
        }
    };

    public static void sendCommand(Context context, String method, JSONObject payload, String requestId) {
        Intent command = new Intent(context, OrbitPlaybackService.class);
        command.setAction(ACTION_COMMAND);
        command.putExtra(EXTRA_METHOD, method);
        command.putExtra(EXTRA_PAYLOAD, payload == null ? "{}" : payload.toString());
        command.putExtra(EXTRA_REQUEST_ID, requestId == null ? "" : requestId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(command);
        } else {
            context.startService(command);
        }
    }

    public static JSONObject stateSnapshot(Context context) {
        OrbitPlaybackService service = instance;
        if (service == null || service.destroyed) return persistedState(context);
        if (Looper.myLooper() == Looper.getMainLooper()) {
            service.expireSleepTimerIfNeeded();
            return service.snapshot();
        }
        FutureTask<JSONObject> task = new FutureTask<JSONObject>(new Callable<JSONObject>() {
            @Override
            public JSONObject call() throws Exception {
                if (service.destroyed) return persistedState(context);
                service.expireSleepTimerIfNeeded();
                return new JSONObject(service.snapshot().toString());
            }
        });
        service.mainHandler.post(task);
        try {
            return task.get(2L, TimeUnit.SECONDS);
        } catch (Exception ignored) {
            task.cancel(false);
            return persistedState(context);
        }
    }

    static boolean isDownloadActive(String id, String token) {
        OrbitPlaybackService service = instance;
        if (service == null || service.destroyed || token == null || token.isEmpty()) return false;
        synchronized (service.downloadTokens) {
            return token.equals(service.downloadTokens.get(id));
        }
    }

    static boolean dispatchMediaButton(final android.view.KeyEvent event) {
        final OrbitPlaybackService service = instance;
        if (service == null || service.destroyed || event == null) return false;
        service.mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!service.destroyed) service.handleMediaButtonKey(event);
            }
        });
        return true;
    }

    private static JSONObject persistedState(Context context) {
        JSONObject state = emptyState();
        try {
            android.content.SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray stored = new JSONArray(preferences.getString("queue", "[]"));
            JSONArray tracks = new JSONArray();
            for (int i = 0; i < Math.min(stored.length(), 500); i++) {
                JSONObject item = stored.optJSONObject(i);
                if (item != null) tracks.put(OrbitTrack.fromJson(context, item));
            }
            int index = tracks.length() == 0 ? -1
                    : clamp(preferences.getInt("index", 0), 0, tracks.length() - 1);
            JSONObject current = tracks.optJSONObject(index);
            state.put("queue", tracks);
            state.put("index", index);
            state.put("track", current == null ? JSONObject.NULL : current);
            state.put("duration", current == null ? 0L : current.optLong("duration", 0L));
            state.put("shuffle", preferences.getBoolean("shuffle", false));
            state.put("repeat", normalizeRepeat(preferences.getString("repeat", "off")));
        } catch (Exception ignored) {
        }
        return state;
    }

    public static JSONObject emptyState() {
        try {
            JSONObject state = new JSONObject();
            state.put("type", "playback");
            state.put("track", JSONObject.NULL);
            state.put("queue", new JSONArray());
            state.put("index", -1);
            state.put("playing", false);
            state.put("loading", false);
            state.put("position", 0L);
            state.put("duration", 0L);
            state.put("shuffle", false);
            state.put("repeat", "off");
            state.put("sleepEndsAt", 0L);
            state.put("sleepMinutes", 0);
            return state;
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createNotificationChannel();
        createMediaSession();
        IntentFilter noisyFilter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(noisyReceiver, noisyFilter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(noisyReceiver, noisyFilter);
        }
        loadPersistedQueue();
        // Starting the foreground service must post a notification promptly.
        startForegroundCompat(buildNotification());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        if (!foregroundStarted) startForegroundCompat(buildNotification());
        if (intent == null) {
            maybeStopIfIdle();
            return START_NOT_STICKY;
        }
        if (Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) {
            handleMediaButtonIntent(intent);
            maybeStopIfIdle();
            return START_NOT_STICKY;
        }
        if (!ACTION_COMMAND.equals(intent.getAction())) {
            maybeStopIfIdle();
            return START_NOT_STICKY;
        }

        String method = intent.getStringExtra(EXTRA_METHOD);
        String requestId = intent.getStringExtra(EXTRA_REQUEST_ID);
        JSONObject payload;
        try {
            payload = new JSONObject(intent.getStringExtra(EXTRA_PAYLOAD));
        } catch (Exception error) {
            replyError(requestId, "Invalid native request payload");
            maybeStopIfIdle();
            return START_NOT_STICKY;
        }

        try {
            handleCommand(method, payload, requestId);
        } catch (Throwable error) {
            Log.e(TAG, "Native command failed", error);
            replyError(requestId, error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
        } finally {
            maybeStopIfIdle();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        generation++;
        instance = null;
        cancelSleepTimer();
        releasePlayer();
        try {
            unregisterReceiver(noisyReceiver);
        } catch (Exception ignored) {
        }
        abandonAudioFocus();
        if (mediaSession != null) {
            mediaSession.setCallback(null);
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        downloadTokens.clear();
        synchronized (pendingDownloadTokens) {
            pendingDownloadTokens.clear();
        }
        pendingDownloadOperations.set(0);
        worker.shutdownNow();
        lookupWorker.shutdownNow();
        stopForegroundCompat();
        super.onDestroy();
    }

    private void handleCommand(String method, JSONObject payload, String requestId) throws JSONException {
        if ("play".equals(method)) {
            ArrayList<JSONObject> replacement = parseQueue(payload.optJSONArray("queue"));
            if (replacement.isEmpty()) throw new JSONException("Playback queue is empty");
            queue.clear();
            queue.addAll(replacement);
            currentIndex = clamp(payload.optInt("index", 0), 0, queue.size() - 1);
            shuffle = payload.optBoolean("shuffle", false);
            repeatMode = normalizeRepeat(payload.optString("repeat", "off"));
            shufflePlayed.clear();
            persistQueue();
            startCurrent(true);
            reply(requestId, ok());
        } else if ("control".equals(method)) {
            control(payload.optString("action", ""), payload.opt("value"));
            reply(requestId, ok());
        } else if ("queue".equals(method)) {
            replaceQueue(payload.optJSONArray("queue"), payload.optInt("index", currentIndex));
            reply(requestId, ok());
        } else if ("enqueue".equals(method)) {
            enqueue(OrbitTrack.fromJson(this, payload.getJSONObject("track")),
                    payload.optBoolean("next", false));
            reply(requestId, ok());
        } else if ("download".equals(method)) {
            JSONObject track = OrbitTrack.fromJson(this, payload.getJSONObject("track"));
            reply(requestId, queueDownload(track));
        } else if ("removeDownload".equals(method)) {
            removeDownload(payload.getString("id"));
            reply(requestId, ok());
        } else if ("rename".equals(method)) {
            renameTrack(payload.getString("id"), payload.getString("title"));
            reply(requestId, ok());
        } else if ("state".equals(method)) {
            reply(requestId, snapshot());
        } else {
            replyError(requestId, "Unsupported native method: " + method);
        }
    }

    private ArrayList<JSONObject> parseQueue(JSONArray input) throws JSONException {
        ArrayList<JSONObject> parsed = new ArrayList<JSONObject>();
        if (input == null) return parsed;
        if (input.length() > 500) throw new JSONException("Playback queue exceeds 500 tracks");
        HashSet<String> ids = new HashSet<String>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject item = input.optJSONObject(i);
            if (item != null) {
                JSONObject track = OrbitTrack.fromJson(this, item);
                if (!ids.add(track.optString("id"))) {
                    throw new JSONException("Playback queue contains a duplicate track");
                }
                parsed.add(track);
            }
        }
        return parsed;
    }

    private synchronized void replaceQueue(JSONArray input, int requestedIndex) throws JSONException {
        String oldId = currentTrack() == null ? "" : currentTrack().optString("id", "");
        boolean wasActive = playing || loading;
        boolean wasWaitingForFocus = resumeAfterFocusGain;
        ArrayList<JSONObject> replacement = parseQueue(input);
        queue.clear();
        queue.addAll(replacement);
        if (queue.isEmpty()) {
            currentIndex = -1;
            generation++;
            releasePlayer();
            resumeAfterFocusGain = false;
            abandonAudioFocus();
            playbackError = "";
            shufflePlayed.clear();
            persistQueue();
            updateMediaState();
            publishState();
            return;
        }

        int matching = -1;
        if (!oldId.isEmpty()) {
            for (int i = 0; i < queue.size(); i++) {
                if (oldId.equals(queue.get(i).optString("id", ""))) {
                    matching = i;
                    break;
                }
            }
        }
        if (matching >= 0) {
            currentIndex = matching;
            // Keep the active player when queue order changes around the same track.
        } else {
            currentIndex = clamp(requestedIndex, 0, queue.size() - 1);
            if (wasActive && !wasWaitingForFocus) startCurrent(true);
            else {
                generation++;
                releasePlayer();
                resumeAfterFocusGain = wasWaitingForFocus;
                if (!wasWaitingForFocus) abandonAudioFocus();
            }
        }
        persistQueue();
        updateMediaState();
        publishState();
    }

    private void enqueue(JSONObject track, boolean next) throws JSONException {
        if (queue.size() >= 500) throw new JSONException("Playback queue exceeds 500 tracks");
        for (JSONObject item : queue) {
            if (item.optString("id").equals(track.optString("id"))) {
                throw new JSONException("Playback queue contains a duplicate track");
            }
        }
        if (queue.isEmpty()) {
            queue.add(track);
            currentIndex = 0;
            persistQueue();
            startCurrent(true);
            return;
        }
        int insertion = next ? Math.min(currentIndex + 1, queue.size()) : queue.size();
        queue.add(insertion, track);
        persistQueue();
        publishState();
    }

    private void control(String action, Object value) {
        if (destroyed) return;
        if ("toggle".equals(action)) {
            if (loading) {
                cancelLoading();
            } else if (playerPrepared && playing) {
                pauseInternal(false);
            } else if (playerPrepared) {
                resumeInternal();
            } else if (currentTrack() != null) {
                startCurrent(true);
            }
        } else if ("pause".equals(action)) {
            if (loading) cancelLoading();
            else pauseInternal(false);
        } else if ("resume".equals(action)) {
            if (!loading && playerPrepared) resumeInternal();
            else if (!loading && currentTrack() != null) startCurrent(true);
        } else if ("next".equals(action)) {
            advance(1, shuffle);
        } else if ("previous".equals(action)) {
            if (playerPrepared && player != null) {
                try {
                    if (player.getCurrentPosition() > 3000) {
                        player.seekTo(0);
                    } else {
                        advance(-1, false);
                    }
                } catch (IllegalStateException ignored) {
                    advance(-1, false);
                }
            } else {
                advance(-1, false);
            }
        } else if ("seek".equals(action)) {
            if (playerPrepared && player != null && value != null) {
                try {
                    double requested = Double.parseDouble(String.valueOf(value));
                    long seconds = (long) Math.max(0d, requested);
                    player.seekTo((int) Math.min(Integer.MAX_VALUE, seconds * 1000L));
                } catch (Exception ignored) {
                }
            }
        } else if ("shuffle".equals(action)) {
            shuffle = value != null && Boolean.parseBoolean(String.valueOf(value));
            shufflePlayed.clear();
            if (currentTrack() != null) shufflePlayed.add(currentTrack().optString("id"));
            persistQueue();
        } else if ("repeat".equals(action)) {
            repeatMode = normalizeRepeat(value == null ? "off" : String.valueOf(value));
            persistQueue();
        } else if ("sleep".equals(action)) {
            try {
                int minutes = value == null ? 0 : Integer.parseInt(String.valueOf(value));
                setSleepTimer(minutes);
            } catch (NumberFormatException ignored) {
                setSleepTimer(0);
            }
        } else if ("stop".equals(action)) {
            pauseInternal(false);
            cancelSleepTimer();
            generation++;
            releasePlayer();
        }
        updateMediaState();
        publishState();
        maybeStopIfIdle();
    }

    private void cancelLoading() {
        generation++;
        releasePlayer();
        resumeAfterFocusGain = false;
        abandonAudioFocus();
        playbackError = "";
    }

    private void startCurrent(boolean requestFocus) {
        if (destroyed || currentIndex < 0 || currentIndex >= queue.size()) return;
        if (expireSleepTimerIfNeeded()) {
            cancelLoading();
            updateMediaState();
            publishState();
            maybeStopIfIdle();
            return;
        }
        resumeAfterFocusGain = false;
        if (!foregroundStarted) startForegroundCompat(buildNotification());
        final int requestGeneration = ++generation;
        final JSONObject track = queue.get(currentIndex);
        shufflePlayed.add(track.optString("id"));
        releasePlayer();
        loading = true;
        playing = false;
        playbackError = "";
        updateMediaState();
        publishState();

        final String trackId = track.optString("id", "");
        lookupWorker.execute(new Runnable() {
            @Override
            public void run() {
                final String localUri = OrbitDownloadStore.completeLocalUri(OrbitPlaybackService.this, trackId);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (!isCurrentRequest(requestGeneration, track)) return;
                        resolveCurrentSource(currentTrack(), localUri, requestGeneration, requestFocus);
                    }
                });
            }
        });
    }

    private void resolveCurrentSource(final JSONObject track, String localUri,
                                       final int requestGeneration, final boolean requestFocus) {
        if (!isCurrentRequest(requestGeneration, track)) return;
        loading = true;
        boolean localAvailable = !localUri.isEmpty();
        if (localAvailable && localUri.startsWith("file://")) {
            String path = Uri.parse(localUri).getPath();
            localAvailable = path != null && new File(path).isFile();
        }
        if (localAvailable) {
            preparePlayer(track, localUri, requestGeneration, requestFocus, true);
            return;
        }

        String source = track.optString("source", "");
        if ("youtube".equals(source)) {
            final String initialTitle = track.optString("title", "");
            final String initialOriginalTitle = track.optString("originalTitle", "");
            OrbitYouTube.resolveAsync(this, track, new OrbitYouTube.Callback() {
                @Override
                public void onSuccess(JSONObject result) {
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (!isCurrentRequest(requestGeneration, result)) return;
                            try {
                                JSONObject current = currentTrack();
                                if (!initialTitle.equals(current.optString("title", ""))
                                        || !initialOriginalTitle.equals(current.optString("originalTitle", ""))) {
                                    result.put("title", current.optString("title", ""));
                                    result.put("originalTitle", current.optString("originalTitle", ""));
                                }
                                queue.set(currentIndex, result);
                                persistQueue();
                                preparePlayer(result, result.getString("audioUrl"), requestGeneration, requestFocus);
                            } catch (JSONException error) {
                                failCurrent(error.getMessage());
                            }
                        }
                    });
                }

                @Override
                public void onError(final String message) {
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (!isCurrentRequest(requestGeneration, track)) return;
                            failCurrent(message);
                        }
                    });
                }
            });
        } else if ("demo".equals(source)) {
            preparePlayer(track, "asset:///" + track.optString("audioUrl", ""), requestGeneration, requestFocus);
        } else if ("local".equals(source)) {
            preparePlayer(track, track.optString("localUri", ""), requestGeneration, requestFocus);
        } else if ("direct".equals(source)) {
            preparePlayer(track, track.optString("audioUrl", ""), requestGeneration, requestFocus);
        } else {
            failCurrent("Unsupported track source");
        }
    }

    private boolean isCurrentRequest(int requestGeneration, JSONObject track) {
        return !destroyed && requestGeneration == generation && currentTrack() != null
                && currentTrack().optString("id", "").equals(track.optString("id", ""));
    }

    private void preparePlayer(JSONObject track, String source, int requestGeneration, boolean requestFocus) {
        preparePlayer(track, source, requestGeneration, requestFocus, false);
    }

    private void preparePlayer(JSONObject track, String source, int requestGeneration,
                               boolean requestFocus, boolean offlineSource) {
        if (destroyed || requestGeneration != generation) return;
        releasePlayer();
        loading = true;
        try {
            final MediaPlayer prepared = new MediaPlayer();
            player = prepared;
            prepared.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            prepared.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);

            if (source.startsWith("asset:///")) {
                String assetPath = source.substring("asset:///".length());
                try (android.content.res.AssetFileDescriptor descriptor = getAssets().openFd(assetPath)) {
                    prepared.setDataSource(descriptor.getFileDescriptor(),
                            descriptor.getStartOffset(), descriptor.getLength());
                }
            } else if (source.startsWith("content://") || source.startsWith("file://")) {
                prepared.setDataSource(this, Uri.parse(source));
            } else if (source.startsWith("https://")) {
                java.util.Map<String, String> headers = new java.util.HashMap<String, String>();
                headers.put("User-Agent", USER_AGENT);
                headers.put("Referer", "https://www.youtube.com/");
                prepared.setDataSource(source, headers);
            } else {
                throw new JSONException("Unsupported media URI");
            }

            prepared.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mediaPlayer) {
                    if (destroyed || requestGeneration != generation || player != mediaPlayer) return;
                    if (expireSleepTimerIfNeeded()) return;
                    if (requestFocus && !requestAudioFocus()) {
                        failCurrent("Audio focus is unavailable");
                        return;
                    }
                    try {
                        mediaPlayer.start();
                        playing = true;
                        loading = false;
                        playerPrepared = true;
                        playbackError = "";
                        if (mediaSession != null) mediaSession.setActive(true);
                        updateMediaState();
                        publishState();
                    } catch (Exception error) {
                        failCurrent(error.getMessage());
                    }
                }
            });
            prepared.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mediaPlayer) {
                    if (destroyed || requestGeneration != generation || player != mediaPlayer) return;
                    if (expireSleepTimerIfNeeded()) return;
                    playing = false;
                    loading = false;
                    if ("one".equals(repeatMode)) {
                        try {
                            mediaPlayer.seekTo(0);
                            mediaPlayer.start();
                            playing = true;
                            updateMediaState();
                            publishState();
                        } catch (Exception error) {
                            failCurrent(error.getMessage());
                        }
                    } else {
                        advance(1, shuffle);
                    }
                }
            });
            prepared.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer mediaPlayer, int what, int extra) {
                    if (!destroyed && requestGeneration == generation && player == mediaPlayer) {
                        if (offlineSource && !playerPrepared) {
                            releasePlayer();
                            resolveCurrentSource(currentTrack(), "", requestGeneration, requestFocus);
                        } else {
                            failCurrent("MediaPlayer error " + what + "/" + extra);
                        }
                    }
                    return true;
                }
            });
            prepared.prepareAsync();
            updateMediaState();
            publishState();
        } catch (Throwable error) {
            if (offlineSource && isCurrentRequest(requestGeneration, track)) {
                releasePlayer();
                resolveCurrentSource(currentTrack(), "", requestGeneration, requestFocus);
            } else {
                failCurrent(error.getMessage() == null ? "Could not prepare audio" : error.getMessage());
            }
        }
    }

    private void advance(int direction, boolean randomize) {
        if (destroyed || queue.isEmpty()) return;
        int next;
        if (randomize) {
            ArrayList<Integer> candidates = new ArrayList<Integer>();
            for (int i = 0; i < queue.size(); i++) {
                if (!shufflePlayed.contains(queue.get(i).optString("id"))) candidates.add(i);
            }
            if (candidates.isEmpty() && "all".equals(repeatMode)) {
                shufflePlayed.clear();
                for (int i = 0; i < queue.size(); i++) {
                    if (queue.size() == 1 || i != currentIndex) candidates.add(i);
                }
            }
            if (candidates.isEmpty()) {
                pauseInternal(false);
                updateMediaState();
                publishState();
                return;
            }
            next = candidates.get(RANDOM.nextInt(candidates.size()));
        } else {
            next = currentIndex + direction;
            if (next < 0) {
                if ("all".equals(repeatMode)) next = queue.size() - 1;
                else {
                    pauseInternal(false);
                    updateMediaState();
                    publishState();
                    return;
                }
            } else if (next >= queue.size()) {
                if ("all".equals(repeatMode)) next = 0;
                else {
                    pauseInternal(false);
                    updateMediaState();
                    publishState();
                    return;
                }
            }
        }
        currentIndex = next;
        persistQueue();
        startCurrent(true);
    }

    private void pauseInternal(boolean rememberResume) {
        boolean wasActive = playing || loading;
        if (loading) {
            generation++;
            releasePlayer();
        }
        if (player != null && playing) {
            try {
                player.pause();
            } catch (Exception ignored) {
            }
        }
        playing = false;
        resumeAfterFocusGain = rememberResume && (wasActive || resumeAfterFocusGain);
        if (!rememberResume) abandonAudioFocus();
        maybeStopIfIdle();
    }

    private void resumeInternal() {
        if (destroyed || player == null || !playerPrepared || expireSleepTimerIfNeeded()) return;
        resumeAfterFocusGain = false;
        if (!requestAudioFocus()) {
            failCurrent("Audio focus is unavailable");
            return;
        }
        try {
            player.start();
            playing = true;
            playbackError = "";
            updateMediaState();
            publishState();
        } catch (Exception error) {
            failCurrent(error.getMessage());
        }
    }

    private void releasePlayer() {
        if (player != null) {
            try {
                player.reset();
            } catch (Exception ignored) {
            }
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
        playing = false;
        loading = false;
        playerPrepared = false;
    }

    private void failCurrent(String message) {
        playbackError = message == null || message.isEmpty() ? "Playback failed" : message;
        generation++;
        releasePlayer();
        resumeAfterFocusGain = false;
        abandonAudioFocus();
        updateMediaState();
        publishState();
        maybeStopIfIdle();
    }

    private boolean requestAudioFocus() {
        if (audioManager == null) return false;
        abandonAudioFocus();
        final int requestEpoch = ++audioFocusEpoch;
        focusListener = new AudioManager.OnAudioFocusChangeListener() {
            @Override
            public void onAudioFocusChange(final int focusChange) {
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (!destroyed && audioFocusOwned && requestEpoch == audioFocusEpoch) {
                            handleAudioFocusChange(focusChange);
                        }
                    }
                });
            }
        };
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                audioFocusRequest = Api26Focus.create(this, focusListener);
            }
            result = Api26Focus.request(audioManager, audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(focusListener,
                    AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        audioFocusOwned = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        if (!audioFocusOwned) abandonAudioFocus();
        return audioFocusOwned;
    }

    private void abandonAudioFocus() {
        audioFocusEpoch++;
        audioFocusOwned = false;
        Object previousRequest = audioFocusRequest;
        AudioManager.OnAudioFocusChangeListener previousListener = focusListener;
        audioFocusRequest = null;
        focusListener = null;
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && previousRequest != null) {
            Api26Focus.abandon(audioManager, previousRequest);
        } else if (previousListener != null) {
            audioManager.abandonAudioFocus(previousListener);
        }
    }

    private void handleAudioFocusChange(int focusChange) {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
            resumeAfterFocusGain = false;
            pauseInternal(false);
        } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            pauseInternal(true);
        } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
            if (resumeAfterFocusGain) {
                resumeAfterFocusGain = false;
                if (playerPrepared) resumeInternal();
                else if (currentTrack() != null) startCurrent(true);
            }
        }
        updateMediaState();
        publishState();
    }

    private void setSleepTimer(int minutes) {
        cancelSleepTimer();
        int[] allowed = {15, 30, 60};
        boolean valid = false;
        for (int value : allowed) if (value == minutes) valid = true;
        if (!valid || minutes <= 0) return;
        sleepMinutes = minutes;
        sleepEndsAt = System.currentTimeMillis() + minutes * 60L * 1000L;
        sleepDeadline = SystemClock.elapsedRealtime() + minutes * 60L * 1000L;
        final long deadline = sleepDeadline;
        sleepRunnable = new Runnable() {
            @Override
            public void run() {
                if (destroyed || sleepDeadline != deadline) return;
                if (!expireSleepTimerIfNeeded()) {
                    mainHandler.postDelayed(this, Math.max(1L, deadline - SystemClock.elapsedRealtime()));
                }
            }
        };
        mainHandler.postDelayed(sleepRunnable, minutes * 60L * 1000L);
    }

    private void cancelSleepTimer() {
        sleepEndsAt = 0L;
        sleepDeadline = 0L;
        sleepMinutes = 0;
        if (sleepRunnable != null) {
            mainHandler.removeCallbacks(sleepRunnable);
            sleepRunnable = null;
        }
    }

    private boolean expireSleepTimerIfNeeded() {
        if (sleepRunnable == null || sleepDeadline <= 0L
                || SystemClock.elapsedRealtime() < sleepDeadline) return false;
        pauseInternal(false);
        cancelSleepTimer();
        updateMediaState();
        publishState();
        maybeStopIfIdle();
        return true;
    }

    private JSONObject queueDownload(final JSONObject track) throws JSONException {
        final String id = track.getString("id");
        JSONObject existing = OrbitDownloadStore.getRefreshed(this, id);
        if (existing != null) {
            String status = existing.optString("status");
            if ("complete".equals(status) || "queued".equals(status)
                    || "downloading".equals(status) || "paused".equals(status)) {
                publishDownload(existing);
                return existing;
            }
            long oldManagerId = existing.optLong("downloadManagerId", -1L);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null && oldManagerId >= 0L) manager.remove(oldManagerId);
            OrbitDownloadStore.deleteOwnedFile(this, existing);
        }
        final String token = UUID.randomUUID().toString().replace("-", "");
        final JSONObject record = new JSONObject();
        record.put("id", id);
        record.put("track", track);
        record.put("status", "queued");
        record.put("jobToken", token);
        setDownloadToken(id, token);
        try {
            OrbitDownloadStore.put(this, record);
        } catch (JSONException error) {
            removeDownloadToken(id, token);
            throw error;
        } catch (RuntimeException error) {
            removeDownloadToken(id, token);
            throw error;
        }
        beginDownloadOperation(token);
        publishDownload(record);

        final String source = track.optString("source", "");
        if ("youtube".equals(source)) {
            try {
                OrbitYouTube.resolveAsync(this, track, new OrbitYouTube.Callback() {
                    @Override
                    public void onSuccess(final JSONObject resolved) {
                        scheduleDownload(id, token, resolved, "youtube");
                    }

                    @Override
                    public void onError(final String message) {
                        failDownload(id, token, message);
                        finishDownloadOperation(id, token);
                    }
                });
            } catch (Throwable error) {
                failDownload(id, token, error.getMessage());
                finishDownloadOperation(id, token);
            }
        } else {
            scheduleDownload(id, token, track, source);
        }
        return record;
    }

    private void scheduleDownload(final String id, final String token,
                                  final JSONObject track, final String source) {
        try {
            worker.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (!isDownloadActive(id, token)) return;
                        if ("youtube".equals(source) || "direct".equals(source)) {
                            enqueueResolvedDownload(id, token, track);
                        } else {
                            copyLocalDownload(id, token, track, source);
                        }
                    } catch (Throwable error) {
                        failDownload(id, token, error.getMessage());
                    } finally {
                        finishDownloadOperation(id, token);
                    }
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException error) {
            failDownload(id, token, "Download preparation was interrupted");
            finishDownloadOperation(id, token);
        }
    }

    private void setDownloadToken(String id, String token) {
        synchronized (downloadTokens) {
            downloadTokens.put(id, token);
        }
    }

    private void removeDownloadToken(String id, String token) {
        synchronized (downloadTokens) {
            String active = downloadTokens.get(id);
            if (token == null || token.equals(active)) downloadTokens.remove(id);
        }
    }

    private void beginDownloadOperation(String token) {
        synchronized (pendingDownloadTokens) {
            if (pendingDownloadTokens.add(token)) pendingDownloadOperations.incrementAndGet();
        }
    }

    private void finishDownloadOperation(String id, String token) {
        boolean counted = false;
        synchronized (pendingDownloadTokens) {
            counted = pendingDownloadTokens.remove(token);
        }
        if (counted) pendingDownloadOperations.decrementAndGet();
        removeDownloadToken(id, token);
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                maybeStopIfIdle();
            }
        });
    }

    private void enqueueResolvedDownload(String id, String token, JSONObject track) throws Exception {
        String audioUrl = track.getString("audioUrl");
        preflightDownload(audioUrl);
        DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) throw new IllegalStateException("DownloadManager is unavailable");
        File musicRoot = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (musicRoot == null) throw new IllegalStateException("App-scoped music storage is unavailable");
        String extension = resolvedDownloadExtension(track);
        String mimeType = resolvedDownloadMimeType(track, extension);
        String fileName = safeFileName(id) + "-" + token + "." + extension;
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(audioUrl));
        request.setTitle(track.optString("title", "Orbit download"));
        request.setDescription("Saving to Orbit music");
        request.setMimeType(mimeType);
        request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.addRequestHeader("User-Agent", USER_AGENT);
        request.addRequestHeader("Referer", "https://www.youtube.com/");
        request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_MUSIC,
                "orbit/" + fileName);

        File directory = new File(musicRoot, "orbit");
        if (!directory.exists()) directory.mkdirs();
        File destination = new File(directory, fileName);
        JSONObject persistedTrack = OrbitTrack.copy(track);
        if ("youtube".equals(persistedTrack.optString("source", ""))) {
            persistedTrack.remove("audioUrl");
        }
        synchronized (OrbitDownloadStore.class) {
            if (!isDownloadActive(id, token)) return;
            JSONObject current = OrbitDownloadStore.get(this, id);
            if (current == null || !token.equals(current.optString("jobToken"))) return;
            long managerId = manager.enqueue(request);
            try {
                JSONObject updates = new JSONObject();
                updates.put("track", persistedTrack);
                updates.put("status", "queued");
                updates.put("downloadManagerId", managerId);
                updates.put("localUri", Uri.fromFile(destination).toString());
                JSONObject record = OrbitDownloadStore.updateIfToken(this, id, token, updates);
                if (record == null) manager.remove(managerId);
                else publishDownload(record);
            } catch (Exception error) {
                manager.remove(managerId);
                throw error;
            }
        }
    }

    private static String resolvedDownloadExtension(JSONObject track) {
        String metadata = track.optString("audioExtension", "").trim().toLowerCase(Locale.US);
        if (!metadata.isEmpty()) {
            if ("m4a".equals(metadata) || "mp3".equals(metadata)) return metadata;
            throw new IllegalStateException("Download format must be M4A or MP3");
        }

        String path = Uri.parse(track.optString("audioUrl", "")).getPath();
        String lower = path == null ? "" : path.toLowerCase(Locale.US);
        if (lower.endsWith(".m4a")) return "m4a";
        if (lower.endsWith(".mp3")) return "mp3";
        throw new IllegalStateException("Download format must be M4A or MP3");
    }

    private static String resolvedDownloadMimeType(JSONObject track, String extension) {
        String metadata = track.optString("audioMimeType", "").trim().toLowerCase(Locale.US);
        if ("m4a".equals(extension)) {
            if ("audio/mp4".equals(metadata) || "audio/x-m4a".equals(metadata)) return metadata;
            return "audio/mp4";
        }
        if ("audio/mpeg".equals(metadata) || "audio/mp3".equals(metadata)) return metadata;
        return "audio/mpeg";
    }

    private void preflightDownload(String url) throws Exception {
        URL destination = new URL(url);
        for (int redirects = 0; redirects <= 5; redirects++) {
            if (!"https".equalsIgnoreCase(destination.getProtocol())) {
                throw new IllegalStateException("Audio downloads must use HTTPS");
            }
            HttpURLConnection connection = (HttpURLConnection) destination.openConnection();
            try {
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("User-Agent", USER_AGENT);
                connection.setRequestProperty("Referer", "https://www.youtube.com/");
                connection.setRequestProperty("Range", "bytes=0-0");
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IllegalStateException("Download redirect has no destination");
                    destination = new URL(destination, location);
                    continue;
                }
                if (code == 429) {
                    throw new IllegalStateException(
                            "YouTube returned HTTP 429. Wait before retrying this download.");
                }
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("Download preflight failed with HTTP " + code);
                }
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new IllegalStateException("Too many download redirects");
    }

    private void copyLocalDownload(String id, String token, JSONObject track, String source) throws Exception {
        JSONObject updates = new JSONObject();
        updates.put("status", "downloading");
        updates.put("progress", 0);
        updates.put("downloadedBytes", 0L);
        File directory = new File(getFilesDir(), "downloads");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("App download storage is unavailable");
        }
        String extension = localDownloadExtension(track, source);
        File destination = new File(directory, safeFileName(id) + "-" + token + "." + extension);
        File temporary = new File(directory, destination.getName() + ".part");
        if (temporary.exists() && !temporary.delete()) {
            throw new IllegalStateException("Could not replace an interrupted download");
        }
        updates.put("localUri", Uri.fromFile(destination).toString());
        long total = localSourceLength(track, source);
        if (total > 0L) updates.put("totalBytes", total);

        JSONObject record;
        synchronized (OrbitDownloadStore.class) {
            if (!isDownloadActive(id, token)) return;
            record = OrbitDownloadStore.updateIfToken(this, id, token, updates);
            if (record == null) return;
            publishDownload(record);
        }

        boolean completed = false;
        long downloaded = 0L;
        long lastPublished = 0L;
        try {
            InputStream sourceStream = "demo".equals(source)
                    ? getAssets().open(track.optString("audioUrl", ""))
                    : getContentResolver().openInputStream(Uri.parse(track.getString("localUri")));
            if (sourceStream == null) throw new IllegalStateException("Could not open source audio");
            try (InputStream input = sourceStream;
                 OutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[32 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (!isDownloadActive(id, token) || Thread.currentThread().isInterrupted()) return;
                    output.write(buffer, 0, count);
                    downloaded += count;
                    if (downloaded - lastPublished >= 256L * 1024L) {
                        updateLocalDownloadProgress(id, token, downloaded, total);
                        lastPublished = downloaded;
                    }
                }
                output.flush();
            }

            if (!isDownloadActive(id, token)) return;
            if (destination.exists() && !destination.delete()) {
                throw new IllegalStateException("Could not replace existing download file");
            }
            if (!temporary.renameTo(destination)) {
                throw new IllegalStateException("Could not finalize download file");
            }

            synchronized (OrbitDownloadStore.class) {
                if (!isDownloadActive(id, token)) return;
                updates.put("status", "complete");
                updates.put("progress", 100);
                updates.put("downloadedBytes", downloaded);
                if (total > 0L) updates.put("totalBytes", total);
                record = OrbitDownloadStore.updateIfToken(this, id, token, updates);
                if (record != null) {
                    completed = true;
                    publishDownload(record);
                }
            }
        } finally {
            if (temporary.exists()) temporary.delete();
            if (!completed && destination.exists()) destination.delete();
        }
    }

    private void updateLocalDownloadProgress(String id, String token, long downloaded, long total) {
        try {
            JSONObject updates = new JSONObject();
            updates.put("status", "downloading");
            updates.put("downloadedBytes", downloaded);
            if (total > 0L) {
                updates.put("totalBytes", total);
                updates.put("progress", (int) Math.max(0L,
                        Math.min(100L, downloaded * 100L / total)));
            }
            synchronized (OrbitDownloadStore.class) {
                JSONObject record = OrbitDownloadStore.updateIfToken(this, id, token, updates);
                if (record != null) publishDownload(record);
            }
        } catch (JSONException ignored) {
        }
    }

    private String localDownloadExtension(JSONObject track, String source) {
        if ("demo".equals(source)) return "wav";
        Uri uri = Uri.parse(track.optString("localUri", ""));
        String path = uri.getPath();
        if (path != null) {
            int slash = path.lastIndexOf('/');
            String name = slash >= 0 ? path.substring(slash + 1) : path;
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String extension = name.substring(dot + 1).toLowerCase(Locale.US);
                if (extension.matches("[a-z0-9]{1,5}")) return extension;
            }
        }
        try {
            String mime = getContentResolver().getType(uri);
            if ("audio/mpeg".equals(mime) || "audio/mp3".equals(mime)) return "mp3";
            if ("audio/mp4".equals(mime) || "audio/x-m4a".equals(mime)) return "m4a";
            if ("audio/wav".equals(mime) || "audio/x-wav".equals(mime)) return "wav";
            if ("audio/ogg".equals(mime)) return "ogg";
            if ("audio/aac".equals(mime)) return "aac";
            if ("audio/flac".equals(mime)) return "flac";
        } catch (Exception ignored) {
        }
        return "audio";
    }

    private long localSourceLength(JSONObject track, String source) {
        try {
            if ("demo".equals(source)) {
                android.content.res.AssetFileDescriptor descriptor =
                        getAssets().openFd(track.optString("audioUrl", ""));
                try {
                    return descriptor.getLength();
                } finally {
                    descriptor.close();
                }
            }
            Uri uri = Uri.parse(track.getString("localUri"));
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                String path = uri.getPath();
                return path == null ? -1L : new File(path).length();
            }
            android.content.res.AssetFileDescriptor descriptor =
                    getContentResolver().openAssetFileDescriptor(uri, "r");
            if (descriptor == null) return -1L;
            try {
                return descriptor.getLength();
            } finally {
                descriptor.close();
            }
        } catch (Exception ignored) {
            return -1L;
        }
    }

    private void removeDownload(String id) throws JSONException {
        removeDownloadToken(id, null);
        JSONObject record = OrbitDownloadStore.removeAndGet(this, id);
        if (record == null) throw new JSONException("Download not found");
        long managerId = record.optLong("downloadManagerId", -1L);
        if (managerId >= 0L) {
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) manager.remove(managerId);
        }
        OrbitDownloadStore.deleteOwnedFile(this, record);
        JSONObject event = new JSONObject();
        event.put("type", "download");
        event.put("id", id);
        event.put("track", record.optJSONObject("track") == null
                ? JSONObject.NULL : record.optJSONObject("track"));
        event.put("status", "removed");
        event.put("error", "Removed");
        emitEvent(event);
    }

    private void failDownload(String id, String token, String message) {
        try {
            JSONObject updates = new JSONObject();
            updates.put("status", "failed");
            updates.put("error", message == null || message.isEmpty() ? "Download failed" : message);
            synchronized (OrbitDownloadStore.class) {
                JSONObject record = OrbitDownloadStore.updateIfToken(this, id, token, updates);
                if (record != null) publishDownload(record);
            }
        } catch (JSONException ignored) {
        }
    }

    private void renameTrack(String id, String title) throws JSONException {
        String cleanTitle = title == null ? "" : title.trim();
        if (cleanTitle.isEmpty()) throw new JSONException("Title is empty");
        if (cleanTitle.length() > 140) cleanTitle = cleanTitle.substring(0, 140);
        for (int i = 0; i < queue.size(); i++) {
            JSONObject track = queue.get(i);
            if (id.equals(track.optString("id", ""))) {
                if (!track.has("originalTitle")) track.put("originalTitle", track.optString("title", ""));
                track.put("title", cleanTitle);
            }
        }
        OrbitDownloadStore.renameTrack(this, id, cleanTitle);
        persistQueue();
        updateMediaState();
        publishState();
    }

    private JSONObject currentTrack() {
        if (currentIndex < 0 || currentIndex >= queue.size()) return null;
        return queue.get(currentIndex);
    }

    private synchronized JSONObject snapshot() {
        JSONObject state = new JSONObject();
        try {
            JSONObject current = currentTrack();
            state.put("type", "playback");
            state.put("track", current == null ? JSONObject.NULL : current);
            state.put("queue", queueJson());
            state.put("index", currentIndex);
            state.put("playing", playing);
            state.put("loading", loading);
            long position = 0L;
            long duration = 0L;
            if (player != null && playerPrepared) {
                try {
                    position = Math.max(0L, player.getCurrentPosition() / 1000L);
                    if (player.getDuration() > 0) duration = player.getDuration() / 1000L;
                } catch (IllegalStateException ignored) {
                }
            }
            state.put("position", position);
            if (duration == 0L && current != null) {
                duration = Math.max(0L, current.optLong("duration", 0L));
            }
            state.put("duration", duration);
            state.put("shuffle", shuffle);
            state.put("repeat", repeatMode);
            state.put("sleepEndsAt", sleepEndsAt);
            state.put("sleepMinutes", sleepMinutes);
            if (!playbackError.isEmpty()) state.put("error", playbackError);
        } catch (JSONException ignored) {
        }
        return state;
    }

    private JSONArray queueJson() {
        JSONArray items = new JSONArray();
        for (JSONObject track : queue) items.put(track);
        return items;
    }

    private void publishState() {
        emitEvent(snapshot());
    }

    private void publishDownload(JSONObject record) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "download");
            event.put("id", record.optString("id"));
            JSONObject track = record.optJSONObject("track");
            event.put("track", track == null ? JSONObject.NULL : track);
            if (track != null) {
                String[] fields = {"title", "originalTitle", "artist", "source",
                        "videoId", "duration", "artworkUrl"};
                for (String field : fields) {
                    if (track.has(field)) event.put(field, track.get(field));
                }
            }
            event.put("status", record.optString("status", "queued"));
            event.put("progress", record.optInt("progress", 0));
            if (record.has("downloadedBytes")) {
                event.put("downloadedBytes", record.optLong("downloadedBytes", 0L));
            }
            if (record.has("totalBytes")) {
                event.put("totalBytes", record.optLong("totalBytes", 0L));
            }
            if (!record.optString("localUri", "").isEmpty()) {
                event.put("localUri", record.optString("localUri"));
            }
            if (!record.optString("error", "").isEmpty()) {
                event.put("error", record.optString("error"));
            }
            emitEvent(event);
        } catch (JSONException ignored) {
        }
    }

    private void emitEvent(JSONObject event) {
        if (destroyed) return;
        Intent intent = new Intent(ACTION_EVENT);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_EVENT, event.toString());
        sendBroadcast(intent, INTERNAL_PERMISSION);
    }

    private void reply(String requestId, JSONObject result) {
        if (requestId == null || requestId.isEmpty()) return;
        Intent intent = new Intent(ACTION_RESPONSE);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_REQUEST_ID, requestId);
        intent.putExtra(EXTRA_RESULT, result.toString());
        sendBroadcast(intent, INTERNAL_PERMISSION);
    }

    private void replyError(String requestId, String message) {
        try {
            JSONObject result = new JSONObject();
            result.put("error", message == null || message.isEmpty() ? "Native request failed" : message);
            reply(requestId, result);
        } catch (JSONException ignored) {
        }
    }

    private JSONObject ok() {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            return result;
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    private void createMediaSession() {
        mediaSession = new MediaSession(this, "OrbitPlayback");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                control("resume", null);
            }

            @Override
            public void onPause() {
                control("pause", null);
            }

            @Override
            public void onStop() {
                control("stop", null);
            }

            @Override
            public void onSkipToNext() {
                advance(1, shuffle);
            }

            @Override
            public void onSkipToPrevious() {
                advance(-1, false);
            }

            @Override
            public void onSeekTo(long position) {
                control("seek", Math.max(0L, position) / 1000d);
            }

            @Override
            public boolean onMediaButtonEvent(Intent intent) {
                return handleMediaButtonIntent(intent);
            }
        });
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setMediaButtonReceiver(mediaButtonPendingIntent());
        Intent open = new Intent(this, MainActivity.class);
        mediaSession.setSessionActivity(PendingIntent.getActivity(this, 0, open,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    private PendingIntent mediaButtonPendingIntent() {
        Intent intent = new Intent(this, OrbitMediaButtonReceiver.class);
        intent.setAction(Intent.ACTION_MEDIA_BUTTON);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ must mutate this PendingIntent to inject EXTRA_KEY_EVENT.
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getBroadcast(this, 4102, intent, flags);
    }

    private void updateMediaState() {
        if (mediaSession == null) return;
        JSONObject track = currentTrack();
        String title = track == null ? "Orbit" : track.optString("title", "Orbit");
        String artist = track == null ? "" : track.optString("artist", "");
        long duration = track == null ? 0L : Math.max(0L, track.optLong("duration", 0L)) * 1000L;

        android.media.MediaMetadata metadata = new android.media.MediaMetadata.Builder()
                .putString(android.media.MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(android.media.MediaMetadata.METADATA_KEY_ALBUM, "Orbit")
                .putLong(android.media.MediaMetadata.METADATA_KEY_DURATION, duration)
                .build();
        mediaSession.setMetadata(metadata);

        int state = PlaybackState.STATE_STOPPED;
        if (loading) state = PlaybackState.STATE_BUFFERING;
        else if (playing) state = PlaybackState.STATE_PLAYING;
        else if (player != null) state = PlaybackState.STATE_PAUSED;
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_STOP;
        long position = 0L;
        if (player != null && playerPrepared) {
            try {
                position = Math.max(0L, player.getCurrentPosition());
            } catch (IllegalStateException ignored) {
            }
        }
        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, position, 1.0f)
                .build());
        updateNotification(title, artist);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Orbit playback",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Music playback and download controls");
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        JSONObject track = currentTrack();
        String title = track == null ? "Orbit" : track.optString("title", "Orbit");
        String artist = track == null ? "" : track.optString("artist", "");
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_orbit)
                .setContentTitle(title)
                .setContentText(artist)
                .setSubText("Orbit")
                .setOngoing(playing || loading)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class),
                        Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));

        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_previous, "Previous",
                servicePendingIntent("previous", 1)).build());
        builder.addAction(new Notification.Action.Builder(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play",
                servicePendingIntent(playing ? "pause" : "resume", 2)).build());
        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_next, "Next",
                servicePendingIntent("next", 3)).build());
        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_stop, "Stop",
                servicePendingIntent("stop", 4)).build());
        if (mediaSession != null) {
            builder.setStyle(new Notification.MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }
        return builder.build();
    }

    private void updateNotification(String title, String artist) {
        if (destroyed || !foregroundStarted) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception ignored) {
        }
    }

    private PendingIntent servicePendingIntent(String action, int requestCode) {
        Intent intent = new Intent(this, OrbitPlaybackService.class);
        intent.setAction(ACTION_COMMAND);
        intent.putExtra(EXTRA_METHOD, "control");
        JSONObject payload = new JSONObject();
        try {
            payload.put("action", action);
        } catch (JSONException ignored) {
        }
        intent.putExtra(EXTRA_PAYLOAD, payload.toString());
        intent.putExtra(EXTRA_REQUEST_ID, "");
        return PendingIntent.getService(this, requestCode, intent,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT
                        | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        foregroundStarted = true;
    }

    private void stopForegroundCompat() {
        foregroundStarted = false;
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private boolean handleMediaButtonIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) return false;
        android.view.KeyEvent event;
        if (Build.VERSION.SDK_INT >= 33) {
            event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent.class);
        } else {
            event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        }
        return event != null && handleMediaButtonKey(event);
    }

    private boolean handleMediaButtonKey(android.view.KeyEvent event) {
        if (destroyed || event == null || event.getAction() != android.view.KeyEvent.ACTION_DOWN
                || event.getRepeatCount() != 0) return false;
        switch (event.getKeyCode()) {
            case android.view.KeyEvent.KEYCODE_MEDIA_NEXT:
                advance(1, shuffle);
                return true;
            case android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                advance(-1, false);
                return true;
            case android.view.KeyEvent.KEYCODE_MEDIA_PLAY:
                control("resume", null);
                return true;
            case android.view.KeyEvent.KEYCODE_MEDIA_PAUSE:
                control("pause", null);
                return true;
            case android.view.KeyEvent.KEYCODE_MEDIA_STOP:
                control("stop", null);
                return true;
            case android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case android.view.KeyEvent.KEYCODE_HEADSETHOOK:
                control("toggle", null);
                return true;
            default:
                return false;
        }
    }

    private void persistQueue() {
        JSONArray persisted = new JSONArray();
        for (JSONObject track : queue) {
            try {
                JSONObject clean = OrbitTrack.copy(track);
                if ("youtube".equals(clean.optString("source", ""))) clean.remove("audioUrl");
                persisted.put(clean);
            } catch (JSONException ignored) {
            }
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("queue", persisted.toString())
                .putInt("index", currentIndex)
                .putBoolean("shuffle", shuffle)
                .putString("repeat", repeatMode)
                .apply();
    }

    private void loadPersistedQueue() {
        try {
            String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString("queue", "[]");
            JSONArray items = new JSONArray(raw);
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item != null) queue.add(OrbitTrack.fromJson(this, item));
            }
            currentIndex = getSharedPreferences(PREFS, MODE_PRIVATE).getInt("index", -1);
            currentIndex = queue.isEmpty() ? -1 : clamp(currentIndex, 0, queue.size() - 1);
            shuffle = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("shuffle", false);
            repeatMode = normalizeRepeat(getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getString("repeat", "off"));
        } catch (Exception ignored) {
            queue.clear();
            currentIndex = -1;
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static String normalizeRepeat(String value) {
        String repeat = value == null ? "off" : value.toLowerCase(Locale.US);
        return "all".equals(repeat) || "one".equals(repeat) ? repeat : "off";
    }

    private static String safeFileName(String value) {
        String clean = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return clean.length() > 80 ? clean.substring(0, 80) : clean;
    }

    private void maybeStopIfIdle() {
        if (destroyed || loading || player != null || resumeAfterFocusGain || sleepRunnable != null
                || pendingDownloadOperations.get() > 0) return;
        final int stopId = lastStartId;
        if (stopId <= 0) return;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed || lastStartId != stopId || loading || player != null
                        || resumeAfterFocusGain || sleepRunnable != null
                        || pendingDownloadOperations.get() > 0) return;
                if (stopSelfResult(stopId)) stopForegroundCompat();
            }
        });
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.O)
    private static final class Api26Focus {
        static Object create(Context context,
                             AudioManager.OnAudioFocusChangeListener listener) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
            return new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes)
                    .setWillPauseWhenDucked(true)
                    .setOnAudioFocusChangeListener(listener)
                    .build();
        }

        static int request(AudioManager manager, Object request) {
            return manager.requestAudioFocus((AudioFocusRequest) request);
        }

        static void abandon(AudioManager manager, Object request) {
            manager.abandonAudioFocusRequest((AudioFocusRequest) request);
        }
    }
}
