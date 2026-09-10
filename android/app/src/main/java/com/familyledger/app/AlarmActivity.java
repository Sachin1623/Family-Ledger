package com.familyledger.app;

import android.app.Activity;
import android.app.KeyguardManager;
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

    // Set by AlarmRingingService's notification-tap PendingIntent (distinct from the auto-popup
    // one that shows this screen the moment the alarm fires, which must NOT stop the ringing on
    // its own) — tells bind() the user got here by actually opening the app in response to the
    // alarm, so the ringing should stop right away, same as tapping any of the buttons below does.
    static final String EXTRA_STOP_ON_OPEN = "stopOnOpen";

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
        if (intent.getBooleanExtra(EXTRA_STOP_ON_OPEN, false)) {
            stopRingingService();
        }
    }

    private void stopRingingService() {
        Intent stop = new Intent(this, AlarmRingingService.class);
        stop.setAction(AlarmRingingService.ACTION_STOP);
        startService(stop);
    }

    /** Re-fires this exact alarm once, 10 minutes from now, via the same AlarmReceiver/exact-alarm
     *  path as any other alarm — independent of (and in addition to) its real recurring schedule,
     *  which was already re-armed for its next real occurrence the moment this one fired. Shared
     *  with AlarmClockPlugin.snoozeRinging() (the in-app banner) via AlarmScheduler.snoozeOnce. */
    private void snooze() {
        stopRingingService();
        String title = ((TextView) findViewById(R.id.alarmTitle)).getText().toString();
        String body = ((TextView) findViewById(R.id.alarmBody)).getText().toString();
        AlarmScheduler.snoozeOnce(this, alarmId, title, body, route, 10);
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
