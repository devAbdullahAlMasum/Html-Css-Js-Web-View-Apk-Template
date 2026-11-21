package app.orbit.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.KeyEvent;

/** Restores Orbit playback when a media button arrives while the service is stopped. */
public final class OrbitMediaButtonReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null
                || !Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) {
            return;
        }

        KeyEvent event;
        if (Build.VERSION.SDK_INT >= 33) {
            event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent.class);
        } else {
            event = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        }
        if (event == null || event.getAction() != KeyEvent.ACTION_DOWN
                || event.getRepeatCount() != 0) {
            return;
        }

        if (OrbitPlaybackService.dispatchMediaButton(event)) return;

        // Android 8+ only routes media buttons here when no active session can handle them.
        // Only resume commands are safe to turn into a cold foreground-service start.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !isResumeCommand(event.getKeyCode())) {
            return;
        }

        Intent serviceIntent = new Intent(context, OrbitPlaybackService.class);
        serviceIntent.setAction(Intent.ACTION_MEDIA_BUTTON);
        serviceIntent.putExtra(Intent.EXTRA_KEY_EVENT, event);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        } catch (IllegalStateException ignored) {
            // Android 12+ can deny a background foreground-service start. A later
            // media command can retry after the app becomes eligible.
        }
    }

    private static boolean isResumeCommand(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_MEDIA_PLAY
                || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || keyCode == KeyEvent.KEYCODE_HEADSETHOOK;
    }
}
