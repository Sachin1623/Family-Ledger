import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc, writeBatch, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { EXPENSE_CATEGORIES, getGroupCategories, getCategoryIcon } from '../lib/constants';
import { groupIconEmoji } from '../lib/groupIcons';
import { listIconGuess, LIST_EMOJI_CHOICES } from '../lib/shoppingIcons';
import { useLanguage } from '../context/LanguageContext';
import { usePageFabAction } from '../context/FabActionContext';

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
  const [category, setCategory] = useState('groceries');
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [pickedIcon, setPickedIcon] = useState<string | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [timeInput, setTimeInput] = useState('10:00');
  const [showPickDate, setShowPickDate] = useState(false);
  const [itemsText, setItemsText] = useState('');
  const [saving, setSaving] = useState(false);

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];
  const selectedGroup = groups.find((g: any) => g.id === groupId);

  const [allMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  const [myListsValue, myLoading, myError] = useCollection(
    user ? query(collection(db, 'shoppingLists'), where('userId', '==', user.uid)) : null,
  );
  const [sharedListsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)) : null,
  );
  const listsById = new Map<string, any>();
  myListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  sharedListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  const lists = Array.from(listsById.values()).sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));

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
          {list.completed && typeof list.totalExpense === 'number' && <span className="rounded-lg bg-green-100 text-green-800 px-2 py-0.5 text-[10px] font-black">Spent {list.totalExpense.toLocaleString()}</span>}
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
    setCategory('groceries');
    setShowAllCategories(false);
    setPickedIcon(null);
    setShowIconPicker(false);
    setGroupId('');
    setDateInput('');
    setTimeInput('10:00');
    setShowPickDate(false);
    setItemsText('');
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!user || !trimmed) return;

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
        itemCount: itemLines.length,
        doneCount: 0,
        createdAt: new Date().toISOString(),
      });
      // items go in after the list exists (their security rule looks up the list)
      if (itemLines.length > 0) {
        const batch = writeBatch(db);
        const now = Date.now();
        itemLines.forEach((text, i) => {
          batch.set(doc(collection(db, 'shoppingLists', docRef.id, 'items')), { text, status: 'pending', addedBy: user.uid, createdAt: new Date(now + i).toISOString() });
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

        <section className="space-y-4">
          {myLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {myError && (
            <p className="text-sm text-error px-1">{t('shoppingLists.couldntLoad', { error: myError.code || myError.message })}</p>
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

      {showForm && (
        <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }} onClick={resetForm}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleCreate} className="bg-white rounded-t-3xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(92vh - 4rem - env(safe-area-inset-bottom))', paddingBottom: '1.25rem' }}>
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-black text-primary">{t('shoppingLists.newList')}</h2>
                <button type="button" onClick={resetForm} className="text-xs font-black text-[#0f7a8f]">{t('common.cancel')}</button>
              </div>

              {/* the name; the icon beside it follows the name, or tap it to choose your own */}
              <div className="flex items-center gap-3 rounded-2xl bg-slate-50 border-2 border-[#22c1a5] p-2.5">
                <button type="button" onClick={() => setShowIconPicker((v) => !v)} title="Change the icon" className="relative w-11 h-11 rounded-xl flex items-center justify-center text-[22px] shrink-0 active:scale-95" style={{ background: tileTint(chosenCategory.id) }}>
                  {newListIcon}
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-white border border-slate-200 flex items-center justify-center"><span className="material-symbols-outlined text-[11px] text-slate-500">edit</span></span>
                </button>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('shoppingLists.listNamePlaceholder')}
                  maxLength={150}
                  required
                  autoFocus
                  className="flex-1 min-w-0 bg-transparent text-[15px] font-bold text-primary outline-none placeholder:text-slate-400 placeholder:font-medium"
                />
              </div>
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
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={chip(!groupId)} onClick={() => setGroupId('')}>🔒 {t('todo.justMe')}</button>
                    {groups.map((g: any) => (
                      <button key={g.id} type="button" className={clsx(chip(groupId === g.id), 'inline-flex items-center gap-1')} onClick={() => setGroupId(g.id)}>
                        {g.photoURL ? <img src={g.photoURL} alt="" className="w-4 h-4 rounded object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(g.icon)}</span>}{g.name}
                      </button>
                    ))}
                  </div>
                  {groupId && <p className="text-[10.5px] text-slate-500 mt-1.5 px-0.5">{t('shoppingLists.sharingHelp')}</p>}
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

              <button type="submit" disabled={saving || !title.trim()} className="w-full mt-4 py-3.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">
                {saving ? t('shoppingLists.creating') : itemLines.length > 0 ? `Create list · ${itemLines.length} item${itemLines.length === 1 ? '' : 's'}` : t('shoppingLists.create')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
