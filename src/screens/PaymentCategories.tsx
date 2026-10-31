import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import CategoryIconPicker from '../components/CategoryIconPicker';
import {
  DEFAULT_PAYMENT_CATEGORIES, PaymentCategory, allPaymentCategories, isMaterialIcon, makePaymentCategoryId,
} from '../lib/paymentCategories';
import { KIND_STYLE } from '../lib/groupKindStyle';

// The categories a Payments group uses for its payments. Separate from the general expense categories, which a Payments group
// never uses. Built-in ones can be renamed or hidden, ones you add can also be removed.
export default function PaymentCategories() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [groupSnap] = useDocument(groupId ? doc(db, 'groups', groupId) : null);
  const [memberSnap] = useDocument(groupId && user ? doc(db, 'members', `${user.uid}_${groupId}`) : null);
  const group: any = groupSnap?.data();
  const role = (memberSnap?.data() as any)?.role;
  const canEdit = role === 'owner' || role === 'admin' || group?.createdBy === user?.uid;
  const style = KIND_STYLE.payments;

  const list = allPaymentCategories(group);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [newIcon, setNewIcon] = useState('🏷️');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  const save = async (next: PaymentCategory[]) => {
    if (!groupId) return;
    setError('');
    try {
      await updateDoc(doc(db, 'groups', groupId), { paymentCategories: next });
    } catch (err) {
      console.error('Could not save the payment categories:', err);
      setError('Could not save the change. Check your connection and try again.');
    }
  };

  const rename = async (id: string) => {
    const name = editName.trim();
    setEditingId(null);
    if (!name) return;
    await save(list.map((c) => (c.id === id ? { ...c, name: name.slice(0, 40) } : c)));
  };
  const toggleHidden = (id: string) => {
    const visibleLeft = list.filter((c) => !c.hidden && c.id !== id).length;
    const target = list.find((c) => c.id === id);
    if (target && !target.hidden && visibleLeft === 0) return setError('Keep at least one category showing.');
    return save(list.map((c) => (c.id === id ? { ...c, hidden: !c.hidden } : c)));
  };
  const remove = (id: string) => save(list.filter((c) => c.id !== id));
  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return setError('There is already a category with that name.');
    await save([...list, { id: makePaymentCategoryId(), name: name.slice(0, 40), icon: newIcon || '🏷️', custom: true }]);
    setNewName('');
    setNewIcon('🏷️');
  };

  const glyph = (icon: string) => (isMaterialIcon(icon)
    ? <span className="material-symbols-outlined text-[22px]">{icon}</span>
    : <span className="text-[22px] leading-none">{icon}</span>);

  return (
    <div className="max-w-2xl mx-auto px-4 pb-28 pt-4 space-y-4">
      <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#2e2a8f,#4f46e5 55%,#818cf8)' }}>
        <button type="button" onClick={() => navigate(`/groups/${groupId}/manage`)} className="-ml-1 mb-2 flex items-center gap-1 text-xs font-bold text-white/85">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>Back to group settings
        </button>
        <p className="text-[11px] font-black uppercase tracking-wider text-white/85 truncate">{group?.icon} {group?.name}</p>
        <h1 className="text-2xl font-black leading-tight">Payment categories</h1>
        <p className="text-[12px] text-white/90 mt-1">What a payment in this group is for. These replace the usual expense categories, which this group never uses.</p>
      </div>

      {!canEdit && <p className="text-xs font-bold rounded-xl bg-amber-50 text-amber-800 px-3 py-2">Only the group's owner and admins can change these.</p>}
      {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

      <div className="bg-white border border-border-subtle rounded-2xl divide-y divide-border-subtle">
        {list.map((c) => (
          <div key={c.id} className={clsx('flex items-center gap-3 px-4 py-3', c.hidden && 'opacity-55')}>
            <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: style.tint, color: style.dark }}>{glyph(c.icon)}</span>
            {editingId === c.id ? (
              <input
                autoFocus
                value={editName}
                maxLength={40}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => rename(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') rename(c.id); if (e.key === 'Escape') setEditingId(null); }}
                className="flex-1 min-w-0 h-9 px-3 rounded-lg border border-border-subtle text-sm font-bold outline-none focus:border-primary"
              />
            ) : (
              <span className={clsx('flex-1 min-w-0 text-sm font-bold text-on-surface truncate', c.hidden && 'line-through')}>{c.name}</span>
            )}
            {canEdit && editingId !== c.id && (
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" onClick={() => { setEditingId(c.id); setEditName(c.name); }} aria-label={`Rename ${c.name}`} className="p-2 text-text-muted hover:text-primary rounded-full">
                  <span className="material-symbols-outlined text-[20px]">edit</span>
                </button>
                <button type="button" onClick={() => toggleHidden(c.id)} aria-label={c.hidden ? `Show ${c.name}` : `Hide ${c.name}`} className="p-2 text-text-muted hover:text-primary rounded-full">
                  <span className="material-symbols-outlined text-[20px]">{c.hidden ? 'visibility' : 'visibility_off'}</span>
                </button>
                {c.custom && (
                  <button type="button" onClick={() => remove(c.id)} aria-label={`Remove ${c.name}`} className="p-2 text-error/80 hover:text-error rounded-full">
                    <span className="material-symbols-outlined text-[20px]">delete</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="bg-white border border-border-subtle rounded-2xl p-4 space-y-2">
          <p className="text-[11px] font-black uppercase tracking-wider text-text-muted">Add your own</p>
          <div className="flex items-center gap-2">
            <CategoryIconPicker value={newIcon} onChange={setNewIcon} />
            <input
              value={newName}
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder="e.g. Pocket money, Insurance, Tuition"
              className="flex-1 h-10 px-3 rounded-xl border border-border-subtle text-sm outline-none focus:border-primary"
            />
            <button type="button" onClick={add} disabled={!newName.trim()} className="h-10 px-4 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-50 shrink-0">Add</button>
          </div>
          <button type="button" onClick={() => { if (window.confirm('Go back to the standard list (Rent, Maintenance, Salary, EMI, Fees, Other)? Categories you added will be removed from the list.')) save(DEFAULT_PAYMENT_CATEGORIES); }} className="text-[11px] font-bold text-text-muted underline pt-1">Reset to the standard list</button>
        </div>
      )}
    </div>
  );
}
