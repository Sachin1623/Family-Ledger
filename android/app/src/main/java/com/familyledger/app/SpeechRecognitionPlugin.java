package com.familyledger.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * "Talk to add an expense": listens with the phone's own speech recogniser and reports back as it hears, and — unlike the
 * community speech plugin this replaces — says exactly what went wrong when it cannot hear (permission, no speech service,
 * no network, recogniser busy ...) instead of failing silently.
 *
 * Events sent to the web app:
 *   listeningState {status: "ready" | "started" | "speechEnd"}
 *   partialResults {matches: [text]}      words heard so far
 *   results        {matches: [text]}      the final words (arrive AFTER speechEnd)
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

    @PluginMethod
    public void start(PluginCall call) {
        final String language = call.getString("language", "en-IN");
        final int maxResults = call.getInt("maxResults", 5);
        bridge.getActivity().runOnUiThread(() -> {
            try {
                destroyRecognizer();
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    call.reject("No speech recognition service on this phone.");
                    return;
                }
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new Listener());

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                // Give a person a moment between words before the recogniser decides they have finished.
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start listening: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            try {
                if (recognizer != null) recognizer.stopListening();
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            destroyRecognizer();
            call.resolve();
        });
    }

    private void destroyRecognizer() {
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

        @Override public void onReadyForSpeech(Bundle params) { sendState("ready"); }
        @Override public void onBeginningOfSpeech() { sendState("started"); }
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() { sendState("speechEnd"); }

        @Override
        public void onError(int error) {
            JSObject o = new JSObject();
            o.put("code", error);
            o.put("message", errorText(error));
            notifyListeners("error", o);
        }

        @Override public void onResults(Bundle results) { sendMatches("results", results); }
        @Override public void onPartialResults(Bundle partial) { sendMatches("partialResults", partial); }
        @Override public void onEvent(int eventType, Bundle params) {}
    }
}
