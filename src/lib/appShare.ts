import { registerPlugin, Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { blobToBase64 } from './fileShare';
import { makeHandleSticker } from './cardCanvas';

// Facebook / Meta app id. Instagram Stories shows a "from FamilyLedger" attribution when it receives one, and the Stories
// share below only runs once this is filled in. Create a free app at developers.facebook.com and paste its id here.
export const META_APP_ID = '';

// Opens ONE specific app with an image ready to post (Facebook / Instagram / WhatsApp / X / LinkedIn),
// instead of the phone's generic share sheet. Native Android only (android/.../AppSharePlugin.java);
// everywhere else — a browser, iOS, or an installed app that predates the plugin — it reports
// 'unavailable' and the caller falls back to the normal share sheet, so nothing breaks.
interface AppSharePlugin {
  shareImage(options: { package: string; fileName: string; text?: string }): Promise<{ success: boolean; reason?: string }>;
  shareInstagramStory(options: { backgroundFile: string; stickerFile?: string; appId?: string; topColor?: string; bottomColor?: string }): Promise<{ success: boolean; reason?: string }>;
  shareFacebookStory(options: { backgroundFile: string; stickerFile?: string; appId: string; topColor?: string; bottomColor?: string }): Promise<{ success: boolean; reason?: string }>;
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

    // Instagram: a Story with the picture and a "Follow us @handle" sticker (and the app attribution when an app id is set).
    // Older installed builds do not have this native method — that throws and we carry on to the normal composer below.
    if (target === 'instagram' && META_APP_ID) {
      try {
        const stickerName = `familyledger-sticker-${Date.now()}.png`;
        await Filesystem.writeFile({ path: stickerName, data: await blobToBase64(await makeHandleSticker()), directory: Directory.Cache });
        const story = await AppShareNative.shareInstagramStory({ backgroundFile: fileName, stickerFile: stickerName, appId: META_APP_ID, topColor: '#0c1230', bottomColor: '#070a18' });
        if (story.success) return { status: 'shared', captionCopied };
      } catch {
        /* no Stories support in this build — use the regular composer */
      }
    }

    // Facebook: a Story with the picture and a "Like our page" sticker. Needs the Meta app id; older builds skip this.
    if (target === 'facebook' && META_APP_ID) {
      try {
        const stickerName = `familyledger-sticker-${Date.now()}.png`;
        await Filesystem.writeFile({ path: stickerName, data: await blobToBase64(await makeHandleSticker('facebook')), directory: Directory.Cache });
        const story = await AppShareNative.shareFacebookStory({ backgroundFile: fileName, stickerFile: stickerName, appId: META_APP_ID, topColor: '#0c1230', bottomColor: '#070a18' });
        if (story.success) return { status: 'shared', captionCopied };
      } catch {
        /* no Stories support in this build — use the regular composer */
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
