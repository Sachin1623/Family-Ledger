import Foundation
import Capacitor
import AVFoundation
import Speech

/**
 * "Talk to add an expense" on iPhone: listens with Apple's own speech recogniser and sends the words to the web app as they are
 * heard. Registered under the same name and with the same methods and events as the Android plugin
 * (@capacitor-community/speech-recognition), so the web code is identical on both phones.
 *
 * Why it lives in the app instead of coming from that package: the package has no Swift Package Manager manifest, and this app's
 * iOS project is built with Swift Package Manager, so the package's iOS half can never be linked in. The recognition logic below
 * follows that package's (MIT licensed) iOS implementation.
 *
 * Nothing is sent to us: Apple's recogniser runs on the phone or through Apple, depending on the language and the phone.
 */
@objc(SpeechRecognitionPlugin)
public class SpeechRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognitionPlugin"
    public let jsName = "SpeechRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSupportedLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise)
    ]

    private var speechRecognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    @objc func available(_ call: CAPPluginCall) {
        guard let recognizer = SFSpeechRecognizer() else {
            call.resolve(["available": false])
            return
        }
        call.resolve(["available": recognizer.isAvailable])
    }

    private func finishListening() {
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest = nil
        recognitionTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        notifyListeners("listeningState", data: ["status": "speechEnd"])
    }

    @objc func start(_ call: CAPPluginCall) {
        if let engine = audioEngine, engine.isRunning {
            call.reject("Ongoing speech recognition")
            return
        }
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            call.reject("Missing permission")
            return
        }

        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            if !granted {
                call.reject("User denied access to microphone")
                return
            }

            let language = call.getString("language") ?? "en-US"
            let maxResults = call.getInt("maxResults") ?? 5
            let partialResults = call.getBool("partialResults") ?? false

            self.recognitionTask?.cancel()
            self.recognitionTask = nil

            let engine = AVAudioEngine()
            self.audioEngine = engine
            self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: language))

            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try session.setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                call.reject("Microphone is already in use by another application.")
                return
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = partialResults
            self.recognitionRequest = request

            let inputNode = engine.inputNode
            let format = inputNode.outputFormat(forBus: 0)

            self.recognitionTask = self.speechRecognizer?.recognitionTask(with: request) { result, error in
                if let result = result {
                    let matches = result.transcriptions.prefix(max(1, maxResults)).map { $0.formattedString }
                    if result.isFinal {
                        self.notifyListeners("results", data: ["matches": matches])
                        self.finishListening()
                    } else if partialResults {
                        self.notifyListeners("partialResults", data: ["matches": matches])
                    }
                }
                if let error = error {
                    // A recogniser that ends because nothing was said reports an error as well; the web side shows "I did not catch that"
                    // when no words were heard, and the real message otherwise.
                    self.notifyListeners("error", data: ["code": (error as NSError).code, "message": error.localizedDescription])
                    self.finishListening()
                }
            }

            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                self.recognitionRequest?.append(buffer)
            }

            engine.prepare()
            do {
                try engine.start()
                self.notifyListeners("listeningState", data: ["status": "ready"])
                call.resolve()
            } catch {
                call.reject("Unknown error occured")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let engine = self.audioEngine, engine.isRunning {
                engine.stop()
                self.recognitionRequest?.endAudio()
            }
            call.resolve()
        }
    }

    @objc func isListening(_ call: CAPPluginCall) {
        call.resolve(["listening": audioEngine?.isRunning ?? false])
    }

    @objc func getSupportedLanguages(_ call: CAPPluginCall) {
        call.resolve(["languages": SFSpeechRecognizer.supportedLocales().map { $0.identifier }])
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let permission: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: permission = "granted"
        case .denied, .restricted: permission = "denied"
        case .notDetermined: permission = "prompt"
        @unknown default: permission = "prompt"
        }
        call.resolve(["speechRecognition": permission])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                if status == .authorized {
                    AVAudioSession.sharedInstance().requestRecordPermission { granted in
                        call.resolve(["speechRecognition": granted ? "granted" : "denied"])
                    }
                } else {
                    self.checkPermissions(call)
                }
            }
        }
    }
}
