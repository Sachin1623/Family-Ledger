package com.familyledger.app;

import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AiSharePlugin.class);
        registerPlugin(AppSharePlugin.class);
        registerPlugin(ReceiptSharePlugin.class);
        registerPlugin(AlarmClockPlugin.class);
        registerPlugin(AppPermissionsPlugin.class);
        registerPlugin(SpeechRecognitionPlugin.class);
        super.onCreate(savedInstanceState);
        installBrandFiles();
    }

    // The app loads its screens from the live website, but a few small brand files (the animated icon video and its first picture, under /brand/)
    // are packed inside the app itself. Requests for them are answered from the app's own files, so they never travel over the network and never
    // touch the server. If a file is not packed in (an older build), the request simply goes to the website as before.
    private void installBrandFiles() {
        final Bridge appBridge = this.bridge;
        if (appBridge == null) return;
        appBridge.setWebViewClient(new BridgeWebViewClient(appBridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = brandResponse(appBridge, request);
                return local != null ? local : super.shouldInterceptRequest(view, request);
            }
        });
    }

    private WebResourceResponse brandResponse(Bridge appBridge, WebResourceRequest request) {
        try {
            if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
            Uri uri = request.getUrl();
            String path = uri.getPath();
            if (path == null || !path.startsWith("/brand/") || path.contains("..")) return null;
            // only for the app's own address (the live site, or the test server), never for another website
            String appHost = Uri.parse(appBridge.getAppUrl()).getHost();
            if (appHost == null || !appHost.equalsIgnoreCase(uri.getHost())) return null;

            String name = path.substring("/brand/".length());
            String mime;
            if (name.endsWith(".mp4")) mime = "video/mp4";
            else if (name.endsWith(".webp")) mime = "image/webp";
            else if (name.endsWith(".png")) mime = "image/png";
            else return null;

            AssetManager assets = getAssets();
            byte[] data;
            try (InputStream in = assets.open("public/brand/" + name)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > 4 * 1024 * 1024) return null; // these files are small; anything big goes to the website
                }
                data = out.toByteArray();
            }

            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "public, max-age=31536000, immutable");
            String range = request.getRequestHeaders() != null ? request.getRequestHeaders().get("Range") : null;
            if (range != null && range.startsWith("bytes=")) {
                // the video player asks for pieces of the file; answer exactly the piece it asked for
                String[] parts = range.substring(6).split("-", 2);
                int start = parts[0].isEmpty() ? 0 : Integer.parseInt(parts[0].trim());
                int end = parts.length > 1 && !parts[1].trim().isEmpty() ? Integer.parseInt(parts[1].trim()) : data.length - 1;
                if (end >= data.length) end = data.length - 1;
                if (start > end) start = 0;
                int length = end - start + 1;
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + data.length);
                headers.put("Content-Length", String.valueOf(length));
                return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new ByteArrayInputStream(data, start, length));
            }
            headers.put("Content-Length", String.valueOf(data.length));
            return new WebResourceResponse(mime, null, 200, "OK", headers, new ByteArrayInputStream(data));
        } catch (Exception e) {
            return null; // not packed in, or unreadable: fall back to the website
        }
    }
}
