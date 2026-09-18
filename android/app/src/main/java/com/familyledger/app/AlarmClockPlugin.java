package com.familyledger.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import java.lang.ref.WeakReference;

/**
 * JS-facing bridge for the alarm-clock-style takeover reminders (see AlarmReceiver/
 * AlarmRingingService/AlarmActivity alongside this file). Distinct from @capacitor/local-
 * notifications — that plugin has no concept of a full-screen, rings-over-silent-mode takeover;
 * this one exists specifically to provide that, starting with medicine reminders (see
 * src/lib/medicineReminders.ts and src/lib/alarmClock.ts on the JS side).
 */
@CapacitorPlugin(name = "AlarmClock")
public class AlarmClockPlugin extends Plugin {

    // --- Currently-ringing-alarm bridge (see AlarmRingingService / GlobalAlarmRingingBanner.tsx) ---
    // Static, not instance state: AlarmRingingService runs even when there's no webview/plugin
    // instance attached (alarm fired with the app killed), so it must be able to record "an alarm
    // is ringing" regardless. When a plugin instance DOES exist, these also fan the change out to
    // JS as an event; otherwise JS picks it up via isRinging() on its next launch/resume.
    private static WeakReference<AlarmClockPlugin> instanceRef;
    private static boolean ringing = false;
    private static int ringingId = 0;
    private static String ringingTitle = "";
    private static String ringingBody = "";
    private static String ringingRoute = "";

    @Override
    public void load() {
        super.load();
        instanceRef = new WeakReference<>(this);
    }

    static void onRingingStarted(int id, String title, String body, String route) {
        ringing = true;
        ringingId = id;
        ringingTitle = title != null ? title : "";
        ringingBody = body != null ? body : "";
        ringingRoute = route != null ? route : "";
        AlarmClockPlugin p = instanceRef != null ? instanceRef.get() : null;
        if (p != null) p.notifyListeners("alarmRinging", ringingState());
    }

    static void onRingingStopped() {
        ringing = false;
        AlarmClockPlugin p = instanceRef != null ? instanceRef.get() : null;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("ringing", false);
            p.notifyListeners("alarmStopped", data);
        }
    }

    private static JSObject ringingState() {
        JSObject o = new JSObject();
        o.put("ringing", ringing);
        o.put("id", ringingId);
        o.put("title", ringingTitle);
        o.put("body", ringingBody);
        o.put("route", ringingRoute);
        return o;
    }

    @PluginMethod
    public void isRinging(PluginCall call) {
        call.resolve(ringingState());
    }

    @PluginMethod
    public void stopRinging(PluginCall call) {
        sendStopToService();
        call.resolve();
    }

    @PluginMethod
    public void snoozeRinging(PluginCall call) {
        int minutes = call.getInt("minutes", 10);
        if (ringing || ringingId != 0) {
            AlarmScheduler.snoozeOnce(getContext(), ringingId, ringingTitle, ringingBody, ringingRoute, minutes);
        }
        sendStopToService();
        call.resolve();
    }

    private void sendStopToService() {
        Intent stop = new Intent(getContext(), AlarmRingingService.class);
        stop.setAction(AlarmRingingService.ACTION_STOP);
        try {
            getContext().startService(stop);
        } catch (Exception ignored) {
            // Service already gone / OS refused — the ringing is already over either way.
        }
    }

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

    // This used to also expose checkFullScreenIntentPermission/requestFullScreenIntentPermission
    // (Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT) here — removed 2026-09-18 along with the
    // USE_FULL_SCREEN_INTENT manifest permission itself, after Play Console rejected the app under
    // the Full-Screen Intent Permission policy. See AndroidManifest.xml's own comment for the full
    // reasoning; the takeover screen still works without either.

    // This is standard Android's own battery
    // optimization exemption (what "Ignore battery optimizations" / "No restrictions" does when
    // toggled manually in Settings). Confirmed via a real device this session: without this, an
    // OEM's own background-management layer (seen on a Vivo phone specifically) can silently drop
    // an alarm's broadcast before it ever reaches AlarmReceiver — no crash, no log, the OS just
    // never delivers it. SCHEDULE_EXACT_ALARM alone does not protect against this; it's a genuinely
    // separate restriction. requestBatteryOptimizationExemption's Intent shows Android's own system
    // dialog directly (one tap to grant), rather than sending the user to hunt through Settings.
    @PluginMethod
    public void checkBatteryOptimizationExemption(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isIgnoringBatteryOptimizations());
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        if (!isIgnoringBatteryOptimizations()) {
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception e) {
                // Some OEM builds block this system dialog outright — nothing more to do from here;
                // the permission just stays whatever it already was.
            }
        }
        JSObject result = new JSObject();
        result.put("granted", isIgnoringBatteryOptimizations());
        call.resolve(result);
    }

    private boolean isIgnoringBatteryOptimizations() {
        android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
