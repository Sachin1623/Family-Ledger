import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { getSharedReceipt } from '../lib/receiptShare';
import { parseReceipt, payeeKey } from '../lib/receiptParse';
import type { ReceiptInfo } from '../components/ReceiptBanner';

const APP_LABEL: Record<string, string> = { phonepe: 'PhonePe', paytm: 'Paytm', gpay: 'Google Pay' };

// Where a shared payment receipt lands. It reads the receipt, looks up what this user chose for the same payee last
// time and whether the receipt was already added, then goes straight to Add Expense, filled in. It only stays on
// screen if what was shared isn't a receipt we can read (or if the app was opened without sharing anything).
export default function ReceiptShare() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const share = getSharedReceipt();
  const parsed = useMemo(() => (share ? parseReceipt(share) : null), [share]);
  const key = useMemo(() => (parsed ? payeeKey(parsed) : ''), [parsed]);
  const [unreadable, setUnreadable] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!share || !parsed || !user) return;
    if (!parsed.amount) {
      setUnreadable(true);
      return;
    }
    let cancelled = false;
    (async () => {
      let remembered: { d: string; c: string } | null = null;
      let duplicateAt: string | null = null;
      try {
        const snap = await getDoc(doc(db, 'receiptPayees', user.uid));
        const m = snap.data()?.map?.[key];
        if (m && (m.d || m.c)) remembered = { d: m.d || '', c: m.c || '' };
      } catch {
        // not critical — carry on without it
      }
      if (parsed.txnId) {
        try {
          const d = await getDoc(doc(db, 'receiptTxns', `${user.uid}_${parsed.txnId}`));
          if (d.exists()) duplicateAt = (d.data()?.at as string) || new Date().toISOString();
        } catch {
          // not critical
        }
      }
      if (cancelled) return;

      const q = new URLSearchParams();
      q.set('amount', parsed.amount);
      const description = remembered?.d || parsed.payee;
      if (description) q.set('description', description);
      if (parsed.date) q.set('date', parsed.date);
      const category = remembered?.c || parsed.categoryHint;
      if (category) q.set('category', category);

      const receipt: ReceiptInfo = {
        appLabel: APP_LABEL[parsed.app] || '',
        notes: parsed.notes,
        alternatives: parsed.alternatives,
        remembered: !!remembered,
        duplicateAt,
        hasPicture: !!share.imageData,
      };
      navigate(`/add-expense?${q.toString()}`, {
        replace: true,
        state: { receiptImages: share.imageData ? [share.imageData] : [], payeeKey: key, txnId: parsed.txnId, fromReceipt: true, receipt },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [share, parsed, user, key, navigate]);

  // Opened with nothing shared (e.g. from a bookmark): explain how it works.
  if (!share || !parsed) {
    return (
      <div className="p-6 max-w-md mx-auto text-center space-y-3">
        <span className="material-symbols-outlined text-5xl text-primary">receipt_long</span>
        <h1 className="text-lg font-black text-primary">Add an expense from a receipt</h1>
        <p className="text-sm text-text-muted">
          Open a payment in PhonePe, Google Pay or Paytm, tap <b>Share receipt</b> and choose <b>FamilyLedger</b>. We'll read the amount, who you paid and the date, and fill in the expense for you.
        </p>
        <button onClick={() => navigate('/')} className="px-5 py-2.5 rounded-xl bg-primary text-white font-bold text-sm">Back to Home</button>
      </div>
    );
  }

  // Shared something we couldn't read as a payment receipt.
  if (unreadable) {
    const details = JSON.stringify({ mime: share.mime, kind: share.kind, sentBy: share.referrer, ocrText: share.ocrText, error: share.error }, null, 2);
    return (
      <div className="p-6 max-w-md mx-auto text-center space-y-4">
        <span className="material-symbols-outlined text-5xl text-amber-600">help_center</span>
        <h1 className="text-lg font-black text-primary">We couldn't read this as a payment receipt</h1>
        <p className="text-sm text-text-muted">
          FamilyLedger reads receipts shared from PhonePe, Google Pay and Paytm. You can still add the expense yourself
          {share.imageData ? ' — the picture will be attached.' : '.'}
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => navigate('/add-expense', { replace: true, state: { receiptImages: share.imageData ? [share.imageData] : [], fromReceipt: true } })}
            className="w-full py-3 rounded-2xl bg-primary text-white font-black"
          >
            Add expense manually
          </button>
          <button onClick={() => navigate('/')} className="w-full py-3 rounded-2xl border border-border-subtle text-primary font-bold">Close</button>
          <button
            onClick={() => { navigator.clipboard?.writeText(details).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}
            className="text-xs font-bold text-text-muted py-1"
          >
            {copied ? 'Copied ✓' : 'Copy details for support'}
          </button>
        </div>
      </div>
    );
  }

  // Reading it (a moment).
  return (
    <div className="p-10 flex flex-col items-center gap-3 text-center">
      <div className="w-9 h-9 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
      <p className="text-sm font-bold text-text-muted">Reading your receipt…</p>
    </div>
  );
}
