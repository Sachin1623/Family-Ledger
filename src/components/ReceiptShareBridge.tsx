import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { getPendingReceiptShare, onReceiptShared, processReceiptFile, receiptShareAvailable, setSharedReceipt, type SharedReceipt } from '../lib/receiptShare';

// Listens for a receipt shared to FamilyLedger from another app (Android) and opens the Receipt screen.
// Covers both a share that cold-starts the app (picked up on mount) and one that arrives while it's open.
export default function ReceiptShareBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!receiptShareAvailable()) return;
    let cancelled = false;
    let remove: (() => void) | null = null;

    const open = (s: SharedReceipt) => {
      setSharedReceipt(s);
      navigate('/receipt-share');
    };

    if (Capacitor.getPlatform() === 'ios') {
      // iOS hands a shared file to the app as a file:// URL ("Copy to FamilyLedger" in the share sheet).
      const seen = new Set<string>();
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
  }, [navigate]);

  return null;
}
