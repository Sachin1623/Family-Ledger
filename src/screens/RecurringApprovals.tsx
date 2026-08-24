import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';

// Recurring expenses no longer add themselves automatically — this is where each due
// occurrence shows up for the user to Accept, Decline, or Change before anything is added.
export default function RecurringApprovals() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { t } = useLanguage();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Filtered client-side to 'pending' rather than adding a second where() clause — avoids
  // needing a composite index for a screen this low-traffic.
  // `includeMetadataChanges` is required so a "still empty, but now confirmed from the server"
  // event actually reaches this listener — see the fromCache handling below.
  const [pendingValue, pendingLoading] = useCollection(
    user ? query(collection(db, 'pendingRecurringExpenses'), where('userId', '==', user.uid)) : null,
    { snapshotListenOptions: { includeMetadataChanges: true } },
  );
  // Tapping the "confirm this recurring expense" push often cold-starts the app — while Firebase
  // Auth is still resolving `user`, `useCollection(null)` reports `loading: false` with no data,
  // which made this screen flash "Nothing waiting on you right now" before the real (correct)
  // list arrived a moment later once auth settled and the real query kicked in. Folding
  // `authLoading` in keeps the spinner up through that whole window instead of a wrong empty
  // state, so what looked like the confirmation "showing very late" is now just a clean loading
  // state the entire time until the real data is ready.
  const loading = authLoading || (!!user && pendingLoading);
  const pending = (pendingValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((p) => p.status === 'pending');
  // A cold app start (exactly the state a tapped push notification launches into) serves Firestore's
  // local persistence cache before the network round trip completes — on a brand-new device that
  // cache predates the item the push is about, so an EMPTY cached snapshot renders first even
  // though the real, just-created pending item is one round trip away. Distinguishing "confirmed
  // empty by the server" from "still only cache-confirmed" stops this screen from flashing
  // "Nothing waiting on you right now" for an item that's actually about to show up.
  const isFromCache = pendingValue?.metadata.fromCache ?? false;
  // Capped at 6s so a genuinely offline device still resolves to a definite state instead of
  // spinning forever — at that point just show what the cache actually has.
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  useEffect(() => {
    if (!isFromCache) { setSyncTimedOut(false); return; }
    const t = setTimeout(() => setSyncTimedOut(true), 6000);
    return () => clearTimeout(t);
  }, [isFromCache]);
  const stillSyncing = !loading && pending.length === 0 && isFromCache && !syncTimedOut;

  const groupIds = Array.from(new Set(pending.map((p) => p.groupId)));
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groupsMap = React.useMemo(() => {
    const map: Record<string, any> = {};
    groupsValue?.docs.forEach((d) => { map[d.id] = d.data(); });
    return map;
  }, [groupsValue]);

  const authedFetch = async (path: string, body?: any) => {
    const idToken = await user!.getIdToken();
    const res = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('approvals.requestFailed'));
    return data;
  };

  const handleAccept = async (id: string, overrides?: { amount?: number; category?: string; description?: string }) => {
    setBusyId(id);
    try {
      await authedFetch(`/api/recurring-confirm/${id}/accept`, overrides);
      setEditingId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('approvals.failedToAccept'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDecline = async (id: string) => {
    setBusyId(id);
    try {
      await authedFetch(`/api/recurring-confirm/${id}/decline`);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('approvals.failedToDecline'));
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (item: any) => {
    setEditingId(item.id);
    setEditAmount(String(item.amount));
    setEditCategory(item.category);
    setEditDescription(item.description);
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('approvals.title')}</h1>
          <p className="text-sm text-text-muted mt-1">
            {t('approvals.subtitle')}
          </p>
        </div>

        {loading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
        {stillSyncing && (
          <div className="bg-white rounded-2xl border border-border-subtle p-8 text-center">
            <span className="material-symbols-outlined text-4xl text-text-muted animate-spin">progress_activity</span>
            <p className="text-sm text-text-muted mt-2">{t('approvals.checkingPending')}</p>
          </div>
        )}
        {!loading && !stillSyncing && pending.length === 0 && (
          <div className="bg-white rounded-2xl border border-border-subtle p-8 text-center">
            <span className="material-symbols-outlined text-4xl text-success">check_circle</span>
            <p className="text-sm text-text-muted mt-2">{t('approvals.nothingWaiting')}</p>
          </div>
        )}

        <div className="space-y-3">
          {pending.map((item) => {
            const group = groupsMap[item.groupId];
            const isIncome = item.type === 'income';
            const categoryList = isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
            const catInfo = categoryList.find((c) => c.id === item.category);
            const isBusy = busyId === item.id;
            const isEditing = editingId === item.id;

            return (
              <div key={item.id} className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', isIncome ? 'bg-success/10 text-success' : 'bg-primary/5 text-primary')}>
                    <span className="text-lg">{catInfo?.icon || '🔁'}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-primary text-sm truncate">{item.description}</p>
                    <p className={clsx('text-[11px] truncate', isIncome ? 'text-success font-bold' : 'text-text-muted')}>
                      {isIncome ? '+' : ''}{getCurrencySymbol(group?.currency)}{item.amount.toFixed(2)} · {group?.name || item.groupName}
                    </p>
                  </div>
                </div>

                {isEditing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className="bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none"
                      />
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none"
                      >
                        {categoryList.map((c) => (
                          <option key={c.id} value={c.id}>{t(`${isIncome ? 'income' : 'category'}.${c.id}`)}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      maxLength={100}
                      className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none"
                    />
                    {hasAmountSumOperator(editAmount) && evaluateAmountSum(editAmount) !== null && (
                      <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(editAmount)!.toFixed(2)}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="flex-1 py-2 rounded-xl text-xs font-bold text-text-muted border border-border-subtle"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        onClick={() => handleAccept(item.id, {
                          amount: evaluateAmountSum(editAmount) || 0,
                          category: editCategory,
                          description: editDescription,
                        })}
                        disabled={isBusy || !evaluateAmountSum(editAmount) || (evaluateAmountSum(editAmount) as number) <= 0}
                        className="flex-1 py-2 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                      >
                        {isBusy ? t('common.saving') : t('approvals.confirmChanges')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDecline(item.id)}
                      disabled={isBusy}
                      className="flex-1 py-2.5 rounded-xl text-xs font-bold text-error border border-error/20 bg-error/5 disabled:opacity-50"
                    >
                      {t('approvals.decline')}
                    </button>
                    <button
                      onClick={() => startEdit(item)}
                      disabled={isBusy}
                      className="flex-1 py-2.5 rounded-xl text-xs font-bold text-primary border border-border-subtle disabled:opacity-50"
                    >
                      {t('approvals.change')}
                    </button>
                    <button
                      onClick={() => handleAccept(item.id)}
                      disabled={isBusy}
                      className="flex-1 py-2.5 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                    >
                      {isBusy ? t('common.saving') : t('approvals.accept')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
