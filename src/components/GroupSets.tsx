import React, { useState } from 'react';
import { clsx } from 'clsx';
import { groupIconEmoji } from '../lib/groupIcons';
import { GroupSet, GROUP_SET_ICONS, makeSetId, upsertSet } from '../lib/groupSets';

// The two sheets for working with sets: the editor (name, icon, which groups) and, for Analysis, the picker that replaces the group dropdown.
// Both stop above the bottom bar, like every other sheet in the app.

export interface SetGroup {
  id: string;
  name: string;
  icon?: string;
  photoURL?: string | null;
  archived?: boolean;
}

const OVERLAY = 'fixed inset-0 bg-black/45 z-[120] flex items-end justify-center';
const OVERLAY_STYLE = { paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' };

function GroupTile({ group, size = 38 }: { group: SetGroup; size?: number }) {
  return (
    <span className="rounded-xl bg-slate-100 flex items-center justify-center shrink-0 overflow-hidden" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {group.photoURL ? <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : groupIconEmoji(group.icon)}
    </span>
  );
}

// Small overlapping icons of the groups in a set
function GroupStack({ groups }: { groups: SetGroup[] }) {
  return (
    <span className="flex shrink-0">
      {groups.slice(0, 3).map((g, i) => (
        <span key={g.id} className="w-5 h-5 rounded-md bg-white border border-slate-200 flex items-center justify-center overflow-hidden text-[11px]" style={{ marginLeft: i === 0 ? 0 : -5 }}>
          {g.photoURL ? <img src={g.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : groupIconEmoji(g.icon)}
        </span>
      ))}
    </span>
  );
}

export function GroupSetEditor({
  groups,
  sets,
  initial,
  onSave,
  onClose,
  showDefaultOption = true,
}: {
  groups: SetGroup[];
  sets: GroupSet[];
  initial: GroupSet | null; // null = a new set
  onSave: (next: GroupSet[]) => Promise<void>;
  onClose: () => void;
  showDefaultOption?: boolean;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [icon, setIcon] = useState(initial?.icon || GROUP_SET_ICONS[0]);
  const [showIcons, setShowIcons] = useState(false);
  const [picked, setPicked] = useState<string[]>(initial?.groupIds || []);
  const [openByDefault, setOpenByDefault] = useState(!!initial?.openByDefault);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...groups].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // ids of groups that are no longer yours stay out of the picked count (they are dropped when you save)
  const validPicked = picked.filter((id) => groups.some((g) => g.id === id));

  const save = async () => {
    if (!name.trim()) { setError('Give the set a name.'); return; }
    if (validPicked.length === 0) { setError('Choose at least one group.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(upsertSet(sets, { id: initial?.id || makeSetId(), name: name.trim().slice(0, 40), icon, groupIds: validPicked, ...(openByDefault ? { openByDefault: true } : {}) }));
      onClose();
    } catch (e) {
      console.error('Failed to save set:', e);
      setError('Could not save. Try again.');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!initial || !window.confirm(`Delete the set "${initial.name}"? Your groups are not affected.`)) return;
    setSaving(true);
    try {
      await onSave(sets.filter((s) => s.id !== initial.id));
      onClose();
    } catch (e) {
      console.error('Failed to delete set:', e);
      setError('Could not delete. Try again.');
      setSaving(false);
    }
  };

  return (
    <div className={OVERLAY} style={OVERLAY_STYLE} onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-t-3xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(92vh - 4rem - env(safe-area-inset-bottom))', paddingBottom: '1.25rem' }}>
          <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-black text-primary">{initial ? 'Edit set' : 'New set'}</h2>
            <button type="button" onClick={onClose} className="text-xs font-black text-[#0f7a8f]">Cancel</button>
          </div>

          <div className="flex items-center gap-3 rounded-2xl bg-slate-50 border-2 border-[#22c1a5] p-2.5">
            <button type="button" onClick={() => setShowIcons((v) => !v)} title="Change the icon" className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center text-[22px] shrink-0 active:scale-95">{icon}</button>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="e.g. Festivals & events" className="flex-1 min-w-0 bg-transparent text-[15px] font-bold text-primary outline-none placeholder:text-slate-400 placeholder:font-medium" />
          </div>
          {showIcons && (
            <div className="mt-2 rounded-2xl bg-slate-50 p-2.5 flex flex-wrap gap-1.5">
              {GROUP_SET_ICONS.map((em) => (
                <button key={em} type="button" onClick={() => { setIcon(em); setShowIcons(false); }} className={clsx('w-9 h-9 rounded-xl text-[20px] flex items-center justify-center active:scale-90', icon === em ? 'bg-white ring-2 ring-[#22c1a5]' : 'bg-white/70')}>{em}</button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mt-4 mb-1.5 px-0.5">
            <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">Which groups?</p>
            <p className="text-[11px] font-black text-[#0f7a8f]">{validPicked.length} chosen</p>
          </div>
          <div className="space-y-1.5">
            {ordered.map((g) => {
              const on = picked.includes(g.id);
              return (
                <button key={g.id} type="button" onClick={() => toggle(g.id)} className={clsx('w-full flex items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-all active:scale-[0.99]', on ? 'bg-emerald-50 border-2 border-[#22c1a5]' : 'bg-slate-50 border-2 border-transparent')}>
                  <span className={clsx('w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0', on ? 'bg-[#0f7a8f] border-[#0f7a8f] text-white' : 'border-slate-300')}>
                    {on && <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>}
                  </span>
                  <GroupTile group={g} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-primary truncate">{g.name}</span>
                    {g.archived && <span className="block text-[10.5px] text-text-muted">Archived</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {showDefaultOption && (
            <button type="button" onClick={() => setOpenByDefault((v) => !v)} className="mt-3 w-full flex items-center gap-2.5 text-left">
              <span className={clsx('w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0', openByDefault ? 'bg-[#0f7a8f] border-[#0f7a8f] text-white' : 'border-slate-300')}>
                {openByDefault && <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>}
              </span>
              <span className="text-xs font-bold text-slate-600">Open Analysis on this set by default</span>
            </button>
          )}

          {error && <p className="text-xs font-bold text-error mt-2 px-1">{error}</p>}
          <button type="button" onClick={save} disabled={saving} className="w-full mt-4 py-3.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">{saving ? 'Saving…' : 'Save set'}</button>
          {initial && <button type="button" onClick={remove} disabled={saving} className="w-full mt-2 py-2.5 text-sm font-black text-rose-600 disabled:opacity-50">Delete this set</button>}
        </div>
      </div>
    </div>
  );
}

// Analysis: choose "all my groups", one of your sets, or a single group
export function GroupSetPicker({
  groups,
  sets,
  selected,
  onSelect,
  onSaveSets,
  onClose,
}: {
  groups: SetGroup[];
  sets: GroupSet[];
  selected: string; // 'all', a group id, or 'set:<id>'
  onSelect: (scope: string) => void;
  onSaveSets: (next: GroupSet[]) => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<GroupSet | 'new' | null>(null);
  const ordered = [...groups].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  const row = (on: boolean) => clsx('w-full flex items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-all active:scale-[0.99]', on ? 'bg-emerald-50 border-2 border-[#22c1a5]' : 'bg-slate-50 border-2 border-transparent');
  const pick = (scope: string) => { onSelect(scope); onClose(); };

  if (editing) {
    return <GroupSetEditor groups={groups} sets={sets} initial={editing === 'new' ? null : editing} onSave={onSaveSets} onClose={() => setEditing(null)} />;
  }

  return (
    <div className={OVERLAY} style={OVERLAY_STYLE} onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-t-3xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(92vh - 4rem - env(safe-area-inset-bottom))', paddingBottom: '1.25rem' }}>
          <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-black text-primary">Analyse</h2>
            <button type="button" onClick={onClose} className="text-xs font-black text-[#0f7a8f]">Close</button>
          </div>

          <button type="button" onClick={() => pick('all')} className={row(selected === 'all')}>
            <span className="w-[38px] h-[38px] rounded-xl bg-sky-100 flex items-center justify-center text-[19px] shrink-0">🌐</span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-black text-primary">All my groups</span><span className="block text-[11px] text-text-muted">{groups.length} group{groups.length === 1 ? '' : 's'}</span></span>
          </button>

          <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mt-4 mb-1.5 px-0.5">My sets</p>
          <div className="space-y-1.5">
            {sets.map((s) => {
              const inSet = s.groupIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as SetGroup[];
              return (
                <div key={s.id} className={row(selected === `set:${s.id}`)} style={{ cursor: 'pointer' }} onClick={() => pick(`set:${s.id}`)}>
                  <span className="w-[38px] h-[38px] rounded-xl bg-amber-100 flex items-center justify-center text-[19px] shrink-0">{s.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-primary truncate">{s.name}</span>
                    <span className="block text-[11px] text-text-muted truncate">{inSet.length === 0 ? 'No groups of yours' : inSet.map((g) => g.name).join(' · ')}</span>
                  </span>
                  <GroupStack groups={inSet} />
                  <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(s); }} className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-black text-slate-500 active:scale-95">Edit</button>
                </div>
              );
            })}
            <button type="button" onClick={() => setEditing('new')} className="w-full rounded-2xl border-2 border-dashed border-slate-300 py-3 text-center text-xs font-black text-[#0f7a8f] active:scale-[0.99]">＋ New set</button>
          </div>

          <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mt-4 mb-1.5 px-0.5">Single group</p>
          <div className="space-y-1.5">
            {ordered.map((g) => (
              <button key={g.id} type="button" onClick={() => pick(g.id)} className={clsx(row(selected === g.id), g.archived && 'opacity-70')}>
                <GroupTile group={g} />
                <span className="min-w-0 flex-1"><span className="block text-sm font-black text-primary truncate">{g.name}</span>{g.archived && <span className="block text-[11px] text-text-muted">Archived</span>}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
