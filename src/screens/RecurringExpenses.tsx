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
import { FrequencyConfig, firstOccurrenceOnOrAfter, nextOccurrenceAfter, describeFrequency, sanitizeFrequencyConfig, frequencyConfigForUpdate } from '../lib/frequency';
import { usePageFabAction } from '../context/FabActionContext';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { groupIconEmoji } from '../lib/groupIcons';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { buildRoster } from '../lib/groupParticipants';
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

// How often a rule repeats, bucketed for the "see only daily / weekly / monthly…" filter
type RepeatGroup = 'daily' | 'weekly' | 'monthly' | 'longer';
const REPEAT_OPTIONS: { id: RepeatGroup; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'longer', label: 'Quarterly & yearly' },
];
const repeatGroupOf = (frequency: string): RepeatGroup =>
  frequency === 'daily' || frequency === 'alternate_day' ? 'daily'
    : frequency === 'weekly' ? 'weekly'
    : frequency === 'monthly' || frequency === 'alternate_month' ? 'monthly'
    : 'longer';

// Soft tints behind each rule's group icon, picked from its category so the same kind of bill always looks the same
const RULE_TINTS = ['#fee2e2', '#e0e7ff', '#dcfce7', '#fae8ff', '#fef3c7', '#e0f2fe', '#ffedd5'];
const ruleTint = (category?: string) => RULE_TINTS[Array.from(category || '').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % RULE_TINTS.length];

// First-time guided flow through the "new rule" form — same engine as CreateGroup.tsx /
// GoalWizard.tsx / AccountsHub.tsx's Add Account modal / AddExpense.tsx (progressive reveal, a
// glow highlight directly on the real field via the shared `.fl-tour-glow` CSS class, no floating
// tooltip card). New-rule-mode only (`?guide=1`, set by the header's "Test: Recurring Flow"
// button) — editing an existing rule never shows this. 'type' and 'split' both auto-skip
// themselves when there's nothing to act on (see the effect below).
const GUIDE_STEPS = ['group', 'type', 'categoryAmount', 'details', 'startDate', 'frequency', 'split'] as const;
type GuideStepId = typeof GUIDE_STEPS[number];

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
  // "Add automatically": each occurrence is added by itself, with no confirmation (see processRecurringExpenses on the server)
  const [autoAdd, setAutoAdd] = useState(false);
  const [autoFilter, setAutoFilter] = useState<'all' | 'auto' | 'ask'>('all');
  const [repeatFilter, setRepeatFilter] = useState<'all' | RepeatGroup>('all');
  const [showCalendar, setShowCalendar] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
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
  // Real members + this group's placeholder trip participants (name-only people) — see
  // lib/groupParticipants.ts. A rule can split with a placeholder; server.ts's
  // computeRecurringSplitInfo passes the id straight through when materialising.
  const groupMembers = buildRoster(groupMembersValue?.docs.map((d) => d.data() as any) || [], selectedGroup);

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

  // occurrences still waiting for this person's accept / change / decline
  const [pendingValue] = useCollection(user ? query(collection(db, 'pendingRecurringExpenses'), where('userId', '==', user.uid)) : null);
  const pendingCount = (pendingValue?.docs || []).filter((d) => d.data().status === 'pending').length;

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
    if (autoFilter === 'auto' && rule.autoAdd !== true) return false;
    if (autoFilter === 'ask' && rule.autoAdd === true) return false;
    if (repeatFilter !== 'all' && repeatGroupOf(rule.frequency) !== repeatFilter) return false;
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
    setAutoAdd(false);
  };

  // the floating button (Navigation.tsx) is "New rule" on this page instead of the default "Add expense"
  usePageFabAction('🔁', t('recurring.newRule'), () => { resetFormFields(); setShowForm(true); });

  // ?edit=<ruleId> opens that rule's editor straight away (the recurring panel in Manage Group links here for the fuller options: split, photos)
  const editParam = searchParams.get('edit');
  const openedEditRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!editParam || openedEditRef.current === editParam) return;
    const rule = rules.find((r: any) => r.id === editParam);
    if (!rule) return;
    openedEditRef.current = editParam;
    handleEditStart(rule);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam, rulesValue]);

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
    setAutoAdd(rule.autoAdd === true);
    setShowForm(true);
  };

  const guide = searchParams.get('guide') === '1' && !editingRuleId;
  const openedGuideRef = React.useRef(false);
  useEffect(() => {
    if (guide && !openedGuideRef.current) {
      openedGuideRef.current = true;
      resetFormFields();
      setShowForm(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide]);
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  const currentGuideStep: GuideStepId | null = guide && guideStepIndex < GUIDE_STEPS.length ? GUIDE_STEPS[guideStepIndex] : null;
  const guideDone = !guide || guideStepIndex >= GUIDE_STEPS.length;
  const guideReached = (step: GuideStepId) => !guide || GUIDE_STEPS.indexOf(step) <= guideStepIndex;
  const guideActive = (step: GuideStepId) => currentGuideStep === step;
  const goToNextGuideStep = () => setGuideStepIndex((i) => Math.min(i + 1, GUIDE_STEPS.length));
  const skipGuide = () => setGuideStepIndex(GUIDE_STEPS.length);
  const stepBadge = (step: GuideStepId) =>
    guideActive(step) && (
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black text-primary uppercase tracking-wider">
          Step {GUIDE_STEPS.indexOf(step) + 1} of {GUIDE_STEPS.length}
        </span>
        <button type="button" onClick={skipGuide} className="text-[9px] font-bold text-text-muted hover:text-primary">
          Skip guide
        </button>
      </div>
    );
  const guideWrapClass = (step: GuideStepId) =>
    clsx(guideActive(step) && 'fl-tour-glow ring-2 ring-primary/70 rounded-2xl p-3 -m-3 bg-primary/5');
  const splitApplies = entryType !== 'income' && !!selectedGroup?.splitEnabled && groupMembers.length > 0;
  React.useEffect(() => {
    if (guide && currentGuideStep === 'type' && !selectedGroup?.incomeEnabled) goToNextGuideStep();
    if (guide && currentGuideStep === 'split' && !splitApplies) goToNextGuideStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, currentGuideStep, selectedGroup?.incomeEnabled, splitApplies]);

  const isRuleCreator = (id: string | null) => !id || rules.find((r: any) => r.id === id)?.userId === user?.uid;

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
          // only the person who set the rule up may change this (the security rules enforce it); anyone else's edit leaves it as it was
          ...(isRuleCreator(editingRuleId) ? { autoAdd } : {}),
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
          autoAdd,
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

  // ---------- the timeline: what is coming up, in date order ----------
  const dayStart = (d: Date) => new Date(`${toDateOnly(d)}T00:00:00`);
  const todayStart = dayStart(new Date());
  const daysAway = (iso: string) => Math.round((dayStart(new Date(iso)).getTime() - todayStart.getTime()) / 86_400_000);
  const symbolOf = (rule: any) => getCurrencySymbol(groups.find((g: any) => g.id === rule.groupId)?.currency);
  // how many times a rule falls due between two dates (from its next date onward)
  const occurrencesWithin = (rule: any, from: Date, to: Date) => {
    let n = 0;
    let d = new Date(rule.nextRunDate);
    for (let guard = 0; d <= to && guard < 60; guard++) {
      if (d >= from) n += 1;
      const nxt = nextOccurrenceAfter(rule as FrequencyConfig, d);
      if (nxt.getTime() <= d.getTime()) break;
      d = nxt;
    }
    return n;
  };
  // an amount per currency, joined into one readable string ("₹15,000" or "₹3,000 + $20")
  const money = (list: { rule: any; times: number }[]) => {
    const totals = new Map<string, number>();
    list.forEach(({ rule, times }) => { if (rule.type !== 'income') totals.set(symbolOf(rule), (totals.get(symbolOf(rule)) || 0) + rule.amount * times); });
    return totals.size === 0 ? '–' : Array.from(totals.entries()).map(([sym, v]) => `${sym}${Math.round(v).toLocaleString()}`).join(' + ');
  };
  const runningRules = rules.filter((r: any) => r.active !== false);
  const weekEnd = new Date(todayStart.getTime() + 7 * 86_400_000 + 86_399_000);
  const monthEnd = new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 0, 23, 59, 59);
  const dueNext7 = money(runningRules.map((rule: any) => ({ rule, times: occurrencesWithin(rule, todayStart, weekEnd) })));
  const leftThisMonth = money(runningRules.map((rule: any) => ({ rule, times: occurrencesWithin(rule, todayStart, monthEnd) })));
  const timelineActive = displayedRules.filter((r: any) => r.active !== false).sort((a: any, b: any) => new Date(a.nextRunDate).getTime() - new Date(b.nextRunDate).getTime());
  const timelinePaused = displayedRules.filter((r: any) => r.active === false);
  const sections: { key: string; title: string; rules: any[] }[] = [
    { key: 'today', title: 'Today', rules: timelineActive.filter((r: any) => daysAway(r.nextRunDate) <= 0) },
    { key: 'tomorrow', title: 'Tomorrow', rules: timelineActive.filter((r: any) => daysAway(r.nextRunDate) === 1) },
    { key: 'week', title: 'This week', rules: timelineActive.filter((r: any) => daysAway(r.nextRunDate) >= 2 && daysAway(r.nextRunDate) <= 7) },
    { key: 'later', title: 'Later', rules: timelineActive.filter((r: any) => daysAway(r.nextRunDate) > 7) },
    { key: 'paused', title: 'Paused', rules: timelinePaused },
  ].filter((sec) => sec.rules.length > 0);
  const viewFilter: 'all' | 'auto' | 'ask' | 'paused' = statusFilter === 'paused' ? 'paused' : autoFilter;
  const setViewFilter = (v: 'all' | 'auto' | 'ask' | 'paused') => {
    setStatusFilter(v === 'paused' ? 'paused' : 'all');
    setAutoFilter(v === 'auto' || v === 'ask' ? v : 'all');
  };
  // only the person who set a rule up can change whether it is added automatically (the security rules enforce this too)
  const toggleAuto = async (rule: any) => {
    if (rule.userId !== user?.uid) return;
    try {
      await updateDoc(doc(db, 'recurringExpenses', rule.id), { autoAdd: rule.autoAdd !== true });
    } catch (err) {
      console.error('Failed to change automatic adding:', err);
    }
  };
  const repeatOptionsPresent = REPEAT_OPTIONS.filter((o) => rules.some((r: any) => repeatGroupOf(r.frequency) === o.id));
  const autoCount = runningRules.filter((r: any) => r.autoAdd === true).length;
  const askCount = runningRules.length - autoCount;
  const pausedCount = rules.length - runningRules.length;
  // the next 7 days for the week strip; a dot where a running rule has its next date
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + i);
    const dateStr = toDateOnly(d);
    const dayMap = dueByDate.get(dateStr);
    return { dateStr, label: d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3), day: d.getDate(), hasDue: !!dayMap && Array.from(dayMap.values()).some((g) => g.activeCount > 0) };
  });
  const asPopup = showForm && (!!editingRuleId || !guide); // adding a rule opens as a popup too, except during the guided tour, which stays inline

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        {/* the month at a glance: what is still to pay, with the status tiles overlapping it */}
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)', paddingBottom: 62 }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-white/85">{t('search.recurringExpenses')} · left this month</p>
              <p className="text-3xl font-black tabular-nums leading-tight truncate">{leftThisMonth}</p>
              <p className="text-[12px] text-white/85 mt-0.5">{dueNext7 === '–' ? 'Nothing due in the next 7 days' : `${dueNext7} due in the next 7 days`} · {runningRules.length} of {rules.length} running</p>
            </div>
            {!showForm && (
              <button
                onClick={() => { resetFormFields(); setShowForm(true); }}
                title={t('recurring.newRule')}
                data-tour="recurring-add"
                className="shrink-0 w-10 h-10 rounded-full bg-white text-[#0f7a8f] flex items-center justify-center shadow-md active:scale-95 transition-all"
              >
                <span className="material-symbols-outlined text-[20px]">event_repeat</span>
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5 relative" style={{ marginTop: -50 }}>
          {([
            ['auto', 'Auto-added', autoCount, 'linear-gradient(160deg,#16a34a,#4ade80)'],
            ['ask', 'Asks you', askCount, 'linear-gradient(160deg,#f97316,#fbbf24)'],
            ['paused', 'Paused', pausedCount, 'linear-gradient(160deg,#64748b,#94a3b8)'],
          ] as const).map(([opt, label, count, bg]) => (
            <button key={opt} type="button" onClick={() => setViewFilter(viewFilter === opt ? 'all' : opt)} className={clsx('rounded-2xl px-3 py-2.5 text-left text-white shadow-lg active:scale-95 transition-all', viewFilter === opt && 'ring-2 ring-white ring-offset-2 ring-offset-[#0f7a8f]')} style={{ background: bg }}>
              <span className="block text-[11px] font-bold text-white/90">{label}</span>
              <span className="block text-xl font-black leading-tight">{count}</span>
            </button>
          ))}
        </div>

        {/* occurrences waiting for an answer, one tap away */}
        <button
          type="button"
          onClick={() => navigate('/recurring-approvals')}
          data-tour="recurring-pending"
          className={clsx('w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-left active:scale-[0.99] transition-transform', pendingCount > 0 ? 'bg-amber-50 border border-amber-300' : 'bg-white border border-border-subtle')}
        >
          <span className={clsx('material-symbols-outlined', pendingCount > 0 ? 'text-amber-600' : 'text-text-muted')}>pending_actions</span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-black text-primary">{pendingCount > 0 ? `${pendingCount} waiting for you` : 'Nothing waiting for you'}</span>
            <span className="block text-[11px] text-text-muted">{pendingCount > 0 ? 'Accept, change or decline them' : t('recurring.viewPendingConfirmations')}</span>
          </span>
          <span className="material-symbols-outlined text-text-muted">chevron_right</span>
        </button>

        {/* the next 7 days: a dot marks a day something falls due; tap a day to see just that day */}
        <div className="flex gap-1.5">
          {weekDays.map((wd) => (
            <button key={wd.dateStr} type="button" onClick={() => setSelectedDate(selectedDate === wd.dateStr ? null : wd.dateStr)} className={clsx('flex-1 rounded-2xl py-2 text-center border transition-all active:scale-95', selectedDate === wd.dateStr ? 'text-white border-transparent shadow-md bg-gradient-to-br from-[#0f7a8f] to-[#22c1a5]' : 'bg-white border-border-subtle text-slate-500')}>
              <span className="block text-[10px] font-black uppercase">{wd.label}</span>
              <span className={clsx('block text-[15px] font-black', selectedDate === wd.dateStr ? 'text-white' : 'text-primary')}>{wd.day}</span>
              <span className={clsx('block mx-auto mt-0.5 w-1.5 h-1.5 rounded-full', wd.hasDue ? (selectedDate === wd.dateStr ? 'bg-white' : 'bg-orange-500') : 'bg-transparent')} />
            </button>
          ))}
        </div>

        {/* one row of filters, plus the group, the type, search and the calendar */}
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {([['all', 'All'], ['auto', 'Auto'], ['ask', 'Asks first'], ['paused', 'Paused']] as const).map(([opt, label]) => (
              <button key={opt} type="button" onClick={() => setViewFilter(opt)} className={clsx('shrink-0 rounded-full px-3.5 py-1.5 text-xs font-black border transition-all', viewFilter === opt ? 'text-white border-transparent shadow-md bg-gradient-to-r from-[#0f7a8f] to-[#22c1a5]' : 'bg-white text-text-muted border-border-subtle')}>
                {label}
              </button>
            ))}
            <span className="flex-1" />
            <button type="button" onClick={() => setShowSearch((v) => !v)} className={clsx('shrink-0 w-8 h-8 rounded-full border flex items-center justify-center', showSearch || searchTerm ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-white border-border-subtle text-text-muted')} title="Search">
              <span className="material-symbols-outlined text-[18px]">search</span>
            </button>
            <button type="button" onClick={() => setShowCalendar((v) => !v)} className={clsx('shrink-0 w-8 h-8 rounded-full border flex items-center justify-center', showCalendar || selectedDate ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-white border-border-subtle text-text-muted')} title="Calendar">
              <span className="material-symbols-outlined text-[18px]">calendar_month</span>
            </button>
          </div>
          {/* see only the rules that repeat daily, weekly, monthly…; only the kinds you actually have are offered */}
          {repeatOptionsPresent.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <span className="shrink-0 text-[10px] font-black uppercase tracking-wider text-slate-500 pr-0.5">Repeats</span>
              {[{ id: 'all' as const, label: 'Any' }, ...repeatOptionsPresent].map((o) => (
                <button key={o.id} type="button" onClick={() => setRepeatFilter(o.id)} className={clsx('shrink-0 rounded-full px-3 py-1 text-[11.5px] font-black border transition-all', repeatFilter === o.id ? 'bg-orange-500 text-white border-orange-500 shadow-sm' : 'bg-white text-text-muted border-border-subtle')}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {showSearch && (
            <input
              type="text"
              autoFocus
              placeholder={t('recurring.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white border border-border-subtle rounded-xl py-2.5 px-4 outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm text-primary"
            />
          )}
          {(groupsWithRules.length > 1 || rules.some((r: any) => r.type === 'income')) && (
            <div className="flex items-center gap-2 flex-wrap">
              {groupsWithRules.length > 1 && (
                <select value={listFilter} onChange={(e) => setListFilter(e.target.value)} className="bg-white px-2.5 py-1.5 rounded-full border border-border-subtle text-xs font-bold text-primary outline-none">
                  <option value="all">All groups</option>
                  {groupsWithRules.map((g: any) => <option key={g.id} value={g.id}>{groupIconEmoji(g.icon)} {g.name}</option>)}
                </select>
              )}
              {rules.some((r: any) => r.type === 'income') && (['all', 'expense', 'income'] as const).map((opt) => (
                <button key={opt} type="button" onClick={() => setTypeFilter(opt)} className={clsx('rounded-full px-3 py-1.5 text-xs font-bold border', typeFilter === opt ? 'bg-primary/10 text-primary border-primary/30' : 'bg-white text-text-muted border-border-subtle')}>
                  {opt === 'all' ? t('groupExpenses.all') : opt === 'income' ? t('common.income') : t('common.expense')}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editing opens as a popup (closes itself on Cancel/Save, same handleSubmit/
            resetFormFields as before) instead of the inline form scrolling into view at the top
            of the page — adding a new rule (and the guided tour, which never runs while editing)
            keeps the original inline placement untouched. */}
        <div
          className={asPopup ? 'fixed inset-0 bg-black/40 z-[120] flex items-start justify-center p-4 pt-10 overflow-y-auto' : undefined}
          onClick={() => { if (asPopup) { resetFormFields(); setShowForm(false); } }}
        >
        <div
          className={asPopup ? 'w-full max-w-lg' : undefined}
          onClick={(e) => { if (asPopup) e.stopPropagation(); }}
        >
        {showForm && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">
              {editingRuleId ? t('recurring.editRule') : t('recurring.newRule')}
            </h2>
            {guideReached('group') && (
            <div className={clsx('space-y-1', guideWrapClass('group'))}>
              {stepBadge('group')}
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.group')}</label>
              {editingRuleId ? (
                <p className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm text-text-muted">
                  {selectedGroup?.name || t('search.unknownGroup')}
                </p>
              ) : (
                <select
                  value={groupId}
                  onChange={(e) => { setGroupId(e.target.value); if (guideActive('group') && e.target.value) goToNextGuideStep(); }}
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
            )}

            {guideReached('type') && selectedGroup?.incomeEnabled && (
              <div className={clsx('space-y-1.5', guideWrapClass('type'))}>
                {stepBadge('type')}
                <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => { setType('expense'); if (guideActive('type')) goToNextGuideStep(); }}
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
                  onClick={() => { setType('income'); if (guideActive('type')) goToNextGuideStep(); }}
                  className={clsx(
                    'py-2.5 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-1.5',
                    entryType === 'income' ? 'bg-success text-white border-success' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">add_circle</span>
                  {t('addExpense.income')}
                </button>
                </div>
              </div>
            )}

            {guideReached('categoryAmount') && (
            <div className={clsx('space-y-1.5', guideWrapClass('categoryAmount'))}>
              {stepBadge('categoryAmount')}
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
              {guideActive('categoryAmount') && (
                <button
                  type="button"
                  onClick={() => { if (evaluateAmountSum(amount) && evaluateAmountSum(amount)! > 0) goToNextGuideStep(); }}
                  disabled={!(evaluateAmountSum(amount) && evaluateAmountSum(amount)! > 0)}
                  className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline px-1"
                >
                  Next →
                </button>
              )}
            </div>
            )}

            {guideReached('details') && (
            <div className={clsx('space-y-4', guideWrapClass('details'))}>
              {stepBadge('details')}
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
              {/* add automatically: no confirmation each time. Only the person who set the rule up can change this. */}
              {(!editingRuleId || isRuleCreator(editingRuleId)) && (
                <button
                  type="button"
                  onClick={() => setAutoAdd((v) => !v)}
                  className={clsx('w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all', autoAdd ? 'border-primary bg-primary/5' : 'border-border-subtle bg-white')}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary">Add automatically</span>
                    <span className="block text-[11px] text-text-muted leading-snug">{autoAdd ? 'Each time it is due it is added by itself, in your name. You are told, and can edit or delete it later.' : 'Off: each time it is due you are asked to accept, change or decline it.'}</span>
                  </span>
                  <span className={clsx('w-10 h-5 rounded-full relative shrink-0 transition-all', autoAdd ? 'bg-primary' : 'bg-gray-200')}>
                    <span className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md', autoAdd ? 'right-0.5' : 'left-0.5')} />
                  </span>
                </button>
              )}
              {guideActive('details') && (
                <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline px-1">{description.trim() || images.length ? 'Next →' : 'Skip, Next →'}</button>
              )}
            </div>
            )}

            {guideReached('startDate') && (
            <div className={clsx('space-y-1', guideWrapClass('startDate'))}>
              {stepBadge('startDate')}
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('recurring.startDate')}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="text-[10px] text-text-muted px-1">{t('recurring.startDateHelp')}</p>
              {guideActive('startDate') && (
                <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline px-1">Next →</button>
              )}
            </div>
            )}

            {guideReached('frequency') && (
            <div className={clsx('space-y-1.5', guideWrapClass('frequency'))}>
              {stepBadge('frequency')}
              <FrequencyPicker config={freqConfig} onChange={setFreqConfig} />
              {guideActive('frequency') && (
                <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline px-1">Looks good, Next →</button>
              )}
            </div>
            )}

            {guideReached('split') && entryType !== 'income' && selectedGroup?.splitEnabled && groupMembers.length > 0 && (
              <div className={clsx("space-y-4 border-t border-border-subtle pt-4", guideWrapClass('split'))}>
                {stepBadge('split')}
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
                {guideActive('split') && (
                  <button
                    type="button"
                    onClick={() => { if (splitMembers.length > 0) goToNextGuideStep(); }}
                    disabled={splitMembers.length === 0}
                    className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline px-1"
                  >
                    Next →
                  </button>
                )}
              </div>
            )}

            {guideDone && (
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
            )}
          </form>
        )}
        </div>
        </div>

        {(showCalendar || selectedDate) && (
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
        )}
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

        <section className="space-y-4">
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
          {sections.map((sec) => (
            <div key={sec.key} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-[11px] font-black text-slate-500 uppercase tracking-[0.12em]">{sec.title}</h2>
                <span className="text-[11px] font-black text-slate-600 tabular-nums rounded-full bg-slate-200/70 px-2 py-px">{sec.key === 'paused' ? `${sec.rules.length}` : money(sec.rules.map((rule: any) => ({ rule, times: 1 })))}</span>
              </div>
              <div className="space-y-2">
                {sec.rules.map((rule: any) => {
                  const group = groups.find((g: any) => g.id === rule.groupId);
                  const catInfo = categoryInfoFor(rule);
                  const isIncome = rule.type === 'income';
                  const isAuto = rule.autoAdd === true;
                  const mine = rule.userId === user?.uid;
                  const due = daysAway(rule.nextRunDate);
                  const dueText = due <= 0 ? 'Today' : due === 1 ? 'Tomorrow' : new Date(rule.nextRunDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
                  const name = rule.description || (catInfo ? t(`${isIncome ? 'income' : 'category'}.${catInfo.id}`) : '');
                  return (
                    <div key={rule.id} onClick={() => setViewingRule(rule)} className={clsx('flex items-center gap-3 px-3 py-2.5 cursor-pointer bg-white rounded-2xl shadow-[0_2px_8px_rgba(30,58,95,0.09)] active:scale-[0.99] transition-all', rule.active === false && 'opacity-60')}>
                      <div className="relative shrink-0">
                        <span className="w-11 h-11 rounded-xl flex items-center justify-center text-xl overflow-hidden" style={{ background: isIncome ? '#dcfce7' : ruleTint(rule.category) }} title={group?.name}>
                          {group?.photoURL ? <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : groupIconEmoji(group?.icon)}
                        </span>
                        <span className={clsx('absolute -right-1 -bottom-1 w-5 h-5 rounded-full border-2 border-white flex items-center justify-center text-[11px]', isIncome ? 'bg-success/15' : 'bg-primary/10')}>{catInfo?.icon || '🔁'}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-black text-primary truncate flex items-center gap-1.5">
                          <span className="truncate">{name}</span>
                          {rule.images?.length > 0 && <span className="material-symbols-outlined text-[13px] text-text-muted/70 shrink-0" title={t('reminders.hasPhoto')}>photo_camera</span>}
                        </p>
                        <p className="text-[11px] text-text-muted truncate">
                          {group?.name || t('search.unknownGroup')} · {describeFrequency(rule)}{rule.splitMembers?.length > 0 && ` · ${t('manageGroup.splitNWays', { count: rule.splitMembers.length })}`}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={clsx('text-sm font-black tabular-nums', isIncome ? 'text-success' : 'text-primary')}>{isIncome ? '+' : ''}{symbolOf(rule)}{Math.round(rule.amount * 100) / 100 === Math.round(rule.amount) ? Math.round(rule.amount).toLocaleString() : rule.amount.toFixed(2)}</p>
                        <p className={clsx('text-[10px] font-bold', rule.active === false ? 'text-text-muted' : due <= 0 ? 'text-amber-700' : 'text-text-muted')}>{rule.active === false ? 'Paused' : dueText}</p>
                      </div>
                      {/* automatic adding: on = added by itself, off = asks first. Only the person who set the rule up can change it. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleAuto(rule); }}
                        disabled={!mine}
                        title={mine ? (isAuto ? 'Added automatically. Tap to ask first instead.' : 'Asks first. Tap to add automatically.') : 'Only the person who set this up can change it'}
                        className="shrink-0 flex flex-col items-center gap-0.5 disabled:opacity-60"
                      >
                        <span className={clsx('w-9 h-5 rounded-full relative transition-all', isAuto ? 'bg-primary' : 'bg-gray-200')}>
                          <span className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md', isAuto ? 'right-0.5' : 'left-0.5')} />
                        </span>
                        <span className="text-[8.5px] font-black uppercase tracking-wider text-text-muted">{isAuto ? 'Auto' : 'Asks'}</span>
                      </button>
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
            <DetailField label={t('todo.status')}>
              <span className="flex items-center gap-3">
                {viewingRule.active !== false ? t('reminders.active') : t('reminders.paused')}
                <button type="button" onClick={() => { const r = viewingRule; setViewingRule(null); handleToggleActive(r); }} className="text-xs font-black text-primary underline decoration-dotted">{viewingRule.active !== false ? t('reminders.pause') : t('reminders.resume')}</button>
              </span>
            </DetailField>
            <DetailField label="Adding">{viewingRule.autoAdd === true ? 'Added automatically, no confirmation' : 'Asks you first each time'}</DetailField>
            <DetailField label={t('recurring.addedByLabel')}>{viewingRule.userId === user?.uid ? t('recurring.you') : creator?.displayName || t('recurring.aMember')}</DetailField>
            {viewingRule.splitMembers?.length > 0 && (
              <DetailField label={t('recurring.splitAmongLabel', { type: viewingRule.splitType === 'equally' ? t('recurring.equallyLower') : viewingRule.splitType === 'percentage' ? t('recurring.percentageLower') : t('recurring.amountLower') })}>
                <div className="space-y-1">
                  {viewingRule.splitMembers.map((uid: string) => {
                    const member = allMembers.find((m: any) => m.userId === uid);
                    const placeholderName = (groups.find((g: any) => g.id === viewingRule.groupId)?.participants || {})[uid]?.name;
                    const share = viewingRule.memberSplits?.[uid];
                    return (
                      <div key={uid} className="flex items-center justify-between">
                        <span>{member?.displayName || placeholderName || t('recurring.aMember')}</span>
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
