import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc, doc, runTransaction } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { getCurrencySymbol, CURRENCY_SYMBOLS } from '../lib/constants';
import { ENTRY_TYPES, LoanEntryType, entryEffect, balanceLabel } from '../lib/loans';
import { todayLocalDateString } from '../lib/dateUtils';
import { useLanguage } from '../context/LanguageContext';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { searchUsers, FoundUser } from '../lib/inviteApi';

const CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

export default function PersonalLoans() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Contact fields
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currency, setCurrency] = useState('INR');

  // Live "pick an existing FamilyLedger user" search, layered onto the plain Name field — typing
  // still works exactly as before for someone who isn't on the app; picking a search result
  // additionally links the new contact to that real account (same effect the email-lookup path
  // already had, just found by name instead of requiring an exact email address).
  const [userResults, setUserResults] = useState<FoundUser[]>([]);
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const [userSearching, setUserSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<FoundUser | null>(null);
  const userSearchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextSearchRef = React.useRef(false);

  // First entry fields
  const [entryType, setEntryType] = useState<LoanEntryType>('given');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [entryDate, setEntryDate] = useState(todayLocalDateString());

  const [myContactsValue, myLoading] = useCollection(
    user ? query(collection(db, 'loanContacts'), where('ownerId', '==', user.uid)) : null,
  );
  const [theirContactsValue] = useCollection(
    user ? query(collection(db, 'loanContacts'), where('linkedUserId', '==', user.uid)) : null,
  );

  const myContacts = myContactsValue?.docs.map((d) => ({ id: d.id, ...d.data(), isOwner: true } as any)) || [];
  const theirContacts = theirContactsValue?.docs.map((d) => ({ id: d.id, ...d.data(), isOwner: false } as any)) || [];
  const allContacts = [...myContacts, ...theirContacts].sort((a, b) => (a.isOwner ? a.name : a.ownerName).localeCompare(b.isOwner ? b.name : b.ownerName));

  // From the current user's own perspective: for contacts I own, balance is already in my
  // perspective (positive = they owe me). For contacts where I'm the linked counterparty, the
  // stored balance is the *owner's* perspective, so mine is the negation of it.
  const myPerspectiveBalance = (c: any) => (c.isOwner ? c.balance : -c.balance);
  // Bucketed by each contact's OWN currency (a loan contact picks its currency at creation, see
  // the `currency` field above) rather than a single blended sum — contacts aren't all
  // necessarily in the same currency, and summing raw numbers across currencies then hardcoding
  // '₹' on top (the old behavior here) mislabels the total exactly like Settlements.tsx's own
  // "Overall" summary used to (same bug, same fix, two different screens).
  const owedToMeByCurrency = React.useMemo(() => {
    const byCurrency: Record<string, number> = {};
    allContacts.forEach((c: any) => {
      const amt = Math.max(0, myPerspectiveBalance(c));
      if (amt > 0.01) byCurrency[c.currency || 'INR'] = (byCurrency[c.currency || 'INR'] || 0) + amt;
    });
    return Object.entries(byCurrency).map(([currencyCode, amount]) => ({ currencyCode, amount }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myContactsValue, theirContactsValue]);
  const iOweByCurrency = React.useMemo(() => {
    const byCurrency: Record<string, number> = {};
    allContacts.forEach((c: any) => {
      const amt = Math.max(0, -myPerspectiveBalance(c));
      if (amt > 0.01) byCurrency[c.currency || 'INR'] = (byCurrency[c.currency || 'INR'] || 0) + amt;
    });
    return Object.entries(byCurrency).map(([currencyCode, amount]) => ({ currencyCode, amount }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myContactsValue, theirContactsValue]);

  React.useEffect(() => {
    if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current);
    if (suppressNextSearchRef.current) {
      suppressNextSearchRef.current = false;
      return;
    }
    if (newName.trim().length < 2) {
      setUserResults([]);
      setUserSearchOpen(false);
      return;
    }
    userSearchTimerRef.current = setTimeout(async () => {
      setUserSearching(true);
      try {
        const results = await searchUsers(newName.trim());
        setUserResults(results);
        setUserSearchOpen(true);
      } catch (err) {
        console.error('User search failed:', err);
      } finally {
        setUserSearching(false);
      }
    }, 350);
    return () => { if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current); };
  }, [newName]);

  const handlePickUser = (u: FoundUser) => {
    suppressNextSearchRef.current = true;
    setNewName(u.displayName);
    setSelectedUser(u);
    setUserSearchOpen(false);
    setUserResults([]);
  };

  const resetForm = () => {
    setSelectedContactId('');
    setNewName('');
    setNewPhone('');
    setNewEmail('');
    setCurrency('INR');
    setEntryType('given');
    setAmount('');
    setDescription('');
    setEntryDate(todayLocalDateString());
    setError(null);
    setShowForm(false);
    setSelectedUser(null);
    setUserResults([]);
    setUserSearchOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const parsedAmount = evaluateAmountSum(amount);
    if (entryType !== 'note' && (!amount || !parsedAmount || parsedAmount <= 0)) {
      setError(t('loans.enterValidAmount'));
      return;
    }
    if (!selectedContactId && !newName.trim()) {
      setError(t('loans.chooseContactOrName'));
      return;
    }
    if (entryDate > todayLocalDateString()) {
      setError(t('loans.dateCannotBeFuture'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let contactId = selectedContactId;
      let contactName = '';
      let linkedUserId: string | null = null;

      if (!contactId) {
        // New contact — link it to a real account if one was picked from the search dropdown,
        // otherwise fall back to the email-lookup path (unchanged) if an email was given instead.
        if (selectedUser) {
          linkedUserId = selectedUser.uid;
        } else if (newEmail.trim()) {
          try {
            const idToken = await user.getIdToken();
            const res = await fetch('/api/loans/find-user', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: newEmail.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.uid) linkedUserId = data.uid;
          } catch (err) {
            console.error('find-user lookup failed (continuing without linking):', err);
          }
        }

        const contactRef = await addDoc(collection(db, 'loanContacts'), {
          ownerId: user.uid,
          ownerName: profile?.displayName || user.displayName || 'Someone',
          ownerPhotoURL: profile?.photoURL || user.photoURL || '',
          name: newName.trim(),
          phone: newPhone.trim() || null,
          linkedUserId,
          currency,
          balance: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        contactId = contactRef.id;
        contactName = newName.trim();
      } else {
        const existing = allContacts.find((c) => c.id === contactId);
        contactName = existing?.isOwner ? existing.name : existing?.ownerName;
        linkedUserId = existing?.isOwner ? existing?.linkedUserId || null : null;
      }

      const effect = entryEffect(entryType, parsedAmount || 0);
      await runTransaction(db, async (transaction) => {
        const contactRef = doc(db, 'loanContacts', contactId);
        const contactSnap = await transaction.get(contactRef);
        if (!contactSnap.exists()) throw new Error('Contact not found.');
        const newBalance = (contactSnap.data().balance || 0) + effect;

        const entryRef = doc(collection(db, 'loanContacts', contactId, 'entries'));
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

      if (linkedUserId) {
        const idToken = await user.getIdToken();
        fetch('/api/notify-loan-activity', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUserId: linkedUserId,
            action: `entry_${entryType}`,
            contactId,
            contactName: profile?.displayName || user.displayName || 'Someone',
            description: description.trim(),
            amount: entryType !== 'note' ? parsedAmount : null,
          }),
        }).catch((err) => console.error('notify-loan-activity failed:', err));
      }

      resetForm();
      navigate(`/personal-loans/${contactId}`);
    } catch (err) {
      console.error('Failed to save loan entry:', err);
      setError(t('loans.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.personalLoans')}</h1>
          <p className="text-sm text-text-muted mt-1">
            {t('loans.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3" data-tour="loans-summary">
          <div className="bg-white rounded-2xl border border-border-subtle p-4">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('loans.owedToYou')}</p>
            {owedToMeByCurrency.length === 0 ? (
              <p className="text-xl font-black text-[#0F7A38] mt-0.5">{getCurrencySymbol('INR')}0</p>
            ) : owedToMeByCurrency.length === 1 ? (
              <p className="text-xl font-black text-[#0F7A38] mt-0.5">
                {getCurrencySymbol(owedToMeByCurrency[0].currencyCode)}{owedToMeByCurrency[0].amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            ) : (
              <div className="mt-0.5">
                {owedToMeByCurrency.map(({ currencyCode, amount }) => (
                  <p key={currencyCode} className="text-base font-black text-[#0F7A38]">
                    {getCurrencySymbol(currencyCode)}{amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white rounded-2xl border border-border-subtle p-4">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('loans.youOweLabel')}</p>
            {iOweByCurrency.length === 0 ? (
              <p className="text-xl font-black text-error mt-0.5">{getCurrencySymbol('INR')}0</p>
            ) : iOweByCurrency.length === 1 ? (
              <p className="text-xl font-black text-error mt-0.5">
                {getCurrencySymbol(iOweByCurrency[0].currencyCode)}{iOweByCurrency[0].amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            ) : (
              <div className="mt-0.5">
                {iOweByCurrency.map(({ currencyCode, amount }) => (
                  <p key={currencyCode} className="text-base font-black text-error">
                    {getCurrencySymbol(currencyCode)}{amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            data-tour="loans-add"
            className="w-full py-3.5 bg-primary/5 border border-primary/20 text-primary font-bold rounded-2xl flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined">add</span>
            {t('loans.newEntry')}
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">{t('loans.newLoanEntry')}</h2>

            {myContacts.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.contact')}</label>
                <select
                  value={selectedContactId}
                  onChange={(e) => setSelectedContactId(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('loans.newContactOption')}</option>
                  {myContacts.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            {!selectedContactId && (
              <>
                <div className="space-y-1 relative">
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.name')}</label>
                  {selectedUser ? (
                    <div className="w-full bg-primary/5 border border-primary/20 rounded-xl p-2.5 flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[10px] font-bold text-primary">
                        {selectedUser.photoURL ? (
                          <img src={selectedUser.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          selectedUser.displayName.slice(0, 1)
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-primary truncate">{selectedUser.displayName}</p>
                        <p className="text-[9px] font-bold text-primary/70 uppercase tracking-wide">{t('loans.linkedAccount')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setSelectedUser(null); setNewName(''); }}
                        className="p-1 text-primary/60 hover:text-primary shrink-0"
                        aria-label="Clear"
                      >
                        <span className="material-symbols-outlined text-[18px]">close</span>
                      </button>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => { setNewName(e.target.value); setSelectedUser(null); }}
                      onFocus={() => { if (userResults.length > 0) setUserSearchOpen(true); }}
                      onBlur={() => setTimeout(() => setUserSearchOpen(false), 150)}
                      placeholder={t('loans.namePlaceholder')}
                      required
                      autoComplete="off"
                      className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  )}
                  {userSearchOpen && !selectedUser && (userResults.length > 0 || userSearching) && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white rounded-xl border border-border-subtle shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                      {userSearching && userResults.length === 0 && (
                        <p className="p-3 text-xs text-text-muted text-center">{t('common.loading')}</p>
                      )}
                      {userResults.map((u) => (
                        <button
                          key={u.uid}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handlePickUser(u)}
                          className="w-full flex items-center gap-2.5 p-2.5 hover:bg-surface transition-colors text-left"
                        >
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[10px] font-bold text-primary">
                            {u.photoURL ? (
                              <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              u.displayName.slice(0, 1)
                            )}
                          </div>
                          <span className="text-sm font-bold text-on-surface truncate">{u.displayName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-text-muted px-1">{t('loans.searchOrTypeName')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.phoneOptional')}</label>
                    <input
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder={t('loans.forWhatsapp')}
                      className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.currency')}</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.emailOptional')}</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder={t('loans.linkEmailPlaceholder')}
                    className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </>
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('loans.whatHappened')}</label>
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
            </div>

            {entryType !== 'note' && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.amount')}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                {hasAmountSumOperator(amount) && evaluateAmountSum(amount) !== null && (
                  <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(amount)!.toFixed(2)}</p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('addExpense.description')}</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('loans.descPlaceholder')}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('addExpense.date')}</label>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  max={todayLocalDateString()}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

            <div className="flex gap-2">
              <button type="button" onClick={resetForm} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={saving} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        )}

        <section className="space-y-2">
          {myLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {!myLoading && allContacts.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">{t('loans.noRecordsYet')}</p>
          )}
          {allContacts.map((c: any) => {
            const perspectiveBalance = myPerspectiveBalance(c);
            const label = balanceLabel(perspectiveBalance);
            const displayName = c.isOwner ? c.name : c.ownerName;
            const symbol = getCurrencySymbol(c.currency);
            return (
              <div
                key={c.id}
                onClick={() => navigate(`/personal-loans/${c.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between cursor-pointer hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0">
                    {displayName?.slice(0, 1) || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{displayName}</p>
                    <p className="text-[10px] text-text-muted uppercase font-bold tracking-wider">
                      {label === 'settled' ? t('loans.settledUp') : label === 'owes_you' ? t('loans.owesYou') : t('loans.youOweLabel')}
                    </p>
                  </div>
                </div>
                <p className={clsx('text-sm font-bold shrink-0', label === 'owes_you' ? 'text-[#0F7A38]' : label === 'you_owe' ? 'text-error' : 'text-text-muted')}>
                  {symbol}{Math.abs(perspectiveBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </p>
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
