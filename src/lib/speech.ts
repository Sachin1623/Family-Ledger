import { Capacitor } from '@capacitor/core';
import { SpeechRecognition as NativeSpeechRecognition } from '@capacitor-community/speech-recognition';

// Speech to text with the phone's own recogniser (Google on Android, Apple's on iPhone), so the voice is not uploaded to us.
// Only the installed apps have it; the website does not, so the mic button simply does not show there.
//
// While developing on a computer (never in the real website: import.meta.env.DEV is false there) Chrome's or Edge's own speech
// recogniser stands in, so the whole flow can be tried on localhost without building an app.

type Listener = (data: any) => void;
const webCtor: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
const useWebStandIn = !Capacitor.isNativePlatform() && import.meta.env.DEV && !!webCtor;

function makeWebStandIn() {
  const listeners: Record<string, Listener[]> = {};
  let rec: any = null;
  const emit = (name: string, data: any) => (listeners[name] || []).forEach((fn) => fn(data));
  return {
    available: async () => ({ available: true }),
    checkPermissions: async () => ({ speechRecognition: 'granted' }),
    requestPermissions: async () => ({ speechRecognition: 'granted' }),
    addListener: async (name: string, fn: Listener) => {
      (listeners[name] = listeners[name] || []).push(fn);
      return { remove: async () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); } };
    },
    start: async (opts: { language?: string }) => {
      rec = new webCtor();
      rec.lang = opts?.language || 'en-IN';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        const text = Array.from(e.results as ArrayLike<any>).map((r) => r[0].transcript).join(' ');
        emit('partialResults', { matches: [text] });
      };
      rec.onspeechend = () => emit('listeningState', { status: 'stopped' });
      rec.onend = () => emit('listeningState', { status: 'stopped' });
      rec.start();
      emit('listeningState', { status: 'started' });
      return {};
    },
    stop: async () => { try { rec?.stop(); } catch { /* not running */ } },
  };
}

export const SpeechRecognition: typeof NativeSpeechRecognition = useWebStandIn ? (makeWebStandIn() as any) : NativeSpeechRecognition;

export function speechAvailableHere(): boolean {
  if (useWebStandIn) return true;
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SpeechRecognition');
}

const SPEECH_LANG: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ar: 'ar-SA', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', ja: 'ja-JP', ro: 'ro-RO', ru: 'ru-RU', zh: 'zh-CN',
};
export function speechLanguageFor(appLanguage: string): string {
  return SPEECH_LANG[appLanguage] || 'en-IN';
}
