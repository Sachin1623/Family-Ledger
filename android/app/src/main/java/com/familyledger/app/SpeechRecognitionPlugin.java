package com.familyledger.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
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
        // Listen on the phone itself when its offline speech pack is installed: no round trip to Google, so no "Didn't catch that" after the
        // words were in fact heard (a slow or dropped connection did that on the first try). Falls back to online when the pack is missing.
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
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

    @Override
    protected void handleOnDestroy() {
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
