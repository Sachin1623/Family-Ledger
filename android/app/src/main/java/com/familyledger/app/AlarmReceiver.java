package com.familyledger.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Fired by AlarmManager at the exact scheduled instant (see AlarmScheduler). Two things happen
 * here, deliberately in this order:
 *
 *   1. Kick off AlarmRingingService immediately — it owns actually ringing/vibrating and putting
 *      the takeover screen up. This receiver has a very short OS-imposed execution window
 *      (onReceive must return quickly), so it must never do the ringing work itself.
 *   2. Re-arm the NEXT occurrence of this alarm, if it's a recurring one (hour/minute >= 0). This
 *      receiver — not AlarmManager's own (removed) repeat-interval API — owns repetition, so a
 *      reboot-restored alarm (see AlarmBootReceiver) keeps recurring correctly forever without
 *      ever needing the JS layer to run again.
 *
 * A one-shot snooze re-fire (see AlarmActivity.snooze()) is sent through this same receiver with
 * hour/minute set to -1, so it rings once but is NOT treated as step 2 above — the real recurring
 * alarm was already re-armed when it originally fired.
 */
public class AlarmReceiver extends BroadcastReceiver {
    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_HOUR = "hour";
    static final String EXTRA_MINUTE = "minute";
    static final String EXTRA_WEEKDAYS = "weekdays"; // CSV of 0(Sun)..6(Sat); empty = every day
    static final String EXTRA_INTERVAL_DAYS = "intervalDays"; // >1 = "every Nth day from startDate"; takes priority over EXTRA_WEEKDAYS when set — see AlarmScheduler.computeNextTrigger
    static final String EXTRA_START_DATE = "startDate"; // 'yyyy-MM-dd' anchor date for EXTRA_INTERVAL_DAYS
    static final String EXTRA_ROUTE = "route";

    @Override
    public void onReceive(Context context, Intent intent) {
        int id = intent.getIntExtra(EXTRA_ID, 0);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String body = intent.getStringExtra(EXTRA_BODY);
        int hour = intent.getIntExtra(EXTRA_HOUR, -1);
        int minute = intent.getIntExtra(EXTRA_MINUTE, -1);
        String weekdays = intent.getStringExtra(EXTRA_WEEKDAYS);
        int intervalDays = intent.getIntExtra(EXTRA_INTERVAL_DAYS, 0);
        String startDate = intent.getStringExtra(EXTRA_START_DATE);
        String route = intent.getStringExtra(EXTRA_ROUTE);

        Intent ringIntent = new Intent(context, AlarmRingingService.class);
        ringIntent.putExtra(EXTRA_ID, id);
        ringIntent.putExtra(EXTRA_TITLE, title);
        ringIntent.putExtra(EXTRA_BODY, body);
        ringIntent.putExtra(EXTRA_ROUTE, route);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(ringIntent);
        } else {
            context.startService(ringIntent);
        }

        if (hour >= 0 && minute >= 0) {
            AlarmScheduler.scheduleNext(context, id, title, body, hour, minute, weekdays, intervalDays, startDate, route);
        }
    }
}
