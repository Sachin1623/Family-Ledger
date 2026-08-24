import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc, updateDoc, deleteDoc, deleteField, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import FrequencyPicker from '../components/FrequencyPicker';
import MonthCalendar from '../components/MonthCalendar';
import { FrequencyConfig, firstOccurrenceOnOrAfter, describeFrequency, sanitizeFrequencyConfig, frequencyConfigForUpdate } from '../lib/frequency';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { groupIconEmoji } from '../lib/groupIcons';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';

// Local YYYY-MM-DD (not UTC) — matches the to-do list's calendar, so "today" and each rule's
// nextRunDate line up with the user's own calendar day rather than a UTC one.
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A rule's category comes from either list depending on its type — 'expense' is the default for
// rules created before income recurrence existed (they never got a `type` field at all).
const categoryInfoFor = (rule: any) =>
  (rule.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).find((c) => c.id === rule.category);

export default function RecurringExpenses() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showForm, setShowForm] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [entryType, setEntryType] = useState<'expense' | 'income'>('expense');
  const [category, setCategory] = useState('food');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [freqConfig, setFreqConfig] = useState<FrequencyConfig>({ frequency: 'monthly', dayOfMonth: 1 });
  // Explicit "start from" date — the rule's first occurrence is the first date on/after this that
  // matches the frequency pattern, rather than always silently anchoring to "today" (which made
  // it easy to accidentally get an unexpected first-run date with no way to defer it).
  const [startDate, setStartDate] = useState(() => toDateOnly(new Date()));
  const [saving, setSaving] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [splitMembers, setSplitMembers] = useState<string[]>([]);
  const [splitType, setSplitType] = useState<'equally' | 'percentage' | 'amount'>('equally');
  const [memberSplits, setMemberSplits] = useState<Record<string, number>>({});
  const [images, setImages] = useState<string[]>([]);
  const [viewingRule, setViewingRule] = useState<any | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Calendar (month grid + click-a-date filter), group filter, and active/paused status filter —
  // same UX as the to-do list's calendar, adapted for rules (always group-owned, no personal
  // dot; "done" maps to "paused" instead).
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<'all' | string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // A feed item or push for a recurring-expense change deep-links here as `?groupId=...` so the
  // list filter opens already scoped to that group instead of landing on "All Groups" — reacts to
  // the param itself, not a mount-only effect, since this screen can already be mounted (React
  // Router reuses the instance for a same-pattern navigation) when the link is tapped.
  useEffect(() => {
    const gid = searchParams.get('groupId');
    if (gid) {
      setListFilter(gid);
      const next = new URLSearchParams(searchParams);
      next.delete('groupId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];
  const selectedGroup = groups.find((g: any) => g.id === groupId);

  const [groupMembersValue] = useCollection(
    groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null,
  );
  const groupMembers = groupMembersValue?.docs.map((d) => d.data() as any) || [];

  React.useEffect(() => {
    // Skip while editing — handleEditStart already prefilled these from the rule being edited,
    // and the group is locked (can't change) during an edit, so there's nothing to re-derive.
    if (editingRuleId) return;
    if (entryType !== 'income' && selectedGroup?.splitEnabled && groupMembers.length > 0) {
      setSplitMembers(groupMembers.map((m) => m.userId));
    } else {
      setSplitMembers([]);
    }
    setSplitType('equally');
    setMemberSplits({});
  }, [groupId, entryType, selectedGroup?.splitEnabled, groupMembers.length, editingRuleId]);

  // Same fallback as AddExpense.tsx: a group without income tracking enabled can't host an
  // income rule, so switching to one snaps the type back to 'expense' rather than leaving the
  // form in an unreachable state.
  React.useEffect(() => {
    if (!editingRuleId && !selectedGroup?.incomeEnabled && entryType === 'income') setType('expense');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.incomeEnabled, editingRuleId]);

  // Income and expense draw from two different category lists — switching type resets the
  // category to the new list's first option. Done directly in the toggle buttons' onClick below
  // (setEntryType + setCategory together) rather than an effect watching `entryType`: an effect
  // can't tell "user just clicked the toggle" apart from "handleEditStart just set entryType from
  // the rule being edited" (which sets its own correct category right after, in the same batch) —
  // it would clobber that with the wrong default every time an edit starts.
  const setType = (next: 'expense' | 'income') => {
    setEntryType(next);
    setCategory((next === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES)[0].id);
  };

  // Shows every recurring expense across every group the user belongs to (not just their own
  // rules) — any group member has full edit/pause/delete control, matching group budgets/
  // invites. `userId` on each rule still records who originally set it up (shown per-card, and
  // it's who the due-occurrence confirmation push goes to), it just isn't a visibility gate.
  const [rulesValue, rulesLoading, rulesError] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'recurringExpenses'), where('groupId', 'in', groupIds)) : null,
  );
  const rules = rulesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];
  if (rulesError) console.error('recurringExpenses query error:', rulesError.code, rulesError.message);

  const [allMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  // Only offer groups that actually have at least one rule as filter options — same reasoning as
  // the to-do list. Every rule always belongs to a group (no personal recurring expenses), so
  // there's no "Just me" option here.
  const groupIdsWithRules = new Set(rules.map((r: any) => r.groupId));
  const groupsWithRules = groups.filter((g: any) => groupIdsWithRules.has(g.id));

  // Group and active/paused filters both apply to the calendar's due-date dots and the list
  // below it, so the calendar only ever shows dots for rules the current filters would actually
  // display.
  const filterMatches = (rule: any) => {
    if (listFilter !== 'all' && rule.groupId !== listFilter) return false;
    if (statusFilter === 'active' && !rule.active) return false;
    if (statusFilter === 'paused' && rule.active) return false;
    if (typeFilter !== 'all' && (typeFilter === 'income' ? rule.type !== 'income' : rule.type === 'income')) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      const catInfo = categoryInfoFor(rule);
      const catName = catInfo ? t(`${rule.type === 'income' ? 'income' : 'category'}.${catInfo.id}`) : '';
      const groupName = groups.find((g: any) => g.id === rule.groupId)?.name || '';
      const matches =
        (rule.description || '').toLowerCase().includes(q) ||
        catName.toLowerCase().includes(q) ||
        groupName.toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  };
  const filteredRules = rules.filter(filterMatches);
  const displayedRules = selectedDate
    ? filteredRules.filter((r: any) => toDateOnly(new Date(r.nextRunDate)) === selectedDate)
    : filteredRules;

  // Per-day breakdown for the visible calendar month — one small group icon per group with a
  // rule due that day (dimmed once every rule from that group due that day is paused).
  const dueByDate = new Map<string, Map<string, { total: number; activeCount: number }>>();
  for (const rule of filteredRules) {
    const dateStr = toDateOnly(new Date(rule.nextRunDate));
    let dayMap = dueByDate.get(dateStr);
    if (!dayMap) {
      dayMap = new Map();
      dueByDate.set(dateStr, dayMap);
    }
    const g = dayMap.get(rule.groupId) || { total: 0, activeCount: 0 };
    g.total += 1;
    if (rule.active) g.activeCount += 1;
    dayMap.set(rule.groupId, g);
  }

  const rulesByGroup = React.useMemo(() => {
    const map = new Map<string, any[]>();
    for (const rule of displayedRules) {
      const list = map.get(rule.groupId) || [];
      list.push(rule);
      map.set(rule.groupId, list);
    }
    return Array.from(map.entries())
      .map(([gId, groupRules]) => ({
        group: groups.find((g: any) => g.id === gId),
        groupId: gId,
        rules: groupRules,
      }))
      .sort((a, b) => (a.group?.name || 'Unknown group').localeCompare(b.group?.name || 'Unknown group'));
  }, [displayedRules, groups]);

  const resetFormFields = () => {
    setEditingRuleId(null);
    setGroupId('');
    setEntryType('expense');
    setCategory('food');
    setAmount('');
    setDescription('');
    setFreqConfig({ frequency: 'monthly', dayOfMonth: 1 });
    setStartDate(toDateOnly(new Date()));
    setSplitType('equally');
    setSplitMembers([]);
    setMemberSplits({});
    setImages([]);
  };

  const handleEditStart = (rule: any) => {
    setEditingRuleId(rule.id);
    setGroupId(rule.groupId);
    setEntryType(rule.type === 'income' ? 'income' : 'expense');
    setCategory(rule.category);
    setAmount(String(rule.amount));
    setDescription(rule.description || '');
    setFreqConfig({
      frequency: rule.frequency,
      dayOfWeek: rule.dayOfWeek,
      daysOfWeek: rule.daysOfWeek,
      dayOfMonth: rule.dayOfMonth,
      month: rule.month,
      hour: rule.hour,
      minute: rule.minute,
    });
    // Seeded from the rule's current next-run date (not today) — editing an active rule
    // shouldn't silently pull its next occurrence forward unless the user actually changes it.
    setStartDate(toDateOnly(new Date(rule.nextRunDate)));
    setSplitType(rule.splitType || 'equally');
    setSplitMembers(rule.splitMembers || []);
    setMemberSplits(rule.memberSplits || {});
    setImages(rule.images || []);
    setShowForm(true);
    // The edit form renders up near the top of the page, above the rule list — without this,
    // starting an edit from a card further down leaves the scroll position unchanged and it
    // looks like the button did nothing.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = evaluateAmountSum(amount);
    if (!user || !groupId || !parsedAmount || parsedAmount <= 0) return;

    if (entryType !== 'income' && selectedGroup?.splitEnabled) {
      if (splitMembers.length === 0) {
        alert(t('recurring.selectAtLeastOneMember'));
        return;
      }
      if (splitType === 'percentage') {
        const totalPct = splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0);
        if (Math.abs(totalPct - 100) > 0.01) {
          alert(t('recurring.percentagesMustAdd100', { total: totalPct }));
          return;
        }
      } else if (splitType === 'amount') {
        const totalAmt = splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0);
        if (Math.abs(totalAmt - parsedAmount) > 0.01) {
          alert(t('recurring.splitAmountMustEqual', { total: totalAmt.toFixed(2) }));
          return;
        }
      }
    }

    setSaving(true);
    try {
      const nextRunDate = firstOccurrenceOnOrAfter(freqConfig, new Date(`${startDate}T00:00:00`)).toISOString();
      const trimmedDescription = description.trim();
      const catInfo = (entryType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).find((c) => c.id === category);

      if (editingRuleId) {
        await updateDoc(doc(db, 'recurringExpenses', editingRuleId), {
          type: entryType,
          category,
          description: trimmedDescription,
          amount: parsedAmount,
          ...frequencyConfigForUpdate(freqConfig),
          nextRunDate,
          // Switching an existing rule to income must actively clear any split fields left over
          // from when it was an expense — updateDoc only merges what's sent, it won't drop fields
          // just because they're no longer relevant, and a stale splitMembers would wrongly still
          // show "split N ways" on what's now an income rule.
          ...(entryType !== 'income' && selectedGroup?.splitEnabled
            ? { splitType, splitMembers, memberSplits }
            : { splitType: deleteField(), splitMembers: deleteField(), memberSplits: deleteField() }),
          images,
        });
        notifyGroupActivity({
          groupId,
          action: 'recurring_changed',
          description: trimmedDescription || catInfo?.name,
          amount: parsedAmount,
          actorName: user.displayName || 'Someone',
        });
      } else {
        await addDoc(collection(db, 'recurringExpenses'), {
          userId: user.uid,
          groupId,
          type: entryType,
          category,
          description: trimmedDescription,
          amount: parsedAmount,
          ...sanitizeFrequencyConfig(freqConfig),
          nextRunDate,
          // Lets the server's daily cron advance nextRunDate using *this user's* calendar day
          // when resolving "which weekday/date is it", instead of the server's own (UTC)
          // timezone — see nowInTimeZone() in server.ts.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          active: true,
          createdAt: new Date().toISOString(),
          ...(entryType !== 'income' && selectedGroup?.splitEnabled ? { splitType, splitMembers, memberSplits } : {}),
          ...(images.length > 0 ? { images } : {}),
        });
        notifyGroupActivity({
          groupId,
          action: 'recurring_created',
          description: trimmedDescription || catInfo?.name,
          amount: parsedAmount,
          actorName: user.displayName || 'Someone',
        });
      }
      resetFormFields();
      setShowForm(false);
    } catch (err) {
      console.error('Failed to save recurring expense:', err);
      alert(t('recurring.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (rule: any) => {
    try {
      await updateDoc(doc(db, 'recurringExpenses', rule.id), { active: !rule.active });
      const catInfo = categoryInfoFor(rule);
      notifyGroupActivity({
        groupId: rule.groupId,
        action: 'recurring_changed',
        description: rule.description || catInfo?.name,
        amount: rule.amount,
        actorName: user?.displayName || 'Someone',
      });
    } catch (err) {
      console.error('Failed to toggle recurring expense:', err);
    }
  };

  const handleDelete = async (rule: any) => {
    if (!window.confirm(t('recurring.confirmDelete'))) return;
    try {
      await deleteDoc(doc(db, 'recurringExpenses', rule.id));
      const catInfo = categoryInfoFor(rule);
      notifyGroupActivity({
        groupId: rule.groupId,
        action: 'recurring_deleted',
        description: rule.description || catInfo?.name,
        amount: rule.amount,
        actorName: user?.displayName || 'Someone',
      });
    } catch (err) {
      console.error('Failed to delete recurring expense:', err);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">{t('search.recurringExpenses')}</h1>
            <p className="text-sm text-text-muted mt-1">
              {t('recurring.subtitle')}
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => { resetFormFields(); setShowForm(true); }}
              title={t('recurring.newRule')}
              data-tour="recurring-add"
              className="shrink-0 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">event_repeat</span>
            </button>
          )}
        </div>

        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-text-muted text-lg">search</span>
          <input
            type="text"
            placeholder={t('recurring.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-white border border-border-subtle rounded-xl py-3 pl-11 pr-4 outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium text-sm text-primary shadow-sm"
          />
        </div>

        <button
          onClick={() => navigate('/recurring-approvals')}
          data-tour="recurring-pending"
          className="w-full py-2.5 bg-surface border border-border-subtle text-primary font-bold rounded-xl text-xs flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-[16px]">pending_actions</span>
          {t('recurring.viewPendingConfirmations')}
        </button>

        {showForm && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">
              {editingRuleId ? t('recurring.editRule') : t('recurring.newRule')}
            </h2>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.group')}</label>
              {editingRuleId ? (
                <p className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm text-text-muted">
                  {selectedGroup?.name || t('search.unknownGroup')}
                </p>
              ) : (
                <select
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  required
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('recurring.selectGroup')}</option>
                  {groups.map((g: any) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              )}
            </div>

            {selectedGroup?.incomeEnabled && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setType('expense')}
                  className={clsx(
                    'py-2.5 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-1.5',
                    entryType === 'expense' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">remove_circle</span>
                  {t('addExpense.expense')}
                </button>
                <button
                  type="button"
                  onClick={() => setType('income')}
                  className={clsx(
                    'py-2.5 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-1.5',
                    entryType === 'income' ? 'bg-success text-white border-success' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">add_circle</span>
                  {t('addExpense.income')}
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.category')}</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {(entryType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => (
                    <option key={c.id} value={c.id}>{t(`${entryType === 'income' ? 'income' : 'category'}.${c.id}`)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.amount')}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                {hasAmountSumOperator(amount) && evaluateAmountSum(amount) !== null && (
                  <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(amount)!.toFixed(2)}</p>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('recurring.descriptionOptional')}</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('recurring.descPlaceholder')}
                maxLength={100}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.photoOptional')}</label>
              <ImageAttachments images={images} onChange={setImages} />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('recurring.startDate')}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="text-[10px] text-text-muted px-1">{t('recurring.startDateHelp')}</p>
            </div>

            <FrequencyPicker config={freqConfig} onChange={setFreqConfig} />

            {entryType !== 'income' && selectedGroup?.splitEnabled && groupMembers.length > 0 && (
              <div className="space-y-4 border-t border-border-subtle pt-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.sharedWith')}</h2>
                    <button
                      type="button"
                      onClick={() => {
                        if (splitMembers.length === groupMembers.length) {
                          setSplitMembers([]);
                        } else {
                          setSplitMembers(groupMembers.map((m) => m.userId));
                        }
                      }}
                      className="text-[10px] font-bold text-primary hover:underline"
                    >
                      {splitMembers.length === groupMembers.length ? t('addExpense.deselectAll') : t('addExpense.selectAll')}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 px-1">
                    {groupMembers.map((member) => (
                      <button
                        key={member.userId}
                        type="button"
                        onClick={() => {
                          if (splitMembers.includes(member.userId)) {
                            setSplitMembers(splitMembers.filter((id) => id !== member.userId));
                          } else {
                            setSplitMembers([...splitMembers, member.userId]);
                          }
                        }}
                        className={clsx(
                          "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all",
                          splitMembers.includes(member.userId)
                            ? "bg-secondary text-on-secondary border-secondary"
                            : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                        )}
                      >
                        {member.userId === user?.uid ? t('common.me') : member.displayName}
                        {splitMembers.includes(member.userId) && (
                          <span className="material-symbols-outlined text-[14px]">check</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.splitMethod')}</h2>
                  <div className="grid grid-cols-3 gap-2 px-1">
                    {[
                      { id: 'equally', label: t('addExpense.equally'), icon: 'balance' },
                      { id: 'percentage', label: t('addExpense.percent'), icon: 'percent' },
                      { id: 'amount', label: t('common.amount'), icon: 'payments' },
                    ].map((method) => (
                      <button
                        key={method.id}
                        type="button"
                        onClick={() => setSplitType(method.id as any)}
                        className={clsx(
                          "flex flex-col items-center justify-center p-2 rounded-xl border transition-all gap-1",
                          splitType === method.id
                            ? "bg-primary text-white border-primary shadow-inner"
                            : "bg-white border-border-subtle hover:bg-surface-container"
                        )}
                      >
                        <span className="material-symbols-outlined text-[18px]">{method.icon}</span>
                        <span className="text-[10px] font-bold">{method.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {splitType !== 'equally' && splitMembers.length > 0 && (
                  <div className="space-y-2 bg-surface p-3 rounded-2xl border border-border-subtle">
                    <h3 className="text-[10px] font-bold text-primary uppercase tracking-widest pl-1">
                      {splitType === 'amount' ? t('addExpense.enterAmounts') : t('addExpense.enterPercentages')}
                    </h3>
                    <div className="space-y-2">
                      {splitMembers.map((uid) => {
                        const member = groupMembers.find((m) => m.userId === uid);
                        return (
                          <div key={uid} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-border-subtle">
                            <span className="text-xs font-bold text-on-surface flex-1 truncate">
                              {uid === user?.uid ? t('common.me') : member?.displayName}
                            </span>
                            <div className="flex items-center gap-1">
                              {splitType === 'amount' && (
                                <span className="text-[10px] font-bold text-primary">{getCurrencySymbol(selectedGroup?.currency)}</span>
                              )}
                              <input
                                type="number"
                                value={memberSplits[uid] || ''}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  setMemberSplits({ ...memberSplits, [uid]: val });
                                }}
                                placeholder="0"
                                className="w-16 h-8 bg-surface rounded-lg border border-border-subtle text-right px-2 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                              />
                              {splitType === 'percentage' && <span className="text-[10px] font-bold text-primary">%</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {splitType === 'percentage' && (
                      <div className={clsx(
                        "text-[10px] font-bold text-center mt-2",
                        splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) === 100 ? "text-success" : "text-error"
                      )}>
                        {t('addExpense.totalPercent', { pct: splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) })}
                      </div>
                    )}
                    {splitType === 'amount' && (
                      <div className={clsx(
                        "text-[10px] font-bold text-center mt-2",
                        Math.abs(splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) - parseFloat(amount || '0')) < 0.01 ? "text-success" : "text-error"
                      )}>
                        {t('addExpense.totalAmount', {
                          spent: `${getCurrencySymbol(selectedGroup?.currency)}${splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0).toFixed(2)}`,
                          total: `${getCurrencySymbol(selectedGroup?.currency)}${parseFloat(amount || '0').toFixed(2)}`,
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { resetFormFields(); setShowForm(false); }}
                className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !groupId || !amount}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
              >
                {saving ? t('common.saving') : editingRuleId ? t('groupExpenses.saveChanges') : t('common.save')}
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1 w-fit">
          {(['all', 'expense', 'income'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setTypeFilter(opt)}
              className={clsx(
                'px-3 py-1.5 rounded-md text-xs font-bold transition-all',
                typeFilter === opt ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
              )}
            >
              {opt === 'all' ? t('groupExpenses.all') : opt === 'income' ? t('common.income') : t('common.expense')}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4 flex-wrap bg-white rounded-xl border border-border-subtle px-3 py-2.5">
          {groupsWithRules.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('todo.show')}</label>
              <select
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                className="bg-surface px-2 py-1.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="all">{t('groupExpenses.all')}</option>
                {groupsWithRules.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('todo.status')}</span>
            <div className="flex items-center gap-2.5">
              {(['all', 'active', 'paused'] as const).map((opt) => (
                <label
                  key={opt}
                  className={clsx(
                    'flex items-center gap-1 text-[10px] font-bold capitalize cursor-pointer',
                    statusFilter === opt ? 'text-primary' : 'text-text-muted',
                  )}
                >
                  <input
                    type="radio"
                    name="recurringStatusFilter"
                    checked={statusFilter === opt}
                    onChange={() => setStatusFilter(opt)}
                    className="w-3 h-3 accent-primary"
                  />
                  {opt === 'all' ? t('groupExpenses.all') : opt === 'active' ? t('reminders.active') : t('reminders.paused')}
                </label>
              ))}
            </div>
          </div>
        </div>

        <MonthCalendar
          cursor={calendarCursor}
          onCursorChange={setCalendarCursor}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          storageKey="recurring-calendar-expanded"
          dayHasActivity={(dateStr) => dueByDate.has(dateStr)}
          dayTitle={(dateStr) => {
            const dayMap = dueByDate.get(dateStr);
            return dayMap && dayMap.size > 0 ? t('recurring.dayTitle', { count: dayMap.size }) : undefined;
          }}
          renderDayDots={(dateStr) => {
            const dayMap = dueByDate.get(dateStr);
            const groupDots = dayMap ? Array.from(dayMap.entries()) : [];
            if (groupDots.length === 0) return null;
            return (
              <span className="flex items-center gap-0.5">
                {groupDots.slice(0, 3).map(([gid, g]) => {
                  const group = groups.find((x: any) => x.id === gid);
                  const allPaused = g.activeCount === 0;
                  return (
                    <span key={gid} className={clsx('text-[10px] leading-none shrink-0', allPaused && 'opacity-40')}>
                      {groupIconEmoji(group?.icon)}
                    </span>
                  );
                })}
                {groupDots.length > 3 && <span className="text-[8px] leading-none font-bold shrink-0">+</span>}
              </span>
            );
          }}
        />
        {selectedDate && (
          <div className="flex items-center justify-between px-1">
            <p className="text-[11px] font-bold text-text-muted">
              {new Date(`${selectedDate}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </p>
            <button type="button" onClick={() => setSelectedDate(null)} className="text-[11px] font-bold text-primary">
              {t('common.viewFullList')}
            </button>
          </div>
        )}

        <section className="space-y-3">
          {rulesLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {rulesError && (
            <p className="text-sm text-error px-1">
              {t('recurring.couldntLoad', { error: rulesError.code || rulesError.message })}
            </p>
          )}
          {!rulesLoading && !rulesError && displayedRules.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">
              {searchTerm.trim() ? t('todo.noSearchResults') : selectedDate ? t('recurring.noRulesDueDay') : t('recurring.noRulesYet')}
            </p>
          )}
          {rulesByGroup.map(({ group, groupId: gId, rules: groupRules }) => (
            <div key={gId} className="space-y-2">
              <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">
                {group?.name || t('search.unknownGroup')}
              </h2>
              <div className="space-y-2">
                {groupRules.map((rule: any) => {
                  const catInfo = categoryInfoFor(rule);
                  const creator = allMembers.find((m: any) => m.userId === rule.userId);
                  return (
                    <div
                      key={rule.id}
                      onClick={() => setViewingRule(rule)}
                      className={clsx(
                        "bg-white rounded-2xl border p-4 flex items-center justify-between gap-3 cursor-pointer",
                        rule.active ? "border-border-subtle" : "border-border-subtle opacity-60"
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', rule.type === 'income' ? 'bg-success/10 text-success' : 'bg-primary/5 text-primary')}>
                          <span className="text-lg">{catInfo?.icon || '🔁'}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-primary text-sm truncate flex items-center gap-1.5">
                            <span className={clsx(
                              'text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                              rule.type === 'income' ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
                            )}>
                              {rule.type === 'income' ? t('addExpense.income') : t('addExpense.expense')}
                            </span>
                            <span className="truncate">{rule.description || (catInfo ? t(`${rule.type === 'income' ? 'income' : 'category'}.${catInfo.id}`) : '')} — {rule.type === 'income' ? '+' : ''}{getCurrencySymbol(group?.currency)}{rule.amount.toFixed(2)}</span>
                            {rule.images?.length > 0 && (
                              <span className="material-symbols-outlined text-[13px] text-text-muted/70 shrink-0" title={t('reminders.hasPhoto')}>photo_camera</span>
                            )}
                          </p>
                          <p className="text-[11px] text-text-muted truncate">
                            {describeFrequency(rule)}
                            {rule.splitMembers?.length > 0 && ` · ${t('manageGroup.splitNWays', { count: rule.splitMembers.length })}`}
                          </p>
                          <p className="text-[10px] text-text-muted">
                            {t('recurring.nextAddedBy', { date: new Date(rule.nextRunDate).toLocaleDateString(), name: rule.userId === user?.uid ? t('shoppingLists.you') : creator?.displayName || t('todo.aMember') })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditStart(rule); }}
                          title={t('common.edit')}
                          className="p-2 text-text-muted hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-lg">edit</span>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggleActive(rule); }}
                          title={t(rule.active ? 'reminders.pause' : 'reminders.resume')}
                          className="p-2 text-text-muted hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-lg">{rule.active ? 'pause_circle' : 'play_circle'}</span>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(rule); }} className="text-error p-2">
                          <span className="material-symbols-outlined text-lg">delete</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      </main>
      {viewingRule && (() => {
        const group = groups.find((g: any) => g.id === viewingRule.groupId);
        const creator = allMembers.find((m: any) => m.userId === viewingRule.userId);
        const catInfo = categoryInfoFor(viewingRule);
        return (
          <DetailSheet
            title={t('recurring.detailTitle')}
            onClose={() => setViewingRule(null)}
            onEdit={() => { const r = viewingRule; setViewingRule(null); handleEditStart(r); }}
            onDelete={() => { const r = viewingRule; setViewingRule(null); handleDelete(r); }}
          >
            <DetailField label={t('common.type')}>
              <span className={clsx(
                'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded',
                viewingRule.type === 'income' ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
              )}>
                {viewingRule.type === 'income' ? t('addExpense.income') : t('addExpense.expense')}
              </span>
            </DetailField>
            <DetailField label={t('addExpense.description')}>{viewingRule.description || (catInfo ? t(`${viewingRule.type === 'income' ? 'income' : 'category'}.${catInfo.id}`) : '') || t('addExpense.untitled')}</DetailField>
            <DetailField label={t('common.amount')}>{viewingRule.type === 'income' ? '+' : ''}{getCurrencySymbol(group?.currency)}{viewingRule.amount.toFixed(2)}</DetailField>
            <DetailField label={t('common.category')}>{catInfo?.icon} {catInfo ? t(`${viewingRule.type === 'income' ? 'income' : 'category'}.${catInfo.id}`) : viewingRule.category}</DetailField>
            <DetailField label={t('common.group')}>{group?.name || t('search.unknownGroup')}</DetailField>
            <DetailField label={t('reminders.frequency')}>{describeFrequency(viewingRule)}</DetailField>
            <DetailField label={t('recurring.nextRun')}>{new Date(viewingRule.nextRunDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</DetailField>
            <DetailField label={t('todo.status')}>{viewingRule.active ? t('reminders.active') : t('reminders.paused')}</DetailField>
            <DetailField label={t('recurring.addedByLabel')}>{viewingRule.userId === user?.uid ? t('recurring.you') : creator?.displayName || t('recurring.aMember')}</DetailField>
            {viewingRule.splitMembers?.length > 0 && (
              <DetailField label={t('recurring.splitAmongLabel', { type: viewingRule.splitType === 'equally' ? t('recurring.equallyLower') : viewingRule.splitType === 'percentage' ? t('recurring.percentageLower') : t('recurring.amountLower') })}>
                <div className="space-y-1">
                  {viewingRule.splitMembers.map((uid: string) => {
                    const member = allMembers.find((m: any) => m.userId === uid);
                    const share = viewingRule.memberSplits?.[uid];
                    return (
                      <div key={uid} className="flex items-center justify-between">
                        <span>{member?.displayName || t('recurring.aMember')}</span>
                        {viewingRule.splitType !== 'equally' && share != null && (
                          <span className="text-text-muted">
                            {viewingRule.splitType === 'percentage' ? `${share}%` : `${getCurrencySymbol(group?.currency)}${Number(share).toFixed(2)}`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </DetailField>
            )}
            {viewingRule.images?.length > 0 && (
              <DetailField label={t('todo.photos')}>
                <div className="flex flex-wrap gap-2">
                  {viewingRule.images.map((src: string, i: number) => (
                    <button key={i} type="button" onClick={() => setLightboxSrc(src)}>
                      <img src={src} alt="" className="w-16 h-16 object-cover rounded-xl border border-border-subtle" />
                    </button>
                  ))}
                </div>
              </DetailField>
            )}
          </DetailSheet>
        );
      })()}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
