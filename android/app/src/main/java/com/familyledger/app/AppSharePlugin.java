package com.familyledger.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * Sends an image straight to ONE specific app (Facebook, Instagram, WhatsApp, X, LinkedIn) instead
 * of Android's generic share sheet — so tapping "Facebook" in Spread the Word / a win share opens
 * Facebook's own composer, and tapping "Instagram" opens Instagram's post / story / reel picker.
 * The image is expected to already be in the app's cache directory (written by the JS side via the
 * Filesystem plugin) and is handed over through the app's FileProvider.
 *
 * If the target app isn't installed this resolves { success:false, reason:"not_installed" } and the
 * JS side falls back to the normal share sheet — it never throws for that case.
 */
@CapacitorPlugin(name = "AppShare")
public class AppSharePlugin extends Plugin {

    @PluginMethod
    public void shareImage(PluginCall call) {
        String packageName = call.getString("package");
        String fileName = call.getString("fileName");
        String text = call.getString("text");
        if (packageName == null || packageName.isEmpty() || fileName == null || fileName.isEmpty()) {
            call.reject("package and fileName are required.");
            return;
        }

        Context context = getContext();
        File file = new File(context.getCacheDir(), fileName);
        if (!file.exists()) {
            call.reject("The image file was not found.");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("image/png");
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.isEmpty()) {
                intent.putExtra(Intent.EXTRA_TEXT, text);
            }
            intent.setPackage(packageName);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

            JSObject result = new JSObject();
            if (intent.resolveActivity(context.getPackageManager()) == null) {
                result.put("success", false);
                result.put("reason", "not_installed");
                call.resolve(result);
                return;
            }
            getActivity().startActivity(intent);
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not open the app: " + e.getMessage());
        }
    }
}
