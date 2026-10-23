import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { blobToBase64, shareText, shareOrDownloadFile } from '../lib/fileShare';
import { makeSlideshowVideo } from '../lib/slideshowVideo';
import { buildShareMessages, shareAppPlain, ShareTarget } from '../lib/spreadTheWord';
import { shareImageToApp, shareImagesToApp, DirectShareTarget } from '../lib/appShare';
import { logGrowthEvent } from '../lib/growthEvents';
import { questEvent } from '../lib/questsApi';
import type { SpreadVariantId } from '../lib/spreadCardImage';
import SpreadPosterPicker from './SpreadPosterPicker';
import ShareAppButtons from './ShareAppButtons';

// The ONE "Spread the Word" sharing experience: Share + WhatsApp / Facebook / Instagram / X / LinkedIn buttons, the themed poster
// picker, the app's own composer (or the phone's share sheet) with the chosen poster, and the copy-link fallback. Used by the Profile
// card and by the admin "Spread the Word" broadcast popup, so both behave and look the same. `onShared` runs once a share was
// started (the broadcast popup uses it to mark the prompt as seen).
export default function SpreadTheWordShare({ onShared }: { onShared?: () => void }) {
  const { user } = useAuth();
  // a share was started: counts toward the weekly quest, then lets the caller know
  const sharedOk = () => {
    questEvent('spread_shared');
    onShared?.();
  };
  const { t } = useLanguage();
  // Tapping any Share button first opens the poster picker (a fresh set of themed posters is drawn every time); the chosen poster is
  // then shared to whichever target was tapped.
  const [pickerTarget, setPickerTarget] = useState<ShareTarget | null>(null);
  // A short note under the share buttons (e.g. "Caption copied — paste it into your post").
  const [shareNote, setShareNote] = useState<string | null>(null);

  // Native-first (Capacitor Share + Filesystem): navigator.share's file support is unreliable inside the installed Android WebView, so
  // the picture goes through the native share plugin; only a browser without those plugins falls back to navigator.share.
  const shareViaOsSheetWithBanner = async (message: string, blob: Blob): Promise<boolean> => {
    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Filesystem') && Capacitor.isPluginAvailable('Share')) {
      try {
        const base64Data = await blobToBase64(blob);
        const written = await Filesystem.writeFile({ path: 'familyledger-features.png', data: base64Data, directory: Directory.Cache });
        await Share.share({ title: 'FamilyLedger', text: message, url: written.uri });
        return true;
      } catch (err: any) {
        if (typeof err?.message === 'string' && /cancel/i.test(err.message)) return true; // user dismissed the sheet
        console.error('Native image share failed, falling back:', err);
        return false;
      }
    }

    const nav = navigator as any;
    if (!nav.share) return false;
    const image = new File([blob], 'familyledger-features.png', { type: 'image/png' });
    if (nav.canShare?.({ files: [image] })) {
      try {
        await nav.share({ title: 'FamilyLedger', text: message, files: [image] });
        return true;
      } catch (err) {
        if ((err as any)?.name === 'AbortError') return true; // user cancelled — don't fall through to a platform link
        console.error('Image share failed, falling back:', err);
      }
    }
    return false;
  };

  // The picture can lose its caption in some receiving apps, so this sends the same message as a text-only share, where the link is
  // guaranteed to render and be tappable.
  const handleShareLinkOnly = async () => {
    const { message } = buildShareMessages();
    const result = await shareText('FamilyLedger', message);
    if (result === 'copied') alert(t('profile.linkCopied'));
    logGrowthEvent('share_link_only', user?.uid);
    sharedOk();
  };

  // Every Share button opens the poster picker; once a poster is chosen this shares it.
  const handleShareApp = (target: ShareTarget) => setPickerTarget(target);

  const handlePosterChosen = async (items: { blob: Blob; id: SpreadVariantId }[]) => {
    const target = pickerTarget;
    if (!target || items.length === 0) return;
    const blob = items[0].blob;
    // The post text follows the poster the person picked (money / health / family / games / all); several posters get the general text.
    const posterId: SpreadVariantId = items.length === 1 ? items[0].id : 'all';
    const { message, shortMessage } = buildShareMessages(posterId);
    // X has a short limit and a WhatsApp status refuses more than 700 characters, so both get the short caption.
    const text = target === 'twitter' || target === 'whatsapp' ? shortMessage : message;
    setPickerTarget(null);
    setShareNote(null);

    // Several posters: one multi-picture share, straight to the chosen app (or the share sheet). The caption is copied as well.
    if (items.length > 1) {
      const multi = await shareImagesToApp(target === 'native' ? 'sheet' : (target as DirectShareTarget), items.map((i) => i.blob), text);
      if (multi.status === 'shared') {
        logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
        setShareNote(`Caption copied. If the app did not fill it in, paste it into your post. (${items.length} posters sent.)`);
        sharedOk();
        return;
      }
      if (multi.status === 'not_installed') {
        setShareNote("That app doesn't seem to be installed. Choose another app, or use Share to pick from your phone's list.");
        return;
      }
    }

    // A specific platform button opens THAT app directly (its own composer — post / story / reel options where the app offers them),
    // when the installed build supports it and the app is on the phone. Otherwise it falls through to the normal share sheet.
    if (target !== 'native') {
      const direct = await shareImageToApp(target as DirectShareTarget, blob, text);
      if (direct.status === 'shared') {
        logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
        if (direct.captionCopied) setShareNote("Caption copied — paste it into your post. (Facebook and Instagram don't let apps fill it in.)");
        sharedOk();
        return;
      }
      if (direct.status === 'not_installed') {
        setShareNote(`That app doesn't seem to be installed — choose another app from the share sheet instead.`);
      }
    }

    const shared = await shareViaOsSheetWithBanner(text, blob);
    if (shared) {
      logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
      sharedOk();
      return;
    }
    // Image sharing unsupported (or no share sheet at all) — text-only fallbacks.
    shareAppPlain(target, user?.uid, posterId);
    sharedOk();
  };

  // WhatsApp Status keeps only one item from a share, so several posters can go as ONE slideshow video instead.
  const handlePostersAsVideo = async (items: { blob: Blob; id: SpreadVariantId }[], onProgress: (fraction: number) => void) => {
    setPickerTarget(null);
    setShareNote(null);
    try {
      const video = await makeSlideshowVideo(items.map((i) => i.blob), onProgress);
      const caption = buildShareMessages('all').shortMessage;
      navigator.clipboard?.writeText(caption).catch(() => {});
      await shareOrDownloadFile(video.blob, `familyledger-posters.${video.extension}`, video.mimeType, caption);
      logGrowthEvent('share_native', user?.uid);
      setShareNote('Caption copied. Pick WhatsApp, then My Status, and paste the caption if it is not filled in.');
      sharedOk();
    } catch (err) {
      console.error('Slideshow video failed:', err);
      setShareNote('Could not make the video on this phone. Share the posters instead.');
    }
  };

  const canShare = typeof navigator !== 'undefined' && !!(navigator as any).share;

  return (
    <>
      <ShareAppButtons
        onShare={handleShareApp}
        onLinkOnly={handleShareLinkOnly}
        primaryIcon={canShare ? 'share' : 'content_copy'}
        primaryLabel={canShare ? t('profile.shareFamilyLedger') : t('profile.copyShareMessage')}
        linkOnlyLabel={t('profile.shareLinkOnly')}
        note={shareNote}
      />
      <SpreadPosterPicker open={pickerTarget !== null} onClose={() => setPickerTarget(null)} onShare={handlePosterChosen} onShareVideo={handlePostersAsVideo} />
    </>
  );
}
