import { registerPlugin, Capacitor } from '@capacitor/core';

interface AiSharePlugin {
  share(options: { text: string; title?: string }): Promise<{ success: boolean; reason?: string; matchedApps?: number }>;
}

// Native (Android): a custom plugin (android/app/.../AiSharePlugin.java) that restricts the
// share sheet to known AI assistant apps only, instead of Android's normal share-to-anything
// sheet. Web: falls back to the standard Web Share API, or clipboard if that's unavailable —
// browsers have no way to restrict share targets to specific apps.
const AiShareNative = registerPlugin<AiSharePlugin>('AiShare');

export async function shareWithAi(text: string, title = 'Analyze with AI'): Promise<{ success: boolean; reason?: string }> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    return AiShareNative.share({ text, title });
  }

  if (navigator.share) {
    try {
      await navigator.share({ text, title });
      return { success: true };
    } catch (err) {
      return { success: false, reason: 'cancelled' };
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return { success: false, reason: 'clipboard_fallback' };
  } catch {
    return { success: false, reason: 'unsupported' };
  }
}
