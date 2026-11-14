import React, { useEffect, useState } from 'react';
import { doc, getDoc, setDoc, updateDoc, deleteField } from 'firebase/firestore';
import { motion } from 'motion/react';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useLanguage } from '../context/LanguageContext';
import { EXPENSE_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import CategoryBadge, { CATEGORY_STYLE } from './CategoryBadge';

// The one "Split by category" sheet, used from both the group's Manage screen and the group quick-actions menu,
// so the two can never look or behave differently again. The saved value is always a percentage of the month's
// budget (0-100 per category, need not add up to 100); the Percent/Amount toggle only changes how a row is typed.
export const RECOMMENDED_SPLIT: Record<string, number> = {
  housing: 21, groceries: 13, finance: 12, bills: 9, food: 7, travel: 7, education: 6, health: 5, ent: 4,
  personal: 3, kids: 3, shopping: 3, household: 3, gifts: 2, misc: 2,
};

interface Props {
  groupId: string;
  group: any;
  budget: { amount: number; categoryAllocations?: Record<string, number> };
  budgetDocId: string;
  previousMonthKey: string;
  onClose: () => void;
  /** called after a successful save, before the sheet closes */
  onSaved?: () => void | Promise<void>;
}

export default function CategorySplitSheet({ groupId, group, budget, budgetDocId, previousMonthKey, onClose, onSaved }: Props) {
  const { t } = useLanguage();
  const [categoryInputMode, setCategoryInputMode] = useState<'pct' | 'amount'>('pct');
  const [categoryPcts, setCategoryPcts] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolledOverFromLastMonth, setRolledOverFromLastMonth] = useState(false);
  // 'default' = filled from the group's saved default split; 'saved' = this month's own split; null = nothing yet
  const [splitSource, setSplitSource] = useState<'default' | 'saved' | null>(null);
  const [makeSplitDefault, setMakeSplitDefault] = useState(false);
  const [lastMonthSplit, setLastMonthSplit] = useState<Record<string, number> | null>(null);

  const categoryPctTotal: number = (Object.values(categoryPcts) as number[]).reduce((s: number, v: number) => s + (v || 0), 0);

  // Start-up: what the sheet is pre-filled with. Pre-filled only, never auto-saved.
  useEffect(() => {
    let cancelled = false;
    const thisMonth = budget?.categoryAllocations;
    const groupDefault = group?.defaultCategoryAllocations as Record<string, number> | undefined;
    // last month's split is looked up either way, so it is offered as a one-tap choice
    getDoc(doc(db, 'groupBudgets', `${groupId}_${previousMonthKey}`))
      .then((snap) => {
        if (cancelled) return;
        const prev = snap.data()?.categoryAllocations as Record<string, number> | undefined;
        if (prev && Object.keys(prev).length > 0) {
          setLastMonthSplit(prev);
          // no split yet and no default: roll last month's split forward in the same ratio
          if (!(thisMonth && Object.keys(thisMonth).length > 0) && !(groupDefault && Object.keys(groupDefault).length > 0)) {
            setCategoryPcts(prev);
            setRolledOverFromLastMonth(true);
          }
        }
      })
      .catch((err) => console.error('Failed to look up last month\'s category split:', err));
    if (thisMonth && Object.keys(thisMonth).length > 0) {
      setCategoryPcts(thisMonth);
      setSplitSource('saved');
    } else if (groupDefault && Object.keys(groupDefault).length > 0) {
      setCategoryPcts(groupDefault);
      setSplitSource('default');
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySplitPreset = (kind: 'recommended' | 'even' | 'last' | 'default' | 'clear') => {
    setError(null);
    if (kind === 'clear') { setCategoryPcts({}); return; }
    if (kind === 'recommended') { setCategoryPcts({ ...RECOMMENDED_SPLIT }); return; }
    if (kind === 'even') {
      const each = 100 / EXPENSE_CATEGORIES.length;
      const next: Record<string, number> = {};
      EXPENSE_CATEGORIES.forEach((c) => { next[c.id] = each; });
      setCategoryPcts(next);
      return;
    }
    if (kind === 'last' && lastMonthSplit) { setCategoryPcts({ ...lastMonthSplit }); return; }
    if (kind === 'default') {
      const d = group?.defaultCategoryAllocations as Record<string, number> | undefined;
      if (d) setCategoryPcts({ ...d });
    }
  };

  const handleSave = async () => {
    if (saving) return;
    // A tiny epsilon above 100 tolerates float drift from amount-mode entries (e.g. three categories each
    // converted from a rupee amount can land at 100.0001) without rejecting a save at exactly 100%.
    if (categoryPctTotal > 100.5) { setError(t('manageGroup.categoryBudgetOver100')); return; }
    setSaving(true);
    setError(null);
    try {
      // 4 decimal places, not a whole percent, so an exact amount (e.g. ₹68,000 of ₹150,000 = 45.3333%) round-trips.
      // Zero/blank entries are dropped so an unallocated category has no entry at all.
      const rounded: Record<string, number> = {};
      Object.entries(categoryPcts).forEach(([catId, pct]: [string, number]) => {
        const r = Math.round(pct * 10000) / 10000;
        if (r > 0) rounded[catId] = r;
      });
      await setDoc(doc(db, 'groupBudgets', budgetDocId), { categoryAllocations: rounded }, { merge: true });
      if (makeSplitDefault) {
        try {
          await updateDoc(doc(db, 'groups', groupId), { defaultCategoryAllocations: rounded });
        } catch (err) {
          console.error('Saved the split but could not save it as the default:', err);
        }
      }
      if (onSaved) await onSaved();
      onClose();
    } catch (err) {
      console.error('Failed to save category budget:', err);
      setError(t('manageGroup.failedToSaveBudget'));
    } finally {
      setSaving(false);
    }
  };

  const sym = getCurrencySymbol(group?.currency);
  const money = (n: number) => `${sym}${Math.round(n).toLocaleString()}`;
  const allocatedAmt = (budget.amount * categoryPctTotal) / 100;
  const leftAmt = (budget.amount * Math.max(0, 100 - categoryPctTotal)) / 100;
  const over = categoryPctTotal > 100.5;
  const hasDefault = !!group?.defaultCategoryAllocations && Object.keys(group.defaultCategoryAllocations).length > 0;
  const segs = EXPENSE_CATEGORIES.filter((c) => (categoryPcts[c.id] || 0) > 0);
  const chip = 'shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-white px-3 py-1.5 text-xs font-extrabold text-primary active:scale-95 transition-transform';

  return (
    <div className="fixed inset-0 z-[320] flex items-end sm:items-center justify-center sm:p-4 bg-black/45" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        className="bg-white w-full max-w-md rounded-t-[28px] sm:rounded-3xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: what is being split, how much is placed, how much is left, and the quick starting points */}
        <div className="px-5 pt-4 pb-3 space-y-3 shrink-0">
          <div className="w-10 h-1.5 rounded-full bg-border-subtle mx-auto sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-extrabold text-primary">Split by category</h3>
              <p className="text-xs text-text-muted mt-0.5">Decide how much of {money(budget.amount)} each kind of spending gets. Leaving some unplaced is fine.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 shrink-0 rounded-full bg-surface-container flex items-center justify-center text-text-muted">
              <span className="material-symbols-outlined text-[19px]">close</span>
            </button>
          </div>

          {/* the whole budget as one bar, coloured by category */}
          <div>
            <div className="h-3 rounded-full bg-surface-container overflow-hidden flex">
              {segs.map((c) => (
                <div key={c.id} style={{ width: `${Math.min(100, categoryPctTotal > 100 ? ((categoryPcts[c.id] || 0) / categoryPctTotal) * 100 : (categoryPcts[c.id] || 0))}%`, background: CATEGORY_STYLE[c.id]?.color || '#64748b' }} />
              ))}
            </div>
            <div className="flex items-center justify-between mt-1.5 text-xs">
              <span className="font-bold text-text-muted">Placed <b className="text-primary">{money(allocatedAmt)}</b> · {Math.round(categoryPctTotal)}%</span>
              <span className={clsx('font-extrabold', over ? 'text-error' : 'text-[#0b6b5a]')}>{over ? `${money((budget.amount * (categoryPctTotal - 100)) / 100)} over` : `${money(leftAmt)} left`}</span>
            </div>
          </div>

          {/* quick starting points */}
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-5 px-5 pb-0.5">
            <button type="button" onClick={() => applySplitPreset('recommended')} className={chip}><span className="material-symbols-outlined text-[16px] text-[#12b89a]">auto_awesome</span>Recommended</button>
            <button type="button" onClick={() => applySplitPreset('even')} className={chip}><span className="material-symbols-outlined text-[16px] text-[#12b89a]">equalizer</span>Even split</button>
            {lastMonthSplit && <button type="button" onClick={() => applySplitPreset('last')} className={chip}><span className="material-symbols-outlined text-[16px] text-[#12b89a]">history</span>Last month</button>}
            {hasDefault && <button type="button" onClick={() => applySplitPreset('default')} className={chip}><span className="material-symbols-outlined text-[16px] text-[#12b89a]">bookmark</span>My default</button>}
            <button type="button" onClick={() => applySplitPreset('clear')} className={clsx(chip, 'text-text-muted')}>Clear</button>
          </div>
          {(rolledOverFromLastMonth || splitSource === 'default') && (
            <p className="text-[11px] font-bold text-[#0b6b5a] bg-[#effcf8] rounded-xl px-3 py-1.5 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px] shrink-0">{splitSource === 'default' ? 'bookmark' : 'history'}</span>
              {splitSource === 'default' ? 'Filled in from your default split. Change anything, then Save.' : t('manageGroup.categoryBudgetRolledOver')}
            </p>
          )}

          {/* % or amount */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-text-muted">Enter as</span>
            <div className="flex items-center bg-surface-container rounded-xl p-0.5">
              {(['pct', 'amount'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setCategoryInputMode(mode)}
                  className={clsx('px-4 py-1.5 rounded-[10px] text-xs font-extrabold transition-all', categoryInputMode === mode ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}
                >
                  {mode === 'pct' ? 'Percent' : `Amount (${sym})`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Categories: each one a card with its icon, the amount it gets, and a slider in its own colour */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 border-t border-border-subtle bg-[#f6f9fb]">
          {EXPENSE_CATEGORIES.map((cat) => {
            const pct = categoryPcts[cat.id] || 0;
            const maxForThis = Math.max(0, Math.min(100, 100 - (categoryPctTotal - pct)));
            const displayValue = pct <= 0 ? '' : categoryInputMode === 'pct' ? String(Math.round(pct)) : String(Math.round((budget.amount * pct) / 100));
            const setPct = (nextPct: number) => {
              setCategoryPcts((prev) => ({ ...prev, [cat.id]: Math.max(0, Math.min(maxForThis, nextPct)) }));
              setError(null);
            };
            const sliderMax = categoryInputMode === 'pct' ? 100 : Math.round((budget.amount * maxForThis) / 100);
            const sliderValue = categoryInputMode === 'pct' ? Math.round(Math.min(pct, maxForThis)) : Math.round((budget.amount * Math.min(pct, maxForThis)) / 100);
            const handleSliderChange = (raw: number) => setPct(categoryInputMode === 'pct' ? raw : budget.amount > 0 ? (raw / budget.amount) * 100 : 0);
            const color = CATEGORY_STYLE[cat.id]?.color || '#64748b';
            return (
              <div key={cat.id} className={clsx('rounded-2xl bg-white border p-3 space-y-1.5 transition-colors', pct > 0 ? 'border-transparent shadow-sm' : 'border-border-subtle opacity-80')} style={pct > 0 ? { boxShadow: `inset 3px 0 0 ${color}, 0 1px 2px rgba(0,0,0,0.05)` } : undefined}>
                <div className="flex items-center gap-2.5">
                  <CategoryBadge id={cat.id} icon={cat.icon} size={34} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-extrabold text-primary truncate">{t(`category.${cat.id}`)}</p>
                    <p className="text-[11px] text-text-muted">{pct > 0 ? (categoryInputMode === 'pct' ? money((budget.amount * pct) / 100) : `${Math.round(pct)}% of budget`) : 'Not set'}</p>
                  </div>
                  <div className="relative shrink-0 w-[92px]">
                    {categoryInputMode === 'amount' && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-text-muted">{sym}</span>}
                    <input
                      type="text"
                      inputMode="decimal"
                      value={displayValue}
                      onChange={(e) => {
                        const raw = Number(e.target.value.replace(/[^0-9.]/g, '')) || 0;
                        setPct(categoryInputMode === 'pct' ? raw : budget.amount > 0 ? (raw / budget.amount) * 100 : 0);
                      }}
                      placeholder="0"
                      className={clsx('w-full h-10 bg-surface border border-border-subtle rounded-xl text-sm font-extrabold text-primary outline-none text-right focus:border-[#12b89a]', categoryInputMode === 'amount' ? 'pl-6 pr-2.5' : 'pr-7 pl-2.5')}
                    />
                    {categoryInputMode === 'pct' && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-text-muted">%</span>}
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  step={1}
                  value={sliderValue}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="w-full h-1.5"
                  style={{ accentColor: color }}
                  aria-label={t('manageGroup.categoryBudgetSliderLabel', { category: t(`category.${cat.id}`) })}
                />
              </div>
            );
          })}
        </div>

        {/* Footer: make it the default, then Save */}
        <div className="px-5 pt-3 pb-4 space-y-3 shrink-0 border-t border-border-subtle bg-white" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
          <button type="button" role="switch" aria-checked={makeSplitDefault} onClick={() => setMakeSplitDefault((v) => !v)} className="w-full flex items-center gap-3 text-left">
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-extrabold text-primary">Use this split every month</span>
              <span className="block text-[11px] text-text-muted">{hasDefault ? 'Replaces your saved default' : 'New months start with it. You can still change any month.'}</span>
            </span>
            <span className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', makeSplitDefault ? 'bg-[#12b89a]' : 'bg-[#cbd7df]')}>
              <span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', makeSplitDefault ? 'left-6' : 'left-1')} />
            </span>
          </button>
          {hasDefault && (
            <button
              type="button"
              onClick={async () => { try { await updateDoc(doc(db, 'groups', groupId), { defaultCategoryAllocations: deleteField() }); } catch (err) { console.error('Could not remove the default split:', err); } }}
              className="text-[11px] font-bold text-text-muted underline"
            >
              Remove my saved default
            </button>
          )}
          {error && <p className="text-xs text-error font-bold text-center">{error}</p>}
          {over && <p className="text-xs text-error font-bold text-center">The total is over 100%. Lower one of the categories to save.</p>}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || over}
            className="w-full h-12 bg-primary text-white font-extrabold rounded-2xl text-sm disabled:opacity-50 active:scale-[0.98] transition-transform"
          >
            {saving ? t('common.saving') : makeSplitDefault ? 'Save and use every month' : t('common.save')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
