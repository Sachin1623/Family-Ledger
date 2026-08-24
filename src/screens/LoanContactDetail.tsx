import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, orderBy, addDoc, doc, updateDoc, runTransaction } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { getCurrencySymbol, CURRENCY_SYMBOLS } from '../lib/constants';
import { ENTRY_TYPES, LoanEntryType, entryEffect, balanceLabel, buildWhatsAppReminder } from '../lib/loans';
import { todayLocalDateString } from '../lib/dateUtils';
import Comments from '../components/Comments';
import { useLanguage } from '../context/LanguageContext';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { claimPoints } from '../lib/pointsApi';

const CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

const toDatetimeLocalValue = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function timeAgo(iso: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 1) return t('loans.today');
  if (days === 1) return t('loans.yesterday');
  if (days < 30) return t('loans.daysAgo', { days });
  return new Date(iso).toLocaleDateString();
}

export default function LoanContactDetail() {
  const { contactId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();

  const [showEntryForm, setShowEntryForm] = useState(false);
  const [entryType, setEntryType] = useState<LoanEntryType>('repayment_by_them');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [entryDate, setEntryDate] = useState(todayLocalDateString());
  const [saving, setSaving] = useState(false);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);

  const [editingAccount, setEditingAccount] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editCurrency, setEditCurrency] = useState('INR');
  const [editEmail, setEditEmail] = useState('');
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [showInstallmentForm, setShowInstallmentForm] = useState(false);
  const [installmentAmount, setInstallmentAmount] = useState('');
  const [installmentFrequency, setInstallmentFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [installmentStart, setInstallmentStart] = useState('');

  const [showCommitmentForm, setShowCommitmentForm] = useState(false);
  const [commitmentMessage, setCommitmentMessage] = useState('');

  const [contactDoc] = useDocument(contactId ? doc(db, 'loanContacts', contactId) : null);
  const contact = contactDoc?.data() as any;
  const isOwner = !!user && contact?.ownerId === user.uid;
  const displayName = isOwner ? contact?.name : contact?.ownerName;
  const symbol = getCurrencySymbol(contact?.currency);
  const perspectiveBalance = contact ? (isOwner ? contact.balance : -contact.balance) : 0;
  const label = balanceLabel(perspectiveBalance);

  const [entriesValue] = useCollection(
    contactId ? query(collection(db, 'loanContacts', contactId, 'entries'), orderBy('createdAt', 'desc')) : null,
  );
  const entries = entriesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [commitmentsValue] = useCollection(
    contactId ? query(collection(db, 'loanContacts', contactId, 'commitments'), orderBy('createdAt', 'desc')) : null,
  );
  const commitments = commitmentsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const otherUserId = contact ? (isOwner ? contact.linkedUserId : contact.ownerId) : null;
  const myReminderField = isOwner ? 'ownerReminderAt' : 'counterpartyReminderAt';
  const myReminderSentField = isOwner ? 'ownerReminderSent' : 'counterpartyReminderSent';

  const notifyOther = async (action: string, extra: { description?: string; amount?: number | null } = {}) => {
    if (!otherUserId || !user) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/notify-loan-activity', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUserId: otherUserId,
          action,
          contactId,
          contactName: profile?.displayName || user.displayName || 'Someone',
          ...extra,
        }),
      });
    } catch (err) {
      console.error('notify-loan-activity failed:', err);
    }
  };

  const startEditingAccount = () => {
    setEditName(contact.name || '');
    setEditPhone(contact.phone || '');
    setEditCurrency(contact.currency || 'INR');
    setEditEmail('');
    setAccountError(null);
    setEditingAccount(true);
  };

  const handleSaveAccountEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !contactId || !editName.trim()) return;
    setSavingAccount(true);
    setAccountError(null);
    try {
      let linkedUserId = contact.linkedUserId || null;
      if (editEmail.trim()) {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/loans/find-user', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: editEmail.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setAccountError(data.error || t('loans.couldNotLookupEmail'));
          setSavingAccount(false);
          return;
        }
        if (data.uid) linkedUserId = data.uid;
      }

      await updateDoc(doc(db, 'loanContacts', contactId), {
        name: editName.trim(),
        phone: editPhone.trim() || null,
        currency: editCurrency,
        linkedUserId,
        updatedAt: new Date().toISOString(),
      });
      setEditingAccount(false);
    } catch (err) {
      console.error('Failed to update account:', err);
      setAccountError(t('loans.failedToSave'));
    } finally {
      setSavingAccount(false);
    }
  };

  const handleUnlink = async () => {
    if (!contactId || !window.confirm(t('loans.confirmUnlink'))) return;
    try {
      await updateDoc(doc(db, 'loanContacts', contactId), { linkedUserId: null, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('Failed to unlink:', err);
    }
  };

  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !contactId) return;
    const parsedAmount = evaluateAmountSum(amount);
    if (entryType !== 'note' && (!amount || !parsedAmount || parsedAmount <= 0)) return;
    setSaving(true);
    try {
      const effect = entryEffect(entryType, parsedAmount || 0);
      const entryRef = doc(collection(db, 'loanContacts', contactId, 'entries'));
      await runTransaction(db, async (transaction) => {
        const contactRef = doc(db, 'loanContacts', contactId);
        const snap = await transaction.get(contactRef);
        if (!snap.exists()) throw new Error('Not found');
        const newBalance = (snap.data().balance || 0) + effect;
        transaction.set(entryRef, {
          type: entryType,
          ...(entryType !== 'note' ? { amount: parsedAmount } : {}),
          description: description.trim(),
          date: entryDate,
          addedBy: user.uid,
          createdAt: new Date().toISOString(),
        });
        transaction.update(contactRef, { balance: newBalance, updatedAt: new Date().toISOString() });
      });
      await notifyOther(`entry_${entryType}`, { description: description.trim(), amount: entryType !== 'note' ? parsedAmount : null });
      if (entryType !== 'note') {
        claimPoints('feature_explorer', { feature: 'personalLoans', sourceCollection: `loanContacts/${contactId}/entries`, sourceDocId: entryRef.id, contactId });
      }
      setAmount('');
      setDescription('');
      setEntryDate(todayLocalDateString());
      setShowEntryForm(false);
    } catch (err) {
      console.error('Failed to add entry:', err);
      alert(t('loans.failedToAddEntry'));
    } finally {
      setSaving(false);
    }
  };

  const handleSetReminder = async (value: string) => {
    if (!contactId) return;
    try {
      await updateDoc(doc(db, 'loanContacts', contactId), {
        [myReminderField]: value ? new Date(value).toISOString() : null,
        [myReminderSentField]: false,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to set reminder:', err);
    }
  };

  const handleProposeInstallment = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedInstallmentAmount = evaluateAmountSum(installmentAmount);
    if (!user || !contactId || !parsedInstallmentAmount || parsedInstallmentAmount <= 0 || !installmentStart) return;
    try {
      const linked = !!contact.linkedUserId || !isOwner;
      await updateDoc(doc(db, 'loanContacts', contactId), {
        installmentPlan: {
          amount: parsedInstallmentAmount,
          frequency: installmentFrequency,
          startDate: installmentStart,
          nextDueDate: new Date(installmentStart).toISOString(),
          proposedBy: user.uid,
          status: linked ? 'pending' : 'active',
          reminderSent: false,
        },
        updatedAt: new Date().toISOString(),
      });
      await notifyOther('installment_proposed', { description: `${installmentFrequency}, starting ${installmentStart}`, amount: parsedInstallmentAmount });
      setShowInstallmentForm(false);
      setInstallmentAmount('');
      setInstallmentStart('');
    } catch (err) {
      console.error('Failed to propose installment plan:', err);
      alert(t('loans.failedToSaveInstallment'));
    }
  };

  const handleInstallmentResponse = async (accept: boolean) => {
    if (!contactId || !contact?.installmentPlan) return;
    try {
      await updateDoc(doc(db, 'loanContacts', contactId), {
        installmentPlan: { ...contact.installmentPlan, status: accept ? 'active' : 'declined' },
        updatedAt: new Date().toISOString(),
      });
      await notifyOther(accept ? 'installment_accepted' : 'installment_declined');
    } catch (err) {
      console.error('Failed to respond to installment plan:', err);
    }
  };

  const handleSendCommitment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !contactId || !commitmentMessage.trim()) return;
    try {
      await addDoc(collection(db, 'loanContacts', contactId, 'commitments'), {
        message: commitmentMessage.trim(),
        respondedBy: user.uid,
        createdAt: new Date().toISOString(),
      });
      await notifyOther('commitment_message', { description: commitmentMessage.trim() });
      setCommitmentMessage('');
      setShowCommitmentForm(false);
    } catch (err) {
      console.error('Failed to send message:', err);
      alert(t('loans.failedToSendMessage'));
    }
  };

  if (!contact) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <p className="text-sm text-text-muted">{t('common.loading')}</p>
        </main>
      </div>
    );
  }

  // The debtor is whichever side currently owes money — resolved fresh from the sign of the
  // stored balance, not fixed at any point in time (see processLoanReminders in server.ts).
  const isDebtor = (isOwner && contact.balance < 0) || (!isOwner && contact.balance > 0);
  const plan = contact.installmentPlan;
  const canRespondToPlan = plan && plan.status === 'pending' && plan.proposedBy !== user?.uid;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-center justify-between">
          <button onClick={() => navigate('/personal-loans')} className="text-xs font-bold text-primary flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            {t('loans.allRecords')}
          </button>
          {isOwner && !editingAccount && (
            <button onClick={startEditingAccount} className="text-xs font-bold text-primary flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">edit</span>
              {t('common.edit')}
            </button>
          )}
        </div>

        {editingAccount ? (
          <form onSubmit={handleSaveAccountEdit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">{t('loans.editAccountDetails')}</h2>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.name')}</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.phone')}</label>
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  placeholder={t('loans.forWhatsapp')}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.currency')}</label>
                <select
                  value={editCurrency}
                  onChange={(e) => setEditCurrency(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            {contact.linkedUserId ? (
              <div className="flex items-center justify-between p-3 bg-surface rounded-xl border border-border-subtle">
                <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">link</span>
                  {t('loans.linkedToAccount')}
                </span>
                <button type="button" onClick={handleUnlink} className="text-[11px] font-bold text-error">{t('loans.unlink')}</button>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.linkToAccountOptional')}</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  placeholder={t('loans.theirEmailPlaceholder')}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}
            {accountError && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{accountError}</div>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditingAccount(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={savingAccount} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                {savingAccount ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        ) : (
          <div className="bg-white rounded-2xl border border-border-subtle p-6 text-center space-y-2">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xl mx-auto">
              {displayName?.slice(0, 1) || '?'}
            </div>
            <h1 className="text-lg font-black text-primary">{displayName}</h1>
            <p className="text-[11px] text-text-muted uppercase font-bold tracking-wider">
              {label === 'settled' ? t('loans.settledUp') : label === 'owes_you' ? t('loans.owesYou') : t('loans.youOweLabel')}
            </p>
            <p className={clsx('text-3xl font-black', label === 'owes_you' ? 'text-[#0F7A38]' : label === 'you_owe' ? 'text-error' : 'text-text-muted')}>
              {symbol}{Math.abs(perspectiveBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
            <a
              href={buildWhatsAppReminder({ contactName: displayName, phone: contact.phone, balance: perspectiveBalance, currencySymbol: symbol, t })}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 mt-2 px-4 py-2 bg-[#25D366]/10 text-[#128C4A] rounded-xl text-xs font-bold border border-[#25D366]/20"
            >
              <span className="material-symbols-outlined text-[16px]">chat</span>
              {t('loans.sendWhatsappReminder')}
            </a>
          </div>
        )}

        {isDebtor && (
          <div className="bg-surface rounded-2xl border border-border-subtle p-4 space-y-2">
            {!showCommitmentForm ? (
              <button
                onClick={() => setShowCommitmentForm(true)}
                className="w-full py-2.5 bg-white border border-border-subtle rounded-xl text-xs font-bold text-primary"
              >
                {t('loans.cantPayYet')}
              </button>
            ) : (
              <form onSubmit={handleSendCommitment} className="space-y-2">
                <textarea
                  value={commitmentMessage}
                  onChange={(e) => setCommitmentMessage(e.target.value)}
                  rows={2}
                  placeholder={t('loans.commitmentPlaceholder')}
                  className="w-full p-2.5 text-xs rounded-xl border border-border-subtle outline-none resize-none"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowCommitmentForm(false)} className="flex-1 py-2 rounded-xl text-xs font-bold text-text-muted border border-border-subtle">
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="flex-1 py-2 bg-primary text-white rounded-xl text-xs font-bold">{t('loans.send')}</button>
                </div>
              </form>
            )}
          </div>
        )}

        <section className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('loans.yourReminder')}</label>
          <input
            type="datetime-local"
            value={contact[myReminderField] ? toDatetimeLocalValue(contact[myReminderField]) : ''}
            onChange={(e) => handleSetReminder(e.target.value)}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </section>

        <section className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('loans.installmentPlan')}</label>
            {!plan && (
              <button onClick={() => setShowInstallmentForm(!showInstallmentForm)} className="text-[11px] font-bold text-primary">
                {t('loans.propose')}
              </button>
            )}
          </div>

          {plan && (
            <div className="space-y-2">
              <p className="text-sm font-bold text-primary">
                {symbol}{plan.amount.toLocaleString()} / {plan.frequency === 'weekly' ? t('analysis.weekly') : t('analysis.monthly')}
              </p>
              <p className="text-[11px] text-text-muted">
                {t('loans.statusLabel')} <span className="font-bold uppercase">{t(plan.status === 'active' ? 'loans.statusActive' : plan.status === 'declined' ? 'loans.statusDeclined' : 'loans.statusPending')}</span>
                {plan.status === 'active' && plan.nextDueDate && t('loans.nextDueSuffix', { date: new Date(plan.nextDueDate).toLocaleDateString() })}
              </p>
              {canRespondToPlan && (
                <div className="flex gap-2">
                  <button onClick={() => handleInstallmentResponse(false)} className="flex-1 py-2 rounded-xl text-xs font-bold text-error border border-error/20">
                    {t('loans.decline')}
                  </button>
                  <button onClick={() => handleInstallmentResponse(true)} className="flex-1 py-2 bg-primary text-white rounded-xl text-xs font-bold">
                    {t('loans.accept')}
                  </button>
                </div>
              )}
              {plan.status === 'declined' && (
                <button onClick={() => setShowInstallmentForm(true)} className="text-[11px] font-bold text-primary">
                  {t('loans.proposeNewPlan')}
                </button>
              )}
            </div>
          )}

          {showInstallmentForm && (
            <form onSubmit={handleProposeInstallment} className="space-y-2 pt-2 border-t border-border-subtle">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  value={installmentAmount}
                  onChange={(e) => setInstallmentAmount(e.target.value)}
                  placeholder={t('loans.amountPlaceholder')}
                  className="bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
                />
                <select
                  value={installmentFrequency}
                  onChange={(e) => setInstallmentFrequency(e.target.value as any)}
                  className="bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
                >
                  <option value="weekly">{t('analysis.weekly')}</option>
                  <option value="monthly">{t('analysis.monthly')}</option>
                </select>
              </div>
              {hasAmountSumOperator(installmentAmount) && evaluateAmountSum(installmentAmount) !== null && (
                <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(installmentAmount)!.toFixed(2)}</p>
              )}
              <input
                type="date"
                value={installmentStart}
                onChange={(e) => setInstallmentStart(e.target.value)}
                className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
              />
              <button type="submit" className="w-full py-2.5 bg-primary text-white rounded-xl text-xs font-bold">
                {t('loans.proposePlan')}
              </button>
            </form>
          )}
        </section>

        {isOwner && (
          <div>
            {!showEntryForm ? (
              <button
                onClick={() => setShowEntryForm(true)}
                className="w-full py-3.5 bg-primary/5 border border-primary/20 text-primary font-bold rounded-2xl flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined">add</span>
                {t('loans.addEntry')}
              </button>
            ) : (
              <form onSubmit={handleAddEntry} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  {ENTRY_TYPES.map((et) => (
                    <button
                      key={et.id}
                      type="button"
                      onClick={() => setEntryType(et.id)}
                      className={clsx(
                        'flex items-center gap-2 p-2.5 rounded-xl border text-xs font-bold transition-all',
                        entryType === et.id ? 'bg-primary text-white border-primary' : 'bg-surface text-on-surface border-border-subtle'
                      )}
                    >
                      <span className="material-symbols-outlined text-[16px]">{et.icon}</span>
                      {t(et.labelKey)}
                    </button>
                  ))}
                </div>
                {entryType !== 'note' && (
                  <>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={t('loans.amountPlaceholder')}
                      className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                    />
                    {hasAmountSumOperator(amount) && evaluateAmountSum(amount) !== null && (
                      <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(amount)!.toFixed(2)}</p>
                    )}
                  </>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('loans.descriptionPlaceholder')}
                    className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                  />
                  <input
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowEntryForm(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={saving} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                    {saving ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">{t('loans.history')}</h2>
          {entries.length === 0 && <p className="text-sm text-text-muted italic px-1">{t('loans.noEntriesYet')}</p>}
          {entries.map((entry: any) => {
            const meta = ENTRY_TYPES.find((t) => t.id === entry.type);
            const isExpanded = expandedEntryId === entry.id;
            return (
              <div key={entry.id} className="bg-white rounded-xl border border-border-subtle overflow-hidden">
                <div
                  onClick={() => setExpandedEntryId(isExpanded ? null : entry.id)}
                  className="p-3 flex items-center gap-3 cursor-pointer hover:bg-surface-container/20 transition-colors"
                >
                  <span className="material-symbols-outlined text-primary/60 text-[18px]">{meta?.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface truncate">{meta ? t(meta.labelKey) : ''}{entry.description ? ` — ${entry.description}` : ''}</p>
                    <p className="text-[10px] text-text-muted">{timeAgo(entry.createdAt, t)}</p>
                  </div>
                  {entry.amount != null && (
                    <span className="text-sm font-bold text-primary shrink-0">{symbol}{entry.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  )}
                  <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">{isExpanded ? 'expand_less' : 'expand_more'}</span>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-border-subtle space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <p className="text-text-muted uppercase font-bold tracking-wider">{t('addExpense.description')}</p>
                        <p className="text-on-surface">{entry.description || '—'}</p>
                      </div>
                      <div>
                        <p className="text-text-muted uppercase font-bold tracking-wider">{t('loans.loanDate')}</p>
                        <p className="text-on-surface">{entry.date ? new Date(entry.date).toLocaleDateString() : '—'}</p>
                      </div>
                      <div>
                        <p className="text-text-muted uppercase font-bold tracking-wider">{t('loans.dateAdded')}</p>
                        <p className="text-on-surface">{new Date(entry.createdAt).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-text-muted uppercase font-bold tracking-wider">{t('reminders.type')}</p>
                        <p className="text-on-surface">{meta ? t(meta.labelKey) : ''}</p>
                      </div>
                    </div>
                    {contactId && (
                      <Comments
                        pathSegments={['loanContacts', contactId, 'entries', entry.id, 'comments']}
                        label={t('comments.label')}
                        placeholder={t('loans.addCommentOnEntry')}
                        emptyText={t('loans.noCommentsOnEntry')}
                        onPosted={(text) => notifyOther('comment_added', { description: text })}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {commitments.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">{t('loans.missedCommitments')}</h2>
            {commitments.map((c: any) => (
              <div key={c.id} className="bg-error/5 rounded-xl border border-error/20 p-3">
                <p className="text-sm text-on-surface">{c.message}</p>
                <p className="text-[10px] text-text-muted mt-1">{timeAgo(c.createdAt, t)}</p>
              </div>
            ))}
          </section>
        )}

        <section className="bg-white rounded-2xl border border-border-subtle p-4">
          {contactId && (
            <Comments
              pathSegments={['loanContacts', contactId, 'comments']}
              label={t('loans.accountComments')}
              placeholder={t('loans.addCommentAboutLoan')}
              emptyText={t('loans.noCommentsYet')}
              onPosted={(text) => notifyOther('comment_added', { description: text })}
            />
          )}
        </section>
      </main>
    </div>
  );
}
