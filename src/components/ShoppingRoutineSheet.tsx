import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import {
  DAY_NAMES, DEFAULT_ROUTINE, FREQ_OPTIONS, FREQ_SHORT, Freq, RecurringItem, ShoppingRoutine,
  canRingShoppingAlarm, getRoutines, recurringKey, routineKeyOf, routineSummary, runRoutineNow, saveRecurring, saveRoutineFor, syncShoppingReminders, todayLocalDate,
} from '../lib/shoppingRoutine';
import { groupIconEmoji } from '../lib/groupIcons';
import StoreChip from './StoreChip';
import RenameStoreSheet from './RenameStoreSheet';
import { historyKey } from '../lib/shoppingHistory';

const UNITS = ['kg', 'gm', 'L', 'ml', 'pk', 'pcs', 'dz'];
// the amounts people pick most often, one tap each (the same ones the item sheet offers)
const QTY_PRESETS: [string, string][] = [['100', 'gm'], ['250', 'gm'], ['500', 'gm'], ['1', 'kg'], ['5', 'kg'], ['500', 'ml'], ['1', 'L'], ['1', 'pk']];
const STARTER_STORES = ['Kirana', 'Supermarket', 'Online', 'Vegetable seller', 'Pharmacy'];

// One repeating item: a line with its amount, store and how often; tap it to change them. Changes are saved as they are made.
function RepeatRow({ itemKey, it, stores, onSave, onRemove }: {
  itemKey: string;
  it: RecurringItem;
  stores: string[];
  onSave: (key: string, next: RecurringItem) => void;
  onRemove: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(it.qty != null ? String(it.qty) : '');
  const commitQty = () => {
    const n = parseFloat(qty.replace(',', '.'));
    const next = Number.isFinite(n) && n > 0 ? n : null;
    if (next !== (it.qty ?? null)) onSave(itemKey, { ...it, qty: next });
    setQty(next != null ? String(next) : '');
  };
  const change = (patch: Partial<RecurringItem>) => {
    const freq = patch.freq ?? it.freq;
    onSave(itemKey, { ...it, ...patch, anchor: patch.freq && patch.freq !== it.freq ? todayLocalDate() : it.anchor || todayLocalDate(), freq });
  };
  const amount = [it.qty != null ? String(it.qty) : '', it.unit || ''].filter(Boolean).join(' ');
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <p className="text-sm font-black text-primary truncate">{it.name}</p>
          <p className="text-[10.5px] text-text-muted truncate">{[amount, it.store ? `🏪 ${it.store}` : ''].filter(Boolean).join(' · ') || 'Tap to set amount and store'}</p>
        </button>
        <select value={it.freq} onChange={(e) => (e.target.value ? change({ freq: e.target.value as Freq }) : onRemove(itemKey))} className="shrink-0 bg-slate-50 py-1.5 px-2 rounded-lg border border-slate-200 text-xs font-bold outline-none">
          {FREQ_OPTIONS.map((o) => <option key={o.id || 'never'} value={o.id}>{o.id ? o.label : 'Stop repeating'}</option>)}
        </select>
        <button type="button" onClick={() => setOpen((v) => !v)} className="shrink-0 text-slate-400" aria-label={open ? 'Close' : 'Edit'}>
          <span className="material-symbols-outlined text-[20px]">{open ? 'expand_less' : 'expand_more'}</span>
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2 bg-slate-50/60">
          <div className="flex flex-wrap gap-1">
            {QTY_PRESETS.map(([q, u]) => (
              <button key={`${q}${u}`} type="button" onClick={() => { setQty(q); onSave(itemKey, { ...it, qty: parseFloat(q), unit: u }); }} className={clsx('px-2 py-1 rounded-lg text-xs font-bold border active:scale-95', String(it.qty ?? '') === q && it.unit === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-slate-200')}>{q} {u}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onBlur={commitQty} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} placeholder="Qty" className="w-20 shrink-0 bg-white p-2 rounded-lg border border-slate-200 text-sm font-bold text-center outline-none focus:ring-2 focus:ring-primary/20" />
            <div className="flex flex-wrap gap-1">
              {UNITS.map((u) => (
                <button key={u} type="button" onClick={() => change({ unit: it.unit === u ? null : u })} className={clsx('px-2 py-1 rounded-lg text-xs font-bold border active:scale-95', it.unit === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-slate-200')}>{u}</button>
              ))}
            </div>
          </div>
          <select value={it.store || ''} onChange={(e) => change({ store: e.target.value || null })} className="w-full bg-white p-2 rounded-lg border border-slate-200 text-sm font-bold outline-none">
            <option value="">🏪 No store</option>
            {stores.map((st) => <option key={st} value={st}>🏪 {st}</option>)}
          </select>
          <button type="button" onClick={() => onRemove(itemKey)} className="text-xs font-black text-rose-600 flex items-center gap-1"><span className="material-symbols-outlined text-[16px]">delete</span>Stop repeating this item</button>
        </div>
      )}
    </div>
  );
}

// The window for adding a repeating item: its name, how much, which store and how often.
function AddRepeatSheet({ stores, defaultFreq, existingKeys, onAdd, onClose }: {
  stores: string[];
  defaultFreq: Freq;
  existingKeys: Set<string>;
  onAdd: (item: { name: string; qty: number | null; unit: string | null; store: string | null; freq: Freq }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [store, setStore] = useState('');
  const [otherStore, setOtherStore] = useState('');
  const [freq, setFreq] = useState<Freq>(defaultFreq);
  const [renamingStore, setRenamingStore] = useState<string | null>(null);
  const key = historyKey(name.trim());
  const duplicate = !!key && existingKeys.has(key);
  const storeChoices = Array.from(new Set<string>([...stores, ...(store ? [store] : [])]));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key || duplicate) return;
    const n = parseFloat(qty.replace(',', '.'));
    onAdd({ name: name.trim().slice(0, 100), qty: Number.isFinite(n) && n > 0 ? n : null, unit: unit || null, store: store || null, freq });
  };
  const cap = 'block text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1.5 px-0.5';
  const input = 'bg-slate-50 px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20';
  return (
    <>
    <div className="fixed inset-0 bg-black/45 z-[130] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="bg-white rounded-3xl shadow-2xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', paddingBottom: '1.25rem' }}>
          <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-black text-primary">Add a repeating item</h2>
            <button type="button" onClick={onClose} className="text-xs font-black text-[#0f7a8f]">Cancel</button>
          </div>

          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Item name, e.g. Milk" maxLength={100} autoFocus className={clsx(input, 'w-full', duplicate && 'border-rose-400 bg-rose-50')} />
          {duplicate && <p className="text-xs font-black text-rose-600 mt-1 px-1">This item already repeats. Change it in the list.</p>}

          <span className={clsx(cap, 'mt-4')}>How much (optional)</span>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {QTY_PRESETS.map(([q, u]) => (
              <button key={`${q}${u}`} type="button" onClick={() => { setQty(q); setUnit(u); }} className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border active:scale-95', qty === q && unit === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-slate-200')}>{q} {u}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" className={clsx(input, 'w-20 shrink-0 text-center')} />
            <div className="flex flex-wrap gap-1">
              {UNITS.map((u) => (
                <button key={u} type="button" onClick={() => setUnit(unit === u ? '' : u)} className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border active:scale-95', unit === u ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-slate-200')}>{u}</button>
              ))}
            </div>
          </div>

          <span className={clsx(cap, 'mt-4')}>Store</span>
          <p className="text-[10.5px] text-slate-400 -mt-1 mb-1.5 px-0.5">Hold a store to rename it.</p>
          <div className="flex flex-wrap gap-1.5">
            {storeChoices.map((st) => (
              <StoreChip key={st} name={st} selected={store === st} onSelect={() => setStore(store === st ? '' : st)} onLongPress={() => setRenamingStore(st)} className={clsx('px-2.5 py-1.5 rounded-lg text-xs font-bold border active:scale-95', store === st ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-slate-200')} />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input type="text" value={otherStore} onChange={(e) => setOtherStore(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && otherStore.trim()) { e.preventDefault(); setStore(otherStore.trim().slice(0, 40)); setOtherStore(''); } }} placeholder="Another store…" maxLength={40} className={clsx(input, 'flex-1 min-w-0')} />
            <button type="button" disabled={!otherStore.trim()} onClick={() => { setStore(otherStore.trim().slice(0, 40)); setOtherStore(''); }} className="shrink-0 px-3 py-2.5 rounded-xl bg-primary text-white text-xs font-black disabled:opacity-40">Use</button>
          </div>

          <span className={clsx(cap, 'mt-4')}>How often</span>
          <div className="grid grid-cols-4 gap-1.5">
            {FREQ_OPTIONS.filter((o) => o.id).map((o) => (
              <button key={o.id} type="button" onClick={() => setFreq(o.id as Freq)} className={clsx('py-2 rounded-xl text-[11px] font-black border active:scale-95', freq === o.id ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>{FREQ_SHORT[o.id as Freq]}</button>
            ))}
          </div>

          <button type="submit" disabled={!key || duplicate} className="w-full mt-5 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">Add item</button>
        </form>
      </div>
    </div>
    {renamingStore !== null && (
      <RenameStoreSheet
        store={renamingStore}
        existing={storeChoices}
        onClose={() => setRenamingStore(null)}
        onRenamed={(oldName, newName) => { if (store === oldName) setStore(newName); }}
      />
    )}
    </>
  );
}

type GroupLite = { id: string; name: string; icon?: string; photoURL?: string };

// The floating card every view of the routine screen sits in.
function Shell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-3xl shadow-2xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)', paddingBottom: '1.25rem' }}>
          <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
          {children}
        </div>
      </div>
    </div>
  );
}

// One routine: its day and time, its reminder, and the items that repeat for it.
function RoutineEditor({ routineKey, group, isNew, nameOf, onBack, onClose, onOpenList }: {
  routineKey: string;
  group: GroupLite | null;
  isNew: boolean;
  nameOf: (key: string) => string;
  onBack: () => void;
  onClose: () => void;
  onOpenList: (listId: string) => void;
}) {
  const { user, profile } = useAuth();
  const routines = getRoutines(profile);
  const saved: ShoppingRoutine = { ...DEFAULT_ROUTINE, groupId: routineKey === 'me' ? null : routineKey, ...(routines[routineKey] || {}) };
  const [enabled, setEnabled] = useState(!!saved.enabled);
  const [day, setDay] = useState<number>(saved.dayOfWeek ?? 0);
  const [time, setTime] = useState<string>(saved.time || '17:00');
  const [reminder, setReminder] = useState<'none' | 'notification' | 'alarm'>(saved.reminder || 'notification');
  const [lead, setLead] = useState<number>(saved.remindLead || 0);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [storeFilter, setStoreFilter] = useState('');
  const [freqFilter, setFreqFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [message, setMessage] = useState<{ text: string; listId?: string } | null>(null);

  // only the items that belong to this routine
  const recurring: [string, RecurringItem][] = Object.entries((profile?.shoppingRecurring || {}) as Record<string, RecurringItem>)
    .filter(([, it]) => it && it.name && it.routine === routineKey)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  const current = (): ShoppingRoutine => ({ enabled, dayOfWeek: day, time: time || '17:00', groupId: routineKey === 'me' ? null : routineKey, reminder, remindLead: lead });

  const persist = async () => {
    if (!user) return;
    await saveRoutineFor(user.uid, routineKey, current(), routines);
    await syncShoppingReminders({ ...routines, [routineKey]: { ...(routines[routineKey] || {}), ...current() } }, nameOf);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await persist();
      onBack();
    } catch (err) {
      console.error('Failed to save routine:', err);
      setMessage({ text: 'Could not save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    setRunning(true);
    setMessage(null);
    try {
      await persist();
      const out = await runRoutineNow(routineKey);
      if (out.result === 'created') setMessage({ text: `Your list is ready with ${out.added} item${out.added === 1 ? '' : 's'}.`, listId: out.listId });
      else if (out.result === 'appended') setMessage({ text: out.added ? `Added ${out.added} item${out.added === 1 ? '' : 's'} to the open list.` : 'The open list already has everything that is due.', listId: out.listId });
      else setMessage({ text: 'Nothing is due yet. Add an item that repeats Weekly, Every 2 weeks or Monthly. Daily items only ride along on a day that has one of those.' });
    } catch (err: any) {
      setMessage({ text: err?.message || 'Could not create the list.' });
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async () => {
    if (!user || !window.confirm(`Delete the ${nameOf(routineKey)} routine and the ${recurring.length} item${recurring.length === 1 ? '' : 's'} that repeat in it?`)) return;
    try {
      await Promise.all(recurring.map(([key]) => saveRecurring(user.uid, key, null)));
      await saveRoutineFor(user.uid, routineKey, null, routines);
      const rest = { ...routines };
      delete rest[routineKey];
      await syncShoppingReminders(rest, nameOf);
      onBack();
    } catch (err) {
      console.error('Failed to delete routine:', err);
      setMessage({ text: 'Could not delete. Try again.' });
    }
  };

  const saveItem = (key: string, next: RecurringItem) => { if (user) saveRecurring(user.uid, key, { ...next, routine: routineKey }).catch((err) => console.error('repeat save failed:', err)); };
  const removeItem = (key: string) => { if (user) saveRecurring(user.uid, key, null).catch(() => {}); };
  const addItem = (item: { name: string; qty: number | null; unit: string | null; store: string | null; freq: Freq }) => {
    const itemKey = historyKey(item.name);
    const key = recurringKey(routineKey, itemKey);
    if (!user || !itemKey || (profile?.shoppingRecurring || {})[key]) return;
    saveItem(key, { ...item, anchor: todayLocalDate(), lastAdded: null });
    setShowAdd(false);
    // jump to where the new item will show
    if (freqFilter && freqFilter !== item.freq) setFreqFilter(item.freq);
  };
  // the stores to pick from: the ones already used on repeating items, the ones you have used before, then the common ones
  const storeOptions = useMemo(
    () => Array.from(new Set<string>([...(profile?.shoppingStores || []), ...recurring.map(([, it]) => it.store || '').filter(Boolean), ...STARTER_STORES])),
    [profile?.shoppingStores, recurring],
  );
  const storesUsed = Array.from(new Set(recurring.map(([, it]) => it.store || '').filter(Boolean)));
  const shown = recurring.filter(([, it]) => (!storeFilter || (storeFilter === '__none' ? !it.store : it.store === storeFilter)) && (!freqFilter || it.freq === freqFilter));

  const label = 'block text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1 px-0.5';
  const field = 'w-full bg-slate-50 px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <>
      <Shell onClose={onClose}>
        <div className="flex items-center gap-2 mb-3">
          <button type="button" onClick={onBack} aria-label="Back" className="shrink-0 -ml-1 p-1 rounded-full text-primary active:bg-slate-100"><span className="material-symbols-outlined">arrow_back</span></button>
          <h2 className="flex-1 min-w-0 text-base font-black text-primary truncate flex items-center gap-1.5">
            {group?.photoURL ? <img src={group.photoURL} alt="" className="w-5 h-5 rounded-md object-cover" referrerPolicy="no-referrer" /> : <span>{group ? groupIconEmoji(group.icon) : '🔒'}</span>}
            {nameOf(routineKey)}
          </h2>
          <button type="button" onClick={onClose} className="text-xs font-black text-[#0f7a8f]">Close</button>
        </div>

        <button type="button" onClick={() => setEnabled((v) => !v)} className="w-full flex items-center gap-3 rounded-2xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-left">
          <span className="flex-1 text-sm font-black text-primary">Make this list automatically</span>
          <span className={clsx('relative w-11 h-6 rounded-full transition-colors shrink-0', enabled ? 'bg-[#0f7a8f]' : 'bg-slate-300')}>
            <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', enabled ? 'left-[22px]' : 'left-0.5')} />
          </span>
        </button>

        <div className={clsx('mt-3 space-y-3', !enabled && 'opacity-50 pointer-events-none')}>
          <div>
            <span className={label}>Shopping day</span>
            <div className="grid grid-cols-7 gap-1">
              {DAY_NAMES.map((name, i) => (
                <button key={name} type="button" onClick={() => setDay(i)} className={clsx('py-2 rounded-lg text-[11px] font-black border transition-all active:scale-95', day === i ? 'bg-[#0f7a8f] text-white border-[#0f7a8f]' : 'bg-white text-slate-600 border-slate-200')}>{name}</button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[7.25rem_1fr] gap-2">
            <label>
              <span className={label}>Time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={clsx(field, 'px-2 text-xs')} />
            </label>
            <div>
              <span className={label}>Remind me by</span>
              <div className="grid grid-cols-3 gap-1.5">
                {([['notification', 'notifications_active', 'Notification'], ['alarm', 'alarm', 'Alarm'], ['none', 'notifications_off', 'None']] as const).map(([id, icon, lbl]) => (
                  <button key={id} type="button" onClick={() => setReminder(id)} className={clsx('rounded-xl border-2 py-1.5 flex flex-col items-center justify-center gap-0 active:scale-95 transition-all', reminder === id ? 'border-[#0f7a8f] bg-teal-50 text-[#0f7a8f]' : 'border-slate-200 bg-white text-slate-500')}>
                    <span className="material-symbols-outlined text-[20px] leading-none">{icon}</span>
                    <span className="text-[10px] font-black leading-tight">{lbl}</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="col-span-2">
              <span className={label}>Remind</span>
              <select value={lead} onChange={(e) => setLead(Number(e.target.value))} disabled={reminder === 'none'} className={clsx(field, reminder === 'none' && 'opacity-50')}>
                <option value={0}>At that time</option>
                <option value={30}>30 min before</option>
                <option value={60}>1 hour before</option>
              </select>
            </label>
          </div>
          {reminder === 'alarm' && <p className="text-[10.5px] text-slate-500 px-0.5 -mt-1">{canRingShoppingAlarm() ? 'Rings like an alarm clock, even on silent.' : 'The alarm rings on Android. Here you get a notification.'}</p>}
        </div>

        <div className="flex items-center justify-between mt-5 mb-2 px-0.5">
          <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">Items that repeat ({recurring.length})</span>
          <button type="button" onClick={() => setShowAdd(true)} className="flex items-center gap-1 rounded-full bg-[#0f7a8f] text-white pl-2.5 pr-3 py-1.5 text-xs font-black active:scale-95">
            <span className="material-symbols-outlined text-[16px]">add</span>Add item
          </button>
        </div>

        {recurring.length > 0 && (
          <div className="flex bg-slate-100 rounded-xl p-1 gap-0.5">
            {[['', 'All'], ...FREQ_OPTIONS.filter((o) => o.id).map((o) => [o.id, FREQ_SHORT[o.id as Freq]])].map(([id, lbl]) => {
              const count = id ? recurring.filter(([, it]) => it.freq === id).length : recurring.length;
              return (
                <button key={id || 'all'} type="button" onClick={() => setFreqFilter(id)} className={clsx('flex-1 rounded-lg py-1.5 text-[11px] font-black transition-all active:scale-95', freqFilter === id ? 'bg-white text-[#0b3b57] shadow-sm' : 'text-slate-500')}>
                  {lbl}<span className={clsx('ml-1 text-[10px]', freqFilter === id ? 'text-[#0f7a8f]' : 'text-slate-400')}>{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {storesUsed.length > 0 && (
          <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} className={clsx(field, 'py-2 text-xs mt-2')} aria-label="Filter by store">
            <option value="">All stores</option>
            {storesUsed.map((st) => <option key={st} value={st}>🏪 {st}</option>)}
            {recurring.some(([, it]) => !it.store) && <option value="__none">No store</option>}
          </select>
        )}

        {recurring.length === 0 ? (
          <p className="text-xs text-text-muted text-center px-3 py-4">Nothing repeats here yet. Tap <b>Add item</b>, or set <b>Repeats</b> on any item in a {group ? `${group.name} ` : ''}list.</p>
        ) : shown.length === 0 ? (
          <p className="text-xs text-text-muted text-center px-3 py-4">Nothing here with this filter.</p>
        ) : (
          <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden mt-2">
            {shown.map(([key, it]) => <React.Fragment key={key}><RepeatRow itemKey={key} it={it} stores={storeOptions} onSave={saveItem} onRemove={removeItem} /></React.Fragment>)}
          </div>
        )}

        <details className="mt-3 group">
          <summary className="text-[11px] font-black text-[#0f7a8f] cursor-pointer select-none list-none flex items-center gap-1"><span className="material-symbols-outlined text-[15px]">info</span>How it works</summary>
          <p className="text-[11px] text-slate-500 mt-1.5 px-0.5 leading-relaxed">On this routine's day its list is made from the items that are due. Daily items go in every list but never make one on their own. Monthly items come on the first shopping day of the month, and every 2 weeks counts from the day you set it. Each group gets one list a day at most, and no new one while that group's last weekly list is still open.</p>
        </details>

        {message && (
          <div className="mt-3 rounded-xl bg-teal-50 border border-teal-200 px-3 py-2.5 text-xs font-bold text-teal-900 flex items-center gap-2">
            <span className="flex-1">{message.text}</span>
            {message.listId && <button type="button" onClick={() => onOpenList(message.listId!)} className="shrink-0 px-3 py-1.5 rounded-lg bg-[#0f7a8f] text-white text-xs font-black">Open</button>}
          </div>
        )}

        <button type="button" onClick={handleRunNow} disabled={running} className="w-full mt-3 py-2 text-xs font-black text-[#0f7a8f] disabled:opacity-50">
          {running ? 'Making your list…' : 'Make my list now'}
        </button>
        <button type="button" onClick={handleSave} disabled={saving} className="w-full py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">{saving ? 'Saving…' : isNew ? 'Save routine' : 'Save'}</button>
        {!isNew && <button type="button" onClick={handleDelete} className="w-full mt-2 py-2 text-xs font-black text-rose-600">Delete this routine</button>}
      </Shell>
      {showAdd && <AddRepeatSheet stores={storeOptions} defaultFreq={(freqFilter as Freq) || 'weekly'} existingKeys={new Set(recurring.map(([, it]) => historyKey(it.name)))} onAdd={addItem} onClose={() => setShowAdd(false)} />}
    </>
  );
}

// Weekly shopping routines: one for each group (and one for just you), each with its own day, time, reminder and items.
export default function ShoppingRoutineSheet({
  groups,
  onClose,
  onOpenList,
}: {
  groups: GroupLite[];
  onClose: () => void;
  onOpenList: (listId: string) => void;
}) {
  const { user, profile } = useAuth();
  const routines = getRoutines(profile);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const nameOf = (key: string) => (key === 'me' ? 'Just me' : groups.find((g) => g.id === key)?.name || 'Group');
  const groupOf = (key: string) => (key === 'me' ? null : groups.find((g) => g.id === key) || null);
  const itemCount = (key: string) => Object.values((profile?.shoppingRecurring || {}) as Record<string, RecurringItem>).filter((it) => it?.routine === key).length;
  const keys = Object.keys(routines).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  // the places that do not have a routine yet
  const available = [{ key: 'me', name: 'Just me', icon: '🔒' }, ...groups.map((g) => ({ key: g.id, name: g.name, icon: g.icon ? groupIconEmoji(g.icon) : '👥' }))].filter((o) => !routines[o.key]);

  const toggle = async (key: string) => {
    if (!user) return;
    const next = { ...routines[key], enabled: !routines[key].enabled };
    await saveRoutineFor(user.uid, key, next, routines).catch((err) => console.error('toggle routine failed:', err));
    await syncShoppingReminders({ ...routines, [key]: next }, nameOf);
  };

  if (editing) {
    return <RoutineEditor routineKey={editing} group={groupOf(editing)} isNew={!routines[editing]} nameOf={nameOf} onBack={() => { setEditing(null); setPicking(false); }} onClose={onClose} onOpenList={onOpenList} />;
  }

  return (
    <Shell onClose={onClose}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-black text-primary">Weekly routines</h2>
        <button type="button" onClick={onClose} className="text-xs font-black text-[#0f7a8f]">Close</button>
      </div>
      <p className="text-xs text-text-muted mb-3">Each group has its own shopping day, reminder and list of items that repeat, and gets one list a day.</p>

      {keys.length === 0 ? (
        <p className="text-xs text-text-muted text-center rounded-xl bg-slate-50 border border-dashed border-slate-300 px-3 py-5">No routines yet. Add one for a group you shop for.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => {
            const g = groupOf(key);
            const r = routines[key];
            const n = itemCount(key);
            return (
              <div key={key} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5">
                <button type="button" onClick={() => setEditing(key)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                  <span className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center text-xl shrink-0 overflow-hidden">
                    {g?.photoURL ? <img src={g.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : g ? groupIconEmoji(g.icon) : '🔒'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-primary truncate">{nameOf(key)}</span>
                    <span className="block text-[11px] text-text-muted truncate">{routineSummary(r)} · {n} repeating item{n === 1 ? '' : 's'}</span>
                  </span>
                  <span className="material-symbols-outlined text-slate-300 shrink-0">chevron_right</span>
                </button>
                <button type="button" onClick={() => toggle(key)} aria-label={r.enabled ? 'Turn off' : 'Turn on'} className={clsx('relative w-11 h-6 rounded-full transition-colors shrink-0', r.enabled ? 'bg-[#0f7a8f]' : 'bg-slate-300')}>
                  <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', r.enabled ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {available.length > 0 && (
        picking ? (
          <div className="mt-3 rounded-2xl border border-slate-200 overflow-hidden">
            <p className="px-3 py-2 text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 bg-slate-50">Set up a routine for</p>
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
              {available.map((o) => (
                <button key={o.key} type="button" onClick={() => setEditing(o.key)} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm font-bold text-slate-700 active:bg-slate-100">
                  <span className="text-base">{o.icon}</span><span className="flex-1 truncate">{o.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setPicking(true)} className="w-full mt-3 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 active:scale-[0.99]">+ Add a routine</button>
        )
      )}
    </Shell>
  );
}
