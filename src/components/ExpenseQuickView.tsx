import React, { Suspense } from 'react';
import CategoryBadge from './CategoryBadge';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCategoryNameOverride, getCategoryIcon, getGroupCategories } from '../lib/constants';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { KindBadge } from './GroupPicker';
import { changeAmount, changeCategory, deleteExpense, loadMoveTargets, moveToGroup, NeedsEditor } from '../lib/expenseQuickEdit';
import Comments from './Comments';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { useAuth } from '../context/AuthContext';
import { parseLocalDate } from '../lib/dateUtils';
import ImageLightbox from './ImageLightbox';
import { useLanguage } from '../context/LanguageContext';
import { resizeImageFile } from '../lib/imageUtils';

const MAX_PHOTOS = 3;
const MAX_TOTAL_BYTES = 900_000; // same Firestore document-size margin ImageAttachments uses

// Loaded only when someone taps Edit: the edit window is the Group Expenses screen's own form, opened by itself over the current screen.
const GroupExpensesEditor = React.lazy(() => import('../screens/GroupExpenses'));

const CATEGORIES = EXPENSE_CATEGORIES;

// A lightweight, read-only "floating" preview of a single expense — opens directly over
// whatever screen the user is on (e.g. the Dashboard), with no page navigation. Full
// editing/deleting still happens via the "Edit in Group" link through to GroupExpenses.
export default function ExpenseQuickView({
  expense: expenseProp,
  groupId,
  currencySymbol,
  payerName,
  payerPhoto,
  members,
  onClose,
  returnTo,
  editOnGroupPage,
  intent,
}: {
  // Opened from a row's swipe buttons: skip the read-only view and go straight to the edit window, which then moves the expense or deletes it.
  intent?: 'edit' | 'move' | 'delete' | 'amount' | 'category';
  expense: any;
  groupId: string;
  currencySymbol: string;
  payerName: string;
  payerPhoto?: string;
  members: any[];
  onClose: () => void;
  // Where the edit modal should send the user back to once they're done (save/delete/cancel),
  // if this quick view was opened from somewhere other than the Group Expenses page itself — e.g.
  // a Dashboard group tile's "Latest spend" row. Omit when opened FROM that page (GroupExpenses.tsx
  // itself, browsing its own list) so finishing an edit there just closes the modal as it always
  // has, rather than navigating anywhere.
  returnTo?: string;
  // The Group Expenses page itself sets this: its own edit window is already part of that page, so Edit goes there (as it always did).
  // Everywhere else, Edit opens the edit window right here, floating over the current screen.
  editOnGroupPage?: boolean;
}) {
  const [editingHere, setEditingHere] = React.useState(!!intent);
  // which field the edit window should jump to, when it was opened from a "tap to change" hint
  const [editIntent, setEditIntent] = React.useState<typeof intent>(intent);
  const openEditor = (focus?: 'amount' | 'category' | 'move') => { setEditIntent(focus); setEditingHere(true); };
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  // the live copy of this expense, so a change made here shows at once (the caller's copy can be a stale snapshot)
  const [liveExpense] = useDocument(doc(db, 'expenses', expenseProp.id));
  const expense = liveExpense?.exists() ? { ...expenseProp, ...liveExpense.data(), id: expenseProp.id } : expenseProp;
  const isIncome = expense.type === 'income';
  const category = (isIncome ? INCOME_CATEGORIES : CATEGORIES).find((c) => c.id === expense.category);
  // A custom category (or a renamed built-in) only exists in its group's own settings — the
  // built-in lists above can't resolve it, which used to leave the raw "custom_xxxx" id on screen
  // instead of the category's name.
  const [groupValue] = useDocument(doc(db, 'groups', groupId));
  const groupCategorySettings = groupValue?.data() as any;
  const categoryName =
    getCategoryNameOverride(groupCategorySettings, expense.category)
    || (category ? t(`${isIncome ? 'income' : 'category'}.${category.id}`) : null)
    || t('common.uncategorized');
  const categoryIcon = category?.icon || getCategoryIcon(groupCategorySettings, expense.category, isIncome ? 'income' : 'expense');
  const [lightboxSrc, setLightboxSrc] = React.useState<string | null>(null);

  // Only the person who added an expense, or a group admin, may change it (see firestore.rules), so only they see the hints and the + button.
  const myMember = members.find((m) => m.userId === user?.uid);
  const canEdit = !!user && (expense.addedBy === user.uid || myMember?.role === 'admin' || myMember?.role === 'owner');
  const [photos, setPhotos] = React.useState<string[]>(expense.images || []);
  React.useEffect(() => { setPhotos(expense.images || []); }, [expense.id, (expense.images || []).length]);
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const addPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files || []);
    e.target.value = '';
    const room = MAX_PHOTOS - photos.length;
    if (files.length === 0 || room <= 0) return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      const resized = await Promise.all(files.slice(0, room).map((f) => resizeImageFile(f, 900, 900, 0.5)));
      const next = [...photos, ...resized];
      if (next.reduce((sum, x) => sum + x.length, 0) > MAX_TOTAL_BYTES) {
        setPhotoError('These photos are too large even after compression. Try fewer or smaller ones.');
        return;
      }
      await updateDoc(doc(db, 'expenses', expense.id), { images: next });
      setPhotos(next);
    } catch (err) {
      console.error('Could not add the photo:', err);
      setPhotoError('Could not save the photo. Only the person who added this expense or a group admin can change it.');
    } finally {
      setPhotoBusy(false);
    }
  };
  const hint = () => <span className="text-[#0b6b5a] flex items-center" aria-label="Tap to change"><span className="material-symbols-outlined text-[16px]">edit</span></span>;
  const canMoveGroup = canEdit && !expense.splitInfo;

  // Small one-field pop-ups: tap an option and it is saved right away, no edit window.
  const [popup, setPopup] = React.useState<null | 'amount' | 'category' | 'group'>(null);
  const [busy, setBusy] = React.useState(false);
  const [popupError, setPopupError] = React.useState<string | null>(null);
  const [amountInput, setAmountInput] = React.useState('');
  const [moveTargets, setMoveTargets] = React.useState<any[] | null>(null);
  const actor = { uid: user?.uid || '', name: profile?.displayName || user?.displayName || 'Someone', photo: profile?.photoURL || user?.photoURL || '' };
  const openPopup = (which: 'amount' | 'category' | 'group') => {
    setPopupError(null);
    if (which === 'amount') setAmountInput(String(expense.amount));
    if (which === 'group' && !moveTargets && user) {
      loadMoveTargets(user.uid, expense.groupId).then((g) => setMoveTargets(g.filter((x: any) => x.groupType !== 'payments'))).catch(() => setMoveTargets([]));
    }
    setPopup(which);
  };
  const run = async (job: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setPopupError(null);
    try {
      await job();
      setPopup(null);
      after?.();
    } catch (err: any) {
      if (err instanceof NeedsEditor) { setPopup(null); setEditIntent('amount'); setEditingHere(true); return; }
      console.error('Quick change failed:', err);
      setPopupError(err?.code === 'permission-denied' ? 'Only the person who added this expense or a group admin can change it.' : (err?.message || 'Could not save the change.'));
    } finally {
      setBusy(false);
    }
  };
  const pickCategory = (id: string) => { if (id === expense.category) { setPopup(null); return; } run(() => changeCategory(expense, id, actor)); };
  const saveAmount = () => {
    const v = evaluateAmountSum(amountInput);
    if (!v || v <= 0) { setPopupError('Enter an amount above zero.'); return; }
    if (Math.abs(v - expense.amount) < 0.005) { setPopup(null); return; }
    run(() => changeAmount(expense, v, actor));
  };
  const pickGroup = (target: any) => {
    const cats = getGroupCategories(target, 'expense');
    const keep = cats.some((c) => c.id === expense.category) ? expense.category : (cats.find((c) => c.id === 'misc')?.id || cats[0]?.id || expense.category);
    run(() => moveToGroup(expense, target, keep, actor), onClose);
  };
  const removeExpense = () => {
    if (!window.confirm('Delete this expense?')) return;
    run(() => deleteExpense(expense, actor), onClose);
  };

  if (editingHere) {
    return (
      <Suspense fallback={<div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center"><span className="material-symbols-outlined text-white text-4xl animate-spin">progress_activity</span></div>}>
        <GroupExpensesEditor embedded={{ expenseId: expense.id, groupId, onClose, intent: editIntent === 'edit' ? undefined : editIntent }} />
      </Suspense>
    );
  }

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        >
          <div className="p-6 border-b border-border-subtle flex justify-between items-center shrink-0">
            <h2 className="text-lg font-bold text-primary">{t('common.expense')}</h2>
            <button onClick={onClose} className="p-2 hover:bg-surface rounded-full">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-bold text-primary break-words">{expense.description}</p>
                <p className="text-xs text-text-muted mt-1">
                  {parseLocalDate(expense.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              {canEdit ? (
                <button type="button" onClick={() => openPopup('amount')} className="shrink-0 text-right active:scale-95 transition-transform">
                  <span className="block text-2xl font-black text-primary">{currencySymbol}{expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  <span className="flex justify-end mt-0.5">{hint()}</span>
                </button>
              ) : (
                <p className="text-2xl font-black text-primary shrink-0">
                  {currencySymbol}{expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              )}
            </div>

            {groupCategorySettings?.name && (
              canMoveGroup ? (
                <button type="button" onClick={() => openPopup('group')} className="w-full flex items-center justify-between gap-2 bg-surface px-3 py-2.5 rounded-xl border border-border-subtle text-left active:scale-[0.98] transition-transform">
                  <span className="min-w-0">
                    <span className="block text-[10px] font-bold text-text-muted uppercase tracking-wider">Group</span>
                    <span className="block text-sm font-bold text-primary truncate">{groupCategorySettings.name}</span>
                  </span>
                  {hint()}
                </button>
              ) : (
                <div className="bg-surface px-3 py-2.5 rounded-xl border border-border-subtle">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Group</p>
                  <p className="text-sm font-bold text-primary truncate">{groupCategorySettings.name}</p>
                </div>
              )
            )}

            {(photos.length > 0 || canEdit) && (
              <div>
                <div className="flex flex-wrap gap-2">
                  {photos.map((src: string, i: number) => (
                    <button key={i} type="button" onClick={() => setLightboxSrc(src)}>
                      <img src={src} alt="" className="w-20 h-20 object-cover rounded-xl border border-border-subtle" />
                    </button>
                  ))}
                  {canEdit && photos.length < MAX_PHOTOS && (
                    <label className={`w-20 h-20 rounded-xl border-2 border-dashed border-border-subtle flex flex-col items-center justify-center gap-0.5 text-primary active:scale-95 transition-transform ${photoBusy ? 'opacity-60' : 'cursor-pointer'}`}>
                      <span className="material-symbols-outlined text-[26px]">{photoBusy ? 'progress_activity' : 'add'}</span>
                      <span className="text-[9px] font-bold">{photoBusy ? 'Saving…' : `${photos.length}/${MAX_PHOTOS}`}</span>
                      <input type="file" accept="image/*" multiple className="hidden" onChange={addPhotos} disabled={photoBusy} />
                    </label>
                  )}
                </div>
                {photoError && <p className="text-[11px] text-error font-bold mt-1">{photoError}</p>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div
                role={canEdit ? 'button' : undefined}
                onClick={canEdit ? () => openPopup('category') : undefined}
                className={`bg-surface p-3 rounded-xl border border-border-subtle ${canEdit ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''}`}
              >
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('common.category')}</p>
                <div className="flex items-center gap-1.5">
                  <CategoryBadge id={expense.category} icon={categoryIcon === '❓' ? '🧾' : categoryIcon} size={28} />
                  <span className="text-sm font-bold text-primary break-words min-w-0">{categoryName}</span>
                </div>
                {canEdit && <div className="mt-1.5">{hint()}</div>}
              </div>
              <div className="bg-surface p-3 rounded-xl border border-border-subtle">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('addExpense.paidBy')}</p>
                {/* Multiple payers (expense.payers) — resolved straight from the `members` prop
                    already passed in, rather than asking every caller to also compute a payers
                    list; the single-payer case below still uses the caller's own payerName/
                    payerPhoto (already resolved there, including the "me"/participant-name
                    fallbacks each caller already handles). */}
                {Array.isArray(expense.payers) && expense.payers.length > 0 ? (
                  <div className="space-y-1">
                    {expense.payers.map((p: any) => {
                      const m = members.find((mem) => mem.userId === p.userId);
                      const name = p.userId === user?.uid ? t('common.me') : (m?.displayName || t('common.unknown'));
                      return (
                        <div key={p.userId} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[9px] font-bold text-primary">
                            {m?.photoURL ? <img src={m.photoURL} alt="" className="w-full h-full object-cover" /> : name.slice(0, 1)}
                          </div>
                          <span className="text-sm font-bold text-primary truncate flex-1">{name}</span>
                          <span className="text-xs font-bold text-text-muted shrink-0">{currencySymbol}{(p.amount || 0).toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[9px] font-bold text-primary">
                      {payerPhoto ? <img src={payerPhoto} alt="" className="w-full h-full object-cover" /> : payerName.slice(0, 1)}
                    </div>
                    <span className="text-sm font-bold text-primary truncate">{payerName}</span>
                  </div>
                )}
              </div>
            </div>

            {expense.splitInfo?.splits?.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2">{t('addExpense.splitWith')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {expense.splitInfo.splits.map((s: any) => {
                    const m = members.find((mem) => mem.userId === s.userId);
                    return (
                      <div key={s.userId} className="flex items-center gap-1 bg-surface px-2 py-1 rounded-full border border-border-subtle">
                        <span className="text-[11px] font-bold text-primary">{m?.displayName || t('common.unknown')}</span>
                        <span className="text-[10px] text-text-muted">{currencySymbol}{(s.amount || 0).toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <Comments
              pathSegments={['expenses', expense.id, 'comments']}
              onPosted={(text) => notifyGroupActivity({
                groupId,
                action: 'commented',
                description: text,
                contextLabel: expense.description,
                actorName: profile?.displayName || user?.displayName || 'Someone',
                expenseId: expense.id,
              })}
            />
          </div>

          <div className="p-4 border-t border-border-subtle shrink-0 space-y-2">
            <button
              onClick={() => (editOnGroupPage ? navigate(`/groups/${groupId}/expenses`, { state: { openExpenseId: expense.id, ...(returnTo ? { returnTo } : {}) } }) : setEditingHere(true))}
              className="w-full h-12 border-2 border-border-subtle text-primary font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              {t('groupExpenses.editOrDeleteInGroupExpenses')}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={removeExpense}
                disabled={busy}
                className="w-full h-11 text-error font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                Delete expense
              </button>
            )}
          </div>

          {popup && (
            <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/40" onClick={() => !busy && setPopup(null)}>
              <div className="w-full bg-white rounded-t-3xl max-h-[80%] overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase tracking-wider text-text-muted">
                    {popup === 'amount' ? 'Change amount' : popup === 'category' ? 'Choose category' : 'Move to group'}
                  </p>
                  <button type="button" onClick={() => setPopup(null)} disabled={busy} aria-label="Close" className="p-1 text-text-muted">
                    <span className="material-symbols-outlined text-[20px]">close</span>
                  </button>
                </div>

                {popup === 'amount' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 rounded-2xl border-2 border-primary/30 bg-surface px-3 py-2">
                      <span className="text-xl font-black text-text-muted">{currencySymbol}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoFocus
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value.replace(/[^0-9.+-]/g, ''))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveAmount(); }}
                        className="flex-1 min-w-0 bg-transparent text-2xl font-black text-primary outline-none"
                      />
                      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setAmountInput((v) => (v ? v.replace(/[+-]$/, '') + '+' : v))} aria-label="Add another amount" className="shrink-0 w-10 h-10 rounded-xl bg-success/10 text-success text-2xl font-black leading-none flex items-center justify-center active:scale-90">
                        +
                      </button>
                      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setAmountInput((v) => (v ? v.replace(/[+-]$/, '') + '-' : v))} aria-label="Subtract an amount" className="shrink-0 w-10 h-10 rounded-xl bg-error/10 text-error text-2xl font-black leading-none flex items-center justify-center active:scale-90">
                        −
                      </button>
                    </div>
                    {hasAmountSumOperator(amountInput) && evaluateAmountSum(amountInput) !== null && (
                      <p className="text-xs font-bold text-success px-1">= {currencySymbol}{evaluateAmountSum(amountInput)!.toFixed(2)}</p>
                    )}
                    {expense.splitInfo && <p className="text-[11px] text-text-muted px-1">The shares update to match the new amount.</p>}
                    <button type="button" onClick={saveAmount} disabled={busy} className="w-full h-12 bg-primary text-white font-bold rounded-2xl text-sm disabled:opacity-50 active:scale-[0.98] transition-transform">
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}

                {popup === 'category' && (
                  <div className="grid grid-cols-4 gap-2">
                    {getGroupCategories(groupCategorySettings, isIncome ? 'income' : 'expense').map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={busy}
                        onClick={() => pickCategory(c.id)}
                        className={`p-2 rounded-xl border flex flex-col items-center gap-1 active:scale-95 transition-transform disabled:opacity-50 ${expense.category === c.id ? 'bg-primary border-primary text-white' : 'bg-white border-border-subtle text-primary'}`}
                      >
                        <CategoryBadge id={c.id} icon={c.icon} size={30} />
                        <span className="text-[10px] font-bold leading-tight text-center line-clamp-2 w-full">
                          {getCategoryNameOverride(groupCategorySettings, c.id) || t(`${isIncome ? 'income' : 'category'}.${c.id}`)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {popup === 'group' && (
                  <div className="-mx-5">
                    {moveTargets === null && <p className="px-5 py-4 text-sm text-text-muted">Loading your groups…</p>}
                    {moveTargets?.length === 0 && <p className="px-5 py-4 text-sm text-text-muted">You have no other group to move this to.</p>}
                    {moveTargets?.map((g) => (
                      <button key={g.id} type="button" disabled={busy} onClick={() => pickGroup(g)} className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border-subtle text-left active:bg-surface disabled:opacity-50">
                        <KindBadge group={g} />
                        <span className="flex-1 min-w-0 truncate text-base font-bold text-primary">{g.name}</span>
                      </button>
                    ))}
                  </div>
                )}

                {busy && popup !== 'amount' && <p className="text-xs font-bold text-text-muted text-center">Saving…</p>}
                {popupError && <p className="text-xs font-bold text-error">{popupError}</p>}
              </div>
            </div>
          )}
        </motion.div>

        {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </div>
    </AnimatePresence>
  );
}
