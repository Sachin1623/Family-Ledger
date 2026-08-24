import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { EXPENSE_CATEGORIES } from '../lib/constants';
import Comments from './Comments';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { useAuth } from '../context/AuthContext';
import { parseLocalDate } from '../lib/dateUtils';
import ImageLightbox from './ImageLightbox';
import { useLanguage } from '../context/LanguageContext';

const CATEGORIES = EXPENSE_CATEGORIES;

// A lightweight, read-only "floating" preview of a single expense — opens directly over
// whatever screen the user is on (e.g. the Dashboard), with no page navigation. Full
// editing/deleting still happens via the "Edit in Group" link through to GroupExpenses.
export default function ExpenseQuickView({
  expense,
  groupId,
  currencySymbol,
  payerName,
  payerPhoto,
  members,
  onClose,
  returnTo,
}: {
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
}) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const category = CATEGORIES.find((c) => c.id === expense.category);
  const [lightboxSrc, setLightboxSrc] = React.useState<string | null>(null);

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
              <p className="text-2xl font-black text-primary shrink-0">
                {currencySymbol}{expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
            </div>

            {expense.images?.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {expense.images.map((src: string, i: number) => (
                  <button key={i} type="button" onClick={() => setLightboxSrc(src)}>
                    <img src={src} alt="" className="w-20 h-20 object-cover rounded-xl border border-border-subtle" />
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface p-3 rounded-xl border border-border-subtle">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('common.category')}</p>
                <div className="flex items-center gap-1.5">
                  <span className="text-base">{category?.icon || '🧾'}</span>
                  <span className="text-sm font-bold text-primary">{category ? t(`category.${category.id}`) : expense.category}</span>
                </div>
              </div>
              <div className="bg-surface p-3 rounded-xl border border-border-subtle">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('addExpense.paidBy')}</p>
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[9px] font-bold text-primary">
                    {payerPhoto ? <img src={payerPhoto} alt="" className="w-full h-full object-cover" /> : payerName.slice(0, 1)}
                  </div>
                  <span className="text-sm font-bold text-primary truncate">{payerName}</span>
                </div>
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

          <div className="p-4 border-t border-border-subtle shrink-0">
            <button
              onClick={() => navigate(`/groups/${groupId}/expenses`, { state: { openExpenseId: expense.id, ...(returnTo ? { returnTo } : {}) } })}
              className="w-full h-12 border-2 border-border-subtle text-primary font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              {t('groupExpenses.editOrDeleteInGroupExpenses')}
            </button>
          </div>
        </motion.div>

        {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </div>
    </AnimatePresence>
  );
}
