import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // readAsDataURL yields "data:<mime>;base64,<data>" — Filesystem.writeFile wants just the
      // base64 payload, not the whole data: URL.
      const result = reader.result as string;
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Downloading a generated file (CSV/PDF) via a blob URL + anchor click, or even the Web Share
// API's file support, works fine in a desktop/mobile browser — but BOTH are unreliable inside a
// Capacitor Android WebView (no Downloads-folder integration for blob: URLs, and file-capable
// `navigator.share` isn't consistently available in the WebView's Chromium build either), so on
// a native install this silently did nothing. On a native platform, this now writes the file to
// the app's cache directory via the Filesystem plugin (Directory.Cache needs no storage
// permission) and hands it to the native OS share sheet via the Share plugin — the same "Save to
// Files / send via WhatsApp / email" outcome the web fallback below was always going for, just
// through APIs that actually work inside the WebView.
//
// Falls through to the web-only approach below on ANY native failure that isn't a user cancel —
// deliberately, not just for browsers. An already-installed app that predates these two native
// plugins being added will report `isNativePlatform() === true` but have no native implementation
// for them at all, throwing immediately; without this fallback that's the exact "nothing happens"
// silent failure this whole native path was supposed to fix. Once a build that actually bundles
// these plugins is installed, the native branch succeeds and this fallback is simply never reached.
export async function shareOrDownloadFile(blob: Blob, filename: string, mimeType: string) {
  if (Capacitor.isNativePlatform()) {
    // An install can report isNativePlatform() === true while genuinely lacking one of these two
    // plugins natively (predates them being added, see the fallback note below for why this
    // isn't just theoretical) — checking up front turns that into an immediately readable error
    // instead of whatever cryptic rejection the plugin call itself throws.
    if (!Capacitor.isPluginAvailable('Filesystem') || !Capacitor.isPluginAvailable('Share')) {
      throw new Error(
        `Required native plugin missing (Filesystem: ${Capacitor.isPluginAvailable('Filesystem')}, Share: ${Capacitor.isPluginAvailable('Share')}) — this app install needs to be updated.`,
      );
    }
    try {
      const base64Data = await blobToBase64(blob);
      console.log(`shareOrDownloadFile: writing ${filename} (${(base64Data.length / 1024).toFixed(0)}KB base64)`);
      const written = await Filesystem.writeFile({ path: filename, data: base64Data, directory: Directory.Cache });
      await Share.share({ title: filename, url: written.uri });
      return;
    } catch (err: any) {
      // Share.share rejects with a message (no `name`) when the user dismisses the native sheet —
      // there's no error to report, and definitely nothing to fall back to (they saw the sheet
      // and chose not to use it).
      if (typeof err?.message === 'string' && /cancel/i.test(err.message)) return;
      console.error('Native file share failed:', err);
      // Deliberately NOT falling through to the web-only path below on native — that path is
      // exactly what the comment above it already documents as unreliable inside a Capacitor
      // WebView (no Downloads-folder integration for blob: URLs, inconsistent File-capable
      // navigator.share support), which is why the native path exists in the first place. Falling
      // through to it silently "succeeded" from this function's own point of view — it never threw
      // — while doing nothing visible on screen, which is worse than a clear failure: the caller's
      // own error handling (an alert with the real message, where wired up) never got a chance to
      // fire, so a real native failure looked identical to a real success.
      throw err;
    }
  }

  try {
    const nav = navigator as any;
    const file = new File([blob], filename, { type: mimeType });
    if (nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file] });
      return;
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') return; // user cancelled the share sheet
    console.error('shareOrDownloadFile share failed, falling back to direct download:', err);
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Plain-text sharing (no file involved) — e.g. AccountsHub's "Share account details". Same native
// vs. web split as shareOrDownloadFile above, but text-only sharing IS reliably supported by both
// the Capacitor Share plugin and a browser's navigator.share, so there's no file-specific WebView
// workaround needed here — just a plain three-tier fallback. Returns which path actually happened
// so the caller can tell the user (e.g. "Copied to clipboard" when there was no share sheet to
// hand off to at all).
export async function shareText(title: string, text: string): Promise<'shared' | 'copied' | 'cancelled'> {
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Share')) {
    try {
      await Share.share({ title, text });
      return 'shared';
    } catch (err: any) {
      if (typeof err?.message === 'string' && /cancel/i.test(err.message)) return 'cancelled';
      console.error('Native text share failed:', err);
      // fall through to the web/clipboard fallback below
    }
  }
  try {
    const nav = navigator as any;
    if (nav.share) {
      await nav.share({ title, text });
      return 'shared';
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') return 'cancelled';
    console.error('shareText navigator.share failed, falling back to clipboard:', err);
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}
