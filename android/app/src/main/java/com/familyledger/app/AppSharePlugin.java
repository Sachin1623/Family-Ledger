package com.familyledger.app;

import android.content.Context;
import android.content.Intent;
import android.content.ClipData;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;
import org.json.JSONArray;

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

    /**
     * Several pictures in one share. With a package it opens that app directly (WhatsApp, Instagram, Facebook ...); without one it
     * shows the phone's share sheet. The pictures are typed image/* so the receiving app treats them as pictures (Capacitor's own
     * Share plugin types a multi-file share as */*, which WhatsApp answers by keeping only the caption).
     */
    @PluginMethod
    public void shareImages(PluginCall call) {
        String packageName = call.getString("package");
        String text = call.getString("text");
        JSONArray names = call.getArray("fileNames");
        if (names == null || names.length() == 0) {
            call.reject("fileNames are required.");
            return;
        }
        Context context = getContext();
        try {
            ArrayList<Uri> uris = new ArrayList<>();
            for (int i = 0; i < names.length(); i++) {
                File file = new File(context.getCacheDir(), names.getString(i));
                if (!file.exists()) {
                    call.reject("An image file was not found.");
                    return;
                }
                uris.add(FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file));
            }
            Intent intent = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
            intent.setType("image/*");
            if (uris.size() > 1) {
                intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            } else {
                intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            }
            if (text != null && !text.isEmpty()) {
                intent.putExtra(Intent.EXTRA_TEXT, text);
            }
            ClipData clip = ClipData.newRawUri("", uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            intent.setClipData(clip);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            JSObject result = new JSObject();
            if (packageName != null && !packageName.isEmpty()) {
                intent.setPackage(packageName);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (intent.resolveActivity(context.getPackageManager()) == null) {
                    result.put("success", false);
                    result.put("reason", "not_installed");
                    call.resolve(result);
                    return;
                }
                getActivity().startActivity(intent);
            } else {
                Intent chooser = Intent.createChooser(intent, "Share my recap");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(chooser);
            }
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not share the pictures: " + e.getMessage());
        }
    }

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

    /**
     * Opens Instagram's Story composer with the picture as the background and a sticker on top (the page handle). When a
     * Facebook app id is supplied, Instagram shows a "from FamilyLedger" attribution on the story.
     */
    @PluginMethod
    public void shareInstagramStory(PluginCall call) {
        String backgroundFile = call.getString("backgroundFile");
        String stickerFile = call.getString("stickerFile");
        String appId = call.getString("appId");
        String topColor = call.getString("topColor");
        String bottomColor = call.getString("bottomColor");
        if (backgroundFile == null || backgroundFile.isEmpty()) {
            call.reject("backgroundFile is required.");
            return;
        }
        Context context = getContext();
        File bg = new File(context.getCacheDir(), backgroundFile);
        if (!bg.exists()) {
            call.reject("The image file was not found.");
            return;
        }
        try {
            String authority = context.getPackageName() + ".fileprovider";
            Uri bgUri = FileProvider.getUriForFile(context, authority, bg);
            Intent intent = new Intent("com.instagram.share.ADD_TO_STORY");
            intent.setDataAndType(bgUri, "image/png");
            intent.setPackage("com.instagram.android");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            if (appId != null && !appId.isEmpty()) {
                intent.putExtra("source_application", appId);
            }
            if (topColor != null && !topColor.isEmpty()) intent.putExtra("top_background_color", topColor);
            if (bottomColor != null && !bottomColor.isEmpty()) intent.putExtra("bottom_background_color", bottomColor);
            context.grantUriPermission("com.instagram.android", bgUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (stickerFile != null && !stickerFile.isEmpty()) {
                File sticker = new File(context.getCacheDir(), stickerFile);
                if (sticker.exists()) {
                    Uri stickerUri = FileProvider.getUriForFile(context, authority, sticker);
                    intent.putExtra("interactive_asset_uri", stickerUri);
                    context.grantUriPermission("com.instagram.android", stickerUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
            }
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
            call.reject("Could not open Instagram Stories: " + e.getMessage());
        }
    }

    /** Opens Facebook's Story composer with the picture as background and a "Like our page" sticker on top. */
    @PluginMethod
    public void shareFacebookStory(PluginCall call) {
        String backgroundFile = call.getString("backgroundFile");
        String stickerFile = call.getString("stickerFile");
        String appId = call.getString("appId");
        String topColor = call.getString("topColor");
        String bottomColor = call.getString("bottomColor");
        if (backgroundFile == null || backgroundFile.isEmpty() || appId == null || appId.isEmpty()) {
            call.reject("backgroundFile and appId are required.");
            return;
        }
        Context context = getContext();
        File bg = new File(context.getCacheDir(), backgroundFile);
        if (!bg.exists()) {
            call.reject("The image file was not found.");
            return;
        }
        try {
            String authority = context.getPackageName() + ".fileprovider";
            Uri bgUri = FileProvider.getUriForFile(context, authority, bg);
            Intent intent = new Intent("com.facebook.stories.ADD_TO_STORY");
            intent.setDataAndType(bgUri, "image/png");
            intent.setPackage("com.facebook.katana");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.putExtra("com.facebook.platform.extra.APPLICATION_ID", appId);
            if (topColor != null && !topColor.isEmpty()) intent.putExtra("top_background_color", topColor);
            if (bottomColor != null && !bottomColor.isEmpty()) intent.putExtra("bottom_background_color", bottomColor);
            context.grantUriPermission("com.facebook.katana", bgUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (stickerFile != null && !stickerFile.isEmpty()) {
                File sticker = new File(context.getCacheDir(), stickerFile);
                if (sticker.exists()) {
                    Uri stickerUri = FileProvider.getUriForFile(context, authority, sticker);
                    intent.putExtra("interactive_asset_uri", stickerUri);
                    context.grantUriPermission("com.facebook.katana", stickerUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
            }
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
            call.reject("Could not open Facebook Stories: " + e.getMessage());
        }
    }
}
