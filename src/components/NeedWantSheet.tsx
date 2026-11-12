import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLanguage } from '../context/LanguageContext';
import CategoryBadge from './CategoryBadge';
import {
  CategoryClassification,
  getCategoryClassification,
  getCategoryNameOverride,
  getGroupCategories,
} from '../lib/constants';

// "Needs and wants": two buckets, and each of the group's spending categories lives in one of them. Drag a category across (finger or mouse),
// or just tap it to send it to the other side. The choice is saved on the group (groups/{id}.categoryClassification) and is what the
// Need / Want filter and chart elsewhere in the app use. "Need" is stored as 'essential' and "Want" as 'optional'.
type Bucket = 'need' | 'want';
const toBucket = (c: CategoryClassification): Bucket => (c === 'essential' ? 'need' : 'want');
const toClass = (b: Bucket): CategoryClassification => (b === 'need' ? 'essential' : 'optional');

export default function NeedWantSheet({ groupId, group, onClose }: { groupId: string; group: any; onClose: () => void }) {
  const { t } = useLanguage();
  const categories = useMemo(() => getGroupCategories(group, 'expense'), [group]);
  const nameOf = (id: string, fallbackName?: string) => getCategoryNameOverride(group, id) || (fallbackName && id.startsWith('custom') ? fallbackName : t(`category.${id}`));

  // what is shown right now: the saved choice, with whatever was just moved applied at once (the saved copy catches up a moment later)
  const [local, setLocal] = useState<Record<string, Bucket>>({});
  const bucketOf = (id: string): Bucket => local[id] || toBucket(getCategoryClassification(group, id));
  useEffect(() => { setLocal({}); }, [group?.categoryClassification]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const move = async (id: string, to: Bucket) => {
    if (bucketOf(id) === to) return;
    setLocal((prev) => ({ ...prev, [id]: to }));
    setSaveError(null);
    try {
      await updateDoc(doc(db, 'groups', groupId), { [`categoryClassification.${id}`]: toClass(to) });
    } catch (err) {
      console.error('Could not save the need/want choice:', err);
      setLocal((prev) => { const n = { ...prev }; delete n[id]; return n; });
      setSaveError('Could not save that. Check your connection and try again.');
    }
  };
  const resetAll = async () => {
    setLocal({});
    try { await updateDoc(doc(db, 'groups', groupId), { categoryClassification: deleteField() }); } catch (err) { console.error('Could not reset:', err); }
  };

  // --- dragging: a ghost chip follows the pointer; the bucket under it lights up; letting go there moves the category ---
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: Bucket | null } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const bucketAt = (x: number, y: number): Bucket | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-bucket]') as HTMLElement | null;
    return (el?.dataset.bucket as Bucket) || null;
  };
  const onPointerDown = (e: React.PointerEvent, id: string) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return;
    d.moved = true;
    setDrag({ id: d.id, x: e.clientX, y: e.clientY, over: bucketAt(e.clientX, e.clientY) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      // a tap: send it to the other side
      move(d.id, bucketOf(d.id) === 'need' ? 'want' : 'need');
    } else {
      const to = bucketAt(e.clientX, e.clientY);
      if (to) move(d.id, to);
    }
    setDrag(null);
  };
  const cancelDrag = () => { dragRef.current = null; setDrag(null); };

  const need = categories.filter((c) => bucketOf(c.id) === 'need');
  const want = categories.filter((c) => bucketOf(c.id) === 'want');

  const chip = (c: { id: string; name: string; icon: string }) => (
    <div
      key={c.id}
      onPointerDown={(e) => onPointerDown(e, c.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag}
      role="button"
      tabIndex={0}
      aria-label={`${nameOf(c.id, c.name)}. Tap to move to ${bucketOf(c.id) === 'need' ? 'Want' : 'Need'}, or drag.`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); move(c.id, bucketOf(c.id) === 'need' ? 'want' : 'need'); } }}
      className={clsx(
        'inline-flex items-center gap-2 rounded-full bg-white border border-border-subtle shadow-sm pl-1.5 pr-3.5 py-1.5 select-none cursor-grab active:cursor-grabbing transition-opacity',
        drag?.id === c.id && 'opacity-30',
      )}
      style={{ touchAction: 'none' }}
    >
      <CategoryBadge id={c.id} icon={c.icon} size={28} />
      <span className="text-[13px] font-bold text-primary whitespace-nowrap">{nameOf(c.id, c.name)}</span>
    </div>
  );

  const zone = (b: Bucket, title: string, hint: string, list: typeof categories, tone: { bg: string; border: string; head: string }) => (
    <div
      data-bucket={b}
      className={clsx('rounded-2xl border-2 border-dashed p-3 min-h-[120px] transition-all', drag?.over === b ? 'scale-[1.01]' : '')}
      style={{ background: tone.bg, borderColor: drag?.over === b ? tone.head : tone.border }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-sm font-extrabold" style={{ color: tone.head }}>{title} <span className="text-xs font-bold opacity-70">· {list.length}</span></p>
        <p className="text-[11px] font-semibold text-text-muted">{hint}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {list.map(chip)}
        {list.length === 0 && <p className="text-xs text-text-muted py-3 px-1">Drop categories here.</p>}
      </div>
    </div>
  );

  const ghostCat = drag ? categories.find((c) => c.id === drag.id) : null;
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center sm:p-4 bg-black/45" onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded-t-[28px] sm:rounded-3xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 shrink-0">
          <div className="w-10 h-1.5 rounded-full bg-border-subtle mx-auto mb-3 sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-extrabold text-primary">Needs and wants</h3>
              <p className="text-xs text-text-muted mt-0.5">Drag a category to the side it belongs to, or just tap it to move it across.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 shrink-0 rounded-full bg-surface-container flex items-center justify-center text-text-muted">
              <span className="material-symbols-outlined text-[19px]">close</span>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-3 bg-[#f6f9fb] pt-3 border-t border-border-subtle">
          {zone('need', 'Need', 'Rent, groceries, bills', need, { bg: '#effcf8', border: '#b9ece0', head: '#0b6b5a' })}
          {zone('want', 'Want', 'Nice to have', want, { bg: '#fff7e6', border: '#f6d9a6', head: '#a05a00' })}
          {saveError && <p className="text-xs text-error font-bold text-center">{saveError}</p>}
        </div>
        <div className="px-5 py-3 shrink-0 border-t border-border-subtle bg-white flex items-center gap-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={resetAll} className="text-xs font-bold text-text-muted underline">Reset to suggested</button>
          <button type="button" onClick={onClose} className="ml-auto h-11 px-8 rounded-2xl bg-primary text-white font-extrabold text-sm active:scale-[0.98]">Done</button>
        </div>
      </div>
      {drag && ghostCat && (
        <div className="fixed pointer-events-none z-[310] inline-flex items-center gap-2 rounded-full bg-white shadow-xl border border-border-subtle pl-1.5 pr-3.5 py-1.5" style={{ left: drag.x, top: drag.y, transform: 'translate(-50%, -120%)' }}>
          <CategoryBadge id={ghostCat.id} icon={ghostCat.icon} size={28} />
          <span className="text-[13px] font-bold text-primary whitespace-nowrap">{nameOf(ghostCat.id, ghostCat.name)}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
