package com.familyledger.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;

/**
 * "Talk to add an expense": listens with the phone's own speech recogniser and reports back as it hears, and says exactly what went wrong
 * when it cannot hear (permission, no speech service, no network, recogniser busy ...) instead of failing silently.
 *
 * One recogniser object is kept and reused for every listening session (Google's recommended pattern). Creating and destroying a new one for
 * every session — what an earlier version did — makes the phone's speech service drop its connection (error 11), report "no match" at once,
 * or sit "listening" without really recording. The recogniser is only thrown away and rebuilt after a real fault.
 *
 * Events sent to the web app:
 *   listeningState {status: "ready" | "started" | "speechEnd"}   "ready" means the microphone really is recording
 *   partialResults {matches: [text...]}   words heard so far
 *   results        {matches: [text...]}   the final words (arrive AFTER speechEnd), best guess first
 *   error          {code, message}        the recogniser gave up
 *
 * Nothing is recorded or kept by FamilyLedger; the audio goes only to the phone's speech service (Google's on Android).
 */
@CapacitorPlugin(
    name = "SpeechRecognition",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "speechRecognition") }
)
public class SpeechRecognitionPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private final Handler main = new Handler(Looper.getMainLooper());
    // True from the moment a session starts until it ends (final result, error or cancel). Callbacks that arrive while false belong to a
    // session that has already finished and are ignored.
    private boolean active = false;
    private Runnable pendingStart;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(permissionStatus());
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            call.resolve(permissionStatus());
            return;
        }
        requestPermissionForAlias("speechRecognition", call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        call.resolve(permissionStatus());
    }

    private JSObject permissionStatus() {
        JSObject ret = new JSObject();
        PermissionState state = getPermissionState("speechRecognition");
        ret.put("speechRecognition", state == null ? "prompt" : state.toString());
        return ret;
    }

    /**
     * Listen through the phone's own "Speak now" box (the system speech dialog) and return what was heard when it closes. Unlike the inline
     * recogniser below, the dialog manages the microphone itself — it keeps listening, offers its own retry, and never leaves the app
     * "listening" with the microphone off — which is what made the inline version flip on and off. No live words, but a steady result.
     */
    @PluginMethod
    public void listenDialog(PluginCall call) {
        String language = call.getString("language", "en-IN");
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, call.getInt("maxResults", 5));
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // Give a person a moment between words before the box decides they have finished.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
        String prompt = call.getString("prompt");
        if (prompt != null) intent.putExtra(RecognizerIntent.EXTRA_PROMPT, prompt);
        try {
            startActivityForResult(call, intent, "dialogResult");
        } catch (Exception e) {
            call.reject("No speech dialog on this phone: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void dialogResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        ArrayList<String> matches = null;
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            matches = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        }
        ret.put("matches", new org.json.JSONArray(matches == null ? new ArrayList<String>() : matches));
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        final String language = call.getString("language", "en-IN");
        final int maxResults = call.getInt("maxResults", 5);
        bridge.getActivity().runOnUiThread(() -> {
            try {
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    call.reject("No speech recognition service on this phone.");
                    return;
                }
                if (pendingStart != null) main.removeCallbacks(pendingStart);
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                    recognizer.setRecognitionListener(new Listener());
                } else {
                    active = false;
                    recognizer.cancel(); // end whatever the previous session was doing, but keep the recogniser
                }

                final Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                // Give a person a moment between words before the recogniser decides they have finished.
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);

                // A short pause after cancel() lets the speech service settle before it is asked to listen again.
                pendingStart = () -> {
                    pendingStart = null;
                    try {
                        if (recognizer == null) return;
                        active = true;
                        recognizer.startListening(intent);
                    } catch (Exception e) {
                        active = false;
                        sendError(-1, "could not start: " + e.getMessage());
                    }
                };
                main.postDelayed(pendingStart, 300);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start listening: " + e.getMessage());
            }
        });
    }

    /** Stop listening but still deliver the final words (the person pressed Done). */
    @PluginMethod
    public void stop(PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            try {
                if (recognizer != null && active) recognizer.stopListening();
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /** Abandon the session without any result (the sheet was closed). */
    @PluginMethod
    public void cancel(PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            if (pendingStart != null) {
                main.removeCallbacks(pendingStart);
                pendingStart = null;
            }
            try {
                if (recognizer != null && active) recognizer.cancel();
            } catch (Exception ignored) {}
            active = false;
            call.resolve();
        });
    }

    private void destroyRecognizer() {
        active = false;
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {}
            recognizer = null;
        }
    }

    // ── Recording a short voice note natively (for the voice-to-expense service) ──────────────────────────────────────────────────────
    // Done here rather than in the web page because a page opened over plain http (the local test setup) is not allowed to use the
    // microphone at all, and because this works the same on every phone. The audio is raw 16 kHz mono, sent to the page as a small WAV.
    private static final int REC_RATE = 16000;
    private AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean recording = false;
    private volatile boolean recHeardVoice = false;
    private volatile double recPeak = 0;
    private ByteArrayOutputStream recBytes;
    private long recStartedAt;

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("speechRecognition", call, "recordPermissionDone");
            return;
        }
        beginRecording(call);
    }

    @PermissionCallback
    private void recordPermissionDone(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            beginRecording(call);
        } else {
            call.reject("microphone permission denied");
        }
    }

    private void beginRecording(PluginCall call) {
        stopRecordingThread();
        final long silenceMs = call.getInt("silenceMs", 1400);
        final long giveUpMs = call.getInt("giveUpMs", 9000);
        final long maxMs = call.getInt("maxMs", 20000);
        int minBuf = AudioRecord.getMinBufferSize(REC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuf <= 0) {
            call.reject("this phone cannot record audio");
            return;
        }
        try {
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, REC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4);
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release();
                audioRecord = null;
                call.reject("the microphone could not be opened");
                return;
            }
        } catch (Exception e) {
            call.reject("the microphone could not be opened: " + e.getMessage());
            return;
        }
        recBytes = new ByteArrayOutputStream();
        recHeardVoice = false;
        recPeak = 0;
        recording = true;
        recStartedAt = System.currentTimeMillis();
        final AudioRecord rec = audioRecord;
        rec.startRecording();
        recordThread = new Thread(() -> {
            short[] buf = new short[1600]; // 100 ms
            long lastVoiceAt = 0;
            long lastLevelSent = 0;
            boolean endedSent = false;
            // The room's own background loudness, learned from the first half second, so speech is judged against it. A fixed loudness
            // limit missed quiet voices on some phones (the recorder then never noticed anyone speaking and gave up).
            double noiseFloor = 1;
            int calibrated = 0;
            int voiceBuffers = 0;
            while (recording) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                double sum = 0;
                byte[] bytes = new byte[n * 2];
                for (int i = 0; i < n; i++) {
                    sum += (buf[i] / 32768.0) * (buf[i] / 32768.0);
                    bytes[i * 2] = (byte) (buf[i] & 0xff);
                    bytes[i * 2 + 1] = (byte) ((buf[i] >> 8) & 0xff);
                }
                synchronized (recBytes) { recBytes.write(bytes, 0, bytes.length); }
                double rms = Math.sqrt(sum / n);
                long now = System.currentTimeMillis();
                double peakNow = 0;
                for (int i = 0; i < n; i++) peakNow = Math.max(peakNow, Math.abs(buf[i] / 32768.0));
                if (peakNow > recPeak) recPeak = peakNow;
                if (rms > 0.00005) noiseFloor = Math.min(noiseFloor, rms);
                calibrated++;
                double threshold = Math.max(0.008, noiseFloor * 3.0);
                if (calibrated >= 3 && rms > threshold) {
                    voiceBuffers++;
                    if (voiceBuffers >= 2) { recHeardVoice = true; lastVoiceAt = now; }
                }
                if (now - lastLevelSent > 90) {
                    lastLevelSent = now;
                    JSObject o = new JSObject();
                    o.put("level", Math.min(1.0, rms * 14));
                    notifyListeners("recordingLevel", o);
                }
                String reason = null;
                if (recHeardVoice && now - lastVoiceAt > silenceMs) reason = "silence";
                else if (!recHeardVoice && now - recStartedAt > giveUpMs) reason = "nothing";
                else if (now - recStartedAt > maxMs) reason = "max";
                if (reason != null && !endedSent) {
                    endedSent = true;
                    JSObject o = new JSObject();
                    o.put("reason", reason);
                    notifyListeners("recordingEnded", o);
                }
            }
        }, "fl-voice-record");
        recordThread.start();
        call.resolve();
    }

    private void stopRecordingThread() {
        recording = false;
        if (recordThread != null) {
            try { recordThread.join(400); } catch (InterruptedException ignored) {}
            recordThread = null;
        }
        if (audioRecord != null) {
            try { audioRecord.stop(); } catch (Exception ignored) {}
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
        }
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        long durationMs = System.currentTimeMillis() - recStartedAt;
        stopRecordingThread();
        byte[] pcm;
        if (recBytes == null) {
            pcm = new byte[0];
        } else {
            synchronized (recBytes) { pcm = recBytes.toByteArray(); }
        }
        recBytes = null;
        // A quiet voice is lifted to a good level (never more than 20x) so the speech model hears it clearly.
        if (recPeak > 0.01 && recPeak < 0.6) {
            double gain = Math.min(20.0, 0.7 / recPeak);
            for (int i = 0; i + 1 < pcm.length; i += 2) {
                int v = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
                v = (int) Math.max(-32768, Math.min(32767, Math.round(v * gain)));
                pcm[i] = (byte) (v & 0xff);
                pcm[i + 1] = (byte) ((v >> 8) & 0xff);
            }
        }
        byte[] wav = new byte[44 + pcm.length];
        int dataLen = pcm.length;
        writeWavHeader(wav, dataLen);
        System.arraycopy(pcm, 0, wav, 44, dataLen);
        JSObject ret = new JSObject();
        ret.put("wavBase64", Base64.encodeToString(wav, Base64.NO_WRAP));
        ret.put("durationMs", durationMs);
        ret.put("peak", recPeak);
        // Even if the loudness check never fired, a recording with a clearly audible peak is worth sending: the model decides.
        ret.put("heardVoice", recHeardVoice || recPeak > 0.05);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        stopRecordingThread();
        recBytes = null;
        call.resolve();
    }

    private static void writeWavHeader(byte[] h, int dataLen) {
        int total = 36 + dataLen;
        byte[] riff = {'R', 'I', 'F', 'F'};
        System.arraycopy(riff, 0, h, 0, 4);
        putInt(h, 4, total);
        byte[] wave = {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '};
        System.arraycopy(wave, 0, h, 8, 8);
        putInt(h, 16, 16);
        h[20] = 1; h[21] = 0; // PCM
        h[22] = 1; h[23] = 0; // mono
        putInt(h, 24, REC_RATE);
        putInt(h, 28, REC_RATE * 2);
        h[32] = 2; h[33] = 0;
        h[34] = 16; h[35] = 0;
        byte[] data = {'d', 'a', 't', 'a'};
        System.arraycopy(data, 0, h, 36, 4);
        putInt(h, 40, dataLen);
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    @Override
    protected void handleOnDestroy() {
        stopRecordingThread();
        destroyRecognizer();
        super.handleOnDestroy();
    }

    private void sendState(String status) {
        JSObject o = new JSObject();
        o.put("status", status);
        notifyListeners("listeningState", o);
    }

    private void sendMatches(String event, Bundle bundle) {
        ArrayList<String> matches = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return;
        JSObject o = new JSObject();
        o.put("matches", new org.json.JSONArray(matches));
        notifyListeners(event, o);
    }

    private void sendError(int code, String message) {
        JSObject o = new JSObject();
        o.put("code", code);
        o.put("message", message);
        notifyListeners("error", o);
    }

    private static String errorText(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "audio (the microphone could not be read)";
            case SpeechRecognizer.ERROR_CLIENT: return "client";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "microphone permission is missing";
            case SpeechRecognizer.ERROR_NETWORK: return "network (the speech service could not be reached)";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "network timeout";
            case SpeechRecognizer.ERROR_NO_MATCH: return "no words recognised";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "the speech service is busy";
            case SpeechRecognizer.ERROR_SERVER: return "the speech service failed";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "no speech heard";
            case 10: return "too many requests to the speech service";
            case 11: return "the connection to the speech service was lost";
            case 12: return "this language is not supported by the speech service";
            case 13: return "this language is not available right now";
            default: return "unknown (" + error + ")";
        }
    }

    private class Listener implements RecognitionListener {

        @Override public void onReadyForSpeech(Bundle params) { if (active) sendState("ready"); }
        @Override public void onBeginningOfSpeech() { if (active) sendState("started"); }
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() { if (active) sendState("speechEnd"); }

        @Override
        public void onError(int error) {
            if (!active) return;
            active = false;
            // After a real fault the recogniser is rebuilt for the next session; ordinary "heard nothing" outcomes keep it.
            if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                main.post(SpeechRecognitionPlugin.this::destroyRecognizer);
            }
            sendError(error, errorText(error));
        }

        @Override
        public void onResults(Bundle results) {
            if (!active) return;
            active = false;
            sendMatches("results", results);
        }

        @Override public void onPartialResults(Bundle partial) { if (active) sendMatches("partialResults", partial); }
        @Override public void onEvent(int eventType, Bundle params) {}
    }
}
