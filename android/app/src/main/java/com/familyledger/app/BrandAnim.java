package com.familyledger.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Outline;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.VideoView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * The FamilyLedger icon animation (the same short video the app's header and loading screen play: the family icon opens into the ledger and
 * closes back into the icon), as a small rounded square for the native alarm screens. The video and its first picture are packed in the app
 * (assets/public/brand); the picture shows at once and the video takes over as soon as it renders, looping silently. If anything fails, the
 * picture simply stays.
 */
final class BrandAnim {
    private static final String VIDEO = "icon-anim-v1.mp4";
    private static final String POSTER = "icon-poster-v1.webp";

    private BrandAnim() {}

    static View create(Context context, int sizeDp) {
        final int px = Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, sizeDp, context.getResources().getDisplayMetrics()));
        final float radius = px * 0.22f;

        FrameLayout box = new FrameLayout(context);
        box.setLayoutParams(new ViewGroup.LayoutParams(px, px));
        box.setClipToOutline(true);
        box.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), radius);
            }
        });

        final ImageView poster = new ImageView(context);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        try (InputStream in = context.getAssets().open("public/brand/" + POSTER)) {
            Bitmap bmp = BitmapFactory.decodeStream(in);
            if (bmp != null) poster.setImageBitmap(bmp);
            else poster.setImageResource(R.mipmap.ic_launcher_round);
        } catch (Exception e) {
            poster.setImageResource(R.mipmap.ic_launcher_round);
        }
        box.addView(poster, new FrameLayout.LayoutParams(px, px));

        try {
            File file = new File(context.getCacheDir(), VIDEO);
            if (!file.exists() || file.length() == 0) {
                try (InputStream in = context.getAssets().open("public/brand/" + VIDEO); FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
            final VideoView video = new VideoView(context);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) video.setAudioFocusRequest(AudioManager.AUDIOFOCUS_NONE); // silent: never disturb the alarm sound
            video.setOnPreparedListener(mp -> {
                mp.setVolume(0f, 0f);
                mp.setLooping(true);
                mp.setOnInfoListener((player, what, extra) -> {
                    if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) poster.setVisibility(View.GONE);
                    return false;
                });
            });
            video.setOnErrorListener((mp, what, extra) -> {
                video.setVisibility(View.GONE); // the picture stays
                return true;
            });
            video.setVideoURI(Uri.fromFile(file));
            box.addView(video, new FrameLayout.LayoutParams(px, px));
            video.start();
        } catch (Exception ignored) {
            // no video: the first picture stays
        }
        return box;
    }
}
