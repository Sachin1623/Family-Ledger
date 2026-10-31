import React, { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { addDoc, collection, deleteDoc, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { getCurrencySymbol } from '../lib/constants';
import { parseLocalDate } from '../lib/dateUtils';
import { useIdentities } from '../lib/userIdentity';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import TrackPaymentSheet, { useTrackInGroup } from '../components/TrackPaymentSheet';

// A "Payments" group: money one member pays another (rent, maintenance, salary, EMI, fees). It is a record, not a split, so
// nothing here makes anyone owe anyone. The payer adds the entry (fromUid is always the signed-in user) and is asked for a
// receipt; the receiver sees it, receipt included, with no confirmation step.

const LABELS: Array<{ label: string; icon: string }> = [
  { label: 'Rent', icon: 'home' },
  { label: 'Maintenance', icon: 'build' },
  { label: 'Salary', icon: 'badge' },
  { label: 'EMI', icon: 'account_balance' },
  { label: 'Fees', icon: 'school' },
  { label: 'Other', icon: 'payments' },
];
const iconFor = (label?: string) => LABELS.find((l) => l.label.toLowerCase() === (label || '').toLowerCase())?.icon || 'payments';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function GroupPayments() {
  const { groupId } = useParams<{ groupId: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [groupSnap] = useDocument(groupId ? doc(db, 'groups', groupId) : null);
  const group: any = groupSnap?.data();
  const [membersSnap] = useCollection(groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null);
  const [paymentsSnap, loading] = useCollection(groupId ? query(collection(db, 'groupPayments'), where('groupId', '==', groupId)) : null);

  const members = useMemo(() => (membersSnap?.docs.map((d) => d.data() as any) || []), [membersSnap]);
  const payments = useMemo(() => {
    const list = (paymentsSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as any[];
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [paymentsSnap]);

  const resolve = useIdentities([...members.map((m) => m.userId), ...payments.flatMap((p) => [p.fromUid, p.toUid])]);
  const nameOf = (uid: string) => {
    if (uid === user?.uid) return 'You';
    const m = members.find((x) => x.userId === uid);
    return resolve(uid, m?.displayName).name || 'Member';
  };

  const symbol = getCurrencySymbol(group?.currency);
  const money = (n: number) => `${symbol}${Math.round(n).toLocaleString()}`;

  const [showForm, setShowForm] = useState(searchParams.get('add') === '1'); // the Dashboard card's "Add a payment" lands here with the form open
  const [receiptFor, setReceiptFor] = useState<any | null>(null); // the entry the receipt prompt / "add receipt" is about
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [trackFor, setTrackFor] = useState<any | null>(null); // the entry being kept in one of my own groups
  // where I have already kept each payment (one note per payment per person), so it is offered once and shows where it went
  const [linksSnap] = useCollection(user ? query(collection(db, 'paymentLinks'), where('uid', '==', user.uid)) : null);
  const linkByPayment = useMemo(() => {
    const map: Record<string, any> = {};
    linksSnap?.docs.forEach((d) => { const l: any = d.data(); map[l.paymentId] = l; });
    return map;
  }, [linksSnap]);

  const monthKey = todayLocal().slice(0, 7);
  const paidThisMonth = payments.filter((p) => (p.date || '').startsWith(monthKey)).reduce((s, p) => s + (p.amount || 0), 0);
  const others = members.filter((m) => m.userId !== user?.uid);

  const removePayment = async (p: any) => {
    if (!window.confirm(`Delete this ${money(p.amount)} payment?`)) return;
    try { await deleteDoc(doc(db, 'groupPayments', p.id)); } catch (err) { console.error('Could not delete payment:', err); }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pb-28 pt-4 space-y-4">
      <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#2e2a8f,#4f46e5 55%,#818cf8)' }}>
        <p className="text-[11px] font-black uppercase tracking-wider text-white/85 truncate">{group?.icon} {group?.name || 'Payments'} · Payments</p>
        <p className="text-[28px] font-black leading-tight tabular-nums">{money(paidThisMonth)}</p>
        <p className="text-[12px] text-white/90">paid this month · {payments.length} payment{payments.length === 1 ? '' : 's'} in all</p>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          disabled={others.length === 0}
          className="mt-3 w-full rounded-xl bg-white text-[#4338ca] py-2.5 text-sm font-black active:scale-95 disabled:opacity-50"
        >
          ＋ Add a payment
        </button>
        {others.length === 0 && <p className="mt-2 text-[11px] font-bold text-white/85">Invite the person you pay (or who pays you) to this group first.</p>}
      </div>

      {loading && <p className="text-center text-sm text-text-muted py-6">Loading payments…</p>}
      {!loading && payments.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border-subtle p-6 text-center text-sm text-text-muted">
          No payments yet. When you pay rent, maintenance or anything regular to someone in this group, add it here and attach the receipt.
        </div>
      )}

      <div className="space-y-3">
        {payments.map((p) => {
          const mine = p.fromUid === user?.uid;
          const images: string[] = p.images || [];
          return (
            <div key={p.id} className="p-3 bg-white border border-border-subtle rounded-2xl shadow-sm">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[20px]">{iconFor(p.label)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-black text-primary truncate">{p.label || 'Payment'}</p>
                    <p className="text-base font-black tabular-nums text-on-surface whitespace-nowrap">{money(p.amount)}</p>
                  </div>
                  <p className="text-[12px] font-bold text-text-muted">{nameOf(p.fromUid)} → {nameOf(p.toUid)}</p>
                  <p className="text-[11px] text-text-muted">{parseLocalDate(p.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  {p.note && <p className="text-xs text-on-surface mt-1 break-words">{p.note}</p>}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {images.map((src, i) => (
                  <button key={i} type="button" onClick={() => setLightbox(src)} className="w-12 h-12 rounded-lg overflow-hidden border border-border-subtle">
                    <img src={src} alt="Receipt" className="w-full h-full object-cover" />
                  </button>
                ))}
                {images.length === 0 && mine && (
                  <button type="button" onClick={() => setReceiptFor(p)} className="text-[11px] font-black rounded-full bg-amber-100 text-amber-800 px-3 py-1.5 active:scale-95">
                    Receipt missing · Add
                  </button>
                )}
                {images.length === 0 && !mine && <span className="text-[11px] text-text-muted">No receipt attached</span>}
                {images.length > 0 && mine && images.length < 3 && (
                  <button type="button" onClick={() => setReceiptFor(p)} className="text-[11px] font-bold text-primary px-2 py-1">＋ Add another</button>
                )}
                {(mine || p.toUid === user?.uid) && (
                  linkByPayment[p.id] ? (
                    <span className="text-[11px] font-black rounded-full bg-success/10 text-success px-3 py-1.5">Tracked in {linkByPayment[p.id].groupName} ✓</span>
                  ) : (
                    <button type="button" onClick={() => setTrackFor(p)} className="text-[11px] font-black rounded-full bg-primary/10 text-primary px-3 py-1.5 active:scale-95">
                      {mine ? 'Track as expense' : 'Track as income'}
                    </button>
                  )
                )}
                <span className="flex-1" />
                {(mine || group?.createdBy === user?.uid) && (
                  <button type="button" onClick={() => removePayment(p)} className="text-[11px] font-bold text-error px-2 py-1" aria-label="Delete payment">Delete</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showForm && user && groupId && (
        <PaymentForm
          groupId={groupId}
          uid={user.uid}
          symbol={symbol}
          others={others}
          nameOf={nameOf}
          onClose={() => setShowForm(false)}
          onSaved={(saved, track) => {
            setShowForm(false);
            // saved without a receipt: ask for it straight away, since a payment with no proof is the usual dispute
            if (!saved.images?.length) setReceiptFor(saved);
            if (track) setTrackFor(saved);
          }}
        />
      )}

      {receiptFor && (
        <ReceiptSheet
          payment={receiptFor}
          onClose={() => setReceiptFor(null)}
        />
      )}

      {trackFor && !receiptFor && user && (
        <TrackPaymentSheet payment={trackFor} role={trackFor.fromUid === user.uid ? 'payer' : 'receiver'} onClose={() => setTrackFor(null)} />
      )}

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function PaymentForm({
  groupId, uid, symbol, others, nameOf, onClose, onSaved,
}: {
  groupId: string;
  uid: string;
  symbol: string;
  others: any[];
  nameOf: (uid: string) => string;
  onClose: () => void;
  onSaved: (saved: any, track: boolean) => void;
}) {
  const [toUid, setToUid] = useState<string>(others.length === 1 ? others[0].userId : '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [label, setLabel] = useState('Rent');
  const [customLabel, setCustomLabel] = useState('');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [trackIt, setTrackIt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const finalLabel = label === 'Other' ? (customLabel.trim() || 'Payment') : label;
  // "Also track it in my group": the group, category and split choices appear here once the switch is on
  const track = useTrackInGroup({ amount: Number(amount) || 0, label: finalLabel, note: note.trim(), date, images, groupId }, 'payer', trackIt);

  const save = async () => {
    const value = Number(amount);
    if (!toUid) return setError('Choose who you paid.');
    if (!(value > 0)) return setError('Enter the amount you paid.');
    if (trackIt) {
      const { error: problem } = track.validate();
      if (problem) return setError(problem);
    }
    setSaving(true);
    setError('');
    const data = {
      groupId,
      fromUid: uid,
      toUid,
      amount: value,
      date,
      label: finalLabel.slice(0, 60),
      ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}),
      ...(images.length ? { images } : {}),
      addedBy: uid,
      createdAt: new Date().toISOString(),
    };
    try {
      const ref = await addDoc(collection(db, 'groupPayments'), data);
      const saved = { id: ref.id, ...data };
      if (trackIt) {
        try {
          await track.commit(saved);
        } catch (trackErr) {
          console.error('Payment saved, but it could not be tracked:', trackErr);
          window.alert('The payment is saved, but it could not be tracked in your group. You can try again with “Track as expense” on the entry.');
        }
      }
      onSaved(saved, false);
    } catch (err) {
      console.error('Could not save payment:', err);
      setError('Could not save the payment. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-primary">Add a payment</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-text-muted"><span className="material-symbols-outlined">close</span></button>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">You paid</label>
          <div className="flex flex-wrap gap-2">
            {others.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => setToUid(m.userId)}
                className={clsx('px-3 py-2 rounded-xl text-xs font-bold border', toUid === m.userId ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
              >
                {nameOf(m.userId)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-text-muted px-1">Amount</label>
            <div className="flex items-center gap-1 rounded-xl border border-border-subtle px-3 py-2.5">
              <span className="text-sm font-black text-text-muted">{symbol}</span>
              <input type="number" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-transparent outline-none text-sm font-black" placeholder="0" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-text-muted px-1">Date</label>
            <input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value || todayLocal())} className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">What for</label>
          <div className="flex flex-wrap gap-2">
            {LABELS.map((l) => (
              <button
                key={l.label}
                type="button"
                onClick={() => setLabel(l.label)}
                className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border', label === l.label ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
              >
                {l.label}
              </button>
            ))}
          </div>
          {label === 'Other' && (
            <input value={customLabel} maxLength={60} onChange={(e) => setCustomLabel(e.target.value)} placeholder="e.g. Pocket money" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Note (optional)</label>
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. November rent" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm bg-transparent" />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Receipt or screenshot</label>
          <ImageAttachments images={images} onChange={setImages} label="Add payment receipt" />
        </div>

        <button type="button" role="switch" aria-checked={trackIt} onClick={() => setTrackIt(!trackIt)} className={clsx('w-full flex items-center gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left transition-all', trackIt ? 'border-primary bg-primary/5' : 'border-border-subtle')}>
          <span className={clsx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', trackIt ? 'bg-primary text-white' : 'bg-surface text-primary')}><span className="material-symbols-outlined text-[20px]">account_tree</span></span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-extrabold text-primary">Also track it in my group</span>
            <span className="block text-[11px] text-text-muted leading-snug">Keep it as an expense in one of your own groups, split if that group splits.</span>
          </span>
          <span className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', trackIt ? 'bg-primary' : 'bg-border-subtle')}><span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', trackIt ? 'left-6' : 'left-1')} /></span>
        </button>

        {trackIt && <div className="rounded-2xl bg-surface p-3.5">{track.fields}</div>}

        {error && <p className="text-xs font-bold text-error">{error}</p>}
        <button type="button" onClick={save} disabled={saving} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95 disabled:opacity-50">
          {saving ? 'Saving…' : trackIt ? 'Save and track' : 'Save payment'}
        </button>
      </div>
    </div>
  );
}

// Asked right after a payment is saved without a receipt, and reused for "Receipt missing · Add" on an existing entry
function ReceiptSheet({ payment, onClose }: { payment: any; onClose: () => void }) {
  const [images, setImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const existing: string[] = payment.images || [];

  const save = async () => {
    if (images.length === 0) return onClose();
    setSaving(true);
    setError('');
    try {
      await updateDoc(doc(db, 'groupPayments', payment.id), { images: [...existing, ...images].slice(0, 3) });
      onClose();
    } catch (err) {
      console.error('Could not attach receipt:', err);
      setError('Could not attach the receipt. Try a smaller photo or check your connection.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[310] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <h2 className="text-lg font-black text-primary">Add the payment receipt</h2>
        <p className="text-xs text-text-muted">A screenshot of the payment or a photo of the receipt keeps the record clear for both of you.</p>
        <ImageAttachments images={images} onChange={setImages} maxImages={Math.max(1, 3 - existing.length)} label="Add receipt or screenshot" />
        {error && <p className="text-xs font-bold text-error">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border-subtle py-2.5 text-sm font-bold text-text-muted active:scale-95">Skip for now</button>
          <button type="button" onClick={save} disabled={saving || images.length === 0} className="flex-1 rounded-xl bg-primary text-white py-2.5 text-sm font-black active:scale-95 disabled:opacity-50">{saving ? 'Saving…' : 'Attach receipt'}</button>
        </div>
      </div>
    </div>
  );
}
