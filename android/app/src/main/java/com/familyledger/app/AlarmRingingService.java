package com.familyledger.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.core.app.NotificationCompat;

/**
 * The actual "ringing" — a foreground service (not just a notification) so the alarm sound and
 * vibration keep going reliably even though the triggering BroadcastReceiver has already
 * returned. Also puts up the full-screen-intent notification AND directly starts AlarmActivity
 * itself; some OEMs defer a bare full-screen intent when the app isn't already foregrounded
 * (background-activity-start restrictions), so starting the activity from a foreground service is
 * a second, more reliable path to actually getting the takeover screen on top of the lock screen.
 */
public class AlarmRingingService extends Service {
    static final String CHANNEL_ID = "familyledger_alarms";
    static final String ACTION_STOP = "com.familyledger.app.ACTION_STOP_ALARM";

    private MediaPlayer mediaPlayer;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private boolean ringing;

    private int currentId;
    private String currentTitle = "";
    private String currentBody = "";
    private String currentRoute = "";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopRinging();
            stopSelf();
            return START_NOT_STICKY;
        }

        // A second alarm firing (or a re-delivered AlarmReceiver broadcast, or a snooze re-fire)
        // while one is already ringing used to stack a fresh MediaPlayer/Vibrator/WakeLock on top
        // and overwrite the fields — the previous ones were orphaned but kept looping, so a single
        // ACTION_STOP (Dismiss) only ever silenced the newest and the alarm "wouldn't stop". Tear
        // any existing ring down first, without emitting a JS "stopped" (we re-start immediately
        // below), so this invocation is the only one live.
        stopRingingInternal(false);

        int id = intent != null ? intent.getIntExtra(AlarmReceiver.EXTRA_ID, 0) : 0;
        String title = intent != null ? intent.getStringExtra(AlarmReceiver.EXTRA_TITLE) : null;
        String body = intent != null ? intent.getStringExtra(AlarmReceiver.EXTRA_BODY) : null;
        String route = intent != null ? intent.getStringExtra(AlarmReceiver.EXTRA_ROUTE) : null;
        if (title == null) title = "Reminder";
        if (body == null) body = "";
        currentId = id;
        currentTitle = title;
        currentBody = body;
        currentRoute = route != null ? route : "";

        ensureChannel();

        Intent activityIntent = new Intent(this, AlarmActivity.class);
        activityIntent.putExtra(AlarmReceiver.EXTRA_ID, id);
        activityIntent.putExtra(AlarmReceiver.EXTRA_TITLE, title);
        activityIntent.putExtra(AlarmReceiver.EXTRA_BODY, body);
        activityIntent.putExtra(AlarmReceiver.EXTRA_ROUTE, route);
        activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        // Auto-popup launch (fired once, right now, by startActivity() below AND by the system via
        // setFullScreenIntent) — deliberately does NOT stop the ringing on its own; the alarm is
        // supposed to keep ringing until the user actually acts on it, same as any real alarm clock.
        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(this, id, activityIntent, piFlags);

        // A SEPARATE PendingIntent (distinct request code, extra EXTRA_STOP_ON_OPEN flag) just for
        // the notification's own tap target. Reusing fullScreenPendingIntent here — as this used to
        // — meant tapping the notification itself (rather than one of AlarmActivity's own in-screen
        // buttons) just re-showed the same ringing screen with the sound still going: "opening the
        // app" from the notification silently did nothing to the alarm. AlarmActivity.bind() checks
        // this extra and stops the ringing the moment it's opened this way, in addition to the
        // explicit stop each of its own buttons already does.
        Intent tapIntent = new Intent(this, AlarmActivity.class);
        tapIntent.putExtra(AlarmReceiver.EXTRA_ID, id);
        tapIntent.putExtra(AlarmReceiver.EXTRA_TITLE, title);
        tapIntent.putExtra(AlarmReceiver.EXTRA_BODY, body);
        tapIntent.putExtra(AlarmReceiver.EXTRA_ROUTE, route);
        tapIntent.putExtra(AlarmActivity.EXTRA_STOP_ON_OPEN, true);
        tapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tapPendingIntent = PendingIntent.getActivity(this, -id, tapIntent, piFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(tapPendingIntent)
            .setOngoing(true)
            .setAutoCancel(false);

        Notification notification = builder.build();
        int notificationId = 2000000000 + id;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(notificationId, notification);
        }

        try {
            startActivity(activityIntent);
        } catch (Exception ignored) {
            // The full-screen-intent notification above is still up as a fallback if this direct
            // launch is refused (e.g. a stricter OEM background-start policy).
        }

        startRinging();

        return START_NOT_STICKY;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Alarms", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Medicine and other reminders that ring like an alarm clock.");
        channel.setBypassDnd(true);
        channel.enableVibration(true);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        Uri sound = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        channel.setSound(sound, attrs);
        nm.createNotificationChannel(channel);
    }

    private void startRinging() {
        ringing = true;
        // Lets the app show its own in-app Snooze/Dismiss banner (GlobalAlarmRingingBanner.tsx)
        // for the whole time this is ringing, not just via the native full-screen AlarmActivity.
        // No-ops when no webview/plugin instance is attached (alarm fired with the app killed) —
        // the JS side re-queries isRinging() on launch/resume to catch that case.
        AlarmClockPlugin.onRingingStarted(currentId, currentTitle, currentBody, currentRoute);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilyLedger:AlarmRinging");
            // Safety cap so a missed Dismiss/Snooze tap (app killed, crash, etc.) can't hold a
            // wake lock forever — 10 minutes comfortably covers a real "wake up and respond" window.
            wakeLock.acquire(10 * 60 * 1000L);
        }

        try {
            Uri sound = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM);
            if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            );
            mediaPlayer.setDataSource(this, sound);
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();
            mediaPlayer.start();
        } catch (Exception e) {
            // No usable alarm sound on this device — vibration below still gets the point across.
            mediaPlayer = null;
        }

        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator()) {
            long[] pattern = { 0, 1000, 1000 };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        }
    }

    private void stopRinging() {
        stopRingingInternal(true);
    }

    // `notify` = tell the JS side ("alarmStopped") that ringing ended. Suppressed only by the
    // idempotency guard in onStartCommand, which stops the previous ring purely to immediately
    // start a new one.
    private void stopRingingInternal(boolean notify) {
        boolean wasRinging = ringing;
        ringing = false;
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {
                // Already stopped/released — nothing to do.
            }
            mediaPlayer.release();
            mediaPlayer = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        stopForeground(true);
        if (notify && wasRinging) {
            AlarmClockPlugin.onRingingStopped();
        }
    }

    @Override
    public void onDestroy() {
        stopRinging();
        super.onDestroy();
    }
}
