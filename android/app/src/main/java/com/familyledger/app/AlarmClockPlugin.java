package com.familyledger.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/**
 * JS-facing bridge for the alarm-clock-style takeover reminders (see AlarmReceiver/
 * AlarmRingingService/AlarmActivity alongside this file). Distinct from @capacitor/local-
 * notifications — that plugin has no concept of a full-screen, rings-over-silent-mode takeover;
 * this one exists specifically to provide that, starting with medicine reminders (see
 * src/lib/medicineReminders.ts and src/lib/alarmClock.ts on the JS side).
 */
@CapacitorPlugin(name = "AlarmClock")
public class AlarmClockPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        Integer id = call.getInt("id");
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        if (id == null || hour == null || minute == null) {
            call.reject("id, hour, and minute are required");
            return;
        }
        String title = call.getString("title", "");
        String body = call.getString("body", "");
        String route = call.getString("route", "");
        int intervalDays = call.getInt("intervalDays", 0);
        String startDate = call.getString("startDate", "");

        StringBuilder csv = new StringBuilder();
        JSArray weekdaysArr = call.getArray("weekdays");
        try {
            if (weekdaysArr != null) {
                for (int i = 0; i < weekdaysArr.length(); i++) {
                    if (i > 0) csv.append(",");
                    csv.append(weekdaysArr.getInt(i));
                }
            }
        } catch (JSONException e) {
            call.reject("Invalid weekdays array", e);
            return;
        }

        AlarmScheduler.schedule(getContext(), id, title, body, hour, minute, csv.toString(), intervalDays, startDate, route);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        AlarmScheduler.cancel(getContext(), id);
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        AlarmScheduler.cancelAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void checkFullScreenIntentPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", canUseFullScreenIntent());
        call.resolve(result);
    }

    @PluginMethod
    public void requestFullScreenIntentPermission(PluginCall call) {
        if (!canUseFullScreenIntent()) {
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception e) {
                // Some OEM builds/emulator images don't expose this settings screen — nothing more
                // to do from here; the permission just stays whatever it already was.
            }
        }
        JSObject result = new JSObject();
        result.put("granted", canUseFullScreenIntent());
        call.resolve(result);
    }

    private boolean canUseFullScreenIntent() {
        // Below Android 14 (API 34) there's no such gate — a declared USE_FULL_SCREEN_INTENT
        // permission is enough on its own.
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.canUseFullScreenIntent();
    }
}
