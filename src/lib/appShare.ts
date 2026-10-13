import { registerPlugin, Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { blobToBase64 } from './fileShare';

// Opens ONE specific app with an image ready to post (Facebook / Instagram / WhatsApp / X / LinkedIn),
// instead of the phone's generic share sheet. Native Android only (android/.../AppSharePlugin.java);
// everywhere else — a browser, iOS, or an installed app that predates the plugin — it reports
// 'unavailable' and the caller falls back to the normal share sheet, so nothing breaks.
interface AppSharePlugin {
  shareImage(options: { package: string; fileName: string; text?: string }): Promise<{ success: boolean; reason?: string }>;
}
const AppShareNative = registerPlugin<AppSharePlugin>('AppShare');

export type DirectShareTarget = 'whatsapp' | 'facebook' | 'instagram' | 'twitter' | 'linkedin';

const PACKAGES: Record<DirectShareTarget, string[]> = {
  whatsapp: ['com.whatsapp', 'com.whatsapp.w4b'],
  facebook: ['com.facebook.katana'],
  instagram: ['com.instagram.android'],
  twitter: ['com.twitter.android'],
  linkedin: ['com.linkedin.android'],
};

// Facebook and Instagram deliberately ignore any caption an app pre-fills (a platform rule), so for
// those the caption is copied to the clipboard and the person pastes it into their post.
const IGNORES_CAPTION: DirectShareTarget[] = ['facebook', 'instagram'];

export type DirectShareResult =
  | { status: 'shared'; captionCopied: boolean }
  | { status: 'not_installed' }
  | { status: 'unavailable' };

export function canShareDirectly(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AppShare') && Capacitor.isPluginAvailable('Filesystem');
}

export async function shareImageToApp(target: DirectShareTarget, blob: Blob, caption: string): Promise<DirectShareResult> {
  if (!canShareDirectly()) return { status: 'unavailable' };
  try {
    const fileName = `familyledger-share-${Date.now()}.png`;
    await Filesystem.writeFile({ path: fileName, data: await blobToBase64(blob), directory: Directory.Cache });

    let captionCopied = false;
    if (IGNORES_CAPTION.includes(target)) {
      try {
        await navigator.clipboard.writeText(caption);
        captionCopied = true;
      } catch {
        /* clipboard unavailable — the image still goes through */
      }
    }

    for (const pkg of PACKAGES[target]) {
      const res = await AppShareNative.shareImage({ package: pkg, fileName, text: IGNORES_CAPTION.includes(target) ? undefined : caption });
      if (res.success) return { status: 'shared', captionCopied };
    }
    return { status: 'not_installed' };
  } catch (err) {
    console.error('Direct app share failed:', err);
    return { status: 'unavailable' };
  }
}
