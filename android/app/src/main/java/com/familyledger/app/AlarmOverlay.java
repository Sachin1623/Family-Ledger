package com.familyledger.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The ringing alarm's pop-up card: a banner drawn over whatever is on screen (another app, the home
 * screen, this app) with the medicine's name and big Snooze / Dismiss buttons, for as long as the
 * alarm rings. It works when the app is not running, because the ringing service draws it, not the
 * web page. It needs the person to have switched on "Display over other apps" for FamilyLedger once
 * (the app asks, see AppPermissionsPlugin); without that, only the notification shows, as before.
 * It does not cover the lock screen (Android never draws these over it); the notification with the
 * same two buttons is what shows there.
 */
final class AlarmOverlay {
    private static View view;
    private static WindowManager manager;

    private AlarmOverlay() {}

    static boolean canShow(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    private static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    static synchronized void show(final Context context, int id, String title, String body, String route) {
        hide();
        if (!canShow(context)) return;
        try {
            final WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm == null) return;

            FrameLayout wrapper = new FrameLayout(context);
            wrapper.setPadding(dp(context, 12), 0, dp(context, 12), 0);

            LinearLayout card = new LinearLayout(context);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.WHITE);
            bg.setCornerRadius(dp(context, 22));
            bg.setStroke(dp(context, 2), Color.parseColor("#4ADE80"));
            card.setBackground(bg);
            card.setElevation(dp(context, 14));

            TextView heading = new TextView(context);
            heading.setText("⏰  " + (title == null || title.isEmpty() ? "Reminder" : title));
            heading.setTextColor(Color.parseColor("#0F172A"));
            heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            heading.setTypeface(Typeface.DEFAULT_BOLD);
            card.addView(heading);

            if (body != null && !body.isEmpty()) {
                TextView text = new TextView(context);
                text.setText(body);
                text.setTextColor(Color.parseColor("#334155"));
                text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
                text.setPadding(0, dp(context, 4), 0, 0);
                card.addView(text);
            }

            // Four buttons: Snooze and Dismiss, then Open app and (for medicine alarms) Mark taken. "Mark taken" opens the app on the Medicines
            // page with the doses of this alarm to tick off; "Open app" opens it without ticking anything.
            final String openPath = route == null || route.isEmpty() ? "/health/medicines" : (route.indexOf('?') >= 0 ? route.substring(0, route.indexOf('?')) : route);
            final boolean canMark = route != null && route.contains("markTaken=");
            LinearLayout row1 = new LinearLayout(context);
            row1.setOrientation(LinearLayout.HORIZONTAL);
            row1.setPadding(0, dp(context, 12), 0, 0);
            row1.addView(button(context, "Snooze 10 min", false, v -> sendToService(context, AlarmRingingService.ACTION_SNOOZE)), new LinearLayout.LayoutParams(0, dp(context, 46), 1f));
            row1.addView(new View(context), new LinearLayout.LayoutParams(dp(context, 10), 1));
            row1.addView(button(context, "Dismiss", true, v -> sendToService(context, AlarmRingingService.ACTION_STOP)), new LinearLayout.LayoutParams(0, dp(context, 46), 1f));
            card.addView(row1);

            LinearLayout row2 = new LinearLayout(context);
            row2.setOrientation(LinearLayout.HORIZONTAL);
            row2.setPadding(0, dp(context, 8), 0, 0);
            row2.addView(button(context, "Open app", false, v -> {
                sendToService(context, AlarmRingingService.ACTION_STOP);
                openApp(context, openPath);
            }), new LinearLayout.LayoutParams(0, dp(context, 46), 1f));
            if (canMark) {
                row2.addView(new View(context), new LinearLayout.LayoutParams(dp(context, 10), 1));
                final String markPath = route;
                row2.addView(button(context, "Mark taken ✓", true, v -> {
                    sendToService(context, AlarmRingingService.ACTION_STOP);
                    openApp(context, markPath);
                }), new LinearLayout.LayoutParams(0, dp(context, 46), 1f));
            }
            card.addView(row2);

            wrapper.addView(card, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(context, 44); // below the status bar

            wm.addView(wrapper, lp);
            wrapper.setTranslationY(-dp(context, 160));
            wrapper.animate().translationY(0).setDuration(260).start();
            view = wrapper;
            manager = wm;
        } catch (Exception ignored) {
            // a phone that refuses overlay windows: the notification and the alarm screen still work
        }
    }

    private static void sendToService(Context context, String action) {
        try {
            context.startService(new Intent(context, AlarmRingingService.class).setAction(action));
        } catch (Exception ignored) {
            /* if the service is already gone the alarm is already over */
        }
    }

    // Opens the app on a page (same deep-link route the alarm screen's own "Open app" button uses).
    private static void openApp(Context context, String path) {
        try {
            Intent launch = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://familyledger.thirteenapps.com" + path));
            launch.setClass(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(launch);
        } catch (Exception ignored) {
            /* nothing more to do */
        }
    }

    private static TextView button(final Context context, String label, boolean primary, View.OnClickListener onClick) {
        TextView b = new TextView(context);
        b.setText(label);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(context, 14));
        if (primary) {
            bg.setColor(Color.parseColor("#1E3A8A"));
            b.setTextColor(Color.WHITE);
        } else {
            bg.setColor(Color.parseColor("#EEF2FF"));
            b.setTextColor(Color.parseColor("#1E3A8A"));
        }
        b.setBackground(bg);
        b.setOnClickListener(onClick);
        return b;
    }

    static synchronized void hide() {
        try {
            if (view != null && manager != null) manager.removeView(view);
        } catch (Exception ignored) {
            /* already removed */
        }
        view = null;
        manager = null;
    }
}
