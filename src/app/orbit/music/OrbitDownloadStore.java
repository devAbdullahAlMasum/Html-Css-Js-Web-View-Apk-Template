package app.orbit.music;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;

/** Persistent metadata for Orbit-owned downloads. */
final class OrbitDownloadStore {
    private static final String PREFS = "orbit_downloads";

    private OrbitDownloadStore() {
    }

    static synchronized JSONObject get(Context context, String id) {
        JSONObject all = read(context);
        return all.optJSONObject(id);
    }

    static synchronized JSONObject put(Context context, JSONObject record) throws JSONException {
        JSONObject all = read(context);
        String id = record.getString("id");
        all.put(id, record);
        write(context, all);
        return record;
    }

    static synchronized JSONObject updateIfToken(Context context, String id, String token,
                                                 JSONObject updates) throws JSONException {
        JSONObject all = read(context);
        JSONObject current = all.optJSONObject(id);
        if (current == null || !token.equals(current.optString("jobToken", ""))) return null;
        JSONObject oldTrack = current.optJSONObject("track");
        Iterator<String> keys = updates.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            current.put(key, updates.get(key));
        }
        JSONObject nextTrack = current.optJSONObject("track");
        if (oldTrack != null && nextTrack != null && oldTrack.has("originalTitle")) {
            nextTrack.put("title", oldTrack.optString("title"));
            nextTrack.put("originalTitle", oldTrack.optString("originalTitle"));
        }
        if (!"failed".equals(current.optString("status"))) current.remove("error");
        all.put(id, current);
        write(context, all);
        return current;
    }

    static synchronized void remove(Context context, String id) {
        JSONObject all = read(context);
        all.remove(id);
        write(context, all);
    }

    static synchronized JSONObject removeAndGet(Context context, String id) {
        JSONObject all = read(context);
        JSONObject record = all.optJSONObject(id);
        all.remove(id);
        write(context, all);
        return record;
    }

    static synchronized JSONObject renameTrack(Context context, String trackId, String title) {
        JSONObject all = read(context);
        JSONObject record = all.optJSONObject(trackId);
        if (record == null) return null;
        try {
            JSONObject track = record.optJSONObject("track");
            if (track == null) track = new JSONObject();
            if (!track.has("originalTitle")) {
                track.put("originalTitle", track.optString("title", ""));
            }
            track.put("title", title);
            record.put("track", track);
            all.put(trackId, record);
            write(context, all);
            return record;
        } catch (JSONException ignored) {
            return record;
        }
    }

    static synchronized String completeLocalUri(Context context, String trackId) {
        JSONObject record = getRefreshed(context, trackId);
        if (record == null || !"complete".equals(record.optString("status"))) return "";
        String localUri = record.optString("localUri", "");
        if (localUri.isEmpty()) return "";
        if (localUri.startsWith("file://")) {
            try {
                if (!new File(Uri.parse(localUri).getPath()).isFile()) return "";
            } catch (Exception ignored) {
                return "";
            }
        }
        return localUri;
    }

    static synchronized JSONObject getRefreshed(Context context, String id) {
        JSONObject all = read(context);
        JSONObject record = all.optJSONObject(id);
        if (record == null) return null;
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (refreshRecord(context, id, record, manager)) write(context, all);
        return record;
    }

    static synchronized JSONArray refreshAndList(Context context) {
        JSONObject all = read(context);
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        boolean changed = false;
        Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            String id = keys.next();
            JSONObject record = all.optJSONObject(id);
            if (record == null) continue;
            changed |= refreshRecord(context, id, record, manager);
        }
        if (changed) write(context, all);
        return listFrom(all);
    }

    private static boolean refreshRecord(Context context, String id, JSONObject record,
                                         DownloadManager manager) {
        long downloadId = record.optLong("downloadManagerId", -1L);
        if (downloadId < 0L) {
            try {
                String status = record.optString("status");
                String uri = record.optString("localUri", "");
                boolean missing = "complete".equals(status) && uri.startsWith("file://")
                        && !new File(Uri.parse(uri).getPath()).isFile();
                boolean interrupted = !"complete".equals(status) && !"failed".equals(status)
                        && !OrbitPlaybackService.isDownloadActive(id, record.optString("jobToken", ""));
                if (missing || interrupted) {
                    deleteOwnedFile(context, record);
                    record.put("status", "failed");
                    record.put("error", missing ? "Downloaded file is missing"
                            : "Download preparation was interrupted. Retry the download.");
                    return true;
                }
            } catch (Exception ignored) {
            }
            return false;
        }
        if (manager == null) return false;

        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                String status = record.optString("status");
                String localUri = record.optString("localUri", "");
                if ("complete".equals(status) && localUri.startsWith("file://")) {
                    File file = new File(Uri.parse(localUri).getPath());
                    boolean ownedFileExists = file.isFile()
                            && (isInside(file, context.getFilesDir())
                            || isInside(file, context.getExternalFilesDir(null)));
                    if (ownedFileExists) return false;
                }
                if (!"failed".equals(status)) {
                    record.put("status", "failed");
                    record.put("error", "complete".equals(status)
                            ? "Downloaded file is missing" : "Download was removed outside Orbit");
                    return true;
                }
                return false;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            int downloadedColumn = cursor.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
            int totalColumn = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
            long downloaded = downloadedColumn >= 0 ? cursor.getLong(downloadedColumn) : 0L;
            long total = totalColumn >= 0 ? cursor.getLong(totalColumn) : 0L;
            String next;
            String error = "";
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                next = "complete";
                downloaded = total > 0L ? total : downloaded;
                String localUri = record.optString("localUri", "");
                if (localUri.startsWith("file://")) {
                    File file = new File(Uri.parse(localUri).getPath());
                    if (!file.isFile()) {
                        next = "failed";
                        error = "Downloaded file is missing";
                    }
                }
            } else if (status == DownloadManager.STATUS_FAILED) {
                next = "failed";
                error = downloadReason(reason);
            } else if (status == DownloadManager.STATUS_RUNNING) {
                next = "downloading";
            } else if (status == DownloadManager.STATUS_PAUSED) {
                next = "paused";
            } else {
                next = "queued";
            }
            int progress = total > 0L
                    ? (int) Math.max(0L, Math.min(100L, downloaded * 100L / total)) : 0;
            if ("complete".equals(next)) progress = 100;
            long previousDownloaded = record.optLong("downloadedBytes", -1L);
            long previousTotal = record.optLong("totalBytes", -1L);
            boolean bytesChanged = downloaded > 0L && downloaded != previousDownloaded
                    || total > 0L && total != previousTotal;
            if (!next.equals(record.optString("status"))
                    || !error.equals(record.optString("error", ""))
                    || progress != record.optInt("progress", 0)
                    || bytesChanged) {
                record.put("status", next);
                record.put("progress", progress);
                if (downloaded > 0L) record.put("downloadedBytes", downloaded);
                if (total > 0L) record.put("totalBytes", total);
                if (error.isEmpty()) record.remove("error");
                else record.put("error", error);
                return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    static synchronized JSONArray list(Context context) {
        return listFrom(read(context));
    }

    static synchronized void deleteOwnedFile(Context context, JSONObject record) {
        if (record == null) return;
        String localUri = record.optString("localUri", "");
        if (!localUri.startsWith("file://")) return;
        try {
            File file = new File(Uri.parse(localUri).getPath());
            File canonical = file.getCanonicalFile();
            if (isInside(canonical, context.getFilesDir())
                    || isInside(canonical, context.getExternalFilesDir(null))) {
                if (canonical.exists()) canonical.delete();
                File temporary = new File(canonical.getPath() + ".part").getCanonicalFile();
                if ((isInside(temporary, context.getFilesDir())
                        || isInside(temporary, context.getExternalFilesDir(null))) && temporary.exists()) {
                    temporary.delete();
                }
            }
        } catch (Exception ignored) {
        }
    }

    private static JSONArray listFrom(JSONObject all) {
        JSONArray out = new JSONArray();
        Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            JSONObject record = all.optJSONObject(keys.next());
            if (record == null) continue;
            JSONObject item = new JSONObject();
            try {
                item.put("id", record.optString("id"));
                JSONObject track = record.optJSONObject("track");
                item.put("track", track == null ? JSONObject.NULL : track);
                if (track != null) {
                    String[] fields = {"title", "originalTitle", "artist", "source",
                            "videoId", "duration", "artworkUrl"};
                    for (String field : fields) {
                        if (track.has(field)) item.put(field, track.get(field));
                    }
                }
                item.put("status", record.optString("status", "queued"));
                item.put("progress", record.optInt("progress", 0));
                if (record.has("downloadedBytes")) {
                    item.put("downloadedBytes", record.optLong("downloadedBytes", 0L));
                }
                if (record.has("totalBytes")) {
                    item.put("totalBytes", record.optLong("totalBytes", 0L));
                }
                if (record.optLong("downloadManagerId", -1L) >= 0L) {
                    item.put("downloadManagerId", record.optLong("downloadManagerId", -1L));
                }
                if (!record.optString("localUri", "").isEmpty()) {
                    item.put("localUri", record.optString("localUri"));
                }
                if (!record.optString("error", "").isEmpty()) {
                    item.put("error", record.optString("error"));
                }
            } catch (JSONException ignored) {
            }
            out.put(item);
        }
        return out;
    }

    private static JSONObject read(Context context) {
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString("records", "{}");
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static void write(Context context, JSONObject all) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString("records", all.toString()).apply();
    }

    private static String downloadReason(int reason) {
        if (reason == DownloadManager.ERROR_HTTP_DATA_ERROR) return "HTTP data error while downloading";
        if (reason == DownloadManager.ERROR_TOO_MANY_REDIRECTS) return "Too many download redirects";
        if (reason == DownloadManager.ERROR_UNHANDLED_HTTP_CODE) return "HTTP error while downloading";
        if (reason == DownloadManager.ERROR_INSUFFICIENT_SPACE) return "Not enough storage space";
        if (reason == DownloadManager.ERROR_DEVICE_NOT_FOUND) return "Download storage is unavailable";
        if (reason == DownloadManager.ERROR_FILE_ALREADY_EXISTS) return "Download file already exists";
        return "Download failed (reason " + reason + ")";
    }

    private static boolean isInside(File file, File parent) {
        if (parent == null) return false;
        try {
            String root = parent.getCanonicalPath();
            String path = file.getCanonicalPath();
            return path.equals(root) || path.startsWith(root + File.separator);
        } catch (Exception ignored) {
            return false;
        }
    }
}
