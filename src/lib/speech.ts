import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

// Speech to text with the phone's own recogniser (Google on Android, Apple's on iPhone), so the voice is not uploaded to us.
// Only the installed apps have it; the website does not, so the mic button simply does not show there.
export function speechAvailableHere(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SpeechRecognition');
}

const SPEECH_LANG: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ar: 'ar-SA', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', ja: 'ja-JP', ro: 'ro-RO', ru: 'ru-RU', zh: 'zh-CN',
};
export function speechLanguageFor(appLanguage: string): string {
  return SPEECH_LANG[appLanguage] || 'en-IN';
}

export { SpeechRecognition };
