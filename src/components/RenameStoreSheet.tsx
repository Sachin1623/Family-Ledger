import React, { useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { renameStore } from '../lib/shoppingStores';

// The small window that opens when a store is held down: type the new name and it is changed everywhere it is still in use.
export default function RenameStoreSheet({ store, existing, onClose, onRenamed }: {
  store: string;
  existing: string[]; // the stores already named, so a name is not used twice
  onClose: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}) {
  const { user, profile } = useAuth();
  const [name, setName] = useState(store);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = name.trim().slice(0, 40);
    if (!user) return;
    if (!next) { setError('Type a name.'); return; }
    if (next === store) { onClose(); return; }
    if (existing.some((s) => s.toLowerCase() === next.toLowerCase() && s !== store)) { setError('You already have a store with this name.'); return; }
    setSaving(true);
    try {
      await renameStore(user.uid, profile, store, next);
      onRenamed(store, next);
      onClose();
    } catch (err) {
      console.error('Failed to rename store:', err);
      setError('Could not rename. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/45 z-[140] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }} onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="bg-white rounded-3xl shadow-2xl px-4 pt-3" style={{ paddingBottom: '1.25rem' }}>
          <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
          <h2 className="text-base font-black text-primary">Rename store</h2>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            maxLength={40}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className={clsx('w-full mt-3 bg-slate-50 px-3 py-3 rounded-xl border text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20', error ? 'border-rose-400 bg-rose-50' : 'border-slate-200')}
          />
          {error && <p className="text-xs font-black text-rose-600 mt-1 px-1">{error}</p>}
          <p className="text-[11px] text-text-muted mt-2 px-0.5">Changes the name on your repeating items and on every list that is not finished. Finished lists keep the old name.</p>
          <div className="flex gap-2 pt-3">
            <button type="button" onClick={onClose} className="flex-1 py-3 rounded-2xl font-black text-slate-500 border border-slate-200">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 py-3 rounded-2xl font-black text-white bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50">{saving ? 'Renaming…' : 'Rename'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
