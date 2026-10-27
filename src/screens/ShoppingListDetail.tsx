import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { doc, collection, query, where, addDoc, updateDoc, deleteDoc, getDocs, writeBatch, setDoc, runTransaction } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, getCurrencySymbol, getCategoryIcon } from '../lib/constants';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { todayLocalDateString } from '../lib/dateUtils';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';
import { groupIconEmoji } from '../lib/groupIcons';
import { itemIcon, listIconGuess } from '../lib/shoppingIcons';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import { tileTint } from './ShoppingLists';

const toDatetimeLocalValue = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type ItemStatus = 'pending' | 'bought' | 'unavailable';

// Falls back to the old boolean `checked` field for items created before the tri-state model.
const getItemStatus = (item: any): ItemStatus => item.status || (item.checked ? 'bought' : 'pending');

export default function ShoppingListDetail() {
  const { listId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();

  const [listValue, listLoading] = useDocument(doc(db, 'shoppingLists', listId!));
  const list = listValue?.data();

  const [membersValue] = useCollection(
    list?.groupId ? query(collection(db, 'members'), where('groupId', '==', list.groupId)) : null,
  );
  const members = membersValue?.docs.map((d) => d.data() as any) || [];
  const creator = members.find((m: any) => m.userId === list?.userId);
  const categoryInfo = EXPENSE_CATEGORIES.find((c) => c.id === list?.category);

  const [groupValue] = useDocument(list?.groupId ? doc(db, 'groups', list.groupId) : null);
  const group = groupValue?.data() as any;
  const currencySymbol = getCurrencySymbol(group?.currency);

  const [itemsValue, itemsLoading] = useCollection(collection(db, 'shoppingLists', listId!, 'items'));
  const items = (itemsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || []).sort((a: any, b: any) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const toBuy = items.filter((i: any) => getItemStatus(i) === 'pending');
  const inCart = items.filter((i: any) => getItemStatus(i) === 'bought');
  const notAvailable = items.filter((i: any) => getItemStatus(i) === 'unavailable');
  const doneCount = inCart.length + notAvailable.length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  // The lists page shows each list's progress without opening its items, from two counts kept on the list itself.
  // They are brought up to date from here whenever they differ from what is really in the list.
  useEffect(() => {
    if (!listId || !list || itemsLoading || !itemsValue) return;
    if (list.itemCount === items.length && list.doneCount === doneCount) return;
    updateDoc(doc(db, 'shoppingLists', listId), { itemCount: items.length, doneCount }).catch((err) => console.error('shopping list counts failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, list?.itemCount, list?.doneCount, items.length, doneCount, itemsLoading]);

  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editScheduled, setEditScheduled] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [showFinish, setShowFinish] = useState(false);
  const [completeAmount, setCompleteAmount] = useState('');
  const [carryOver, setCarryOver] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [viewingItem, setViewingItem] = useState<any | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [carriedListId, setCarriedListId] = useState<string | null>(null);

  const openEdit = () => {
    if (!list) return;
    setEditTitle(list.title);
    setEditScheduled(list.scheduledAt ? toDatetimeLocalValue(list.scheduledAt) : '');
    setShowEdit(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = editTitle.trim();
    if (!trimmed || !listId) return;
    setSavingEdit(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), {
        title: trimmed,
        scheduledAt: editScheduled ? new Date(editScheduled).toISOString() : null,
      });
      setShowEdit(false);
    } catch (err) {
      console.error('Failed to update shopping list:', err);
      alert(t('shoppingLists.failedToUpdate'));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteList = async () => {
    if (!listId || !window.confirm(t('shoppingLists.confirmDeleteList'))) return;
    try {
      const itemsSnap = await getDocs(collection(db, 'shoppingLists', listId, 'items'));
      const batch = writeBatch(db);
      itemsSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, 'shoppingLists', listId));
      await batch.commit();
      navigate('/shopping-lists');
    } catch (err) {
      console.error('Failed to delete shopping list:', err);
      alert(t('shoppingLists.failedToDelete'));
    }
  };

  // What was not bought can move to a fresh list (same group, category and icon) so it is not forgotten.
  const carryUnboughtToNewList = async () => {
    if (!user || !list) return;
    const left = items.filter((i: any) => getItemStatus(i) === 'pending');
    if (left.length === 0) return;
    const newRef = await addDoc(collection(db, 'shoppingLists'), {
      userId: user.uid,
      title: `${list.title} (carried over)`,
      description: list.title,
      category: list.category || 'misc',
      ...(list.icon ? { icon: list.icon } : {}),
      groupId: list.groupId || null,
      scheduledAt: null,
      completed: false,
      itemCount: left.length,
      doneCount: 0,
      createdAt: new Date().toISOString(),
    });
    const batch = writeBatch(db);
    const now = Date.now();
    left.forEach((it: any, i: number) => {
      batch.set(doc(collection(db, 'shoppingLists', newRef.id, 'items')), { text: it.text, status: 'pending', addedBy: user.uid, createdAt: new Date(now + i).toISOString(), ...(it.notes ? { notes: it.notes } : {}) });
    });
    await batch.commit();
    setCarriedListId(newRef.id);
  };

  // Personal (non-shared) lists have no group to add an expense to — just mark done.
  const handleCompletePersonal = async () => {
    if (!listId) return;
    setCompleting(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), {
        completed: true,
        completedAt: new Date().toISOString(),
        completedBy: user?.uid,
      });
      if (carryOver) await carryUnboughtToNewList();
      setShowFinish(false);
    } catch (err) {
      console.error('Failed to mark list completed:', err);
      alert(t('shoppingLists.failedToMarkCompleted'));
    } finally {
      setCompleting(false);
    }
  };

  // Shared lists: completing asks for the total spent, then creates a real group expense from
  // it (description/category came from the list at creation time) — same write pattern as
  // AddExpense.tsx's handleSave (transaction: expense + group.totalSpending + activity log),
  // so it shows up in budgets/analysis/settlements identically to a manually-added expense.
  const handleCompleteWithExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !listId || !list?.groupId) return;
    const parsedAmount = evaluateAmountSum(completeAmount);
    if (!parsedAmount || parsedAmount <= 0) return;

    const expenseDescription = list.description || list.title;
    const expenseCategory = list.category || 'other';
    const actorName = profile?.displayName || user.displayName || 'Someone';

    setCompleting(true);
    try {
      const groupRef = doc(db, 'groups', list.groupId);
      const expenseRef = doc(collection(db, 'expenses'));
      await runTransaction(db, async (transaction) => {
        const groupDoc = await transaction.get(groupRef);
        if (!groupDoc.exists()) throw new Error('Group does not exist!');

        transaction.set(expenseRef, {
          groupId: list.groupId,
          amount: parsedAmount,
          description: expenseDescription,
          category: expenseCategory,
          date: todayLocalDateString(),
          paidBy: user.uid,
          paymentMethod: 'cash',
          addedBy: user.uid,
          createdAt: new Date().toISOString(),
        });

        transaction.update(groupRef, {
          totalSpending: (groupDoc.data().totalSpending || 0) + parsedAmount,
        });

        const activityRef = doc(collection(db, 'activities'));
        transaction.set(activityRef, {
          groupId: list.groupId,
          userId: user.uid,
          userName: actorName,
          userPhoto: profile?.photoURL || user.photoURL || '',
          type: 'add_expense',
          description: `${actorName} completed shopping: ${expenseDescription}`,
          data: { amount: parsedAmount, description: expenseDescription },
          createdAt: new Date().toISOString(),
        });

        transaction.update(doc(db, 'shoppingLists', listId), {
          completed: true,
          completedAt: new Date().toISOString(),
          completedBy: user.uid,
          totalExpense: parsedAmount,
          expenseId: expenseRef.id,
        });
      });

      await updateGlobalStats({ expenses: 1, amount: parsedAmount });
      setDoc(doc(db, 'users', user.uid), { lastExpenseAddedAt: new Date().toISOString() }, { merge: true }).catch(
        (err) => console.error('lastExpenseAddedAt update failed:', err),
      );
      notifyGroupActivity({
        groupId: list.groupId,
        action: 'added',
        description: expenseDescription,
        amount: parsedAmount,
        actorName,
      });

      // the expense is already saved; moving the leftovers is a bonus that must not make the finish look failed
      if (carryOver) await carryUnboughtToNewList().catch((err) => console.error('carry over failed:', err));
      setShowFinish(false);
      setCompleteAmount('');
    } catch (err) {
      console.error('Failed to complete shopping list:', err);
      alert(t('shoppingLists.failedToCompleteExpense'));
    } finally {
      setCompleting(false);
    }
  };

  // One or many items: a pasted block of lines becomes one item per line
  const addItems = async (lines: string[]) => {
    const texts = lines.map((l) => l.trim().slice(0, 200)).filter(Boolean).slice(0, 100);
    if (texts.length === 0 || !user || !listId) return;
    setAddingItem(true);
    try {
      const batch = writeBatch(db);
      const now = Date.now();
      texts.forEach((text, i) => {
        batch.set(doc(collection(db, 'shoppingLists', listId, 'items')), { text, status: 'pending', addedBy: user.uid, createdAt: new Date(now + i).toISOString() });
      });
      await batch.commit();
      setNewItemText('');
    } catch (err) {
      console.error('Failed to add item:', err);
      alert(t('shoppingLists.failedToAddItem'));
    } finally {
      setAddingItem(false);
    }
  };

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    addItems([newItemText]);
  };

  // Tapping the already-selected status resets the item back to pending; tapping the other one
  // switches directly (an item is either bought or not-available, never both).
  const handleSetItemStatus = async (item: any, target: ItemStatus) => {
    const next = getItemStatus(item) === target ? 'pending' : target;
    try {
      await updateDoc(doc(db, 'shoppingLists', listId!, 'items', item.id), { status: next });
      setViewingItem((prev: any) => (prev && prev.id === item.id ? { ...prev, status: next } : prev));
    } catch (err) {
      console.error('Failed to update item:', err);
    }
  };

  const handleSaveItemNotes = async (item: any) => {
    setSavingNotes(true);
    try {
      const trimmed = notesDraft.trim();
      await updateDoc(doc(db, 'shoppingLists', listId!, 'items', item.id), { notes: trimmed || null });
      setViewingItem((prev: any) => (prev && prev.id === item.id ? { ...prev, notes: trimmed } : prev));
    } catch (err) {
      console.error('Failed to save item notes:', err);
      alert(t('shoppingLists.failedToSaveNotes'));
    } finally {
      setSavingNotes(false);
    }
  };

  const handleDeleteItem = async (item: any) => {
    try {
      await deleteDoc(doc(db, 'shoppingLists', listId!, 'items', item.id));
    } catch (err) {
      console.error('Failed to delete item:', err);
    }
  };

  if (listLoading) {
    return <div className="min-h-screen flex items-center justify-center text-text-muted">{t('common.loading')}</div>;
  }
  if (!list) {
    return <div className="min-h-screen flex items-center justify-center text-text-muted">{t('shoppingLists.listNotFound')}</div>;
  }

  const heroIcon = list.icon || listIconGuess(list.title) || getCategoryIcon(group, list.category, 'expense') || '🛒';
  const scheduledPast = list.scheduledAt && !list.completed && new Date(list.scheduledAt) < new Date();

  const renderItem = (item: any) => {
    const status = getItemStatus(item);
    const adder = members.find((m: any) => m.userId === item.addedBy);
    const resolved = status !== 'pending';
    return (
      <div
        key={item.id}
        onClick={() => { setViewingItem(item); setNotesDraft(item.notes || ''); }}
        className={clsx('bg-white rounded-2xl px-3 py-2.5 flex items-center gap-2.5 cursor-pointer shadow-[0_2px_8px_rgba(30,58,95,0.09)] active:scale-[0.99] transition-all', resolved && 'opacity-60')}
      >
        <button
          onClick={(e) => { e.stopPropagation(); handleSetItemStatus(item, 'bought'); }}
          title={t('shoppingLists.bought')}
          aria-label={status === 'bought' ? 'Mark as not bought' : 'Mark as bought'}
          className={clsx('w-7 h-7 rounded-full border-[2.5px] flex items-center justify-center shrink-0 transition-all active:scale-90', status === 'bought' ? 'bg-green-600 border-green-600 text-white' : status === 'unavailable' ? 'bg-rose-500 border-rose-500 text-white' : 'border-slate-300 text-transparent')}
        >
          <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'wght' 700" }}>{status === 'unavailable' ? 'close' : 'check'}</span>
        </button>
        <span className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-[19px] shrink-0">{itemIcon(item.text)}</span>
        <div className="min-w-0 flex-1">
          <p className={clsx('text-sm font-black truncate', resolved ? 'line-through text-text-muted' : 'text-primary')}>{item.text}</p>
          <p className="text-[10.5px] text-text-muted truncate flex items-center gap-1">
            {t('todo.addedBy', { name: item.addedBy === user?.uid ? t('shoppingLists.you') : adder?.displayName || t('todo.aMember') })}
            {item.notes && <span className="inline-flex items-center gap-0.5 text-amber-700 font-bold truncate">· 📝 {item.notes}</span>}
          </p>
        </div>
        {status !== 'bought' && (
          <button
            onClick={(e) => { e.stopPropagation(); handleSetItemStatus(item, 'unavailable'); }}
            title={t('shoppingLists.notAvailableTitle')}
            className={clsx('shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black active:scale-95', status === 'unavailable' ? 'border-rose-300 text-rose-600 bg-rose-50' : 'border-slate-200 text-slate-500')}
          >
            {t('shoppingLists.na')}
          </button>
        )}
      </div>
    );
  };

  const section = (label: string, list2: any[], tone?: 'muted') => list2.length === 0 ? null : (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</h2>
        <span className="text-[11px] font-black rounded-full px-2 py-px bg-slate-200/70 text-slate-600">{list2.length}</span>
      </div>
      <div className={clsx('space-y-2', tone === 'muted' && 'opacity-90')}>{list2.map(renderItem)}</div>
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => navigate('/shopping-lists')} className="flex items-center gap-1 text-xs font-bold text-text-muted">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          {t('shoppingLists.allLists')}
        </button>

        {/* the list at a glance */}
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)' }}>
          <div className="flex items-start gap-3">
            <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-[24px] shrink-0" style={{ background: tileTint(list.category) }}>{heroIcon}</span>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-black leading-tight">{list.title}</h1>
              <p className="text-[12px] text-white/85 mt-0.5 flex items-center gap-1.5 flex-wrap">
                {list.groupId ? (
                  <span className="inline-flex items-center gap-1">{group?.photoURL ? <img src={group.photoURL} alt="" className="w-3.5 h-3.5 rounded-sm object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(group?.icon)}</span>}{group?.name || t('shoppingLists.theGroup')}</span>
                ) : <span>🔒 {t('shoppingLists.personalList')}</span>}
                {creator && <span>· {t('shoppingLists.createdBy', { name: list.userId === user?.uid ? t('shoppingLists.you') : creator.displayName })}</span>}
              </p>
              {list.scheduledAt && (
                <p className={clsx('text-[11px] font-black mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-0.5', scheduledPast ? 'bg-rose-500/90' : 'bg-white/20')}>
                  <span className="material-symbols-outlined text-[13px]">event</span>{new Date(list.scheduledAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </p>
              )}
            </div>
            <div className="shrink-0 rounded-full flex items-center justify-center" style={{ width: 58, height: 58, background: `conic-gradient(#ffd166 0 ${pct}%, rgba(255,255,255,.25) 0)` }}>
              <div className="rounded-full flex items-center justify-center text-[12px] font-black" style={{ width: 45, height: 45, background: '#0d5167' }}>{items.length > 0 ? `${doneCount}/${items.length}` : '0'}</div>
            </div>
          </div>
          {list.description && categoryInfo && list.description !== list.title && (
            <p className="text-[11px] text-white/80 mt-2">{list.description} · {t(`category.${categoryInfo.id}`)}</p>
          )}
          <div className="flex items-center gap-2 mt-3">
            {list.completed ? (
              <div className="flex-1 rounded-xl bg-white/95 text-green-800 px-3 py-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px]">task_alt</span>
                <div className="min-w-0">
                  <p className="text-xs font-black">{t('shoppingLists.completed')}</p>
                  <p className="text-[10px] text-green-900/70">
                    {new Date(list.completedAt).toLocaleString()}
                    {typeof list.totalExpense === 'number' && t('shoppingLists.totalAmountSuffix', { amount: `${currencySymbol}${list.totalExpense.toFixed(2)}` })}
                  </p>
                </div>
              </div>
            ) : (
              <button onClick={() => { setCarryOver(toBuy.length > 0); setShowFinish(true); }} className="flex-1 rounded-xl bg-white text-[#0b3b57] py-2.5 text-sm font-black active:scale-95">
                {t('shoppingLists.markCompleted')}
              </button>
            )}
            <button onClick={openEdit} title={t('shoppingLists.editList')} className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
              <span className="material-symbols-outlined text-[20px]">edit</span>
            </button>
            <button onClick={handleDeleteList} title={t('common.delete')} className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>
          {carriedListId && (
            <button onClick={() => navigate(`/shopping-lists/${carriedListId}`)} className="mt-2 w-full rounded-xl bg-white/15 py-2 text-xs font-black">Items you did not buy moved to a new list · Open it</button>
          )}
        </div>

        <section className="space-y-4">
          {itemsLoading && <p className="text-sm text-text-muted px-1">{t('shoppingLists.loadingItems')}</p>}
          {!itemsLoading && items.length === 0 && (
            <div className="rounded-2xl bg-white p-6 text-center shadow-[0_2px_8px_rgba(30,58,95,0.09)]">
              <p className="text-4xl">🧺</p>
              <p className="text-sm font-black text-primary mt-2">{t('shoppingLists.noItemsYet')}</p>
              <p className="text-xs text-text-muted mt-1">Type an item below, or paste a whole list to add one per line.</p>
            </div>
          )}
          {section('To buy', toBuy)}
          {section('In the cart', inCart, 'muted')}
          {section('Not available', notAvailable, 'muted')}
        </section>
      </main>

      {/* add items: Enter adds one; pasting several lines adds one per line */}
      {!list.completed && (
        <form onSubmit={handleAddItem} className="fixed left-3 right-3 z-30 mx-auto max-w-xl flex items-center gap-2 bg-white border border-border-subtle rounded-full shadow-lg pl-4 pr-1.5 py-1.5" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 10px)' }}>
          <input
            type="text"
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (/\r?\n/.test(text.trim())) { e.preventDefault(); addItems(text.split(/\r?\n/)); }
            }}
            placeholder={t('shoppingLists.addItemPlaceholder')}
            maxLength={200}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none text-primary placeholder:text-text-muted"
          />
          <button type="submit" disabled={addingItem || !newItemText.trim()} className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-orange-500 to-rose-500 text-white flex items-center justify-center disabled:opacity-50 active:scale-95">
            <span className="material-symbols-outlined text-[20px]">add</span>
          </button>
        </form>
      )}

      {showEdit && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }} onClick={() => setShowEdit(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleSaveEdit} className="bg-white rounded-t-3xl px-4 pt-3 space-y-3" style={{ paddingBottom: '1.25rem' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-1" />
              <h2 className="text-base font-black text-primary">{t('shoppingLists.editList')}</h2>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider px-1">{t('shoppingLists.listName')}</label>
                <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={150} required autoFocus className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider px-1">{t('shoppingLists.scheduledTimeEdit')}</label>
                <input type="datetime-local" value={editScheduled} onChange={(e) => setEditScheduled(e.target.value)} className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowEdit(false)} className="flex-1 py-3 rounded-2xl font-black text-slate-500 border border-slate-200">{t('common.cancel')}</button>
                <button type="submit" disabled={savingEdit || !editTitle.trim()} className="flex-1 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50">{savingEdit ? t('common.saving') : t('groupExpenses.saveChanges')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* finish shopping: a shared list adds one expense to the group; a personal list is just marked done */}
      {showFinish && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }} onClick={() => setShowFinish(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={list.groupId ? handleCompleteWithExpense : (e) => { e.preventDefault(); handleCompletePersonal(); }} className="bg-white rounded-t-3xl px-4 pt-3" style={{ paddingBottom: '1.25rem' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-black text-primary">{t('shoppingLists.markCompleted')}</h2>
                <button type="button" onClick={() => setShowFinish(false)} className="text-xs font-black text-[#0f7a8f]">{t('common.cancel')}</button>
              </div>
              <div className="flex items-center gap-3 mb-3">
                <span className="w-11 h-11 rounded-xl flex items-center justify-center text-[22px] shrink-0" style={{ background: tileTint(list.category) }}>{heroIcon}</span>
                <div className="min-w-0">
                  <p className="text-sm font-black text-primary truncate">{list.title}</p>
                  <p className="text-[11px] text-text-muted">{inCart.length} bought{notAvailable.length > 0 ? ` · ${notAvailable.length} not available` : ''}{toBuy.length > 0 ? ` · ${toBuy.length} not bought` : ''}</p>
                </div>
              </div>

              {list.groupId && (
                <>
                  <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1.5 px-0.5">{t('shoppingLists.totalSpentLabel', { group: group?.name || t('shoppingLists.theGroup') })}</p>
                  <div className="flex items-center gap-1.5 rounded-2xl bg-slate-50 border-2 border-[#22c1a5] px-3 py-2">
                    <span className="text-2xl font-black text-slate-400">{currencySymbol}</span>
                    <input type="text" inputMode="decimal" value={completeAmount} onChange={(e) => setCompleteAmount(e.target.value)} placeholder="0.00" autoFocus required className="flex-1 min-w-0 bg-transparent text-2xl font-black text-primary outline-none" />
                  </div>
                  {hasAmountSumOperator(completeAmount) && evaluateAmountSum(completeAmount) !== null && (
                    <p className="text-xs font-black text-green-700 px-1 mt-1">= {currencySymbol}{evaluateAmountSum(completeAmount)!.toFixed(2)}</p>
                  )}
                  {evaluateAmountSum(completeAmount) ? (
                    <p className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-[11.5px] text-emerald-900 font-medium">
                      Adds <b>{currencySymbol}{evaluateAmountSum(completeAmount)!.toLocaleString()}</b> to <b>{group?.name || t('shoppingLists.theGroup')}</b> as <b>"{list.description || list.title}"</b>, paid by you.
                    </p>
                  ) : null}
                </>
              )}

              {toBuy.length > 0 && (
                <button type="button" onClick={() => setCarryOver((v) => !v)} className="mt-3 w-full flex items-center gap-2.5 text-left">
                  <span className={clsx('w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0', carryOver ? 'bg-[#0f7a8f] border-[#0f7a8f] text-white' : 'border-slate-300')}>
                    {carryOver && <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>}
                  </span>
                  <span className="text-xs font-bold text-slate-600">Move the {toBuy.length} item{toBuy.length === 1 ? '' : 's'} not bought to a new list</span>
                </button>
              )}

              <button type="submit" disabled={completing || (!!list.groupId && !evaluateAmountSum(completeAmount))} className="w-full mt-4 py-3.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">
                {completing ? t('common.saving') : list.groupId ? 'Finish and add expense' : 'Finish shopping'}
              </button>
            </form>
          </div>
        </div>
      )}

      {viewingItem && (() => {
        const adder = members.find((m: any) => m.userId === viewingItem.addedBy);
        const status = getItemStatus(viewingItem);
        return (
          <DetailSheet
            aboveNav
            title={t('shoppingLists.itemDetailTitle')}
            onClose={() => setViewingItem(null)}
            onDelete={() => { const it = viewingItem; setViewingItem(null); handleDeleteItem(it); }}
          >
            <DetailField label={t('shoppingLists.item')}>
              <span className="inline-flex items-center gap-2"><span className="text-xl">{itemIcon(viewingItem.text)}</span>{viewingItem.text}</span>
            </DetailField>
            <DetailField label={t('todo.status')}>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleSetItemStatus(viewingItem, 'bought')}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-xs font-bold border transition-all',
                    status === 'bought' ? 'bg-success text-white border-success' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {t('shoppingLists.bought')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSetItemStatus(viewingItem, 'unavailable')}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-xs font-bold border transition-all',
                    status === 'unavailable' ? 'bg-error text-white border-error' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {t('shoppingLists.na')}
                </button>
              </div>
            </DetailField>
            <DetailField label={t('shoppingLists.notes')}>
              <div className="space-y-2">
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  placeholder={t('shoppingLists.notesPlaceholder')}
                  maxLength={500}
                  rows={2}
                  className="w-full bg-surface p-2.5 rounded-lg border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
                />
                {notesDraft !== (viewingItem.notes || '') && (
                  <button
                    type="button"
                    onClick={() => handleSaveItemNotes(viewingItem)}
                    disabled={savingNotes}
                    className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50"
                  >
                    {savingNotes ? t('common.saving') : t('todo.saveNotes')}
                  </button>
                )}
              </div>
            </DetailField>
            <DetailField label={t('shoppingLists.addedByLabel')}>
              {viewingItem.addedBy === user?.uid ? t('shoppingLists.you') : adder?.displayName || t('todo.aMember')}
            </DetailField>
          </DetailSheet>
        );
      })()}
    </div>
  );
}
