import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { doc, collection, query, where, addDoc, updateDoc, deleteDoc, getDocs, writeBatch, setDoc, runTransaction } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { todayLocalDateString } from '../lib/dateUtils';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';
import DetailSheet, { DetailField } from '../components/DetailSheet';

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
  const currencySymbol = getCurrencySymbol(groupValue?.data()?.currency);

  const [itemsValue, itemsLoading] = useCollection(collection(db, 'shoppingLists', listId!, 'items'));
  const items = (itemsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || []).sort((a: any, b: any) => {
    const aResolved = getItemStatus(a) !== 'pending';
    const bResolved = getItemStatus(b) !== 'pending';
    if (aResolved !== bResolved) return aResolved ? 1 : -1;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  const boughtCount = items.filter((i: any) => getItemStatus(i) === 'bought').length;
  const unavailableCount = items.filter((i: any) => getItemStatus(i) === 'unavailable').length;

  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editScheduled, setEditScheduled] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [completeAmount, setCompleteAmount] = useState('');
  const [completing, setCompleting] = useState(false);
  const [viewingItem, setViewingItem] = useState<any | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

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

  // Personal (non-shared) lists have no group to add an expense to — just mark done.
  const handleCompletePersonal = async () => {
    if (!listId || !window.confirm(t('shoppingLists.confirmMarkCompleted'))) return;
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), {
        completed: true,
        completedAt: new Date().toISOString(),
        completedBy: user?.uid,
      });
    } catch (err) {
      console.error('Failed to mark list completed:', err);
      alert(t('shoppingLists.failedToMarkCompleted'));
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

      setShowCompleteForm(false);
      setCompleteAmount('');
    } catch (err) {
      console.error('Failed to complete shopping list:', err);
      alert(t('shoppingLists.failedToCompleteExpense'));
    } finally {
      setCompleting(false);
    }
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newItemText.trim();
    if (!trimmed || !user || !listId) return;
    setAddingItem(true);
    try {
      await addDoc(collection(db, 'shoppingLists', listId, 'items'), {
        text: trimmed,
        status: 'pending',
        addedBy: user.uid,
        createdAt: new Date().toISOString(),
      });
      setNewItemText('');
    } catch (err) {
      console.error('Failed to add item:', err);
      alert(t('shoppingLists.failedToAddItem'));
    } finally {
      setAddingItem(false);
    }
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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <button onClick={() => navigate('/shopping-lists')} className="flex items-center gap-1 text-xs font-bold text-text-muted">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          {t('shoppingLists.allLists')}
        </button>

        {!showEdit ? (
          <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm space-y-2">
            <div className="flex items-start justify-between gap-2">
              <h1 className="text-xl font-black text-primary">{list.title}</h1>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={openEdit} className="p-1.5 text-text-muted hover:text-primary">
                  <span className="material-symbols-outlined text-[18px]">edit</span>
                </button>
                <button onClick={handleDeleteList} className="p-1.5 text-error">
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              {list.groupId ? t('shoppingLists.sharedListDesc') : t('shoppingLists.personalList')}
              {creator && ` · ${t('shoppingLists.createdBy', { name: list.userId === user?.uid ? t('shoppingLists.you') : creator.displayName })}`}
            </p>
            {list.description && (
              <p className="text-xs text-on-surface flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px] text-text-muted">description</span>
                {list.description}
                {categoryInfo && ` · ${t(`category.${categoryInfo.id}`)}`}
              </p>
            )}
            {list.scheduledAt && (
              <p className="text-xs font-bold text-primary flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px]">event</span>
                {t('shoppingLists.scheduledLabel', { date: new Date(list.scheduledAt).toLocaleString() })}
              </p>
            )}
            <p className="text-[11px] text-text-muted">
              {t('shoppingLists.boughtCount', { count: boughtCount })}{unavailableCount > 0 && t('shoppingLists.notAvailableSuffix', { count: unavailableCount })}{t('shoppingLists.totalSuffix', { count: items.length })}
            </p>

            {list.completed ? (
              <div className="bg-success/10 border border-success/20 rounded-xl p-3 flex items-center gap-2 mt-1">
                <span className="material-symbols-outlined text-success">task_alt</span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-success">{t('shoppingLists.completed')}</p>
                  <p className="text-[10px] text-text-muted">
                    {new Date(list.completedAt).toLocaleString()}
                    {typeof list.totalExpense === 'number' && t('shoppingLists.totalAmountSuffix', { amount: `${currencySymbol}${list.totalExpense.toFixed(2)}` })}
                  </p>
                </div>
              </div>
            ) : !showCompleteForm ? (
              <button
                onClick={() => (list.groupId ? setShowCompleteForm(true) : handleCompletePersonal())}
                className="w-full mt-1 py-2.5 bg-success/10 border border-success/20 text-success font-bold rounded-xl text-xs flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">task_alt</span>
                {t('shoppingLists.markCompleted')}
              </button>
            ) : (
              <form onSubmit={handleCompleteWithExpense} className="mt-1 space-y-2 bg-surface p-3 rounded-xl border border-border-subtle">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                  {t('shoppingLists.totalSpentLabel', { group: groupValue?.data()?.name || t('shoppingLists.theGroup') })}
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center gap-1 bg-white px-3 rounded-xl border border-border-subtle">
                    <span className="text-sm font-bold text-primary">{currencySymbol}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={completeAmount}
                      onChange={(e) => setCompleteAmount(e.target.value)}
                      placeholder="0.00"
                      autoFocus
                      required
                      className="flex-1 h-10 bg-transparent text-sm outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={completing || !completeAmount}
                    className="px-4 h-10 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                  >
                    {completing ? t('common.saving') : t('shoppingLists.confirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCompleteForm(false)}
                    className="w-10 h-10 rounded-xl text-text-muted flex items-center justify-center"
                  >
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>
                {hasAmountSumOperator(completeAmount) && evaluateAmountSum(completeAmount) !== null && (
                  <p className="text-xs font-bold text-success px-1">= {currencySymbol}{evaluateAmountSum(completeAmount)!.toFixed(2)}</p>
                )}
              </form>
            )}
          </div>
        ) : (
          <form onSubmit={handleSaveEdit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">{t('shoppingLists.editList')}</h2>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('shoppingLists.listName')}</label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={150}
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('shoppingLists.scheduledTimeEdit')}</label>
              <input
                type="datetime-local"
                value={editScheduled}
                onChange={(e) => setEditScheduled(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowEdit(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={savingEdit || !editTitle.trim()} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                {savingEdit ? t('common.saving') : t('groupExpenses.saveChanges')}
              </button>
            </div>
          </form>
        )}

        <form onSubmit={handleAddItem} className="flex gap-2">
          <input
            type="text"
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            placeholder={t('shoppingLists.addItemPlaceholder')}
            maxLength={200}
            className="flex-1 bg-white p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="submit"
            disabled={addingItem || !newItemText.trim()}
            className="px-4 bg-primary text-white rounded-xl font-bold text-sm disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[20px]">add</span>
          </button>
        </form>

        <section className="space-y-2">
          {itemsLoading && <p className="text-sm text-text-muted px-1">{t('shoppingLists.loadingItems')}</p>}
          {!itemsLoading && items.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">{t('shoppingLists.noItemsYet')}</p>
          )}
          {items.map((item: any) => {
            const adder = members.find((m: any) => m.userId === item.addedBy);
            const status = getItemStatus(item);
            return (
              <div
                key={item.id}
                onClick={() => { setViewingItem(item); setNotesDraft(item.notes || ''); }}
                className={clsx('bg-white rounded-xl border p-3 flex items-center gap-3 flex-wrap cursor-pointer', status !== 'pending' ? 'border-border-subtle opacity-60' : 'border-border-subtle')}
              >
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleSetItemStatus(item, 'bought')}
                    title={t('shoppingLists.bought')}
                    className={clsx(
                      'px-2.5 py-1.5 rounded-lg text-[10px] font-bold flex flex-col items-center gap-0.5 border',
                      status === 'bought' ? 'bg-success/10 text-success border-success/30' : 'bg-surface text-text-muted border-border-subtle'
                    )}
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      {status === 'bought' ? 'radio_button_checked' : 'radio_button_unchecked'}
                    </span>
                    {t('shoppingLists.bought')}
                  </button>
                  <button
                    onClick={() => handleSetItemStatus(item, 'unavailable')}
                    title={t('shoppingLists.notAvailableTitle')}
                    className={clsx(
                      'px-2.5 py-1.5 rounded-lg text-[10px] font-bold flex flex-col items-center gap-0.5 border',
                      status === 'unavailable' ? 'bg-error/10 text-error border-error/30' : 'bg-surface text-text-muted border-border-subtle'
                    )}
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      {status === 'unavailable' ? 'radio_button_checked' : 'radio_button_unchecked'}
                    </span>
                    {t('shoppingLists.na')}
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={clsx('text-sm font-bold truncate flex items-center gap-1', status !== 'pending' ? 'line-through text-text-muted' : 'text-on-surface')}>
                    {item.text}
                    {item.notes && (
                      <span className="material-symbols-outlined text-[14px] text-text-muted shrink-0 no-underline" title={t('shoppingLists.notes')}>sticky_note_2</span>
                    )}
                  </p>
                  <p className="text-[10px] text-text-muted truncate">
                    {t('todo.addedBy', { name: item.addedBy === user?.uid ? t('shoppingLists.you') : adder?.displayName || t('todo.aMember') })}
                  </p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteItem(item); }} className="p-1.5 text-error shrink-0">
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            );
          })}
        </section>
      </main>
      {viewingItem && (() => {
        const adder = members.find((m: any) => m.userId === viewingItem.addedBy);
        const status = getItemStatus(viewingItem);
        return (
          <DetailSheet title={t('shoppingLists.itemDetailTitle')} onClose={() => setViewingItem(null)}>
            <DetailField label={t('shoppingLists.item')}>{viewingItem.text}</DetailField>
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
