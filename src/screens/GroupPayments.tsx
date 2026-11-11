import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { addDoc, collection, deleteDoc, deleteField, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { getCurrencySymbol } from '../lib/constants';
import { formatRelativeTimeAgo, parseLocalDate } from '../lib/dateUtils';
import { ownPhoto, useIdentities } from '../lib/userIdentity';
import MemberAvatar from '../components/MemberAvatar';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import TrackPaymentSheet, { useTrackInGroup } from '../components/TrackPaymentSheet';
import { notifyPaymentChange, nudgeForReceipt } from '../lib/paymentApi';
import PaymentRemindersSheet from '../components/PaymentRemindersSheet';
import { PaymentReminder, REMINDER_TYPES, REMINDER_TYPE_ICON, skipPaidOccurrences } from '../lib/paymentReminders';
import { BackClose, useModalBack } from '../lib/useModalBack';
import PaymentRolePicker, { canPay, canReceive, PAYMENT_ROLE_LABEL, isPaymentRole } from '../components/PaymentRolePicker';
import { PaymentCategory, isMaterialIcon, paymentCategoryIcon, visiblePaymentCategories } from '../lib/paymentCategories';

// A "Payments" group: money one member pays another (rent, maintenance, salary, EMI, fees). It is a record, not a split, so
// nothing here makes anyone owe anyone. ANY member can record a payment between any two members (a payer records what they paid; a
// receiver records "Ravi paid me"). The payer is asked for a receipt, and anyone else can nudge them for it; the receiver sees it,
// receipt included, with no confirmation step.
// A payment can also be a SECURITY DEPOSIT (`kind: 'deposit'`): money paid to the receiver that comes back after any damage and repairs
// are settled. It is not spending, so it stays out of the month's totals; the receiver records what is returned and what is kept.

// a category's icon: a Material symbol for the built-in ones, an emoji for ones the group added
const Glyph = ({ icon }: { icon: string }) => (isMaterialIcon(icon)
  ? <span className="material-symbols-outlined text-[20px]">{icon}</span>
  : <span className="text-[20px] leading-none">{icon}</span>);

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const isDeposit = (p: any) => p?.kind === 'deposit';
const settlementsOf = (p: any): any[] => (Array.isArray(p?.depositSettlements) ? p.depositSettlements : []);
// what the receiver still holds: the deposit less everything returned or kept so far
const depositBalance = (p: any) => Math.max(0, (Number(p?.amount) || 0) - settlementsOf(p).reduce((s, x) => s + (Number(x.returned) || 0) + (Number(x.kept) || 0), 0));
const DEPOSIT_LABEL = 'Security deposit';
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // the server allows one receipt nudge per payment every 6 hours
const bytesOf = (a: string[]) => a.reduce((s, x) => s + x.length, 0);
const DOC_IMAGE_BUDGET = 900_000; // a payment lives in one Firestore document (1 MB cap), photos included

export default function GroupPayments() {
  const { groupId } = useParams<{ groupId: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [groupSnap] = useDocument(groupId ? doc(db, 'groups', groupId) : null);
  const group: any = groupSnap?.data();
  const [showReminders, setShowReminders] = useState(searchParams.get('reminders') === '1'); // the Dashboard card's "Manage" lands here
  const [remindersSnap] = useCollection(groupId ? query(collection(db, 'groupPaymentReminders'), where('groupId', '==', groupId)) : null);
  const groupReminders = useMemo(() => (remindersSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as PaymentReminder[], [remindersSnap]);
  const reminderCount = groupReminders.filter((r) => r.active).length;
  const [membersSnap] = useCollection(groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null);
  const [paymentsSnap, loading] = useCollection(groupId ? query(collection(db, 'groupPayments'), where('groupId', '==', groupId)) : null);

  const members = useMemo(() => (membersSnap?.docs.map((d) => d.data() as any) || []), [membersSnap]);
  const payments = useMemo(() => {
    const list = (paymentsSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as any[];
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [paymentsSnap]);

  const resolve = useIdentities([...members.map((m) => m.userId), ...payments.flatMap((p) => [p.fromUid, p.toUid, p.addedBy])]);
  const nameOf = (uid: string) => {
    if (uid === user?.uid) return 'You';
    const m = members.find((x) => x.userId === uid);
    return resolve(uid, m?.displayName).name || 'Member';
  };

  const photoOf = (uid: string) => {
    const m = members.find((x) => x.userId === uid);
    return resolve(uid, m?.displayName, m?.photoURL).photo || (uid === user?.uid ? ownPhoto(user) : '');
  };

  const symbol = getCurrencySymbol(group?.currency);
  const money = (n: number) => `${symbol}${Math.round(n).toLocaleString()}`;

  const [showForm, setShowForm] = useState(searchParams.get('add') === '1'); // the Dashboard card's "Add a payment" lands here with the form open
  // a payment reminder tapped while this screen is already open (the same route is reused, so the line above does not run again)
  const addParam = searchParams.get('add') + (searchParams.get('label') || '');
  const firstAddParam = useRef(addParam);
  useEffect(() => {
    if (addParam === firstAddParam.current) return;
    firstAddParam.current = addParam;
    if (searchParams.get('add') === '1') setShowForm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addParam]);
  // the same for "Manage" on the Dashboard card while this screen is already open
  const remParam = searchParams.get('reminders') || '';
  const firstRemParam = useRef(remParam);
  useEffect(() => {
    if (remParam === firstRemParam.current) return;
    firstRemParam.current = remParam;
    if (remParam === '1') setShowReminders(true);
  }, [remParam]);
  const [receiptFor, setReceiptFor] = useState<any | null>(null); // the entry the receipt prompt / "add receipt" is about
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<any | null>(null); // the payment its recorder is editing
  const [trackFor, setTrackFor] = useState<any | null>(null); // the entry being kept in one of my own groups
  const [settleFor, setSettleFor] = useState<any | null>(null); // the security deposit the receiver is recording a refund for
  const [nudging, setNudging] = useState<string | null>(null); // the payment whose "nudge for receipt" is being sent
  const [nudgeError, setNudgeError] = useState<{ id: string; text: string } | null>(null);
  // where I have already kept each payment (one note per payment per person), so it is offered once and shows where it went
  const [linksSnap] = useCollection(user ? query(collection(db, 'paymentLinks'), where('uid', '==', user.uid)) : null);
  const linkByPayment = useMemo(() => {
    const map: Record<string, any> = {};
    linksSnap?.docs.forEach((d) => { const l: any = d.data(); map[l.paymentId] = l; });
    return map;
  }, [linksSnap]);

  const monthKey = todayLocal().slice(0, 7);
  // deposits are not spending: they stay out of the month's total and have their own line
  const ordinary = payments.filter((p) => !isDeposit(p));
  const deposits = payments.filter(isDeposit);
  const paidThisMonth = ordinary.filter((p) => (p.date || '').startsWith(monthKey)).reduce((s, p) => s + (p.amount || 0), 0);
  const depositsHeld = deposits.reduce((s, p) => s + depositBalance(p), 0);
  // receivers first, so the people you most likely pay are at the front
  const others = members.filter((m) => m.userId !== user?.uid).sort((a, b) => Number(canReceive(b.paymentRole)) - Number(canReceive(a.paymentRole)));
  const myMember = members.find((m) => m.userId === user?.uid);
  const myRole = myMember?.paymentRole;

  // the usual reminder types, then the group's own payment categories, then Other
  const ownCategories = visiblePaymentCategories(group).filter((c) => !/^other$/i.test(c.name));
  const baseTypes = REMINDER_TYPES.filter((t) => t !== 'Other').map((name) => ({ name, icon: ownCategories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.icon || REMINDER_TYPE_ICON[name] }));
  const typeOptions = [
    ...baseTypes,
    ...ownCategories.filter((c) => !baseTypes.some((b) => b.name.toLowerCase() === c.name.toLowerCase())).map((c) => ({ name: c.name, icon: c.icon })),
    { name: 'Other', icon: 'payments' },
  ];
  const isAdmin = !!user && (group?.createdBy === user.uid || myMember?.role === 'admin');

  const removePayment = async (p: any) => {
    if (!window.confirm(`Delete this ${money(p.amount)} ${isDeposit(p) ? 'security deposit' : 'payment'}?`)) return;
    try { await deleteDoc(doc(db, 'groupPayments', p.id)); } catch (err) { console.error('Could not delete payment:', err); }
  };

  // asks the payer (push + feed) for the receipt; the server allows one nudge per payment every 6 hours
  const nudge = async (p: any) => {
    setNudging(p.id);
    setNudgeError(null);
    const result = await nudgeForReceipt(p.id);
    if (!result.ok) setNudgeError({ id: p.id, text: result.error || 'Could not send the reminder.' });
    setNudging(null);
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pb-28 pt-4 space-y-4">
      <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#2e2a8f,#4f46e5 55%,#818cf8)' }}>
        <p className="text-[11px] font-black uppercase tracking-wider text-white/85 truncate">{group?.icon} {group?.name || 'Payments'} · Payments</p>
        <p className="text-[28px] font-black leading-tight tabular-nums">{money(paidThisMonth)}</p>
        <p className="text-[12px] text-white/90">paid this month · {ordinary.length} payment{ordinary.length === 1 ? '' : 's'} in all{deposits.length > 0 && ` · ${deposits.length} deposit${deposits.length === 1 ? '' : 's'}`}</p>
        {deposits.length > 0 && (
          <p className="mt-1 text-[12px] font-bold text-white/95 flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">lock</span>
            {depositsHeld > 0 ? `${money(depositsHeld)} in security deposits held` : 'All security deposits settled'}
          </p>
        )}
        {isPaymentRole(myRole) && <p className="mt-1 text-[11px] font-black uppercase tracking-wider text-white/85">You are: {PAYMENT_ROLE_LABEL[myRole]}</p>}
        <button
          type="button"
          onClick={() => setShowForm(true)}
          disabled={others.length === 0}
          className="mt-3 w-full rounded-xl bg-white text-[#4338ca] py-2.5 text-sm font-black active:scale-95 disabled:opacity-50"
        >
          ＋ Add a payment
        </button>
        {others.length === 0 && <p className="mt-2 text-[11px] font-bold text-white/85">Invite the person you pay (or who pays you) to this group first.</p>}
        <button
          type="button"
          onClick={() => setShowReminders(true)}
          className="mt-2 w-full rounded-xl bg-white/15 text-white py-2.5 text-sm font-black active:scale-95 flex items-center justify-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[18px]">alarm_add</span>
          Payment reminders{reminderCount > 0 ? ` · ${reminderCount} on` : ''}
        </button>
      </div>

      {showReminders && groupId && (
        <PaymentRemindersSheet
          groupId={groupId}
          groupName={group?.name || ''}
          symbol={symbol}
          typeOptions={typeOptions}
          isAdmin={isAdmin}
          reminders={groupReminders}
          members={members.map((m) => ({ userId: m.userId, name: nameOf(m.userId), photo: photoOf(m.userId), role: m.paymentRole }))}
          onClose={() => setShowReminders(false)}
        />
      )}

      {loading && <p className="text-center text-sm text-text-muted py-6">Loading payments…</p>}
      {!loading && payments.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border-subtle p-6 text-center text-sm text-text-muted">
          No payments yet. When you pay rent, maintenance or anything regular to someone in this group, add it here and attach the receipt. If someone paid you, add it too and nudge them for the receipt.
        </div>
      )}

      <div className="space-y-3">
        {payments.map((p) => {
          const mine = p.fromUid === user?.uid;
          const deposit = isDeposit(p);
          const images: string[] = p.images || [];
          const settlements = settlementsOf(p);
          const balance = deposit ? depositBalance(p) : 0;
          const canAttach = mine || p.addedBy === user?.uid; // the payer, or whoever recorded it, may add the receipt
          const canSettle = deposit && balance > 0 && (p.toUid === user?.uid || isAdmin);
          const canDelete = p.addedBy === user?.uid || isAdmin;
          const nudgedAt = p.receiptNudgedAt ? Date.parse(p.receiptNudgedAt) : NaN;
          const nudgedRecently = Number.isFinite(nudgedAt) && Date.now() - nudgedAt < NUDGE_COOLDOWN_MS;
          const payerFirst = nameOf(p.fromUid).split(' ')[0];
          return (
            <div key={p.id} className="p-3 bg-white border border-border-subtle rounded-2xl shadow-sm">
              <div className="flex items-start gap-3">
                <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', deposit ? 'bg-[#eef0ff] text-[#4338ca]' : 'bg-primary/10 text-primary')}>
                  <Glyph icon={deposit ? 'lock' : paymentCategoryIcon(group, p.label)} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-black text-primary truncate">{deposit ? DEPOSIT_LABEL : p.label || 'Payment'}</p>
                    <p className="text-base font-black tabular-nums text-on-surface whitespace-nowrap">{money(p.amount)}</p>
                  </div>
                  <p className="text-[12px] font-bold text-text-muted flex items-center gap-1.5 flex-wrap">
                    <MemberAvatar name={nameOf(p.fromUid)} photo={photoOf(p.fromUid)} size={20} />{nameOf(p.fromUid)} →
                    <MemberAvatar name={nameOf(p.toUid)} photo={photoOf(p.toUid)} size={20} />{nameOf(p.toUid)}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    {parseLocalDate(p.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                    {p.addedBy && p.addedBy !== p.fromUid && ` · recorded by ${nameOf(p.addedBy)}`}
                    {p.editedAt && ' · edited'}
                  </p>
                  {p.note && <p className="text-xs text-on-surface mt-1 break-words">{p.note}</p>}
                </div>
              </div>

              {deposit && (
                <div className="mt-2 rounded-xl bg-[#f6f7ff] border border-[#e0e3ff] px-3 py-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[10px] font-black uppercase tracking-wider rounded-full bg-[#eef0ff] text-[#4338ca] px-2 py-0.5">Refundable deposit</span>
                    {balance === 0 ? (
                      <span className="text-[11px] font-black rounded-full bg-success/10 text-success px-2.5 py-1">Settled ✓</span>
                    ) : settlements.length === 0 ? (
                      <span className="text-[11px] font-black rounded-full bg-amber-100 text-amber-800 px-2.5 py-1">{money(balance)} held by {nameOf(p.toUid)}</span>
                    ) : (
                      <span className="text-[11px] font-black rounded-full bg-amber-100 text-amber-800 px-2.5 py-1">Partly settled · {money(balance)} still held</span>
                    )}
                  </div>
                  {settlements.map((s: any, i: number) => (
                    <div key={s.id || i} className="text-[12px] text-on-surface flex items-start gap-2">
                      <span className="material-symbols-outlined text-[16px] text-[#4338ca] mt-0.5">undo</span>
                      <div className="min-w-0 flex-1">
                        <p>
                          <b>{money(Number(s.returned) || 0)}</b> returned
                          {Number(s.kept) > 0 && <> · <b>{money(Number(s.kept))}</b> kept{s.reason ? ` for ${s.reason}` : ''}</>}
                        </p>
                        <p className="text-[11px] text-text-muted">{s.date ? parseLocalDate(s.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}{s.note ? ` · ${s.note}` : ''}</p>
                      </div>
                      {(s.images || []).map((src: string, k: number) => (
                        <button key={k} type="button" onClick={() => setLightbox(src)} className="w-9 h-9 rounded-lg overflow-hidden border border-border-subtle shrink-0">
                          <img src={src} alt="Refund receipt" className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  ))}
                  {canSettle && (
                    <button type="button" onClick={() => setSettleFor(p)} className="w-full rounded-lg bg-[#4338ca] text-white py-2 text-[12px] font-black active:scale-95">
                      Record a refund or deduction
                    </button>
                  )}
                </div>
              )}

              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {images.map((src, i) => (
                  <button key={i} type="button" onClick={() => setLightbox(src)} className="w-12 h-12 rounded-lg overflow-hidden border border-border-subtle">
                    <img src={src} alt="Receipt" className="w-full h-full object-cover" />
                  </button>
                ))}
                {images.length === 0 && canAttach && (
                  <button type="button" onClick={() => setReceiptFor(p)} className="text-[11px] font-black rounded-full bg-amber-100 text-amber-800 px-3 py-1.5 active:scale-95">
                    Receipt missing · Add
                  </button>
                )}
                {images.length === 0 && !mine && (
                  nudgedRecently ? (
                    <span className="text-[11px] font-bold rounded-full bg-surface text-text-muted px-3 py-1.5">{payerFirst} reminded {formatRelativeTimeAgo(p.receiptNudgedAt)}</span>
                  ) : (
                    <button type="button" onClick={() => nudge(p)} disabled={nudging === p.id} className="text-[11px] font-black rounded-full bg-[#eef0ff] text-[#4338ca] px-3 py-1.5 active:scale-95 disabled:opacity-60 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">notifications_active</span>
                      {nudging === p.id ? 'Sending…' : `Nudge ${payerFirst} for receipt`}
                    </button>
                  )
                )}
                {images.length > 0 && canAttach && images.length < 3 && (
                  <button type="button" onClick={() => setReceiptFor(p)} className="text-[11px] font-bold text-primary px-2 py-1">＋ Add another</button>
                )}
                {!deposit && (mine || p.toUid === user?.uid) && (
                  linkByPayment[p.id] ? (
                    <span className="text-[11px] font-black rounded-full bg-success/10 text-success px-3 py-1.5">Tracked in {linkByPayment[p.id].groupName} ✓</span>
                  ) : (
                    <button type="button" onClick={() => setTrackFor(p)} className="text-[11px] font-black rounded-full bg-primary/10 text-primary px-3 py-1.5 active:scale-95">
                      {mine ? 'Track as expense' : 'Track as income'}
                    </button>
                  )
                )}
                {p.addedBy === user?.uid && (
                  <button type="button" onClick={() => setEditFor(p)} className="text-[11px] font-bold text-primary px-2 py-1">Edit</button>
                )}
                <span className="flex-1" />
                {canDelete && (
                  <button type="button" onClick={() => removePayment(p)} className="text-[11px] font-bold text-error px-2 py-1" aria-label="Delete payment">Delete</button>
                )}
              </div>
              {nudgeError?.id === p.id && <p className="mt-1.5 text-[11px] font-bold text-error">{nudgeError.text}</p>}
            </div>
          );
        })}
      </div>

      {/* a reminder can open the form before there is anyone to pay: the "Invite the person you pay" note above says what to do first */}
      {((showForm && others.length > 0) || editFor) && user && groupId && (
        <PaymentForm
          editing={editFor}
          groupId={groupId}
          uid={user.uid}
          symbol={symbol}
          members={members}
          myRole={myRole}
          categories={visiblePaymentCategories(group)}
          initialLabel={searchParams.get('label') || ''}
          defaultTrackExpenseGroupId={myMember?.trackExpenseGroupId}
          defaultTrackIncomeGroupId={myMember?.trackIncomeGroupId}
          nameOf={nameOf}
          photoOf={photoOf}
          onClose={() => { setShowForm(false); setEditFor(null); }}
          onSaved={(saved, track) => {
            setShowForm(false);
            // paid ahead of a reminder: that one should not ring as well
            if (!isDeposit(saved)) void skipPaidOccurrences(groupReminders, saved.label, saved.date);
            // the payer saved it without a receipt: ask for it straight away, since a payment with no proof is the usual dispute.
            // (When someone else recorded it, the payer is told by notification, and anyone can nudge them from the entry.)
            if (!saved.images?.length && saved.fromUid === user.uid) setReceiptFor(saved);
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

      {settleFor && user && (
        <DepositSettleSheet
          payment={settleFor}
          symbol={symbol}
          uid={user.uid}
          payerName={nameOf(settleFor.fromUid)}
          onClose={() => setSettleFor(null)}
        />
      )}

      {trackFor && !receiptFor && user && (
        <>
          <BackClose onBack={() => setTrackFor(null)} />
          <TrackPaymentSheet payment={trackFor} role={trackFor.fromUid === user.uid ? 'payer' : 'receiver'} defaultGroupId={trackFor.fromUid === user.uid ? myMember?.trackExpenseGroupId : myMember?.trackIncomeGroupId} onClose={() => setTrackFor(null)} />
        </>
      )}

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function PaymentForm({
  groupId, uid, symbol, members, editing, myRole, categories, initialLabel, defaultTrackExpenseGroupId, defaultTrackIncomeGroupId, nameOf, photoOf, onClose, onSaved,
}: {
  photoOf: (uid: string) => string;
  initialLabel?: string; // what a payment reminder was for, so the form opens on it
  groupId: string;
  uid: string;
  symbol: string;
  members: any[];
  editing?: any;
  myRole?: string;
  categories: PaymentCategory[];
  defaultTrackExpenseGroupId?: string;
  defaultTrackIncomeGroupId?: string;
  nameOf: (uid: string) => string;
  onClose: () => void;
  onSaved: (saved: any, track: boolean) => void;
}) {
  const others = members.filter((m) => m.userId !== uid);
  // Any member of the group can add a payment, whatever their role. The person recording is usually the payer, but a member marked Receiver
  // starts from "someone paid me": the one marked Payer if there is exactly one, otherwise they choose who paid.
  const onlyPayer = myRole === 'receiver' ? others.filter((m) => canPay(m.paymentRole)) : [];
  const initialFrom: string = editing ? editing.fromUid : myRole === 'receiver' ? (onlyPayer.length === 1 ? onlyPayer[0].userId : '') : uid;
  // who gets paid by default: if someone else paid, the person recording; otherwise the one clear receiver (by role), or whoever is left
  const defaultTo = (from: string) => {
    if (from !== uid) return uid;
    const receivers = others.filter((m) => canReceive(m.paymentRole));
    return others.length === 1 ? others[0].userId : receivers.length === 1 ? receivers[0].userId : '';
  };
  const [fromUid, setFromUid] = useState<string>(initialFrom);
  const [toUid, setToUid] = useState<string>(editing ? editing.toUid : defaultTo(initialFrom));
  // a security deposit is chosen when the entry is created and stays one
  const [deposit, setDeposit] = useState<boolean>(editing ? isDeposit(editing) : false);
  // editing starts from the saved payment; a label that is no longer one of the categories is shown under "Other"
  const knownLabel = !!editing && categories.some((c) => c.name === editing.label);
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  const [date, setDate] = useState(editing?.date || todayLocal());
  // opened from a reminder: its label if the group has that category, otherwise under "Other" with the label filled in
  const hintKnown = !editing && !!initialLabel && categories.some((c) => c.name.toLowerCase() === initialLabel.toLowerCase());
  const hintOther = !editing && !!initialLabel && !hintKnown && categories.some((c) => c.id === 'other');
  const [label, setLabel] = useState(editing
    ? (knownLabel ? editing.label : (categories.find((c) => c.id === 'other')?.name || editing.label))
    : hintKnown ? categories.find((c) => c.name.toLowerCase() === initialLabel.toLowerCase())!.name
    : hintOther ? categories.find((c) => c.id === 'other')!.name
    : (categories[0]?.name || 'Payment'));
  const [customLabel, setCustomLabel] = useState(editing && !knownLabel ? editing.label : hintOther ? initialLabel : '');
  const [note, setNote] = useState(editing?.note || '');
  const [images, setImages] = useState<string[]>(editing?.images || []);
  // my own tracking: as an expense when I paid, as income when I was paid; not when someone else's payment was recorded by a third member
  const trackRole: 'payer' | 'receiver' | null = fromUid === uid ? 'payer' : toUid === uid ? 'receiver' : null;
  const canTrack = !editing && !deposit && trackRole !== null;
  // switched on from the start when this person has chosen a group to track their payments in
  const [trackIt, setTrackIt] = useState(!editing && !!(initialFrom === uid ? defaultTrackExpenseGroupId : defaultTrackIncomeGroupId));
  const tracking = trackIt && canTrack;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isOtherCategory = categories.find((c) => c.name === label)?.id === 'other';
  const finalLabel = deposit ? DEPOSIT_LABEL : isOtherCategory ? (customLabel.trim() || 'Payment') : label;
  // "Also track it in my group": the group, category and split choices appear here once the switch is on
  const track = useTrackInGroup({ amount: Number(amount) || 0, label: finalLabel, note: note.trim(), date, images, groupId }, trackRole || 'payer', tracking, trackRole === 'receiver' ? defaultTrackIncomeGroupId : defaultTrackExpenseGroupId);
  useModalBack(onClose); // Back closes the form, not the screen behind it

  const pickPayer = (id: string) => {
    setFromUid(id);
    setToUid(defaultTo(id));
    setTrackIt(false); // the role changed (payer / receiver), so the tracking choice starts again
  };

  const save = async () => {
    const value = Number(amount);
    if (!fromUid) return setError('Choose who paid.');
    if (!toUid || toUid === fromUid) return setError('Choose who received the money.');
    if (!(value > 0)) return setError(deposit ? 'Enter the deposit amount.' : 'Enter the amount paid.');
    if (editing && deposit) {
      const settled = settlementsOf(editing).reduce((s, x) => s + (Number(x.returned) || 0) + (Number(x.kept) || 0), 0);
      if (value < settled) return setError(`The deposit cannot be less than what has already been settled (${symbol}${Math.round(settled).toLocaleString()}).`);
    }
    if (tracking) {
      const { error: problem } = track.validate();
      if (problem) return setError(problem);
    }
    setSaving(true);
    setError('');
    if (editing) {
      // the recorder changes the payment; the server then updates every tracked copy and tells the other people in it
      try {
        await updateDoc(doc(db, 'groupPayments', editing.id), {
          toUid,
          amount: value,
          date,
          label: finalLabel.slice(0, 60),
          note: note.trim() ? note.trim().slice(0, 300) : deleteField(),
          images: images.length ? images : deleteField(),
          editedAt: new Date().toISOString(),
        });
        void notifyPaymentChange(editing.id, 'edited', editing.amount);
        onClose();
      } catch (err) {
        console.error('Could not save the changes:', err);
        setError('Could not save the changes. Check your connection and try again.');
        setSaving(false);
      }
      return;
    }
    const data = {
      groupId,
      fromUid,
      toUid,
      amount: value,
      date,
      label: finalLabel.slice(0, 60),
      ...(deposit ? { kind: 'deposit' } : {}),
      ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}),
      ...(images.length ? { images } : {}),
      addedBy: uid,
      createdAt: new Date().toISOString(),
    };
    try {
      const ref = await addDoc(collection(db, 'groupPayments'), data);
      const saved = { id: ref.id, ...data };
      void notifyPaymentChange(ref.id, 'created'); // lets the other people in the payment know
      if (tracking) {
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

  const Person: React.FC<{ m: any; selected: boolean; onPick: () => void; disabled?: boolean }> = ({ m, selected, onPick, disabled }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className={clsx('px-3 py-2 rounded-xl text-xs font-bold border disabled:opacity-100', selected ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
    >
      <MemberAvatar name={nameOf(m.userId)} photo={photoOf(m.userId)} size={22} className="mr-2 inline-flex align-middle" />{nameOf(m.userId)}{isPaymentRole(m.paymentRole) && <span className="ml-1.5 opacity-75 font-semibold">· {PAYMENT_ROLE_LABEL[m.paymentRole]}</span>}
    </button>
  );
  // me first, then the rest
  const ordered = [...members].sort((a, b) => Number(b.userId === uid) - Number(a.userId === uid));

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-primary">{editing ? (deposit ? 'Edit security deposit' : 'Edit payment') : deposit ? 'Add a security deposit' : 'Add a payment'}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-text-muted"><span className="material-symbols-outlined">close</span></button>
        </div>

        {myRole === 'receiver' && fromUid === uid && !editing && (
          <p className="text-[11px] font-bold rounded-xl bg-amber-50 text-amber-800 px-3 py-2">You are marked as a receiver. If someone paid you, choose them under “Paid by”.</p>
        )}
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Paid by</label>
          <div className="flex flex-wrap gap-2">
            {ordered.map((m) => <Person key={m.userId} m={m} selected={fromUid === m.userId} onPick={() => pickPayer(m.userId)} disabled={!!editing} />)}
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Paid to</label>
          <div className="flex flex-wrap gap-2">
            {ordered.filter((m) => m.userId !== fromUid).map((m) => <Person key={m.userId} m={m} selected={toUid === m.userId} onPick={() => setToUid(m.userId)} />)}
          </div>
          {fromUid !== uid && toUid !== uid && !editing && <p className="text-[11px] text-text-muted px-1">You are recording this for two other people. They will both be told.</p>}
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

        {!editing && (
          <button type="button" role="switch" aria-checked={deposit} onClick={() => { setDeposit(!deposit); setTrackIt(false); }} className={clsx('w-full flex items-center gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left transition-all', deposit ? 'border-[#4338ca] bg-[#eef0ff]' : 'border-border-subtle')}>
            <span className={clsx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', deposit ? 'bg-[#4338ca] text-white' : 'bg-surface text-[#4338ca]')}><span className="material-symbols-outlined text-[20px]">lock</span></span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-extrabold text-primary">This is a security deposit</span>
              <span className="block text-[11px] text-text-muted leading-snug">Refundable money held by the receiver. They return it after any damage and repairs are settled.</span>
            </span>
            <span className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', deposit ? 'bg-[#4338ca]' : 'bg-border-subtle')}><span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', deposit ? 'left-6' : 'left-1')} /></span>
          </button>
        )}

        {!deposit && (
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-text-muted px-1">What for</label>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setLabel(c.name)}
                  className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border', label === c.name ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                >
                  {c.name}
                </button>
              ))}
            </div>
            {isOtherCategory && (
              <input value={customLabel} maxLength={60} onChange={(e) => setCustomLabel(e.target.value)} placeholder="e.g. Pocket money" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
            )}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Note (optional)</label>
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={deposit ? 'e.g. Flat 4B, 11-month lease' : 'e.g. November rent'} className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm bg-transparent" />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Receipt or screenshot</label>
          <ImageAttachments images={images} onChange={setImages} label="Add payment receipt" />
          {fromUid !== uid && images.length === 0 && !editing && <p className="text-[11px] text-text-muted px-1">No receipt yet? Save it anyway: the payer is asked to add theirs.</p>}
        </div>

        {canTrack && (
          <button type="button" role="switch" aria-checked={trackIt} onClick={() => setTrackIt(!trackIt)} className={clsx('w-full flex items-center gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left transition-all', trackIt ? 'border-primary bg-primary/5' : 'border-border-subtle')}>
            <span className={clsx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', trackIt ? 'bg-primary text-white' : 'bg-surface text-primary')}><span className="material-symbols-outlined text-[20px]">account_tree</span></span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-extrabold text-primary">Also track it in my group</span>
              <span className="block text-[11px] text-text-muted leading-snug">{trackRole === 'receiver' ? 'Keep it as income in one of your own groups.' : 'Keep it as an expense in one of your own groups, split if that group splits.'}</span>
            </span>
            <span className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', trackIt ? 'bg-primary' : 'bg-border-subtle')}><span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', trackIt ? 'left-6' : 'left-1')} /></span>
          </button>
        )}

        {tracking && <div className="rounded-2xl bg-surface p-3.5">{track.fields}</div>}

        {editing && <p className="text-[11px] text-text-muted">The other people in this payment are told about the change, and any copy of it tracked in a group is updated too.</p>}
        {error && <p className="text-xs font-bold text-error">{error}</p>}
        <button type="button" onClick={save} disabled={saving} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95 disabled:opacity-50">
          {saving ? 'Saving…' : editing ? 'Save changes' : deposit ? 'Save deposit' : tracking ? 'Save and track' : 'Save payment'}
        </button>
      </div>
    </div>
  );
}

// Asked right after the payer saves a payment without a receipt, and reused for "Receipt missing · Add" on an existing entry
function ReceiptSheet({ payment, onClose }: { payment: any; onClose: () => void }) {
  const [images, setImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const existing: string[] = payment.images || [];
  useModalBack(onClose);

  const save = async () => {
    if (images.length === 0) return onClose();
    setSaving(true);
    setError('');
    try {
      await updateDoc(doc(db, 'groupPayments', payment.id), { images: [...existing, ...images].slice(0, 3) });
      void notifyPaymentChange(payment.id, 'receipt'); // tracked copies show the receipt too
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

// The receiver of a security deposit records what goes back and what is kept (damage, repairs, cleaning, unpaid dues). It can be done in
// one go or in several steps: the deposit stays "held" for whatever has not been returned or kept yet.
const KEEP_REASONS = ['Damages', 'Repairs', 'Cleaning', 'Unpaid dues'];
function DepositSettleSheet({ payment, symbol, uid, payerName, onClose }: { payment: any; symbol: string; uid: string; payerName: string; onClose: () => void }) {
  const held = depositBalance(payment);
  const money = (n: number) => `${symbol}${Math.round(n * 100) / 100}`;
  const [returned, setReturned] = useState(String(held));
  const [kept, setKept] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [note, setNote] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editedReturned = useRef(false); // once the person types the returned amount, stop recalculating it from what is kept
  useModalBack(onClose);

  const onKept = (v: string) => {
    setKept(v);
    if (!editedReturned.current) setReturned(String(Math.max(0, Math.round((held - (Number(v) || 0)) * 100) / 100)));
  };
  const r = Number(returned) || 0;
  const k = Number(kept) || 0;
  const stillHeld = Math.round((held - r - k) * 100) / 100;

  const save = async () => {
    if (r < 0 || k < 0) return setError('Amounts cannot be negative.');
    if (r + k <= 0) return setError('Enter the amount returned or the amount kept.');
    if (r + k > held + 0.001) return setError(`That is more than the ${money(held)} still held.`);
    if (k > 0 && !reason.trim()) return setError('Say what the kept amount is for (damage, repairs…).');
    const used = bytesOf(payment.images || []) + settlementsOf(payment).reduce((s, x) => s + bytesOf(x.images || []), 0);
    if (used + bytesOf(images) > DOC_IMAGE_BUDGET) return setError('This deposit already holds a lot of photos. Remove the new photo or try a smaller one.');
    setSaving(true);
    setError('');
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      returned: r,
      kept: k,
      ...(k > 0 ? { reason: reason.trim().slice(0, 80) } : {}),
      date,
      ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}),
      ...(images.length ? { images } : {}),
      by: uid,
      at: new Date().toISOString(),
    };
    try {
      await updateDoc(doc(db, 'groupPayments', payment.id), { depositSettlements: [...settlementsOf(payment), entry].slice(0, 20) });
      void notifyPaymentChange(payment.id, 'deposit_settled'); // tells the payer
      onClose();
    } catch (err) {
      console.error('Could not record the deposit settlement:', err);
      setError('Could not save this. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[310] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-3.5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-primary">Return the security deposit</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-text-muted"><span className="material-symbols-outlined">close</span></button>
        </div>
        <p className="text-xs text-text-muted">You hold <b className="text-on-surface">{money(held)}</b> of {payerName}’s deposit. Record what goes back and what you keep for damage or repairs; {payerName} is told.</p>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-text-muted px-1">Returned</label>
            <div className="flex items-center gap-1 rounded-xl border border-border-subtle px-3 py-2.5">
              <span className="text-sm font-black text-text-muted">{symbol}</span>
              <input type="number" inputMode="decimal" min="0" value={returned} onChange={(e) => { editedReturned.current = true; setReturned(e.target.value); }} className="w-full bg-transparent outline-none text-sm font-black" placeholder="0" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-text-muted px-1">Kept (damage / repairs)</label>
            <div className="flex items-center gap-1 rounded-xl border border-border-subtle px-3 py-2.5">
              <span className="text-sm font-black text-text-muted">{symbol}</span>
              <input type="number" inputMode="decimal" min="0" value={kept} onChange={(e) => onKept(e.target.value)} className="w-full bg-transparent outline-none text-sm font-black" placeholder="0" />
            </div>
          </div>
        </div>

        {k > 0 && (
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-text-muted px-1">What the kept amount is for</label>
            <div className="flex flex-wrap gap-2">
              {KEEP_REASONS.map((x) => (
                <button key={x} type="button" onClick={() => setReason(x)} className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border', reason === x ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>{x}</button>
              ))}
            </div>
            <input value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Repair of the bedroom door" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm bg-transparent" />
          </div>
        )}

        <p className={clsx('text-[12px] font-bold rounded-xl px-3 py-2', stillHeld < -0.001 ? 'bg-error/10 text-error' : stillHeld > 0.001 ? 'bg-amber-50 text-amber-800' : 'bg-success/10 text-success')}>
          {stillHeld < -0.001 ? `That is ${money(-stillHeld)} more than you hold.` : stillHeld > 0.001 ? `${money(stillHeld)} will still be held after this.` : 'This settles the whole deposit.'}
        </p>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Date</label>
          <input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value || todayLocal())} className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
        </div>
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm bg-transparent" />
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Proof of the refund or the repair bill (optional)</label>
          <ImageAttachments images={images} onChange={setImages} maxImages={1} label="Add a screenshot or photo" />
        </div>

        {error && <p className="text-xs font-bold text-error">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border-subtle py-2.5 text-sm font-bold text-text-muted active:scale-95">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="flex-1 rounded-xl bg-[#4338ca] text-white py-2.5 text-sm font-black active:scale-95 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
