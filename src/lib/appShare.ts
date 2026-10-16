import { registerPlugin, Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { blobToBase64 } from './fileShare';
import { makeHandleSticker } from './cardCanvas';

// Facebook / Meta app id. Instagram Stories shows a "from FamilyLedger" attribution when it receives one, and the Stories
// share below only runs once this is filled in. Create a free app at developers.facebook.com and paste its id here.
export const META_APP_ID = '1857746475636342';

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


// Asks how to share on Facebook / Instagram: as a Story (picture + a follow sticker) or as a normal post / reel (the app's own
// composer). A small self-contained sheet, so every screen that shares gets the same choice. Resolves null when dismissed.
function chooseShareMode(network: 'instagram' | 'facebook'): Promise<'story' | 'post' | null> {
  return new Promise((resolve) => {
    const name = network === 'instagram' ? 'Instagram' : 'Facebook';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;font-family:inherit';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:460px;background:#fff;border-radius:22px 22px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));color:#10283a';
    const done = (v: 'story' | 'post' | null) => { overlay.remove(); resolve(v); };
    const btn = (label: string, sub: string, v: 'story' | 'post', primary: boolean) => {
      const b = document.createElement('button');
      b.style.cssText = `display:block;width:100%;text-align:left;border-radius:16px;padding:13px 15px;margin-top:10px;border:${primary ? '0' : '1.5px solid #d5dde3'};background:${primary ? '#05344d' : '#fff'};color:${primary ? '#fff' : '#10283a'}`;
      b.innerHTML = `<div style="font-size:15px;font-weight:800">${label}</div><div style="font-size:12px;opacity:.78;margin-top:2px">${sub}</div>`;
      b.onclick = () => done(v);
      return b;
    };
    const title = document.createElement('div');
    title.style.cssText = 'font-size:17px;font-weight:800';
    title.textContent = `Share on ${name}`;
    sheet.appendChild(title);
    sheet.appendChild(btn(`${name} Story`, network === 'instagram' ? 'Picture with a "Follow @family.ledger" sticker. Add a Mention sticker in Instagram to make it tappable.' : 'Picture with a "Like our page" sticker.', 'story', true));
    sheet.appendChild(btn(network === 'instagram' ? 'Post or Reel' : 'Post', network === 'instagram' ? "Open Instagram's own picker (Post, Story or Reel with music). The caption is copied — just paste it." : "Open Facebook's normal composer. The caption is copied — just paste it.", 'post', false));
    const cancel = document.createElement('button');
    cancel.style.cssText = 'display:block;width:100%;margin-top:8px;padding:12px;background:none;border:0;font-weight:700;color:#6b7c8a;font-size:14px';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(null);
    sheet.appendChild(cancel);
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  });
}

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
    let storyChoice: 'story' | 'post' | null = 'post';
    if ((target === 'instagram' || target === 'facebook') && META_APP_ID) {
      storyChoice = await chooseShareMode(target);
      if (storyChoice === null) return { status: 'shared', captionCopied: false };
    }
    if (target === 'instagram' && META_APP_ID && storyChoice === 'story') {
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
    if (target === 'facebook' && META_APP_ID && storyChoice === 'story') {
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
