package com.familyledger.app;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * The actual "alarm is ringing" screen — plain Android (no Capacitor/WebView), so it shows
 * instantly and reliably regardless of whether the app's JS bundle has finished loading (this
 * app's WebView content is fetched live over the network at runtime — see capacitor.config.ts —
 * which makes a native fallback the only thing that can guarantee an immediate screen at the
 * moment an alarm fires, network conditions notwithstanding).
 */
public class AlarmActivity extends Activity {

    private int alarmId;
    private String route;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_alarm);
        bind(getIntent());

        findViewById(R.id.alarmDismissButton).setOnClickListener(v -> {
            stopRingingService();
            finish();
        });
        findViewById(R.id.alarmSnoozeButton).setOnClickListener(v -> {
            snooze();
            finish();
        });
        findViewById(R.id.alarmOpenButton).setOnClickListener(v -> {
            openApp();
            stopRingingService();
            finish();
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    private void bind(Intent intent) {
        alarmId = intent.getIntExtra(AlarmReceiver.EXTRA_ID, 0);
        String title = intent.getStringExtra(AlarmReceiver.EXTRA_TITLE);
        String body = intent.getStringExtra(AlarmReceiver.EXTRA_BODY);
        route = intent.getStringExtra(AlarmReceiver.EXTRA_ROUTE);
        ((TextView) findViewById(R.id.alarmTitle)).setText(title != null ? title : "Reminder");
        ((TextView) findViewById(R.id.alarmBody)).setText(body != null ? body : "");
    }

    private void stopRingingService() {
        Intent stop = new Intent(this, AlarmRingingService.class);
        stop.setAction(AlarmRingingService.ACTION_STOP);
        startService(stop);
    }

    /** Re-fires this exact alarm once, 10 minutes from now, via the same AlarmReceiver/exact-alarm
     *  path as any other alarm — independent of (and in addition to) its real recurring schedule,
     *  which was already re-armed for its next real occurrence the moment this one fired. */
    private void snooze() {
        stopRingingService();

        String title = ((TextView) findViewById(R.id.alarmTitle)).getText().toString();
        String body = ((TextView) findViewById(R.id.alarmBody)).getText().toString();

        Intent receiverIntent = new Intent(this, AlarmReceiver.class);
        receiverIntent.putExtra(AlarmReceiver.EXTRA_ID, alarmId);
        receiverIntent.putExtra(AlarmReceiver.EXTRA_TITLE, title);
        receiverIntent.putExtra(AlarmReceiver.EXTRA_BODY, body);
        receiverIntent.putExtra(AlarmReceiver.EXTRA_ROUTE, route);
        // Negative hour/minute marks this as a one-shot: AlarmReceiver rings it but does not
        // re-arm a further occurrence from it (see AlarmReceiver's own doc comment).
        receiverIntent.putExtra(AlarmReceiver.EXTRA_HOUR, -1);
        receiverIntent.putExtra(AlarmReceiver.EXTRA_MINUTE, -1);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        // Distinct request-code space so a snooze's one-shot PendingIntent never clobbers this
        // alarm's own recurring one.
        PendingIntent pi = PendingIntent.getBroadcast(this, 1_000_000_000 + alarmId, receiverIntent, flags);

        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long trigger = System.currentTimeMillis() + 10 * 60 * 1000L;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, trigger, pi);
        }
    }

    // Deep-links straight into `route` (e.g. /health/medicines) instead of just opening the app to
    // wherever it was left — reuses this app's EXISTING App Links plumbing rather than building a
    // new native<->JS bridge: @capacitor/app's own AppPlugin fires 'appUrlOpen' for any
    // ACTION_VIEW intent carrying a data URI (see its handleOnNewIntent), and App.tsx already
    // listens for that event and navigates to the URL's path+search — the same mechanism a tapped
    // invite/join link already goes through. Targeted explicitly at MainActivity (not an implicit
    // ACTION_VIEW resolution) since this is an in-app launch, not an externally-tapped link — no
    // dependency on App Links domain verification having succeeded on this device.
    private void openApp() {
        String path = (route != null && !route.isEmpty()) ? route : "/health/medicines";
        Intent launch = new Intent(Intent.ACTION_VIEW, Uri.parse("https://familyledger.thirteenapps.com" + path));
        launch.setClass(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
    }
}
