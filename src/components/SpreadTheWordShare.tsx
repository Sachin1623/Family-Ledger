import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { blobToBase64, shareText } from '../lib/fileShare';
import { buildShareMessages, shareAppPlain, ShareTarget } from '../lib/spreadTheWord';
import { shareImageToApp, DirectShareTarget } from '../lib/appShare';
import { logGrowthEvent } from '../lib/growthEvents';
import type { SpreadVariantId } from '../lib/spreadCardImage';
import SpreadPosterPicker from './SpreadPosterPicker';
import ShareAppButtons from './ShareAppButtons';

// The ONE "Spread the Word" sharing experience: Share + WhatsApp / Facebook / Instagram / X / LinkedIn buttons, the themed poster
// picker, the app's own composer (or the phone's share sheet) with the chosen poster, and the copy-link fallback. Used by the Profile
// card and by the admin "Spread the Word" broadcast popup, so both behave and look the same. `onShared` runs once a share was
// started (the broadcast popup uses it to mark the prompt as seen).
export default function SpreadTheWordShare({ onShared }: { onShared?: () => void }) {
  const { user } = useAuth();
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
    onShared?.();
  };

  // Every Share button opens the poster picker; once a poster is chosen this shares it.
  const handleShareApp = (target: ShareTarget) => setPickerTarget(target);

  const handlePosterChosen = async (blob: Blob, posterId: SpreadVariantId) => {
    const target = pickerTarget;
    if (!target) return;
    // The post text follows the poster the person picked (money / health / family / games / all).
    const { message, shortMessage } = buildShareMessages(posterId);
    const text = target === 'twitter' ? shortMessage : message;
    setPickerTarget(null);
    setShareNote(null);

    // A specific platform button opens THAT app directly (its own composer — post / story / reel options where the app offers them),
    // when the installed build supports it and the app is on the phone. Otherwise it falls through to the normal share sheet.
    if (target !== 'native') {
      const direct = await shareImageToApp(target as DirectShareTarget, blob, text);
      if (direct.status === 'shared') {
        logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
        if (direct.captionCopied) setShareNote("Caption copied — paste it into your post. (Facebook and Instagram don't let apps fill it in.)");
        onShared?.();
        return;
      }
      if (direct.status === 'not_installed') {
        setShareNote(`That app doesn't seem to be installed — choose another app from the share sheet instead.`);
      }
    }

    const shared = await shareViaOsSheetWithBanner(text, blob);
    if (shared) {
      logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
      onShared?.();
      return;
    }
    // Image sharing unsupported (or no share sheet at all) — text-only fallbacks.
    shareAppPlain(target, user?.uid, posterId);
    onShared?.();
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
      <SpreadPosterPicker open={pickerTarget !== null} onClose={() => setPickerTarget(null)} onShare={handlePosterChosen} />
    </>
  );
}
