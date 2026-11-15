import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { getPendingReceiptShare, onReceiptShared, processReceiptFile, receiptShareAvailable, setSharedReceipt, type SharedReceipt } from '../lib/receiptShare';

// Files already handed to the app, remembered for the whole session. This must outlive the effect below: the iPhone keeps returning the
// same launch URL, so a fresh list on every run made the app read the (already deleted) file again, replace the good receipt with an empty
// one, and jump back to the Receipt screen after Close or Add expense manually.
const handledFiles = new Set<string>();

// Listens for a receipt shared to FamilyLedger from another app (Android) and opens the Receipt screen.
// Covers both a share that cold-starts the app (picked up on mount) and one that arrives while it's open.
export default function ReceiptShareBridge() {
  const navigate = useNavigate();
  // useNavigate changes whenever the page changes; kept in a ref so the listeners below are set up once, not after every navigation.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!receiptShareAvailable()) return;
    let cancelled = false;
    let remove: (() => void) | null = null;

    const open = (s: SharedReceipt) => {
      setSharedReceipt(s);
      navigateRef.current('/receipt-share');
    };

    if (Capacitor.getPlatform() === 'ios') {
      // iOS hands a shared file to the app as a file:// URL ("Copy to FamilyLedger" in the share sheet).
      const seen = handledFiles;
      const handle = (url: string | undefined, source?: string) => {
        if (!url || !url.startsWith('file:') || seen.has(url)) return;
        seen.add(url);
        processReceiptFile(url)
          .then((r) => {
            if (!cancelled) open({ ...r, referrer: r.referrer || source });
          })
          .catch(() => {});
      };
      CapacitorApp.getLaunchUrl().then((l) => handle(l?.url)).catch(() => {});
      CapacitorApp.addListener('appUrlOpen', (d) => handle(d.url, (d as { iosSourceApplication?: string }).iosSourceApplication))
        .then((h) => {
          if (cancelled) h.remove();
          else remove = () => h.remove();
        })
        .catch(() => {});
    } else {
      getPendingReceiptShare()
        .then((r) => {
          if (!cancelled && r && (r as SharedReceipt).mime !== undefined) open(r as SharedReceipt);
        })
        .catch(() => {});
      onReceiptShared(open)
        .then((h) => {
          if (cancelled) h.remove();
          else remove = () => h.remove();
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  return null;
}
