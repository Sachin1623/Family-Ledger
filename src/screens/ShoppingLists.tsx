import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc, writeBatch, doc, setDoc } from 'firebase/firestore';
import { useLiveQuery } from '../lib/liveCache';
import { clsx } from 'clsx';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { EXPENSE_CATEGORIES, getGroupCategories, getCategoryIcon, getCurrencySymbol } from '../lib/constants';
import { groupIconEmoji } from '../lib/groupIcons';
import { listIconGuess, LIST_EMOJI_CHOICES } from '../lib/shoppingIcons';
import { useLanguage } from '../context/LanguageContext';
import { usePageFabAction } from '../context/FabActionContext';
import { backfillHistory, historyKey, suggestFromHistory } from '../lib/shoppingHistory';
import ShoppingRoutineSheet from '../components/ShoppingRoutineSheet';
import { getRoutines, migrateLegacyShopping, syncShoppingReminders } from '../lib/shoppingRoutine';

// Local YYYY-MM-DD, and a day offset from it (same helpers the to-do sheet uses)
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (dateStr: string, n: number) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateOnly(d);
};
const comingSaturday = (todayStr: string) => addDays(todayStr, (6 - new Date(`${todayStr}T00:00:00`).getDay() + 7) % 7);

// the four categories most shopping lists are for; "More" opens every category (including a group's own)
const QUICK_CATEGORY_IDS = ['groceries', 'household', 'health', 'shopping'];

// soft tile colours, picked from the category so the same kind of list always looks the same
const TILE_TINTS = ['#dcfce7', '#e0e7ff', '#ffe4e6', '#fef3c7', '#fae8ff', '#e0f2fe', '#ffedd5'];
export const tileTint = (category?: string) => TILE_TINTS[Array.from(category || '').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % TILE_TINTS.length];

export default function ShoppingLists() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showForm, setShowForm] = useState(false);
  // ?new=1 (from the home-page icon when there is no list yet) opens the new-list sheet right away. It reacts to the param itself, not only on mount,
  // because this screen can already be showing when the link is followed.
  useEffect(() => {
    if (searchParams.get('new')) {
      setShowForm(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  // Global floating "+" button (Navigation.tsx) becomes "New List" here instead of the default
  // "Add Expense" — see FabActionContext.tsx.
  usePageFabAction('🛒', t('shoppingLists.newList'), () => setShowForm(true));
  const [tab, setTab] = useState<'active' | 'done'>('active');
  const [title, setTitle] = useState('');
  // set when Create is tapped without a list name, so the name box can say why nothing happened
  const [titleError, setTitleError] = useState(false);
  const titleBoxRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('groceries');
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [pickedIcon, setPickedIcon] = useState<string | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [showRoutine, setShowRoutine] = useState(false);
  const defaultApplied = useRef(false);
  const [dateInput, setDateInput] = useState('');
  const [timeInput, setTimeInput] = useState('10:00');
  const [showPickDate, setShowPickDate] = useState(false);
  const [itemsText, setItemsText] = useState('');
  // suggestions ticked in the new-list sheet, by item key
  const [pickedItems, setPickedItems] = useState<Record<string, { name: string; qty: number | null; unit: string | null; store: string | null }>>({});
  const [saving, setSaving] = useState(false);

  const [membershipsValue] = useLiveQuery(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useLiveQuery(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];
  const selectedGroup = groups.find((g: any) => g.id === groupId);

  const [allMembersValue] = useLiveQuery(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  const [myListsValue, myLoading, myError] = useLiveQuery(
    user ? query(collection(db, 'shoppingLists'), where('userId', '==', user.uid)) : null,
  );
  const [sharedListsValue] = useLiveQuery(
    groupIds.length > 0 ? query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)) : null,
  );
  const listsById = new Map<string, any>();
  myListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  sharedListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  const lists = Array.from(listsById.values()).sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  // A new list starts shared with the group the person chose last time ("Just me" if they chose that), once their groups are loaded.
  useEffect(() => {
    if (!showForm) { defaultApplied.current = false; return; }
    if (defaultApplied.current || groups.length === 0) return;
    defaultApplied.current = true;
    const preferred = profile?.shoppingDefaultGroupId;
    if (preferred && groups.some((g: any) => g.id === preferred)) setGroupId(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, groups.length, profile?.shoppingDefaultGroupId]);

  // The earlier single routine becomes the routine of the group it was for, once.
  const migrated = useRef(false);
  useEffect(() => {
    if (!user || !profile || migrated.current) return;
    migrated.current = true;
    migrateLegacyShopping(user.uid, profile).catch((err) => console.error('shopping routine migration failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, !!profile]);

  // Make sure this phone has the reminders the saved routines ask for (a new phone, a reinstall), once per visit to this page.
  const reminderSynced = useRef(false);
  useEffect(() => {
    if (!profile?.shoppingRoutines || reminderSynced.current) return;
    if (groupIds.length > 0 && groups.length === 0) return; // wait for the group names
    reminderSynced.current = true;
    syncShoppingReminders(getRoutines(profile), (key) => (key === 'me' ? 'Just me' : groups.find((g: any) => g.id === key)?.name || 'shopping'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.shoppingRoutines, groups.length]);

  // First visit after this feature arrived: learn what the person has bought from their recent lists, once.
  const backfillStarted = useRef(false);
  useEffect(() => {
    if (!user || !profile || myLoading || backfillStarted.current || profile.shoppingHistoryBackfilled) return;
    backfillStarted.current = true;
    backfillHistory(user.uid, lists).catch((err) => console.error('shopping history backfill failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, profile?.shoppingHistoryBackfilled, myLoading, lists.length]);

  // ---------- the lists page ----------
  const todayStr = toDateOnly(new Date());
  const activeLists = lists.filter((l: any) => !l.completed);
  const doneLists = lists.filter((l: any) => l.completed);
  const hasCounts = (l: any) => typeof l.itemCount === 'number';
  const itemsLeft = activeLists.reduce((sum: number, l: any) => sum + (hasCounts(l) ? Math.max(0, l.itemCount - (l.doneCount || 0)) : 0), 0);
  const isLate = (l: any) => !!l.scheduledAt && !l.completed && new Date(l.scheduledAt) < new Date();
  const byScheduled = (a: any, b: any) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9') || (b.createdAt || '').localeCompare(a.createdAt || '');
  const needsAttention = activeLists.filter(isLate).sort(byScheduled);
  const comingUp = activeLists.filter((l: any) => !isLate(l)).sort(byScheduled);

  const whenPill = (list: any) => {
    if (!list.scheduledAt) return null;
    const at = new Date(list.scheduledAt);
    const day = toDateOnly(at);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (list.completed) return null;
    if (at < new Date()) return { text: day === todayStr ? `Today ${time} passed` : 'Overdue', cls: 'bg-rose-100 text-rose-700' };
    if (day === todayStr) return { text: `Today ${time}`, cls: 'bg-amber-100 text-amber-800' };
    if (day === addDays(todayStr, 1)) return { text: `Tomorrow ${time}`, cls: 'bg-sky-100 text-sky-800' };
    return { text: at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), cls: 'bg-sky-100 text-sky-800' };
  };

  const listIcon = (list: any) => {
    const catGroup = groups.find((g: any) => g.id === list.groupId);
    return list.icon || listIconGuess(list.title) || getCategoryIcon(catGroup, list.category, 'expense') || '🛒';
  };

  const renderList = (list: any) => {
    const group = groups.find((g: any) => g.id === list.groupId);
    const creator = allMembers.find((m: any) => m.userId === list.userId);
    const when = whenPill(list);
    const total = hasCounts(list) ? list.itemCount : null;
    const done = list.doneCount || 0;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <div
        key={list.id}
        onClick={() => navigate(`/shopping-lists/${list.id}`)}
        className={clsx('bg-white rounded-2xl p-3 cursor-pointer shadow-[0_2px_8px_rgba(30,58,95,0.09)] active:scale-[0.99] transition-all', list.completed && 'opacity-70')}
      >
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-[22px] shrink-0" style={{ background: list.completed ? '#dcfce7' : tileTint(list.category) }}>
            {list.completed ? '✅' : listIcon(list)}
          </span>
          <div className="min-w-0 flex-1">
            <p className={clsx('text-sm font-black truncate', list.completed ? 'text-text-muted line-through' : 'text-primary')}>{list.title}</p>
            <p className="text-[11px] text-text-muted truncate flex items-center gap-1.5">
              {group ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-sky-50 text-sky-800 px-1.5 py-px text-[10px] font-bold shrink-0">
                  {group.photoURL ? <img src={group.photoURL} alt="" className="w-3.5 h-3.5 rounded-sm object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(group.icon)}</span>}{group.name}
                </span>
              ) : <span>🔒 {t('shoppingLists.personal')}</span>}
              {group && list.userId !== user?.uid && <span className="truncate">· {creator?.displayName || t('todo.aMember')}</span>}
            </p>
          </div>
          <span className="material-symbols-outlined text-slate-300">chevron_right</span>
        </div>
        {total !== null && !list.completed && (
          <div className="h-1.5 rounded-full bg-slate-200/80 mt-2.5 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-green-600 to-green-400" style={{ width: `${pct}%` }} /></div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {total !== null && !list.completed && (
            <span className="rounded-lg bg-sky-100 text-sky-800 px-2 py-0.5 text-[10px] font-black">{total === 0 ? 'No items yet' : `${done} of ${total} done`}</span>
          )}
          {list.completed && typeof list.totalExpense === 'number' && (
            <span className="rounded-lg bg-green-100 text-green-800 px-2 py-0.5 text-[10px] font-black">
              Spent {getCurrencySymbol(group?.currency)}{list.totalExpense.toLocaleString()}{group ? ` · added to ${group.name}` : ''}
            </span>
          )}
          {list.completed && list.completedAt && <span className="rounded-lg bg-slate-100 text-slate-600 px-2 py-0.5 text-[10px] font-black">{new Date(list.completedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
          {when && <span className={clsx('rounded-lg px-2 py-0.5 text-[10px] font-black', when.cls)}>{when.text}</span>}
        </div>
      </div>
    );
  };

  const section = (key: string, label: string, list: any[], tone?: 'red') => list.length === 0 ? null : (
    <div key={key} className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className={clsx('text-[11px] font-black uppercase tracking-[0.12em]', tone === 'red' ? 'text-rose-600' : 'text-slate-500')}>{label}</h2>
        <span className={clsx('text-[11px] font-black rounded-full px-2 py-px', tone === 'red' ? 'bg-rose-100 text-rose-700' : 'bg-slate-200/70 text-slate-600')}>{list.length}</span>
      </div>
      <div className="space-y-2">{list.map(renderList)}</div>
    </div>
  );

  // ---------- the new-list sheet ----------
  const resetForm = () => {
    setTitle('');
    setTitleError(false);
    setCategory('groceries');
    setShowAllCategories(false);
    setPickedIcon(null);
    setShowIconPicker(false);
    setGroupId('');
    setShowGroupMenu(false);
    setDateInput('');
    setTimeInput('10:00');
    setShowPickDate(false);
    setItemsText('');
    setPickedItems({});
    setShowForm(false);
  };

  const categories = getGroupCategories(selectedGroup, 'expense');
  const categoryName = (c: { id: string; name: string }) => (c.id.startsWith('custom_') ? c.name : t(`category.${c.id}`));
  const chosenCategory = categories.find((c) => c.id === category) || categories.find((c) => c.id === 'misc') || EXPENSE_CATEGORIES[0];
  // the quick row, with a category picked from "More" taking the last slot so the choice stays visible
  const quick = QUICK_CATEGORY_IDS.map((id) => categories.find((c) => c.id === id)).filter(Boolean) as typeof categories;
  const quickRow = quick.some((c) => c.id === chosenCategory.id) ? quick : [...quick.slice(0, 3), chosenCategory];
  const newListIcon = pickedIcon || listIconGuess(title) || chosenCategory.icon;
  const dayKey = !dateInput ? 'none' : dateInput === todayStr ? 'today' : dateInput === addDays(todayStr, 1) ? 'tomorrow' : dateInput === comingSaturday(todayStr) ? 'weekend' : 'pick';
  const itemLines = itemsText.split(/\r?\n/).map((l) => l.trim().slice(0, 200)).filter(Boolean).slice(0, 100);
  // ticked suggestions first, then the typed lines (a typed line that repeats a ticked item is dropped)
  const pickedList = (Object.keys(pickedItems) as string[]).map((key) => ({ key, ...pickedItems[key] }));
  const newItems: { text: string; qty?: number; unit?: string; store?: string }[] = [
    ...pickedList.map((p) => ({ text: p.name, ...(p.qty != null ? { qty: p.qty } : {}), ...(p.unit ? { unit: p.unit } : {}), ...(p.store ? { store: p.store } : {}) })),
    ...itemLines.filter((l) => !pickedItems[historyKey(l)]).map((text) => ({ text })),
  ];
  const typedKeys = useMemo(() => new Set(itemLines.map(historyKey)), [itemsText]);
  const suggestions = useMemo(() => suggestFromHistory(profile?.shoppingHistory, typedKeys, 10), [profile?.shoppingHistory, typedKeys]);
  const togglePick = (sg: { key: string; name: string; qty: number | null; unit: string | null; store: string | null }) => setPickedItems((cur) => {
    const next = { ...cur };
    if (next[sg.key]) delete next[sg.key]; else next[sg.key] = { name: sg.name, qty: sg.qty, unit: sg.unit, store: sg.store };
    return next;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!user) return;
    if (!trimmed) {
      setTitleError(true);
      titleBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      titleInputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      const scheduledAt = dateInput ? new Date(`${dateInput}T${timeInput || '10:00'}`).toISOString() : null;
      const docRef = await addDoc(collection(db, 'shoppingLists'), {
        userId: user.uid,
        title: trimmed,
        // what the group expense is called when this list is finished: the list's own name
        description: trimmed,
        category: chosenCategory.id,
        ...(pickedIcon ? { icon: pickedIcon } : {}),
        groupId: groupId || null,
        scheduledAt,
        completed: false,
        itemCount: newItems.length,
        doneCount: 0,
        createdAt: new Date().toISOString(),
      });
      // items go in after the list exists (their security rule looks up the list)
      if (newItems.length > 0) {
        const batch = writeBatch(db);
        const now = Date.now();
        newItems.forEach((item, i) => {
          batch.set(doc(collection(db, 'shoppingLists', docRef.id, 'items')), { ...item, status: 'pending', addedBy: user.uid, createdAt: new Date(now + i).toISOString() });
        });
        await batch.commit();
      }
      if (groupId) {
        notifyGroupActivity({
          groupId,
          action: 'shopping_list_created',
          description: trimmed,
          contextLabel: scheduledAt ? new Date(scheduledAt).toLocaleString() : undefined,
          actorName: profile?.displayName || user.displayName || 'Someone',
          listId: docRef.id,
        });
      }
      resetForm();
      navigate(`/shopping-lists/${docRef.id}`);
    } catch (err) {
      console.error('Failed to create shopping list:', err);
      alert(t('shoppingLists.failedToCreate'));
    } finally {
      setSaving(false);
    }
  };

  const chip = (on: boolean) => clsx(
    'rounded-full px-3.5 py-1.5 text-xs font-black border transition-all active:scale-95',
    on ? 'text-white border-transparent shadow-sm bg-gradient-to-r from-[#0f7a8f] to-[#22c1a5]' : 'bg-white text-slate-600 border-slate-200',
  );
  const cap = (label: string) => <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mt-4 mb-1.5 px-0.5">{label}</p>;
  const catTile = (c: { id: string; name: string; icon: string }) => (
    <button key={c.id} type="button" onClick={() => { setCategory(c.id); }} className={clsx('rounded-2xl py-2 px-1 text-center border-2 transition-all active:scale-95', chosenCategory.id === c.id ? 'border-[#22c1a5] bg-emerald-50 text-[#0b6b59]' : 'border-transparent bg-slate-50 text-slate-600')}>
      <span className="block text-[20px] leading-tight">{c.icon}</span>
      <span className="block text-[10px] font-black truncate">{categoryName(c)}</span>
    </button>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        {/* the lists at a glance */}
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-black leading-tight">{t('tools.shoppingLists')}</h1>
              <p className="text-[12px] text-white/85 mt-0.5">
                {activeLists.length === 0 ? 'Nothing to buy right now' : `${activeLists.length} active${itemsLeft > 0 ? ` · ${itemsLeft} item${itemsLeft === 1 ? '' : 's'} left to buy` : ''}`}
              </p>
            </div>
            <button type="button" data-tour="shopping-add" onClick={() => setShowForm(true)} title={t('shoppingLists.newList')} className="shrink-0 w-10 h-10 rounded-full bg-white text-[#0f7a8f] flex items-center justify-center shadow-md active:scale-95">
              <span className="material-symbols-outlined text-[22px]">add_shopping_cart</span>
            </button>
          </div>
          <div className="flex bg-white/15 rounded-xl p-1 mt-3">
            {([['active', `Active ${activeLists.length}`], ['done', `Done ${doneLists.length}`]] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={clsx('flex-1 rounded-lg py-1.5 text-xs font-black transition-all', tab === id ? 'bg-white text-[#0b3b57]' : 'text-white/90')}>{label}</button>
            ))}
          </div>
        </div>

        {/* the weekly routine: day, time and the items that repeat */}
        <button type="button" onClick={() => setShowRoutine(true)} className="w-full rounded-2xl bg-white shadow-[0_2px_8px_rgba(30,58,95,0.09)] p-3 flex items-center gap-3 text-left active:scale-[0.99] transition-all">
          <span className="w-11 h-11 rounded-xl bg-teal-50 flex items-center justify-center text-[22px] shrink-0">🔁</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-black text-primary">Weekly routines</span>
            <span className="block text-[11px] text-text-muted truncate">
              {(() => {
                const on = Object.values(getRoutines(profile)).filter((r) => r?.enabled).length;
                const items = Object.keys(profile?.shoppingRecurring || {}).length;
                return on > 0 ? `${on} routine${on === 1 ? '' : 's'} on · ${items} repeating item${items === 1 ? '' : 's'}` : 'Have a list made for each group every week';
              })()}
            </span>
          </span>
          <span className="material-symbols-outlined text-slate-300">chevron_right</span>
        </button>

        <section className="space-y-4">
          {myLoading && <div className="space-y-3" aria-hidden><div className="h-16 rounded-2xl bg-border-subtle/50 animate-pulse" /><div className="h-16 rounded-2xl bg-border-subtle/50 animate-pulse" /></div>}
          {myError && (
            <p className="text-sm text-error px-1">{t('shoppingLists.couldntLoad', { error: (myError as any).code || myError.message })}</p>
          )}
          {!myLoading && !myError && lists.length === 0 && (
            <div className="rounded-2xl bg-white p-6 text-center shadow-[0_2px_8px_rgba(30,58,95,0.09)]">
              <p className="text-4xl">🛒</p>
              <p className="text-sm font-black text-primary mt-2">{t('shoppingLists.noListsYet')}</p>
              <p className="text-xs text-text-muted mt-1">Make a list, share it with your family, and tick things off as you shop.</p>
              <button type="button" onClick={() => setShowForm(true)} className="mt-4 px-5 py-2.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 active:scale-95">{t('shoppingLists.newList')}</button>
            </div>
          )}
          {tab === 'active' ? (
            <>
              {section('attention', 'Needs attention', needsAttention, 'red')}
              {section('coming', needsAttention.length > 0 ? 'Coming up' : 'Your lists', comingUp)}
              {!myLoading && lists.length > 0 && activeLists.length === 0 && <p className="text-sm text-text-muted italic px-1">All your lists are done.</p>}
            </>
          ) : (
            <>
              {section('done', 'Finished', doneLists)}
              {!myLoading && doneLists.length === 0 && <p className="text-sm text-text-muted italic px-1">No finished lists yet.</p>}
            </>
          )}
        </section>
      </main>

      {showRoutine && <ShoppingRoutineSheet groups={groups.map((g: any) => ({ id: g.id, name: g.name, icon: g.icon, photoURL: g.photoURL }))} onClose={() => setShowRoutine(false)} onOpenList={(id) => { setShowRoutine(false); navigate(`/shopping-lists/${id}`); }} />}

      {showForm && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={resetForm}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleCreate} className="bg-white rounded-3xl shadow-2xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', paddingBottom: '1.25rem' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-black text-primary">{t('shoppingLists.newList')}</h2>
                <button type="button" onClick={resetForm} className="text-xs font-black text-[#0f7a8f]">{t('common.cancel')}</button>
              </div>

              {/* the name; the icon beside it follows the name, or tap it to choose your own */}
              <div ref={titleBoxRef} className={clsx('flex items-center gap-3 rounded-2xl p-2.5 border-2 transition-colors', titleError ? 'bg-rose-50 border-rose-500' : 'bg-slate-50 border-[#22c1a5]')}>
                <button type="button" onClick={() => setShowIconPicker((v) => !v)} title="Change the icon" className="relative w-11 h-11 rounded-xl flex items-center justify-center text-[22px] shrink-0 active:scale-95" style={{ background: tileTint(chosenCategory.id) }}>
                  {newListIcon}
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-white border border-slate-200 flex items-center justify-center"><span className="material-symbols-outlined text-[11px] text-slate-500">edit</span></span>
                </button>
                <input
                  type="text"
                  value={title}
                  ref={titleInputRef}
                  onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
                  placeholder={t('shoppingLists.listNamePlaceholder')}
                  maxLength={150}
                  autoFocus
                  className="flex-1 min-w-0 bg-transparent text-[15px] font-bold text-primary outline-none placeholder:text-slate-400 placeholder:font-medium"
                />
              </div>
              {titleError && <p className="mt-1.5 px-1 text-xs font-black text-rose-600 flex items-center gap-1"><span className="material-symbols-outlined text-[15px]">error</span>Give your list a name to create it</p>}
              {showIconPicker && (
                <div className="mt-2 rounded-2xl bg-slate-50 p-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {LIST_EMOJI_CHOICES.map((em) => (
                      <button key={em} type="button" onClick={() => { setPickedIcon(em); setShowIconPicker(false); }} className={clsx('w-9 h-9 rounded-xl text-[20px] flex items-center justify-center active:scale-90', pickedIcon === em ? 'bg-white ring-2 ring-[#22c1a5]' : 'bg-white/70')}>{em}</button>
                    ))}
                  </div>
                  {pickedIcon && <button type="button" onClick={() => { setPickedIcon(null); setShowIconPicker(false); }} className="mt-2 text-[11px] font-black text-[#0f7a8f]">Use the automatic icon</button>}
                </div>
              )}

              {cap('What is it for?')}
              <div className="grid grid-cols-5 gap-1.5">
                {quickRow.map(catTile)}
                <button type="button" onClick={() => setShowAllCategories((v) => !v)} className={clsx('rounded-2xl py-2 px-1 text-center border-2 transition-all active:scale-95', showAllCategories ? 'border-[#22c1a5] bg-emerald-50 text-[#0b6b59]' : 'border-transparent bg-slate-50 text-slate-600')}>
                  <span className="block text-[20px] leading-tight">⋯</span>
                  <span className="block text-[10px] font-black">More</span>
                </button>
              </div>
              {showAllCategories && (
                <div className="mt-2 rounded-2xl bg-slate-50 p-2">
                  <div className="grid grid-cols-4 gap-1.5">{categories.filter((c) => !quickRow.some((q) => q.id === c.id)).map(catTile)}</div>
                  <p className="text-[10.5px] text-slate-500 mt-2 px-1">Nothing fits? Choose <b>Other</b>. The category only labels the expense when you finish shopping with a group.</p>
                </div>
              )}

              {cap('When are you going?')}
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chip(dayKey === 'today')} onClick={() => { setDateInput(todayStr); setShowPickDate(false); }}>Today</button>
                <button type="button" className={chip(dayKey === 'tomorrow')} onClick={() => { setDateInput(addDays(todayStr, 1)); setShowPickDate(false); }}>Tomorrow</button>
                <button type="button" className={chip(dayKey === 'weekend')} onClick={() => { setDateInput(comingSaturday(todayStr)); setShowPickDate(false); }}>Weekend</button>
                <button type="button" className={chip(dayKey === 'pick' || showPickDate)} onClick={() => setShowPickDate((v) => !v)}>📅 {dayKey === 'pick' ? new Date(`${dateInput}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'Pick'}</button>
                <button type="button" className={chip(dayKey === 'none')} onClick={() => { setDateInput(''); setShowPickDate(false); }}>No date</button>
              </div>
              {showPickDate && (
                <input type="date" value={dateInput} onChange={(e) => { setDateInput(e.target.value); if (e.target.value) setShowPickDate(false); }} className="mt-2 w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
              )}
              {dateInput && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs font-bold text-slate-600">At</span>
                  <input type="time" value={timeInput} onChange={(e) => setTimeInput(e.target.value)} className="bg-slate-50 px-3 py-2 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                </div>
              )}

              {groups.length > 0 && (
                <>
                  {cap('Who sees it')}
                  {(() => {
                    const defaultId = profile?.shoppingDefaultGroupId || '';
                    const groupIcon = (g: any) => (g.photoURL ? <img src={g.photoURL} alt="" className="w-5 h-5 rounded-md object-cover shrink-0" referrerPolicy="no-referrer" /> : <span className="text-base leading-none shrink-0">{groupIconEmoji(g.icon)}</span>);
                    const row = (id: string, icon: React.ReactNode, name: string) => (
                      <button key={id || 'me'} type="button" onClick={() => { setGroupId(id); setShowGroupMenu(false); }} className={clsx('w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold active:bg-slate-100', groupId === id ? 'bg-teal-50 text-[#0f7a8f]' : 'text-slate-700')}>
                        {icon}
                        <span className="flex-1 truncate">{name}</span>
                        {defaultId === id && <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Default</span>}
                        {groupId === id && <span className="material-symbols-outlined text-[18px]">check</span>}
                      </button>
                    );
                    return (
                      <>
                      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                        <button type="button" onClick={() => setShowGroupMenu((v) => !v)} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm font-black text-primary">
                          {selectedGroup ? groupIcon(selectedGroup) : <span className="text-base leading-none">🔒</span>}
                          <span className="flex-1 truncate">{selectedGroup ? selectedGroup.name : t('todo.justMe')}</span>
                          <span className="material-symbols-outlined text-slate-400 transition-transform" style={{ transform: showGroupMenu ? 'rotate(180deg)' : 'none' }}>expand_more</span>
                        </button>
                        {showGroupMenu && (
                          <div className="border-t border-slate-100 max-h-56 overflow-y-auto divide-y divide-slate-50">
                            {row('', <span className="text-base leading-none">🔒</span>, t('todo.justMe'))}
                            {groups.map((g: any) => row(g.id, groupIcon(g), g.name))}
                          </div>
                        )}
                      </div>
                      {groupId === defaultId ? (
                        <p className="mt-1.5 px-0.5 text-[11px] font-black text-[#0f7a8f] flex items-center gap-1"><span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>New lists start with this</p>
                      ) : (
                        <button type="button" onClick={() => { if (user) setDoc(doc(db, 'users', user.uid), { shoppingDefaultGroupId: groupId || '' }, { merge: true }).catch((err) => console.error('default share choice failed:', err)); }} className="mt-1.5 px-0.5 text-[11px] font-black text-[#0f7a8f] flex items-center gap-1 active:opacity-60">
                          <span className="material-symbols-outlined text-[15px]">star</span>Make this the default for new lists
                        </button>
                      )}
                      </>
                    );
                  })()}
                  {groupId && <p className="text-[10.5px] text-slate-500 mt-1.5 px-0.5">{t('shoppingLists.sharingHelp')}</p>}
                </>
              )}

              {suggestions.length > 0 && (
                <>
                  {cap('From what you bought before')}
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((sg) => {
                      const on = !!pickedItems[sg.key];
                      const amount = [sg.qty != null ? String(sg.qty) : '', sg.unit || ''].filter(Boolean).join(' ');
                      return (
                        <button key={sg.key} type="button" onClick={() => togglePick(sg)} className={clsx('rounded-full px-3 py-1.5 text-xs font-black border transition-all active:scale-95 flex items-center gap-1', on ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-700 border-slate-200')}>
                          {on ? '✓' : '+'} {sg.name}
                          {amount && <span className={clsx('font-bold', on ? 'text-white/80' : 'text-[#0f7a8f]')}>{amount}</span>}
                          {sg.due && !on && <span className="w-1.5 h-1.5 rounded-full bg-orange-500" title="Probably due again" />}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10.5px] text-slate-500 mt-1 px-0.5">Tap to add. The amount is what you bought last time; an orange dot means it is probably due again.</p>
                </>
              )}

              {cap('Add items now (optional)')}
              <textarea
                value={itemsText}
                onChange={(e) => setItemsText(e.target.value)}
                rows={4}
                placeholder={'Milk\nEggs, 12\nWhole wheat atta 5kg'}
                className="w-full bg-slate-50 p-3 rounded-xl border-2 border-dashed border-slate-300 text-sm font-medium outline-none focus:border-[#22c1a5] resize-none"
              />
              <p className="text-[10.5px] text-slate-500 mt-1 px-0.5">One item per line, or paste a whole list.</p>

              <button type="submit" disabled={saving} className="w-full mt-4 py-3.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">
                {saving ? t('shoppingLists.creating') : newItems.length > 0 ? `Create list · ${newItems.length} item${newItems.length === 1 ? '' : 's'}` : t('shoppingLists.create')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
