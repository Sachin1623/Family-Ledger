import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { getSharedReceipt } from '../lib/receiptShare';
import { parseReceipt, payeeKey } from '../lib/receiptParse';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { EXPENSE_CATEGORIES } from '../lib/constants';

// Opened when a receipt is shared to FamilyLedger from another app (PhonePe …). Shows what was read,
// lets you correct it, then hands over to Add Expense. Never saves anything on its own.
// The "What we received" box is for this testing stage — it shows exactly what the sharing app sent.
export default function ReceiptShare() {
  const navigate = useNavigate();
  const share = getSharedReceipt();
  const { user } = useAuth();
  const parsed = useMemo(() => (share ? parseReceipt(share) : null), [share]);
  const key = useMemo(() => (parsed ? payeeKey(parsed) : ''), [parsed]);

  const [amount, setAmount] = useState(parsed?.amount || '');
  const [payee, setPayee] = useState(parsed?.payee || '');
  const [date, setDate] = useState(parsed?.date || '');
  const [copied, setCopied] = useState(false);
  // What this user chose for this payee last time (description + category), from their private list.
  const [remembered, setRemembered] = useState<{ d: string; c: string } | null>(null);
  const [category, setCategory] = useState(parsed?.categoryHint || '');
  useEffect(() => {
    if (!user || !key) return;
    let cancelled = false;
    getDoc(doc(db, 'receiptPayees', user.uid))
      .then((snap) => {
        const m = snap.data()?.map?.[key];
        if (cancelled || !m) return;
        if (typeof m.d === 'string' && m.d) setPayee(m.d);
        if (typeof m.c === 'string' && m.c) setCategory(m.c);
        setRemembered({ d: m.d || '', c: m.c || '' });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, key]);

  if (!share || !parsed) {
    return (
      <div className="p-6 max-w-md mx-auto text-center space-y-3">
        <span className="material-symbols-outlined text-5xl text-primary">receipt_long</span>
        <h1 className="text-lg font-black text-primary">Share a receipt</h1>
        <p className="text-sm text-text-muted">
          Open a payment in PhonePe or Paytm, tap <b>Share receipt</b> and choose <b>FamilyLedger</b>. We'll read the amount, who you paid and the date, so you can add it as an expense.
        </p>
        <button onClick={() => navigate('/')} className="px-5 py-2.5 rounded-xl bg-primary text-white font-bold text-sm">Back to Home</button>
      </div>
    );
  }

  const canCreate = /^\d+(\.\d{1,2})?$/.test(amount) && parsed.direction !== 'received';

  const createExpense = () => {
    const q = new URLSearchParams();
    q.set('amount', amount);
    if (payee.trim()) q.set('description', payee.trim());
    if (date) q.set('date', date);
    if (category) q.set('category', category);
    // The picture goes along as router state (too big for the URL); Add Expense shows it under the receipt photos.
    navigate(`/add-expense?${q.toString()}`, { state: { receiptImages: share.imageData ? [share.imageData] : [], payeeKey: key, fromReceipt: true } });
  };

  const debug = {
    mime: share.mime,
    kind: share.kind,
    name: share.name,
    sizeBytes: share.sizeBytes,
    sentBy: share.referrer,
    imageSize: share.width ? `${share.width}x${share.height}` : undefined,
    pages: share.pages,
    pluginVersion: share.pluginVersion,
    imageChars: share.imageChars,
    imageError: share.imageError,
    ocrMs: share.ocrMs,
    sharedText: share.text,
    subject: share.subject,
    error: share.error,
  };
  const debugText = JSON.stringify({ ...debug, imageAttached: !!share.imageData, parsed, ocrText: share.ocrText, lines: share.lines }, null, 2);

  return (
    <div className="p-4 max-w-md mx-auto space-y-4 pb-28">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/')} className="p-1 text-text-muted" aria-label="Close">
          <span className="material-symbols-outlined">close</span>
        </button>
        <h1 className="text-lg font-black text-primary">Receipt</h1>
        <span
          className={clsx(
            'ml-auto px-2.5 py-0.5 rounded-full text-[11px] font-black',
            parsed.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800',
          )}
        >
          {parsed.status === 'success' ? 'PAYMENT SUCCESSFUL' : parsed.status.toUpperCase()}
        </span>
      </div>

      {parsed.notes.length > 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 space-y-1">
          {parsed.notes.map((n) => (
            <p key={n} className="text-xs font-bold text-amber-900">⚠️ {n}</p>
          ))}
        </div>
      )}

      <div className="rounded-2xl bg-white border border-border-subtle p-4 space-y-3">
        <label className="block">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Amount (₹)</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="mt-1 w-full text-3xl font-black text-primary bg-surface rounded-xl px-3 py-2 outline-none"
          />
          {parsed.alternatives.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold text-text-muted">Which is right?</span>
              {parsed.alternatives.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAmount(a)}
                  className={clsx('px-3 py-1 rounded-full text-xs font-black border', amount === a ? 'bg-primary text-white border-primary' : 'bg-white text-primary border-border-subtle')}
                >
                  ₹{a}
                </button>
              ))}
            </div>
          )}
        </label>
        <label className="block">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{parsed.kind === 'bill' ? `Paid to · ${parsed.billType || 'Bill'}` : 'Paid to'}</span>
          <input value={payee} onChange={(e) => setPayee(e.target.value)} className="mt-1 w-full text-sm font-bold bg-surface rounded-xl px-3 py-2.5 outline-none" />
        </label>
        {(remembered || category) && (
          <div className="flex flex-wrap items-center gap-2 -mt-1">
            {remembered && <span className="px-2.5 py-1 rounded-full bg-green-100 text-green-800 text-[11px] font-black">✓ Remembered from last time</span>}
            {category && (
              <span className="px-2.5 py-1 rounded-full bg-surface text-primary text-[11px] font-black">
                {EXPENSE_CATEGORIES.find((c) => c.id === category)?.icon} {EXPENSE_CATEGORIES.find((c) => c.id === category)?.name || category}
              </span>
            )}
          </div>
        )}
        <label className="block">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Date{parsed.time ? ` · ${parsed.time}` : ''}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full text-sm font-bold bg-surface rounded-xl px-3 py-2.5 outline-none" />
        </label>
        {(parsed.txnId || parsed.paidFrom || parsed.message || parsed.upiId || parsed.reference) && (
          <div className="pt-2 border-t border-border-subtle space-y-1 text-[11px] text-text-muted">
            {parsed.paidFrom && <p><b>Paid from:</b> {parsed.paidFrom}</p>}
            {parsed.upiId && <p className="break-all"><b>UPI ID:</b> {parsed.upiId}</p>}
            {parsed.reference && <p><b>Number:</b> {parsed.reference}</p>}
            {parsed.message && <p><b>Message:</b> {parsed.message}</p>}
            {parsed.txnId && <p className="break-all"><b>Transaction ID:</b> {parsed.txnId}</p>}
            {parsed.utr && <p><b>UTR:</b> {parsed.utr}</p>}
          </div>
        )}
      </div>

      {/* The receipt picture always goes along to Add Expense (the user can remove it there). */}
      <div className="rounded-2xl bg-white border border-border-subtle p-3 flex items-center gap-3">
        {share.imageData ? (
          <img src={share.imageData} alt="Receipt" className="w-16 h-20 object-cover object-top rounded-lg border border-border-subtle" />
        ) : (
          <div className="w-16 h-20 rounded-lg bg-surface flex items-center justify-center text-text-muted">
            <span className="material-symbols-outlined">image_not_supported</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black text-primary">{share.imageData ? 'Receipt will be attached' : 'Receipt picture not received'}</p>
          <p className="text-[11px] text-text-muted">
            {share.imageData
              ? 'It goes to the expense as a receipt photo. You can remove it on the next screen.'
              : share.pluginVersion === undefined
              ? 'The installed app is an older test build that cannot pass the picture along. Install the newest APK (build 32 or later).'
              : `The picture could not be prepared${share.imageError ? ` (${share.imageError})` : ''}.`}
          </p>
        </div>
      </div>

      <button
        onClick={createExpense}
        disabled={!canCreate}
        className="w-full py-3.5 rounded-2xl bg-primary text-white font-black disabled:opacity-40"
      >
        Review &amp; add expense
      </button>
      <p className="text-[11px] text-text-muted text-center -mt-2">Nothing is saved until you confirm on the next screen.</p>

      <details className="rounded-2xl bg-white border border-border-subtle p-3">
        <summary className="text-xs font-black text-primary cursor-pointer">What FamilyLedger received (for testing)</summary>
        <div className="mt-3 space-y-2">
          <div className="text-[11px] text-text-muted space-y-0.5">
            {Object.entries(debug).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => (
              <p key={k} className="break-all"><b>{k}:</b> {String(v)}</p>
            ))}
          </div>
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Text read from the image</p>
          <pre className="text-[10px] bg-surface rounded-lg p-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">{share.ocrText || '(none)'}</pre>
          <button
            onClick={() => { navigator.clipboard?.writeText(debugText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}
            className="px-3 py-2 rounded-xl bg-primary/10 text-primary text-xs font-bold"
          >
            {copied ? 'Copied ✓' : 'Copy everything'}
          </button>
        </div>
      </details>
    </div>
  );
}
