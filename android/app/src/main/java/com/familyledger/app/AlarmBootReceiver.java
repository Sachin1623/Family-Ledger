package com.familyledger.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * AlarmManager forgets every scheduled alarm across a device reboot — and the JS layer (where
 * medicine reminders etc. are actually defined) isn't running at boot time to re-schedule them.
 * AlarmScheduler persists every alarm to SharedPreferences specifically so this receiver can
 * restore them all natively, with no dependency on the app, its WebView, or the network being up.
 */
public class AlarmBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AlarmScheduler.restoreAll(context);
    }
}
