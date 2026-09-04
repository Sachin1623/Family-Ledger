package com.familyledger.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Owns everything about persisting and (re)arming a takeover alarm — shared by AlarmClockPlugin
 * (JS-initiated schedule/cancel), AlarmReceiver (re-arming the next occurrence after each fire),
 * and AlarmBootReceiver (restoring every alarm after a device reboot, since AlarmManager forgets
 * everything across a reboot and the JS layer isn't running to re-schedule from Firestore data at
 * that point). Every alarm this schedules is stored in SharedPreferences as its own source of
 * truth — deliberately NOT dependent on JS/Firestore being reachable, matching why this whole
 * feature exists as native code in the first place.
 */
class AlarmScheduler {
    private static final String PREFS = "familyledger_alarm_clock";
    private static final String KEY_IDS = "ids";

    static void schedule(Context context, int id, String title, String body, int hour, int minute, String weekdaysCsv, int intervalDays, String startDate, String route) {
        persist(context, id, title, body, hour, minute, weekdaysCsv, intervalDays, startDate, route);
        scheduleNext(context, id, title, body, hour, minute, weekdaysCsv, intervalDays, startDate, route);
    }

    static void scheduleNext(Context context, int id, String title, String body, int hour, int minute, String weekdaysCsv, int intervalDays, String startDate, String route) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long trigger = computeNextTrigger(hour, minute, parseWeekdays(weekdaysCsv), intervalDays, startDate);
        PendingIntent pi = buildPendingIntent(context, id, title, body, hour, minute, weekdaysCsv, intervalDays, startDate, route);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            // Same graceful fallback as @capacitor/local-notifications uses elsewhere in this app
            // (see LocalNotificationManager.setExactIfPossible) — an inexact alarm still fires,
            // just not guaranteed to the minute, until the user grants "Alarms & reminders".
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, trigger, pi);
        }
    }

    static void cancel(Context context, int id) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, AlarmReceiver.class);
        int flags = PendingIntent.FLAG_CANCEL_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent, flags);
        if (am != null) am.cancel(pi);
        pi.cancel();
        removePersisted(context, id);
    }

    static void cancelAll(Context context) {
        for (int id : getAllIds(context)) cancel(context, id);
    }

    static void restoreAll(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        for (int id : getAllIds(context)) {
            String json = prefs.getString("alarm_" + id, null);
            if (json == null) continue;
            try {
                JSONObject obj = new JSONObject(json);
                scheduleNext(
                    context,
                    id,
                    obj.optString("title"),
                    obj.optString("body"),
                    obj.optInt("hour"),
                    obj.optInt("minute"),
                    obj.optString("weekdays"),
                    obj.optInt("intervalDays"),
                    obj.optString("startDate"),
                    obj.optString("route")
                );
            } catch (JSONException ignored) {
                // Corrupt entry — skip it rather than crash the boot receiver for every other alarm.
            }
        }
    }

    private static PendingIntent buildPendingIntent(Context context, int id, String title, String body, int hour, int minute, String weekdaysCsv, int intervalDays, String startDate, String route) {
        Intent intent = new Intent(context, AlarmReceiver.class);
        intent.putExtra(AlarmReceiver.EXTRA_ID, id);
        intent.putExtra(AlarmReceiver.EXTRA_TITLE, title);
        intent.putExtra(AlarmReceiver.EXTRA_BODY, body);
        intent.putExtra(AlarmReceiver.EXTRA_HOUR, hour);
        intent.putExtra(AlarmReceiver.EXTRA_MINUTE, minute);
        intent.putExtra(AlarmReceiver.EXTRA_WEEKDAYS, weekdaysCsv);
        intent.putExtra(AlarmReceiver.EXTRA_INTERVAL_DAYS, intervalDays);
        intent.putExtra(AlarmReceiver.EXTRA_START_DATE, startDate);
        intent.putExtra(AlarmReceiver.EXTRA_ROUTE, route);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(context, id, intent, flags);
    }

    private static void persist(Context context, int id, String title, String body, int hour, int minute, String weekdaysCsv, int intervalDays, String startDate, String route) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONObject obj = new JSONObject();
            obj.put("title", title == null ? "" : title);
            obj.put("body", body == null ? "" : body);
            obj.put("hour", hour);
            obj.put("minute", minute);
            obj.put("weekdays", weekdaysCsv == null ? "" : weekdaysCsv);
            obj.put("intervalDays", intervalDays);
            obj.put("startDate", startDate == null ? "" : startDate);
            obj.put("route", route == null ? "" : route);
            Set<String> ids = new HashSet<>(prefs.getStringSet(KEY_IDS, new HashSet<>()));
            ids.add(String.valueOf(id));
            prefs.edit().putString("alarm_" + id, obj.toString()).putStringSet(KEY_IDS, ids).apply();
        } catch (JSONException ignored) {
            // Nothing sensible to fall back to — the alarm still fires once (scheduleNext already
            // ran), it just won't survive a reboot if this failed.
        }
    }

    private static void removePersisted(Context context, int id) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> ids = new HashSet<>(prefs.getStringSet(KEY_IDS, new HashSet<>()));
        ids.remove(String.valueOf(id));
        prefs.edit().remove("alarm_" + id).putStringSet(KEY_IDS, ids).apply();
    }

    private static List<Integer> getAllIds(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> ids = prefs.getStringSet(KEY_IDS, new HashSet<>());
        List<Integer> result = new ArrayList<>();
        for (String s : ids) {
            try {
                result.add(Integer.parseInt(s));
            } catch (NumberFormatException ignored) {
                // Skip a corrupted entry rather than fail the whole restore/cancel-all pass.
            }
        }
        return result;
    }

    private static int[] parseWeekdays(String csv) {
        if (csv == null || csv.isEmpty()) return new int[0];
        String[] parts = csv.split(",");
        List<Integer> result = new ArrayList<>();
        for (String part : parts) {
            try {
                result.add(Integer.parseInt(part.trim()));
            } catch (NumberFormatException ignored) {
                // Skip a malformed weekday token.
            }
        }
        int[] arr = new int[result.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = result.get(i);
        return arr;
    }

    // Whole-calendar-day difference between a 'yyyy-MM-dd' anchor date and a Calendar instant —
    // both compared at local midnight, mirroring medicines.ts's own daysBetween() exactly (same
    // "construct at local midnight, diff the millis, round" approach) so native and JS agree on
    // which day number a given date is, DST included.
    private static long daysBetween(int sy, int sm, int sd, Calendar instant) {
        Calendar start = Calendar.getInstance();
        start.clear();
        start.set(sy, sm - 1, sd, 0, 0, 0);
        Calendar midnight = (Calendar) instant.clone();
        midnight.set(Calendar.HOUR_OF_DAY, 0);
        midnight.set(Calendar.MINUTE, 0);
        midnight.set(Calendar.SECOND, 0);
        midnight.set(Calendar.MILLISECOND, 0);
        return Math.round((midnight.getTimeInMillis() - start.getTimeInMillis()) / 86400000.0);
    }

    /** hour/minute are the target time-of-day. Two mutually exclusive repeat patterns (matching
     *  Medicine.intervalDays/weekdays in medicines.ts exactly):
     *    - intervalDays > 1 (with startDate 'yyyy-MM-dd' as the anchor): due every Nth day,
     *      counted from startDate — checked FIRST, since when it's set weekdays is ignored.
     *    - otherwise, weekdays (JS's 0=Sun..6=Sat / Date.getDay() convention) — empty or length>=7
     *      means every day, matching medicineReminders.ts's own convention so no conversion is
     *      needed at the JS boundary. */
    static long computeNextTrigger(int hour, int minute, int[] weekdays, int intervalDays, String startDate) {
        Calendar now = Calendar.getInstance();
        Calendar cal = (Calendar) now.clone();
        cal.set(Calendar.HOUR_OF_DAY, hour);
        cal.set(Calendar.MINUTE, minute);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);

        if (intervalDays > 1 && startDate != null && !startDate.isEmpty()) {
            try {
                String[] parts = startDate.split("-");
                int sy = Integer.parseInt(parts[0]);
                int sm = Integer.parseInt(parts[1]);
                int sd = Integer.parseInt(parts[2]);
                for (int i = 0; i <= intervalDays; i++) {
                    Calendar candidate = (Calendar) cal.clone();
                    candidate.add(Calendar.DAY_OF_YEAR, i);
                    long diff = daysBetween(sy, sm, sd, candidate);
                    if (diff >= 0 && diff % intervalDays == 0 && candidate.getTimeInMillis() > now.getTimeInMillis()) {
                        return candidate.getTimeInMillis();
                    }
                }
            } catch (Exception ignored) {
                // Malformed startDate — fall through to the weekday-based path below rather than
                // crash the alarm entirely.
            }
        }

        if (weekdays == null || weekdays.length == 0 || weekdays.length >= 7) {
            if (cal.getTimeInMillis() <= now.getTimeInMillis()) {
                cal.add(Calendar.DAY_OF_YEAR, 1);
            }
            return cal.getTimeInMillis();
        }

        Set<Integer> targetDays = new HashSet<>();
        for (int w : weekdays) targetDays.add(w + 1); // JS 0=Sun..6=Sat -> Calendar 1=Sun..7=Sat
        for (int i = 0; i < 8; i++) {
            Calendar candidate = (Calendar) cal.clone();
            candidate.add(Calendar.DAY_OF_YEAR, i);
            if (targetDays.contains(candidate.get(Calendar.DAY_OF_WEEK)) && candidate.getTimeInMillis() > now.getTimeInMillis()) {
                return candidate.getTimeInMillis();
            }
        }
        // Unreachable in practice (the 8-day window always contains a match when targetDays is
        // non-empty) — fall back to tomorrow at the target time rather than throw.
        cal.add(Calendar.DAY_OF_YEAR, 1);
        return cal.getTimeInMillis();
    }
}
