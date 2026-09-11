package com.familyledger.app;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS-facing bridge for the "some permissions are missing" reminder (see
 * src/components/AppPermissionsReminder.tsx). Reports current grant status for the handful of
 * permissions this app actually asks for, and opens the right OS settings screen to fix each one.
 * There's no single Capacitor-core API covering all of these together — notifications, contacts,
 * and microphone are ordinary runtime permissions, while exact-alarm scheduling and the battery-
 * optimization exemption are special OS-level toggles that live on their own dedicated Settings
 * screens, reachable only via specific Intent actions, not a permission request dialog.
 */
@CapacitorPlugin(name = "AppPermissions")
public class AppPermissionsPlugin extends Plugin {

    @PluginMethod
    public void checkAll(PluginCall call) {
        Context ctx = getContext();
        JSObject result = new JSObject();
        result.put("notifications", granted(ctx, Manifest.permission.POST_NOTIFICATIONS, Build.VERSION_CODES.TIRAMISU));
        result.put("contacts", granted(ctx, Manifest.permission.READ_CONTACTS, 0));
        result.put("microphone", granted(ctx, Manifest.permission.RECORD_AUDIO, 0));
        result.put("exactAlarm", canScheduleExactAlarms(ctx));
        result.put("batteryOptimization", isIgnoringBatteryOptimizations(ctx));
        call.resolve(result);
    }

    // `minSdk` = the API level this permission first became a runtime permission at all; below
    // that, Android grants it automatically at install time and there's nothing to check.
    private boolean granted(Context ctx, String permission, int minSdk) {
        if (minSdk > 0 && Build.VERSION.SDK_INT < minSdk) return true;
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean canScheduleExactAlarms(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true; // no such restriction pre-Android 12
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private boolean isIgnoringBatteryOptimizations(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + ctx.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                ctx.startActivity(intent);
                call.resolve();
                return;
            } catch (Exception e) {
                // Some OEM builds don't expose this screen despite advertising the API — fall
                // back to the general app settings page rather than failing the request.
            }
        }
        openAppSettings(call);
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                ctx.startActivity(intent);
                call.resolve();
                return;
            } catch (Exception e) {
                // Same OEM-quirk fallback as above.
            }
        }
        openAppSettings(call);
    }
}
