import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPendingReceiptShare, onReceiptShared, receiptShareAvailable, setSharedReceipt, type SharedReceipt } from '../lib/receiptShare';

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

    return () => {
      cancelled = true;
      remove?.();
    };
  }, [navigate]);

  return null;
}
