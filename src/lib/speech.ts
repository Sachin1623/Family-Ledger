import { Capacitor, registerPlugin } from '@capacitor/core';

// Speech to text with the phone's own recogniser (Google on Android, Apple's on iPhone), so the voice is not uploaded to us.
// Only the installed apps have it; the website does not, so the mic button simply does not show there.
// The native halves are our own plugins: android/.../SpeechRecognitionPlugin.java and ios/App/App/SpeechRecognitionPlugin.swift.

export interface SpeechListenerHandle {
  remove: () => Promise<void>;
}

export interface SpeechPlugin {
  available(): Promise<{ available: boolean }>;
  checkPermissions(): Promise<{ speechRecognition: string }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  start(options: { language?: string; maxResults?: number }): Promise<void>;
  stop(): Promise<void>;
  cancel?(): Promise<void>;
  /** Android: the phone's own "Speak now" box. Resolves when it closes, with the guesses (best first), or none if it was dismissed. */
  listenDialog?(options: { language?: string; maxResults?: number; prompt?: string }): Promise<{ matches: string[] }>;
  /**
   * partialResults: words heard so far. results: the final words (they arrive AFTER the speech has ended).
   * listeningState: "ready" | "started" | "speechEnd". error: the recogniser gave up (code + plain message).
   */
  addListener(event: 'partialResults' | 'results', fn: (d: { matches: string[] }) => void): Promise<SpeechListenerHandle>;
  addListener(event: 'listeningState', fn: (d: { status: string }) => void): Promise<SpeechListenerHandle>;
  addListener(event: 'error', fn: (d: { code: number; message: string }) => void): Promise<SpeechListenerHandle>;
}

// While developing on a computer (never in the real website: import.meta.env.DEV is false there) Chrome's or Edge's own speech
// recogniser stands in, so the whole flow can be tried on localhost without building an app.
type AnyFn = (data: any) => void;
const webCtor: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
const useWebStandIn = !Capacitor.isNativePlatform() && import.meta.env.DEV && !!webCtor;

function makeWebStandIn(): SpeechPlugin {
  const listeners: Record<string, AnyFn[]> = {};
  let rec: any = null;
  const emit = (name: string, data: any) => (listeners[name] || []).forEach((fn) => fn(data));
  return {
    available: async () => ({ available: true }),
    checkPermissions: async () => ({ speechRecognition: 'granted' }),
    requestPermissions: async () => ({ speechRecognition: 'granted' }),
    addListener: (async (name: string, fn: AnyFn) => {
      (listeners[name] = listeners[name] || []).push(fn);
      return { remove: async () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); } };
    }) as any,
    start: async (opts) => {
      rec = new webCtor();
      rec.lang = opts?.language || 'en-IN';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        const text = Array.from(e.results as ArrayLike<any>).map((r) => r[0].transcript).join(' ');
        const last = e.results[e.results.length - 1];
        emit(last && last.isFinal ? 'results' : 'partialResults', { matches: [text] });
      };
      rec.onspeechend = () => emit('listeningState', { status: 'speechEnd' });
      rec.onerror = (e: any) => emit('error', { code: 0, message: String(e?.error || 'error') });
      rec.start();
      emit('listeningState', { status: 'ready' });
    },
    stop: async () => { try { rec?.stop(); } catch { /* not running */ } },
  };
}

export const SpeechRecognition: SpeechPlugin = useWebStandIn ? makeWebStandIn() : registerPlugin<SpeechPlugin>('SpeechRecognition');

/** Android uses the phone's own speech box (steady); everything else (iPhone, the dev stand-in) listens inline with live words. */
export const useSpeechDialog = !useWebStandIn && Capacitor.getPlatform() === 'android';

/** Phones record a short clip and a speech model on our server reads the expense from it (far better than the phone's own recogniser). */
export const useServerVoice = Capacitor.isNativePlatform() || import.meta.env.DEV;

export function speechAvailableHere(): boolean {
  // While developing in a browser: the recording path needs only a microphone.
  if (import.meta.env.DEV && !Capacitor.isNativePlatform()) return !!navigator.mediaDevices?.getUserMedia;
  if (useWebStandIn) return true;
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SpeechRecognition');
}

const SPEECH_LANG: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ar: 'ar-SA', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', ja: 'ja-JP', ro: 'ro-RO', ru: 'ru-RU', zh: 'zh-CN',
};
export function speechLanguageFor(appLanguage: string): string {
  return SPEECH_LANG[appLanguage] || 'en-IN';
}
