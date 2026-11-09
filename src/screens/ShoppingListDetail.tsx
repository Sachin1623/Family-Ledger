import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { doc, collection, query, where, addDoc, updateDoc, deleteDoc, getDocs, writeBatch, setDoc, runTransaction, arrayUnion, deleteField } from 'firebase/firestore';
import { useLiveQuery, useLiveRef } from '../lib/liveCache';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, getCurrencySymbol, getCategoryIcon, getGroupCategories } from '../lib/constants';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { todayLocalDateString } from '../lib/dateUtils';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';
import { groupIconEmoji } from '../lib/groupIcons';
import { itemIcon, listIconGuess } from '../lib/shoppingIcons';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import { tileTint } from './ShoppingLists';
import StoreChip from '../components/StoreChip';
import RenameStoreSheet from '../components/RenameStoreSheet';
import { storeFieldKey } from '../lib/shoppingStores';
import { historyKey, recordPurchase, suggestFromHistory } from '../lib/shoppingHistory';
import { useFriendships } from '../lib/useFriendships';
import { eventKeyOf, eventNameFromTitle, revokeShareLink, sendListCopy, shareLinkFor } from '../lib/shoppingEvents';
import { shareText } from '../lib/fileShare';
import { FREQ_OPTIONS, FREQ_SHORT, Freq, getRoutines, recurringKey, routineKeyOf, saveRecurring, todayLocalDate } from '../lib/shoppingRoutine';

const toDatetimeLocalValue = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type ItemStatus = 'pending' | 'bought' | 'unavailable';

// Each store's tile has its own colour (a store keeps the same one for as long as it stays in the person's list of stores).
const STORE_COLORS = [
  { bg: '#e0f2fe', border: '#7dd3fc', ink: '#075985' },
  { bg: '#dcfce7', border: '#86efac', ink: '#166534' },
  { bg: '#fef3c7', border: '#fcd34d', ink: '#92400e' },
  { bg: '#ffe4e6', border: '#fda4af', ink: '#9f1239' },
  { bg: '#ede9fe', border: '#c4b5fd', ink: '#5b21b6' },
  { bg: '#ffedd5', border: '#fdba74', ink: '#9a3412' },
  { bg: '#ccfbf1', border: '#5eead4', ink: '#115e59' },
  { bg: '#fae8ff', border: '#f0abfc', ink: '#86198f' },
  { bg: '#ecfccb', border: '#bef264', ink: '#3f6212' },
  { bg: '#e0e7ff', border: '#a5b4fc', ink: '#3730a3' },
];
const NO_STORE_COLOR = { bg: '#f1f5f9', border: '#cbd5e1', ink: '#475569' };

// The amounts people type most often, one tap each; the unit chips below cover everything else.
const QTY_PRESETS: [string, string][] = [['100', 'gm'], ['250', 'gm'], ['500', 'gm'], ['1', 'kg'], ['5', 'kg'], ['500', 'ml'], ['1', 'L'], ['1', 'pk']];
const UNIT_CHOICES = ['kg', 'gm', 'L', 'ml', 'pk', 'pcs', 'dz'];
const qtyLabel = (item: any) => [item.qty != null ? String(item.qty) : '', item.unit || ''].filter(Boolean).join(' ');

// Falls back to the old boolean `checked` field for items created before the tri-state model.
const getItemStatus = (item: any): ItemStatus => item.status || (item.checked ? 'bought' : 'pending');

export default function ShoppingListDetail() {
  const { listId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();

  const [listValue, listLoading] = useLiveRef(doc(db, 'shoppingLists', listId!));
  const list = listValue?.data();

  const [membersValue] = useLiveQuery(
    list?.groupId ? query(collection(db, 'members'), where('groupId', '==', list.groupId)) : null,
  );
  const members = membersValue?.docs.map((d) => d.data() as any) || [];
  const { acceptedUids, usersByUid } = useFriendships(user?.uid);
  const creator = members.find((m: any) => m.userId === list?.userId) || (list?.userId && usersByUid.get(list.userId) ? { displayName: usersByUid.get(list.userId)!.displayName } : undefined);
  const sharedFriendUids: string[] = Array.isArray(list?.sharedWith) ? list.sharedWith : [];
  // a friend the list was shared with directly (not through a group) can use the list but not delete it
  const friendOnly = !!user && !!list && list.userId !== user.uid && sharedFriendUids.includes(user.uid) && !members.some((m: any) => m.userId === user.uid);
  const categoryInfo = EXPENSE_CATEGORIES.find((c) => c.id === list?.category);

  // The groups the owner can share this list with (only fetched while the share sheet is open)
  const isOwner = !!user && list?.userId === user.uid;
  const [showEdit, setShowEdit] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [myMembershipsValue] = useLiveQuery(
    showShare && isOwner && user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const myGroupIds: string[] = myMembershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [myGroupsValue] = useLiveQuery(
    myGroupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', myGroupIds.slice(0, 30))) : null,
  );
  const myGroups = myGroupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [groupValue] = useLiveRef(list?.groupId ? doc(db, 'groups', list.groupId) : null);
  const group = groupValue?.data() as any;
  const currencySymbol = getCurrencySymbol(group?.currency);

  const [itemsValue, itemsLoading] = useLiveQuery(collection(db, 'shoppingLists', listId!, 'items'));
  const items = (itemsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || []).sort((a: any, b: any) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const toBuy = items.filter((i: any) => getItemStatus(i) === 'pending');
  const inCart = items.filter((i: any) => getItemStatus(i) === 'bought');
  const notAvailable = items.filter((i: any) => getItemStatus(i) === 'unavailable');
  const doneCount = inCart.length + notAvailable.length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  const [filterStore, setFilterStore] = useState('');
  // Dragging an item to another store: the grip on a row starts it, the list is replaced by one big drop target per store,
  // and letting go over a target moves the item there. Pointer events (not the browser's own drag and drop) so it works with a finger.
  // a store's category and what was spent there, saved on the list so finishing it can add the spend to the group
  const [spendFor, setSpendFor] = useState<string | null>(null);
  const [renamingStore, setRenamingStore] = useState<string | null>(null);
  const [catFor, setCatFor] = useState<string | null>(null);
  const [spendCat, setSpendCat] = useState('');
  const [spendAmount, setSpendAmount] = useState('');
  const spendInputRef = useRef<HTMLInputElement>(null);
  const [savingSpend, setSavingSpend] = useState(false);
  const [drag, setDrag] = useState<{ item: any; x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dragItemRef = useRef<any>(null);
  const moveItemToStore = (item: any, store: string) => {
    if (!listId || (item.store || '') === store) return;
    updateDoc(doc(db, 'shoppingLists', listId, 'items', item.id), { store: store || null }).catch((err) => console.error('Failed to move item:', err));
    if (store && user && !(profile?.shoppingStores || []).includes(store)) setDoc(doc(db, 'users', user.uid), { shoppingStores: arrayUnion(store) }, { merge: true }).catch(() => {});
  };
  const startDrag = (e: React.PointerEvent, item: any) => {
    e.preventDefault();
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not every browser allows it */ }
    dragItemRef.current = item;
    setDrag({ item, x: e.clientX, y: e.clientY });
    setDragOver(null);
  };
  useEffect(() => {
    if (!drag) return;
    const dropTargetAt = (x: number, y: number): string | null => {
      for (const el of document.elementsFromPoint(x, y)) {
        const v = (el as HTMLElement).dataset?.storeDrop;
        if (v !== undefined) return v;
      }
      return null;
    };
    const move = (e: PointerEvent) => { setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d)); setDragOver(dropTargetAt(e.clientX, e.clientY)); };
    const up = (e: PointerEvent) => {
      const target = dropTargetAt(e.clientX, e.clientY);
      const item = dragItemRef.current;
      setDrag(null);
      setDragOver(null);
      if (target !== null && item) moveItemToStore(item, target);
    };
    const cancel = () => { setDrag(null); setDragOver(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.item?.id]);

  // a repeat belongs to the routine of the group this list is shared with ('me' for a personal list)
  const routineKey = routineKeyOf(list?.groupId);
  const recKey = (text: string) => recurringKey(routineKey, historyKey(text || ''));
  const hasRoutine = !!getRoutines(profile)[routineKey];
  const itemKeys = new Set(items.map((i: any) => historyKey(i.text || '')));
  const suggestions = list && !list.completed ? suggestFromHistory(profile?.shoppingHistory, itemKeys, 10) : [];

  // Stores: the ones this person has used, plus any a group member put on an item here. The list can be viewed
  // one store at a time, and the items still to buy are grouped under their store.
  const knownStores: string[] = Array.from(new Set<string>([...(profile?.shoppingStores || []), ...items.map((i: any) => i.store).filter(Boolean)]));
  const storesInList = knownStores.filter((st) => items.some((i: any) => i.store === st));
  const activeFilter = filterStore && storesInList.includes(filterStore) ? filterStore : '';
  const matchesFilter = (i: any) => !activeFilter || i.store === activeFilter;
  const STARTER_STORES = ['Kirana', 'Supermarket', 'Online', 'Vegetable seller', 'Pharmacy'];
  const storeTotals = (list?.storeTotals || {}) as Record<string, { store?: string; category?: string; amount?: number }>;
  const storeSpendTotal = Object.values(storeTotals).reduce((sum, v) => sum + (v?.amount || 0), 0);
  const spendCategories = getGroupCategories(group, 'expense');
  const categoryLabel = (c: { id: string; name: string }) => (c.id.startsWith('custom_') ? c.name : t(`category.${c.id}`));
  const openSpend = (store: string) => {
    const cur = storeTotals[storeFieldKey(store)];
    setSpendAmount(cur?.amount ? String(cur.amount) : '');
    setSpendFor(store);
  };
  const openCategory = (store: string) => {
    const cur = storeTotals[storeFieldKey(store)];
    setSpendCat(cur?.category || list?.category || 'groceries');
    setCatFor(store);
  };
  // the category and the amount are saved separately: saving one never clears the other
  const handleSaveSpend = async () => {
    if (spendFor === null || !listId) return;
    const amount = spendAmount.trim() ? evaluateAmountSum(spendAmount) : null;
    if (spendAmount.trim() && (!amount || amount <= 0)) return;
    setSavingSpend(true);
    try {
      await setDoc(doc(db, 'shoppingLists', listId), { storeTotals: { [storeFieldKey(spendFor)]: { store: spendFor, amount: amount ?? deleteField() } } }, { merge: true });
      setSpendFor(null);
    } catch (err) {
      console.error('Failed to save store spend:', err);
      alert('Could not save. Try again.');
    } finally {
      setSavingSpend(false);
    }
  };
  const handleSaveCategory = async () => {
    if (catFor === null || !listId) return;
    setSavingSpend(true);
    try {
      await setDoc(doc(db, 'shoppingLists', listId), { storeTotals: { [storeFieldKey(catFor)]: { store: catFor, category: spendCat } } }, { merge: true });
      setCatFor(null);
    } catch (err) {
      console.error('Failed to save store category:', err);
      alert('Could not save. Try again.');
    } finally {
      setSavingSpend(false);
    }
  };

  // The lists page shows each list's progress without opening its items, from two counts kept on the list itself.
  // They are brought up to date from here whenever they differ from what is really in the list.
  useEffect(() => {
    if (!listId || !list || itemsLoading || !itemsValue) return;
    if (list.itemCount === items.length && list.doneCount === doneCount) return;
    updateDoc(doc(db, 'shoppingLists', listId), { itemCount: items.length, doneCount }).catch((err) => console.error('shopping list counts failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, list?.itemCount, list?.doneCount, items.length, doneCount, itemsLoading]);

  const [editTitle, setEditTitle] = useState('');
  const [editScheduled, setEditScheduled] = useState('');
  const [shareGroupId, setShareGroupId] = useState('');
  const [savingShare, setSavingShare] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [showFinish, setShowFinish] = useState(false);
  const [completeAmount, setCompleteAmount] = useState('');
  const [carryOver, setCarryOver] = useState(true);
  const [carryNotAvailable, setCarryNotAvailable] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [viewingItem, setViewingItem] = useState<any | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [qtyDraft, setQtyDraft] = useState('');
  const [unitDraft, setUnitDraft] = useState('');
  const [storeDraft, setStoreDraft] = useState('');
  const [freqDraft, setFreqDraft] = useState('');
  const [newStoreText, setNewStoreText] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [carriedListId, setCarriedListId] = useState<string | null>(null);
  const [shareFriendUids, setShareFriendUids] = useState<string[]>([]);

  const openEdit = () => {
    if (!list) return;
    setEditTitle(list.title);
    setEditScheduled(list.scheduledAt ? toDatetimeLocalValue(list.scheduledAt) : '');
    setShowEdit(true);
  };

  const openShare = () => {
    if (!list) return;
    setShareGroupId(list.groupId || '');
    setShareFriendUids(sharedFriendUids);
    setShowShare(true);
  };

  const handleSaveShare = async () => {
    if (!listId) return;
    setSavingShare(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), { groupId: shareGroupId || null, sharedWith: shareFriendUids });
      setShowShare(false);
    } catch (err) {
      console.error('Failed to share shopping list:', err);
      alert(t('shoppingLists.failedToUpdate'));
    } finally {
      setSavingShare(false);
    }
  };

  // ---- yearly Event: the list comes back every year (Diwali, Holi...) ----
  const [showEvent, setShowEvent] = useState(false);
  const [eventNameDraft, setEventNameDraft] = useState('');
  const [savingEvent, setSavingEvent] = useState(false);
  const openEvent = () => { if (!list) return; setEventNameDraft(list.eventName || eventNameFromTitle(list.title)); setShowEvent(true); };
  const handleSaveEvent = async () => {
    const name = eventNameDraft.trim().slice(0, 60);
    if (!name || !listId || !list) return;
    setSavingEvent(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), { isEvent: true, eventName: name, eventKey: eventKeyOf(name), eventYear: list.eventYear || Number((list.createdAt || '').slice(0, 4)) || new Date().getFullYear() });
      setShowEvent(false);
    } catch (err) {
      console.error('Failed to make the list an event:', err);
      alert('Could not save. Try again.');
    } finally {
      setSavingEvent(false);
    }
  };
  const handleRemoveEvent = async () => {
    if (!listId) return;
    setSavingEvent(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId), { isEvent: deleteField(), eventName: deleteField(), eventKey: deleteField(), eventYear: deleteField() });
      setShowEvent(false);
    } catch (err) {
      console.error('Failed to remove the event:', err);
    } finally {
      setSavingEvent(false);
    }
  };

  // ---- send a copy: to friends, or as a link anyone can open ----
  const [showSend, setShowSend] = useState(false);
  const [sendUids, setSendUids] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState('');
  const [sentLink, setSentLink] = useState<{ id: string; url: string } | null>(null);
  const openSend = () => { setSendUids([]); setSendNote(''); setSentLink(null); setShowSend(true); };
  const handleSendToFriends = async () => {
    if (!listId || sendUids.length === 0) return;
    setSending(true);
    setSendNote('');
    try {
      const r = await sendListCopy(listId, { toUids: sendUids });
      setSendNote(`Sent to ${r.sentTo} friend${r.sentTo === 1 ? '' : 's'}. They can save their own copy.`);
      setSendUids([]);
    } catch (err: any) {
      setSendNote(err?.message || 'Could not send. Try again.');
    } finally {
      setSending(false);
    }
  };
  const handleGetLink = async () => {
    if (!listId) return;
    setSending(true);
    setSendNote('');
    try {
      const r = await sendListCopy(listId, { link: true });
      const url = shareLinkFor(r.id);
      setSentLink({ id: r.id, url });
      const text = `${list?.title}: ${r.itemCount} items. Save your own copy in FamilyLedger 👉 ${url}`;
      const out = await shareText(list?.title || 'Shopping list', text);
      if (out === 'copied') setSendNote('Link copied. Paste it wherever you like.');
    } catch (err: any) {
      setSendNote(err?.message || 'Could not make the link. Try again.');
    } finally {
      setSending(false);
    }
  };
  const handleTurnOffLink = async () => {
    if (!sentLink) return;
    await revokeShareLink(sentLink.id).catch(() => {});
    setSentLink(null);
    setSendNote('That link no longer works.');
  };

  const openItem = (item: any) => {
    setViewingItem(item);
    setNotesDraft(item.notes || '');
    setNameDraft(item.text || '');
    setQtyDraft(item.qty != null ? String(item.qty) : '');
    setUnitDraft(item.unit || '');
    setStoreDraft(item.store || '');
    setFreqDraft(profile?.shoppingRecurring?.[recKey(item.text || '')]?.freq || '');
    setNewStoreText('');
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

  // What was not bought, and optionally what was not available, can move to a fresh list (same group, category and icon)
  // so it is not forgotten. Both go into one list when both are chosen.
  const carryUnboughtToNewList = async () => {
    if (!user || !list) return;
    const left = items.filter((i: any) => {
      const s = getItemStatus(i);
      return (carryOver && s === 'pending') || (carryNotAvailable && s === 'unavailable');
    });
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
      batch.set(doc(collection(db, 'shoppingLists', newRef.id, 'items')), { text: it.text, status: 'pending', addedBy: user.uid, createdAt: new Date(now + i).toISOString(), ...(it.notes ? { notes: it.notes } : {}), ...(it.qty != null ? { qty: it.qty } : {}), ...(it.unit ? { unit: it.unit } : {}), ...(it.store ? { store: it.store } : {}) });
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
      if (carryOver || carryNotAvailable) await carryUnboughtToNewList();
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
      if (carryOver || carryNotAvailable) await carryUnboughtToNewList().catch((err) => console.error('carry over failed:', err));
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
  const addItems = async (lines: (string | { text: string; qty?: number | null; unit?: string | null; store?: string | null })[]) => {
    const entries = lines
      .map((l) => (typeof l === 'string' ? { text: l } : l))
      .map((l) => ({ ...l, text: l.text.trim().slice(0, 200) }))
      .filter((l) => l.text)
      .slice(0, 100);
    if (entries.length === 0 || !user || !listId) return;
    setAddingItem(true);
    try {
      const batch = writeBatch(db);
      const now = Date.now();
      entries.forEach((entry, i) => {
        batch.set(doc(collection(db, 'shoppingLists', listId, 'items')), {
          text: entry.text,
          status: 'pending',
          addedBy: user.uid,
          createdAt: new Date(now + i).toISOString(),
          ...(entry.qty != null ? { qty: entry.qty } : {}),
          ...(entry.unit ? { unit: entry.unit } : {}),
          ...(entry.store ? { store: entry.store } : {}),
        });
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
      if (next === 'bought' && user) recordPurchase(user.uid, profile?.shoppingHistory || {}, { text: item.text, qty: item.qty, unit: item.unit, store: item.store });
      setViewingItem((prev: any) => (prev && prev.id === item.id ? { ...prev, status: next } : prev));
    } catch (err) {
      console.error('Failed to update item:', err);
    }
  };

  // Saves the item's name, quantity, unit and notes together
  const handleSaveItem = async (item: any) => {
    const name = nameDraft.trim().slice(0, 200);
    if (!name) return;
    const parsedQty = parseFloat(qtyDraft.replace(',', '.'));
    const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : null;
    const unit = unitDraft || null;
    const notes = notesDraft.trim();
    const store = storeDraft.trim().slice(0, 40) || null;
    setSavingNotes(true);
    try {
      await updateDoc(doc(db, 'shoppingLists', listId!, 'items', item.id), { text: name, qty, unit, store, notes: notes || null });
      setViewingItem((prev: any) => (prev && prev.id === item.id ? { ...prev, text: name, qty, unit, store, notes } : prev));
      // how often it repeats (the weekly routine builds its list from these)
      if (user) {
        const oldKey = recKey(item.text || '');
        const newKey = recKey(name);
        const prevRec = profile?.shoppingRecurring?.[oldKey];
        if (freqDraft) {
          const anchor = prevRec && prevRec.freq === freqDraft ? prevRec.anchor || todayLocalDate() : todayLocalDate();
          if (prevRec && oldKey !== newKey) saveRecurring(user.uid, oldKey, null).catch(() => {});
          saveRecurring(user.uid, newKey, { name, qty, unit, store, freq: freqDraft as Freq, routine: routineKey, anchor, lastAdded: prevRec?.lastAdded || null }).catch(() => {});
        } else if (prevRec) {
          saveRecurring(user.uid, oldKey, null).catch(() => {});
        }
      }
      // a store typed here is remembered for the next item and the next list
      if (store && user && !(profile?.shoppingStores || []).includes(store)) setDoc(doc(db, 'users', user.uid), { shoppingStores: arrayUnion(store) }, { merge: true }).catch(() => {});
      setQtyDraft(qty != null ? String(qty) : '');
      setNameDraft(name);
    } catch (err) {
      console.error('Failed to save item:', err);
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

  const renderItem = (item: any, hideStore = false) => {
    const status = getItemStatus(item);
    const adder = members.find((m: any) => m.userId === item.addedBy);
    const resolved = status !== 'pending';
    return (
      <div
        key={item.id}
        onClick={() => openItem(item)}
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
          <p className={clsx('text-sm font-black truncate', resolved ? 'line-through text-text-muted' : 'text-primary')}>
            {item.text}
            {qtyLabel(item) && <span className="ml-1.5 align-middle text-[11px] font-black text-[#0f7a8f] bg-teal-50 rounded-md px-1.5 py-px no-underline">{qtyLabel(item)}</span>}
          </p>
          <p className="text-[10.5px] text-text-muted truncate flex items-center gap-1">
            {t('todo.addedBy', { name: item.addedBy === user?.uid ? t('shoppingLists.you') : adder?.displayName || t('todo.aMember') })}
            {profile?.shoppingRecurring?.[recKey(item.text || '')]?.freq && <span className="inline-flex items-center rounded bg-amber-50 text-amber-800 px-1 text-[10px] font-black shrink-0">🔁 {FREQ_SHORT[profile.shoppingRecurring[recKey(item.text || '')].freq as Freq]}</span>}
            {item.store && !hideStore && <span className="inline-flex items-center rounded bg-sky-50 text-sky-800 px-1 text-[10px] font-black shrink-0">🏪 {item.store}</span>}
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
        {!list.completed && (
          <span
            onPointerDown={(e) => startDrag(e, item)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to another store"
            aria-label="Drag to another store"
            className="shrink-0 -mr-1 w-7 h-9 flex items-center justify-center text-slate-300 cursor-grab select-none"
            style={{ touchAction: 'none' }}
          >
            <span className="material-symbols-outlined text-[22px]">drag_indicator</span>
          </span>
        )}
      </div>
    );
  };

  const section = (label: string, all: any[], tone?: 'muted', grouped?: boolean) => {
    const list2 = all.filter(matchesFilter);
    if (list2.length === 0) return null;
    // under "To buy", items sit under their store's heading (stores in the order they were added, no store last)
    const groups: [string, any[]][] = grouped && activeFilter
      ? [[activeFilter, list2]]
      : grouped && storesInList.length > 0
      ? [
          ...storesInList.filter((st) => list2.some((i: any) => i.store === st)).map((st) => [st, list2.filter((i: any) => i.store === st)] as [string, any[]]),
          ...(list2.some((i: any) => !i.store) ? [['', list2.filter((i: any) => !i.store)] as [string, any[]]] : []),
        ]
      : [];
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</h2>
          <span className="text-[11px] font-black rounded-full px-2 py-px bg-slate-200/70 text-slate-600">{list2.length}</span>
        </div>
        {groups.length > 0 ? groups.map(([st, rows]) => {
          const col = st ? STORE_COLORS[Math.max(0, knownStores.indexOf(st)) % STORE_COLORS.length] : NO_STORE_COLOR;
          const spend = storeTotals[storeFieldKey(st)];
          const catInfo = spend?.category ? spendCategories.find((c) => c.id === spend.category) : null;
          const pill = 'shrink-0 rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-black active:scale-95';
          return (
            <div key={st || 'none'} className="rounded-3xl p-2.5 space-y-2" style={{ background: col.bg, border: `1.5px solid ${col.border}` }}>
              <div className="flex items-center gap-2 px-1.5 pt-0.5">
                {/* name, then its category */}
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  <p className="min-w-0 truncate text-sm font-black" style={{ color: col.ink }}>{st ? `🏪 ${st}` : 'No store yet'}<span className="ml-1 text-[10px] font-black opacity-60">· {rows.length}</span></p>
                  {list.completed ? (
                    catInfo && <span className={pill} style={{ color: col.ink }}>{catInfo.icon} {categoryLabel(catInfo)}</span>
                  ) : (
                    <button type="button" onClick={() => openCategory(st)} className={clsx(pill, 'truncate max-w-[45%]')} style={{ color: col.ink }}>
                      {catInfo ? `${catInfo.icon} ${categoryLabel(catInfo)}` : '+ Category'}
                    </button>
                  )}
                </div>
                {/* what was spent there, on the right */}
                {list.completed ? (
                  spend?.amount ? <span className={pill} style={{ color: col.ink }}>{currencySymbol}{spend.amount.toLocaleString()}</span> : null
                ) : (
                  <button type="button" onClick={() => openSpend(st)} className={pill} style={{ color: col.ink }}>
                    {spend?.amount ? `${currencySymbol}${spend.amount.toLocaleString()}` : '+ Spend'}
                  </button>
                )}
              </div>
              {rows.map((it: any) => renderItem(it, true))}
            </div>
          );
        }) : (
          <div className={clsx('space-y-2', tone === 'muted' && 'opacity-90')}>{list2.map((it: any) => renderItem(it))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(13rem + env(safe-area-inset-bottom))' }}>

        {/* the list at a glance */}
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)' }}>
          <div className="flex items-start gap-3">
            <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-[24px] shrink-0" style={{ background: tileTint(list.category) }}>{heroIcon}</span>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-black leading-tight">{list.title}</h1>
              <p className="text-[12px] text-white/85 mt-0.5 flex items-center gap-1.5 flex-wrap">
                {list.groupId ? (
                  <span className="inline-flex items-center gap-1">{group?.photoURL ? <img src={group.photoURL} alt="" className="w-3.5 h-3.5 rounded-sm object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(group?.icon)}</span>}{group?.name || t('shoppingLists.theGroup')}</span>
                ) : sharedFriendUids.length > 0 ? <span>👥 {list.userId === user?.uid ? `Shared with ${sharedFriendUids.length} friend${sharedFriendUids.length === 1 ? '' : 's'}` : 'Shared with you'}</span> : <span>🔒 {t('shoppingLists.personalList')}</span>}
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
              <button onClick={() => { setCarryOver(toBuy.length > 0); setCompleteAmount(storeSpendTotal > 0 ? String(storeSpendTotal) : ''); setShowFinish(true); }} className="flex-1 rounded-xl bg-white text-[#0b3b57] py-2.5 text-sm font-black active:scale-95">
                {t('shoppingLists.markCompleted')}
              </button>
            )}
            {isOwner && (
              <button onClick={openEvent} title={list.isEvent ? 'Yearly event' : 'Make this a yearly event'} className={clsx('shrink-0 w-10 h-10 rounded-xl flex items-center justify-center active:scale-95', list.isEvent ? 'bg-amber-400 text-[#7c2d12]' : 'bg-white/15')}>
                <span className="material-symbols-outlined text-[20px]">event_repeat</span>
              </button>
            )}
            <button onClick={openSend} title="Send a copy to a friend" className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
              <span className="material-symbols-outlined text-[20px]">forward_to_inbox</span>
            </button>
            {isOwner && !list.completed && (
              <button onClick={openShare} title="Share this list with a group" className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
                <span className="material-symbols-outlined text-[20px]">group_add</span>
              </button>
            )}
            <button onClick={openEdit} title={t('shoppingLists.editList')} className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
              <span className="material-symbols-outlined text-[20px]">edit</span>
            </button>
            {!friendOnly && <button onClick={handleDeleteList} title={t('common.delete')} className="shrink-0 w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center active:scale-95">
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>}
          </div>
          {carriedListId && (
            <button onClick={() => navigate(`/shopping-lists/${carriedListId}`)} className="mt-2 w-full rounded-xl bg-white/15 py-2 text-xs font-black">Items you did not get moved to a new list · Open it</button>
          )}
        </div>

        <section className="space-y-4">
          {itemsLoading && <div className="space-y-3" aria-hidden><div className="h-16 rounded-2xl bg-border-subtle/50 animate-pulse" /><div className="h-16 rounded-2xl bg-border-subtle/50 animate-pulse" /></div>}
          {!itemsLoading && items.length === 0 && (
            <div className="rounded-2xl bg-white p-6 text-center shadow-[0_2px_8px_rgba(30,58,95,0.09)]">
              <p className="text-4xl">🧺</p>
              <p className="text-sm font-black text-primary mt-2">{t('shoppingLists.noItemsYet')}</p>
              <p className="text-xs text-text-muted mt-1">Type an item below, or paste a whole list to add one per line.</p>
            </div>
          )}
          {storesInList.length > 0 && (
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
              {['', ...storesInList].map((st) => (
                <button key={st || 'all'} type="button" onClick={() => setFilterStore(st)} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-xs font-black border transition-all active:scale-95', activeFilter === st ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>
                  {st ? `🏪 ${st}` : 'All stores'}
                </button>
              ))}
            </div>
          )}
          {drag && (
            <div className="space-y-2">
              <p className="px-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Drop on a store</p>
              {(() => {
                const dropStores = ['', ...Array.from(new Set<string>([...knownStores, ...STARTER_STORES]))];
                return dropStores.map((st, idx) => {
                  const here = items.filter((i: any) => (i.store || '') === st).length;
                  const current = (drag.item.store || '') === st;
                  const over = dragOver === st;
                  // the same colour the store's tile has in the list (known stores come first, in the same order)
                  const col = st ? STORE_COLORS[(idx - 1) % STORE_COLORS.length] : NO_STORE_COLOR;
                  return (
                    <div
                      key={st || 'none'}
                      data-store-drop={st}
                      className="rounded-2xl px-4 py-3.5 flex items-center gap-2 text-xs font-black transition-all"
                      style={over
                        ? { background: col.ink, border: `2px solid ${col.ink}`, color: '#fff', transform: 'scale(1.03)', boxShadow: '0 8px 20px rgba(0,0,0,.18)' }
                        : { background: col.bg, border: `2px ${current ? 'solid' : 'dashed'} ${col.border}`, color: col.ink }}
                    >
                      <span>{st ? `🏪 ${st}` : 'No store yet'}</span>
                      <span className="text-[10px] opacity-60">· {here}</span>
                      {current && <span className="ml-auto text-[10px] font-bold opacity-70">currently here</span>}
                    </div>
                  );
                });
              })()}
            </div>
          )}
          {/* the rows stay in the page while dragging (the drag is tracked from the grip that was pressed) but take no room */}
          <div className="space-y-4" style={drag ? { height: 0, overflow: 'hidden' } : undefined} aria-hidden={!!drag}>
            {section('To buy', toBuy, undefined, true)}
            {section('In the cart', inCart, 'muted')}
            {section('Not available', notAvailable, 'muted')}
          </div>
        </section>
      </main>

      {/* while dragging: the item follows the finger; the list itself swaps its rows for store bars to drop on */}
      {drag && (
        <div className="fixed pointer-events-none z-[120] rounded-full bg-primary text-white text-sm font-black px-4 py-2 shadow-2xl max-w-[70vw] truncate" style={{ left: drag.x, top: drag.y, transform: 'translate(-50%, -140%)' }}>
          {drag.item.text}
        </div>
      )}

      {/* quick add from what was bought before: one tap adds the item with its usual amount */}
      {!list.completed && !drag && suggestions.length > 0 && (
        <div className="fixed left-0 right-0 z-30 mx-auto max-w-xl" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 70px)' }}>
          <p className="px-5 pb-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">Bought before</p>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-3 pb-1">
            {suggestions.map((sg) => {
              const amount = [sg.qty != null ? String(sg.qty) : '', sg.unit || ''].filter(Boolean).join(' ');
              return (
                <button key={sg.key} type="button" onClick={() => addItems([{ text: sg.name, qty: sg.qty, unit: sg.unit, store: sg.store }])} className="shrink-0 rounded-full bg-white border border-slate-200 shadow-sm px-3 py-1.5 text-xs font-black text-slate-700 flex items-center gap-1 active:scale-95">
                  <span className="text-[#0f7a8f]">+</span> {sg.name}
                  {amount && <span className="font-bold text-[#0f7a8f]">{amount}</span>}
                  {sg.due && <span className="w-1.5 h-1.5 rounded-full bg-orange-500" title="Probably due again" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* add items: Enter adds one; pasting several lines adds one per line */}
      {!list.completed && !drag && (
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

      {showEvent && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setShowEvent(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3 space-y-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-1" />
              <h2 className="text-base font-black text-primary">{list.isEvent ? 'Yearly event' : 'Make this a yearly event'}</h2>
              <p className="text-xs text-text-muted">A list that comes back every year, like Diwali or Holi. It stays under <b>My events</b> on the shopping page, and next year you can start a fresh copy of it in one tap. This year's list stays as it is.</p>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider px-1">Event name</label>
                <input type="text" value={eventNameDraft} onChange={(e) => setEventNameDraft(e.target.value)} maxLength={60} placeholder="Diwali" autoFocus className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowEvent(false)} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 text-sm font-black">Cancel</button>
                <button type="button" onClick={handleSaveEvent} disabled={savingEvent || !eventNameDraft.trim()} className="flex-1 py-3 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 disabled:opacity-50">{savingEvent ? 'Saving…' : list.isEvent ? 'Save' : 'Make it an event'}</button>
              </div>
              {list.isEvent && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setShowEvent(false); navigate(`/shopping-events/${list.eventKey}`); }} className="flex-1 py-2 text-xs font-black text-[#0f7a8f]">See all years</button>
                  <button type="button" onClick={handleRemoveEvent} disabled={savingEvent} className="flex-1 py-2 text-xs font-black text-rose-600">Not an event anymore</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSend && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setShowSend(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3 space-y-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-1" />
              <h2 className="text-base font-black text-primary">Send a copy of this list</h2>
              <p className="text-xs text-text-muted">They get their own list to keep and change. Only the items go (names, amounts, stores, notes), never what you spent, your ticks or who you share with. Your list is not touched.</p>
              {acceptedUids.size === 0 ? (
                <p className="text-[11px] text-text-muted px-1">Add friends from the Friends page to send lists to them, or use the link below.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(Array.from(acceptedUids) as string[]).filter((uid) => uid !== user?.uid).map((uid) => {
                    const on = sendUids.includes(uid);
                    const f = usersByUid.get(uid);
                    return (
                      <button key={uid} type="button" onClick={() => setSendUids(on ? sendUids.filter((x) => x !== uid) : [...sendUids, uid])} className={clsx('pl-1.5 pr-3 py-1.5 rounded-xl text-xs font-black border flex items-center gap-1.5 max-w-full', on ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>
                        {f?.photoURL ? <img src={f.photoURL} alt="" className="w-5 h-5 rounded-full object-cover" referrerPolicy="no-referrer" /> : <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] flex items-center justify-center">{(f?.displayName || '?').slice(0, 1).toUpperCase()}</span>}
                        <span className="truncate">{f?.displayName || 'Friend'}</span>
                        {on && <span className="material-symbols-outlined text-[16px]">check</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <button type="button" onClick={handleSendToFriends} disabled={sending || sendUids.length === 0} className="w-full py-3 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 disabled:opacity-50">
                {sending ? 'Sending…' : sendUids.length > 0 ? `Send to ${sendUids.length} friend${sendUids.length === 1 ? '' : 's'}` : 'Choose a friend to send to'}
              </button>
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <p className="text-[11px] font-black text-slate-500 uppercase tracking-wider px-1">Or share a link (WhatsApp, anyone)</p>
                <button type="button" onClick={handleGetLink} disabled={sending} className="w-full py-3 rounded-2xl bg-[#0f7a8f] text-white text-sm font-black disabled:opacity-50 flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-[18px]">link</span>{sentLink ? 'Share the link again' : 'Get a link to share'}
                </button>
                {sentLink && <button type="button" onClick={handleTurnOffLink} className="w-full py-1.5 text-xs font-black text-rose-600">Turn this link off</button>}
                <p className="text-[10.5px] text-text-muted px-1">Anyone with the link can see the items and save their own copy. You can turn the link off.</p>
              </div>
              {sendNote && <p className="text-xs font-black text-[#0f7a8f] px-1">{sendNote}</p>}
              <button type="button" onClick={() => setShowSend(false)} className="w-full py-2 text-xs font-black text-slate-500">Close</button>
            </div>
          </div>
        </div>
      )}

      {showEdit && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setShowEdit(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleSaveEdit} className="bg-white rounded-3xl shadow-2xl px-4 pt-3 space-y-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
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

      {showShare && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setShowShare(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3 space-y-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-1" />
              <h2 className="text-base font-black text-primary">Share this list</h2>
              {isOwner && (
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider px-1">Share with</label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setShareGroupId('')} className={clsx('px-3 py-2 rounded-xl text-xs font-black border', shareGroupId === '' ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>🔒 Only me</button>
                    {myGroups.map((g: any) => (
                      <button key={g.id} type="button" onClick={() => setShareGroupId(g.id)} className={clsx('px-3 py-2 rounded-xl text-xs font-black border max-w-full truncate', shareGroupId === g.id ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>
                        {groupIconEmoji(g.icon)} {g.name}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-text-muted px-1">{shareGroupId ? 'Everyone in this group can see the list, add items and tick them off.' : shareFriendUids.length === 0 ? 'Only you can see this list.' : ''}</p>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider px-1 pt-2">Friends (along with the group, or on their own)</label>
                  {acceptedUids.size === 0 ? (
                    <p className="text-[11px] text-text-muted px-1">Add friends from the Friends page to share lists with them.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {(Array.from(acceptedUids) as string[]).map((uid) => {
                        const on = shareFriendUids.includes(uid);
                        const f = usersByUid.get(uid);
                        return (
                          <button key={uid} type="button" onClick={() => setShareFriendUids(on ? shareFriendUids.filter((x) => x !== uid) : [...shareFriendUids, uid])} className={clsx('pl-1.5 pr-3 py-1.5 rounded-xl text-xs font-black border flex items-center gap-1.5 max-w-full', on ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>
                            {f?.photoURL ? <img src={f.photoURL} alt="" className="w-5 h-5 rounded-full object-cover" referrerPolicy="no-referrer" /> : <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] flex items-center justify-center">{(f?.displayName || '?').slice(0, 1).toUpperCase()}</span>}
                            <span className="truncate">{f?.displayName || 'Friend'}</span>
                            {on && <span className="material-symbols-outlined text-[16px]">check</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {shareFriendUids.length > 0 && <p className="text-[11px] text-text-muted px-1">The friends you pick can see the list, add items and tick them off. They cannot delete it or change who it is shared with.</p>}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowShare(false)} className="flex-1 py-3 rounded-2xl font-black text-slate-500 border border-slate-200">{t('common.cancel')}</button>
                <button type="button" onClick={handleSaveShare} disabled={savingShare || (shareGroupId === (list.groupId || '') && shareFriendUids.length === sharedFriendUids.length && shareFriendUids.every((u) => sharedFriendUids.includes(u)))} className="flex-1 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50">{savingShare ? t('common.saving') : 'Save'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {renamingStore !== null && (
        <RenameStoreSheet
          store={renamingStore}
          existing={knownStores}
          onClose={() => setRenamingStore(null)}
          onRenamed={(oldName, newName) => {
            if (storeDraft === oldName) setStoreDraft(newName);
            if (filterStore === oldName) setFilterStore(newName);
            setViewingItem((prev: any) => (prev && prev.store === oldName ? { ...prev, store: newName } : prev));
          }}
        />
      )}

      {/* a store's category */}
      {catFor !== null && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setCatFor(null)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
              <h2 className="text-base font-black text-primary">{catFor ? `🏪 ${catFor}` : 'Items with no store'}</h2>
              <p className="text-[11px] text-text-muted mb-3">What kind of spending is this store? It is used when the spend is added to the group.</p>
              <div className="grid grid-cols-4 gap-2 max-h-60 overflow-y-auto">
                {spendCategories.map((c) => (
                  <button key={c.id} type="button" onClick={() => setSpendCat(c.id)} className={clsx('rounded-xl border-2 py-2 flex flex-col items-center gap-0.5 active:scale-95', spendCat === c.id ? 'border-[#0f7a8f] bg-teal-50' : 'border-transparent bg-slate-50')}>
                    <span className="text-xl leading-none">{c.icon}</span>
                    <span className="text-[10px] font-black text-slate-600 truncate w-full px-1">{categoryLabel(c)}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 pt-3">
                <button type="button" onClick={() => setCatFor(null)} className="flex-1 py-3 rounded-2xl font-black text-slate-500 border border-slate-200">{t('common.cancel')}</button>
                <button type="button" onClick={handleSaveCategory} disabled={savingSpend} className="flex-1 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50">{savingSpend ? t('common.saving') : 'Save category'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* what was spent at a store */}
      {spendFor !== null && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setSpendFor(null)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
              <h2 className="text-base font-black text-primary mb-3">{spendFor ? `🏪 ${spendFor}` : 'Items with no store'}</h2>
              <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1.5 px-0.5">Total spent here</p>
              <div className="flex items-center gap-1.5 rounded-2xl bg-slate-50 border-2 border-[#22c1a5] px-3 py-2">
                <span className="text-2xl font-black text-slate-400">{currencySymbol}</span>
                <input ref={spendInputRef} type="text" inputMode="decimal" value={spendAmount} onChange={(e) => setSpendAmount(e.target.value)} placeholder="0.00" autoFocus className="flex-1 min-w-0 bg-transparent text-2xl font-black text-primary outline-none" />
              </div>
              <div className="flex items-center gap-2 mt-2">
                {(['+', '-'] as const).map((op) => (
                  <button
                    key={op}
                    type="button"
                    onClick={() => {
                      setSpendAmount((cur) => {
                        const base = cur.trim();
                        if (!base) return cur;
                        return /[+-]$/.test(base) ? base.slice(0, -1) + op : base + op;
                      });
                      spendInputRef.current?.focus();
                    }}
                    disabled={!spendAmount.trim()}
                    className={clsx('flex-1 py-2.5 rounded-xl border-2 text-sm font-black active:scale-95 disabled:opacity-40', op === '+' ? 'border-green-300 bg-green-50 text-green-700' : 'border-rose-300 bg-rose-50 text-rose-700')}
                  >
                    {op === '+' ? '＋ Add more' : '－ Take off'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-text-muted mt-1.5 px-0.5">Tap {'＋'} or {'－'} after the amount to add to it or take from it, for example 80+25 or 80-10.</p>
              {hasAmountSumOperator(spendAmount) && evaluateAmountSum(spendAmount) !== null && <p className="text-xs font-black text-green-700 px-1 mt-1">= {currencySymbol}{evaluateAmountSum(spendAmount)!.toFixed(2)}</p>}
              <p className="text-[11px] text-text-muted mt-2 px-0.5">Saved with the list. When you finish, the spend from every store adds up to the total for the group.</p>
              <div className="flex gap-2 pt-3">
                <button type="button" onClick={() => setSpendFor(null)} className="flex-1 py-3 rounded-2xl font-black text-slate-500 border border-slate-200">{t('common.cancel')}</button>
                <button type="button" onClick={handleSaveSpend} disabled={savingSpend} className="flex-1 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50">{savingSpend ? t('common.saving') : 'Save spend'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* finish shopping: a shared list adds one expense to the group; a personal list is just marked done */}
      {showFinish && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={() => setShowFinish(false)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={list.groupId ? handleCompleteWithExpense : (e) => { e.preventDefault(); handleCompletePersonal(); }} className="bg-white rounded-3xl shadow-2xl px-4 pt-3" style={{ paddingBottom: '1.25rem', maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', overflowY: 'auto' }}>
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
                    {/* the phone's number keyboard has no plus key, so adding several bills together needs its own button */}
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setCompleteAmount((v) => (v && !/[+\-*/]$/.test(v) ? `${v}+` : v))} aria-label="Add another amount" className="shrink-0 w-10 h-10 rounded-xl bg-[#22c1a5]/15 text-[#0f7a8f] flex items-center justify-center active:scale-90">
                      <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'wght' 700" }}>add</span>
                    </button>
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
              {notAvailable.length > 0 && (
                <button type="button" onClick={() => setCarryNotAvailable((v) => !v)} className="mt-3 w-full flex items-center gap-2.5 text-left">
                  <span className={clsx('w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0', carryNotAvailable ? 'bg-[#0f7a8f] border-[#0f7a8f] text-white' : 'border-slate-300')}>
                    {carryNotAvailable && <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>}
                  </span>
                  <span className="text-xs font-bold text-slate-600">Add the {notAvailable.length} not-available item{notAvailable.length === 1 ? '' : 's'} to a new list to buy later</span>
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
        const itemDirty = notesDraft !== (viewingItem.notes || '') || nameDraft.trim() !== viewingItem.text || qtyDraft !== (viewingItem.qty != null ? String(viewingItem.qty) : '') || unitDraft !== (viewingItem.unit || '') || storeDraft !== (viewingItem.store || '') || freqDraft !== (profile?.shoppingRecurring?.[recKey(viewingItem.text || '')]?.freq || '');
        return (
          <DetailSheet
            title={t('shoppingLists.itemDetailTitle')}
            aboveNav
            onClose={() => setViewingItem(null)}
            onDelete={() => { const it = viewingItem; setViewingItem(null); handleDeleteItem(it); }}
            deleteInHeader
            onDone={async () => { if (itemDirty && nameDraft.trim()) await handleSaveItem(viewingItem); setViewingItem(null); }}
          >
            <DetailField label={t('shoppingLists.item')}>
              <div className="flex items-center gap-2">
                <span className="text-xl shrink-0">{itemIcon(nameDraft || viewingItem.text)}</span>
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={200}
                  className="flex-1 min-w-0 bg-surface p-2.5 rounded-lg border border-border-subtle text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </DetailField>
            {/* the decision for this item, up front: big, coloured, one tap */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleSetItemStatus(viewingItem, 'bought')}
                className={clsx(
                  'h-14 rounded-2xl border-2 font-black text-sm flex items-center justify-center gap-2 active:scale-95 transition-all',
                  status === 'bought' ? 'bg-green-600 border-green-600 text-white shadow-md shadow-green-600/30' : 'bg-green-50 border-green-300 text-green-700',
                )}
              >
                <span className="material-symbols-outlined text-[24px]" style={{ fontVariationSettings: `'FILL' ${status === 'bought' ? 1 : 0}` }}>check_circle</span>
                {status === 'bought' ? 'Bought' : 'Mark bought'}
              </button>
              <button
                type="button"
                onClick={() => handleSetItemStatus(viewingItem, 'unavailable')}
                className={clsx(
                  'h-14 rounded-2xl border-2 font-black text-sm flex items-center justify-center gap-2 active:scale-95 transition-all',
                  status === 'unavailable' ? 'bg-rose-600 border-rose-600 text-white shadow-md shadow-rose-600/30' : 'bg-rose-50 border-rose-300 text-rose-700',
                )}
              >
                <span className="material-symbols-outlined text-[24px]" style={{ fontVariationSettings: `'FILL' ${status === 'unavailable' ? 1 : 0}` }}>remove_shopping_cart</span>
                Not available
              </button>
            </div>
            <DetailField label="Quantity">
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {QTY_PRESETS.map(([q, u]) => (
                    <button
                      key={`${q}${u}`}
                      type="button"
                      onClick={() => { setQtyDraft(q); setUnitDraft(u); }}
                      className={clsx('px-2.5 py-1 rounded-lg text-xs font-bold border transition-all', qtyDraft === q && unitDraft === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                    >
                      {q} {u}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={qtyDraft}
                    onChange={(e) => setQtyDraft(e.target.value)}
                    placeholder="Qty"
                    className="w-20 shrink-0 bg-surface p-2.5 rounded-lg border border-border-subtle text-sm font-bold text-center outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {UNIT_CHOICES.map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setUnitDraft(unitDraft === u ? '' : u)}
                        className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all', unitDraft === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </DetailField>
            <DetailField label="Store">
              <div className="space-y-2">
                <p className="text-[10.5px] text-slate-400 font-normal normal-case">Hold a store to rename it.</p>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(new Set<string>([...knownStores, ...STARTER_STORES, ...(storeDraft ? [storeDraft] : [])])).map((st) => (
                    <StoreChip key={st} name={st} selected={storeDraft === st} onSelect={() => setStoreDraft(storeDraft === st ? '' : st)} onLongPress={() => setRenamingStore(st)} className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all', storeDraft === st ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')} />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newStoreText}
                    onChange={(e) => setNewStoreText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newStoreText.trim()) { e.preventDefault(); setStoreDraft(newStoreText.trim().slice(0, 40)); setNewStoreText(''); } }}
                    placeholder="Another store…"
                    maxLength={40}
                    className="flex-1 min-w-0 bg-surface p-2.5 rounded-lg border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <button type="button" disabled={!newStoreText.trim()} onClick={() => { setStoreDraft(newStoreText.trim().slice(0, 40)); setNewStoreText(''); }} className="shrink-0 px-3 py-2.5 rounded-lg bg-primary text-white text-xs font-black disabled:opacity-40">Use</button>
                </div>
              </div>
            </DetailField>
            <DetailField label="Repeats">
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {FREQ_OPTIONS.map((o) => (
                    <button key={o.id || 'never'} type="button" onClick={() => setFreqDraft(o.id)} className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all', freqDraft === o.id ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>
                      {o.id ? `🔁 ${o.label}` : o.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-text-muted">{freqDraft ? (hasRoutine ? `Goes into ${group?.name ? `the ${group.name}` : 'your'} weekly list automatically.` : `Saved. Set up a weekly routine for ${group?.name || 'your personal shopping'} under Weekly routines on the Shopping Lists page so it is listed for you.`) : 'Choose how often you buy this and it will be listed for you.'}</p>
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
