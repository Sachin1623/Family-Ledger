package com.familyledger.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Shares text only to known AI assistant apps (Gemini, Copilot, ChatGPT, Claude, etc.),
 * instead of Android's normal share sheet which shows every app on the device. Package
 * names are best-effort and may drift as these apps update — any that don't match simply
 * won't appear, so this fails gracefully rather than crashing.
 */
@CapacitorPlugin(name = "AiShare")
public class AiSharePlugin extends Plugin {

    private static final List<String> AI_APP_PACKAGES = Arrays.asList(
        "com.google.android.apps.bard",       // Google Gemini
        "com.google.android.apps.gemini",
        "com.microsoft.copilot",              // Microsoft Copilot
        "com.microsoft.bing",
        "com.openai.chatgpt",                 // ChatGPT
        "com.anthropic.claude",               // Claude
        "com.anthropic.claude.android",
        "com.perplexity.app.android"          // Perplexity (bonus, still an AI assistant)
    );

    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text");
        String title = call.getString("title", "Analyze with AI");

        if (text == null || text.isEmpty()) {
            call.reject("No text provided to share.");
            return;
        }

        Intent baseIntent = new Intent(Intent.ACTION_SEND);
        baseIntent.setType("text/plain");
        baseIntent.putExtra(Intent.EXTRA_TEXT, text);

        PackageManager pm = getActivity().getPackageManager();
        List<ResolveInfo> candidates = pm.queryIntentActivities(baseIntent, 0);

        List<Intent> matchedIntents = new ArrayList<>();
        List<String> matchedPackages = new ArrayList<>();
        for (ResolveInfo info : candidates) {
            String pkg = info.activityInfo.packageName;
            if (AI_APP_PACKAGES.contains(pkg) && !matchedPackages.contains(pkg)) {
                Intent targeted = new Intent(baseIntent);
                targeted.setPackage(pkg);
                matchedIntents.add(targeted);
                matchedPackages.add(pkg);
            }
        }

        JSObject result = new JSObject();

        if (matchedIntents.isEmpty()) {
            result.put("success", false);
            result.put("reason", "no_ai_app_installed");
            call.resolve(result);
            return;
        }

        Intent chooserIntent = Intent.createChooser(matchedIntents.remove(0), title);
        if (!matchedIntents.isEmpty()) {
            chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, matchedIntents.toArray(new Intent[0]));
        }
        chooserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(chooserIntent);

        result.put("success", true);
        result.put("matchedApps", matchedPackages.size());
        call.resolve(result);
    }
}
