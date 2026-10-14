package com.familyledger.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONObject;

/**
 * Receives a payment receipt shared to FamilyLedger from another app (PhonePe …) through Android's
 * share menu, reads the text in it ON THE PHONE (Google ML Kit text recognition — no network, nothing
 * is uploaded) and hands the result to the web layer.
 *
 * The shared file is read straight from the sender's content:// URI into memory and is never written
 * to disk by us — once the text is read, only the text goes on to JS. (Android only lets us read the
 * URI for a short while after the share, so we do it immediately.)
 *
 * What arrives is deliberately reported in full (mime type, name, size, sender, any shared text) so
 * this early version can show what each payment app really sends.
 */
@CapacitorPlugin(name = "ReceiptShare")
public class ReceiptSharePlugin extends Plugin {

    private static final int MAX_IMAGE_SIDE = 2600;
    private static final String HANDLED_FLAG = "fl_receipt_handled";

    // A share that arrived before the web layer was listening (cold start); handed over by getPendingShare().
    private JSObject pending;

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (isShare(intent)) process(intent, false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isShare(intent)) process(intent, true);
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject result = pending != null ? pending : new JSObject();
        pending = null;
        call.resolve(result);
    }

    private boolean isShare(Intent intent) {
        return intent != null && Intent.ACTION_SEND.equals(intent.getAction());
    }

    private Uri streamOf(Intent intent) {
        Uri uri;
        if (Build.VERSION.SDK_INT >= 33) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) uri = clip.getItemAt(0).getUri();
        }
        return uri;
    }

    private void process(final Intent intent, final boolean live) {
        // The same Intent can be handed to us again (e.g. the screen is rotated) — only handle it once.
        if (intent.getBooleanExtra(HANDLED_FLAG, false)) return;
        intent.putExtra(HANDLED_FLAG, true);

        final JSObject out = new JSObject();
        // Lets the web layer tell a new build from an old one (and a failed picture from a missing feature).
        out.put("pluginVersion", 3);
        String type = intent.getType();
        out.put("action", intent.getAction());
        out.put("mime", type == null ? "" : type);

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null) out.put("text", text);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null) out.put("subject", subject);
        try {
            Uri ref = getActivity().getReferrer();
            if (ref != null) out.put("referrer", ref.toString());
        } catch (Exception ignored) {
            // best effort — not every sender provides one
        }

        final Uri uri = streamOf(intent);
        if (uri == null) {
            out.put("kind", "text");
            deliver(out, live);
            return;
        }

        new Thread(() -> {
            try {
                Bitmap bmp = loadBitmap(uri, out);
                if (bmp == null) {
                    deliver(out, live);
                    return;
                }
                final long t0 = SystemClock.elapsedRealtime();
                final TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                final Bitmap finalBmp = bmp;
                recognizer
                    .process(InputImage.fromBitmap(bmp, 0))
                    .addOnSuccessListener(visionText -> {
                        try {
                            JSArray lines = new JSArray();
                            for (Text.TextBlock block : visionText.getTextBlocks()) {
                                for (Text.Line line : block.getLines()) {
                                    Rect box = line.getBoundingBox();
                                    JSONObject l = new JSONObject();
                                    l.put("text", line.getText());
                                    l.put("top", box != null ? box.top : 0);
                                    l.put("left", box != null ? box.left : 0);
                                    l.put("bottom", box != null ? box.bottom : 0);
                                    l.put("right", box != null ? box.right : 0);
                                    lines.put(l);
                                }
                            }
                            out.put("ocrText", visionText.getText());
                            out.put("lines", lines);
                        } catch (Exception e) {
                            out.put("error", "ocr-result: " + e);
                        }
                        out.put("ocrMs", SystemClock.elapsedRealtime() - t0);
                        attachImage(out, finalBmp);
                        finalBmp.recycle();
                        recognizer.close();
                        deliver(out, live);
                    })
                    .addOnFailureListener(e -> {
                        out.put("error", "ocr: " + e);
                        attachImage(out, finalBmp);
                        finalBmp.recycle();
                        recognizer.close();
                        deliver(out, live);
                    });
            } catch (Exception e) {
                out.put("error", "read: " + e);
                deliver(out, live);
            }
        }).start();
    }

    /** Reads the shared file into a bitmap (image, or the first page of a PDF) and records what it was. */
    private Bitmap loadBitmap(Uri uri, JSObject out) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String mime = resolver.getType(uri);
        if (mime != null) out.put("mime", mime);

        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0) out.put("name", c.getString(n));
                if (s >= 0 && !c.isNull(s)) out.put("sizeBytes", c.getLong(s));
            }
        } catch (Exception ignored) {
            // some senders don't answer the query — we still try to read the file
        }

        String name = out.optString("name", "").toLowerCase();
        boolean isPdf = "application/pdf".equals(mime) || name.endsWith(".pdf");
        boolean isImage = mime != null && mime.startsWith("image/");

        if (isPdf) {
            out.put("kind", "pdf");
            try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                if (pfd == null) {
                    out.put("error", "pdf: could not open");
                    return null;
                }
                PdfRenderer renderer = new PdfRenderer(pfd);
                out.put("pages", renderer.getPageCount());
                PdfRenderer.Page page = renderer.openPage(0);
                int width = 1500;
                int height = Math.max(1, Math.round((float) page.getHeight() * width / page.getWidth()));
                Bitmap bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                new Canvas(bmp).drawColor(Color.WHITE);
                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                page.close();
                renderer.close();
                out.put("width", width);
                out.put("height", height);
                return bmp;
            }
        }

        if (isImage || mime == null) {
            out.put("kind", "image");
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = resolver.openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_SIDE) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = resolver.openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) {
                out.put("error", "image: could not decode");
                return null;
            }
            out.put("width", bmp.getWidth());
            out.put("height", bmp.getHeight());
            return bmp;
        }

        out.put("kind", "file");
        return null;
    }

    /**
     * A small compressed copy of the receipt (long side 1100 px, JPEG) so the web layer can attach it to the
     * expense the user creates — same size class as the other receipt photos kept with expenses.
     */
    private void attachImage(JSObject out, Bitmap bmp) {
        try {
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            float scale = Math.min(1f, 1100f / Math.max(w, h));
            Bitmap small = scale < 1f ? Bitmap.createScaledBitmap(bmp, Math.round(w * scale), Math.round(h * scale), true) : bmp;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 62, bytes);
            String data = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
            out.put("imageData", "data:image/jpeg;base64," + data);
            out.put("imageChars", data.length());
            if (small != bmp) small.recycle();
        } catch (Exception e) {
            out.put("imageError", e.toString());
        }
    }

    private void deliver(JSObject out, boolean live) {
        if (live && hasListeners("receiptShared")) {
            notifyListeners("receiptShared", out, true);
        } else {
            pending = out;
        }
    }
}
