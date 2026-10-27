import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, setDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { scheduleLocalTodoReminder, cancelLocalTodoReminder, syncTodoAlarms, canRingTodoAlarm } from '../lib/localReminders';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { fireWrite } from '../lib/offlineWrite';
import { executeCashToAccountTransfer, notifyGoalsMet } from '../lib/accountAllocations';
import { getCurrencySymbol } from '../lib/constants';
import { fromMinorUnits } from '../lib/goals';
import { groupIconEmoji } from '../lib/groupIcons';
import { claimPoints } from '../lib/pointsApi';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import MonthCalendar from '../components/MonthCalendar';
import HabitTracker from '../components/HabitTracker';
import FrequencyPicker from '../components/FrequencyPicker';
import {
  FrequencyConfig,
  firstOccurrenceOnOrAfter,
  describeFrequency,
  frequencyConfigFromFields,
  sanitizeFrequencyConfig,
  frequencyConfigForUpdate,
} from '../lib/frequency';
import { useLanguage } from '../context/LanguageContext';
import { isDueOnDate } from '../lib/frequency';

// Local YYYY-MM-DD (not UTC) — matches what a `date` input produces/expects, and what we key the
// calendar's per-day due-count map by, so "today" lines up with the user's own calendar day.
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Quick due-date choices in the new-to-do sheet
const addDays = (dateStr: string, n: number) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateOnly(d);
};
// the coming Saturday (today, if it is one) and the coming Monday (never today)
const comingSaturday = (todayStr: string) => addDays(todayStr, (6 - new Date(`${todayStr}T00:00:00`).getDay() + 7) % 7);
const comingMonday = (todayStr: string) => addDays(todayStr, ((1 - new Date(`${todayStr}T00:00:00`).getDay() + 7) % 7) || 7);

// Reminder date/time are two separate native inputs (matching the Due Date field and
// FrequencyPicker's time input elsewhere in the app) rather than one combined `datetime-local`
// field — datetime-local renders as an inconsistent, awkward-to-tap single widget across
// browsers/OS, whereas date+time are the same familiar controls used everywhere else here.
const toTimeOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Maps a habit's reminderOffsetMinutes back to the same label shown in the picker's <select>,
// for the detail sheet's read-only summary.
const REMINDER_OFFSET_KEYS: Record<number, string> = {
  15: 'todo.remind15min',
  30: 'todo.remind30min',
  60: 'todo.remind1hr',
  240: 'todo.remind4hr',
  1440: 'todo.remind1day',
};
const reminderOffsetLabel = (minutes: number, t: (key: string) => string) =>
  t(REMINDER_OFFSET_KEYS[minutes] || 'todo.remind1hr');

// Solid colour for each habit tile, cycling in order
const HABIT_TONES = [
  'linear-gradient(160deg,#16a34a,#4ade80)',
  'linear-gradient(160deg,#f97316,#fbbf24)',
  'linear-gradient(160deg,#0ea5e9,#38bdf8)',
  'linear-gradient(160deg,#7c3aed,#a78bfa)',
  'linear-gradient(160deg,#e11d48,#fb7185)',
];

// A friendly icon for a task, guessed from its words (a shared task shows its group's icon instead)
const TASK_ICONS: [RegExp, string][] = [
  [/\b(bank|hdfc|sbi|icici|axis|kotak|balance|account|deposit|fd|savings?|cry\w*|bitcoin|invest\w*|mutual|sip|stocks?|shares?)\b/i, '🏦'],
  [/\b(pay|bill|fee|fees|rent|emi|loan|tax|recharge|premium|subscription|electricity)\b/i, '💳'],
  [/\b(call|phone|ring|whatsapp|text|message|email|mail)\b/i, '📞'],
  [/\b(buy|shop|shopping|order|grocer\w*|gift|purchase|market)\b/i, '🛒'],
  [/\b(doctor|medicine|medicines|tablet|dentist|hospital|checkup|check-up|vaccin\w*|lab|blood|health)\b/i, '🩺'],
  [/\b(meeting|meet|appointment|interview|presentation|conference)\b/i, '📅'],
  [/\b(school|class|exam|homework|study|teacher|tuition|college|admission|course)\b/i, '🎓'],
  [/\b(car|bike|scooter|insurance|service|repair|plumber|electrician|mechanic|fix|puncture)\b/i, '🔧'],
  [/\b(book|ticket|flight|train|travel|trip|hotel|visa|passport|booking)\b/i, '✈️'],
  [/\b(clean|laundry|wash|cook|dinner|lunch|breakfast|kitchen|iron|sweep|dust)\b/i, '🧹'],
  [/\b(birthday|anniversary|party|wedding|function|festival|diwali|holi|celebrat\w*)\b/i, '🎉'],
  [/\b(gym|workout|run|walk|yoga|exercise|swim\w*|cycle)\b/i, '🏃'],
  [/\b(renew|submit|file|form|document|documents|aadhaar|pan|apply|application|licen[cs]e|registration)\b/i, '📄'],
  [/\b(maintain|check|review|remember|remind\w*|follow\s?up)\b/i, '🔔'],
];
const taskIcon = (text: string) => TASK_ICONS.find(([re]) => re.test(text || ''))?.[1] || '📝';

export default function ToDoList() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [reminderDateInput, setReminderDateInput] = useState('');
  const [reminderTimeInput, setReminderTimeInput] = useState('');
  const [dueDateInput, setDueDateInput] = useState('');
  const [groupId, setGroupId] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [freqConfig, setFreqConfig] = useState<FrequencyConfig>({ frequency: 'daily' });
  const [reminderOffsetMinutes, setReminderOffsetMinutes] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [viewingTodo, setViewingTodo] = useState<any | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'habits'>('list');

  // Calendar (month grid + click-a-date filter) and the group/personal filter dropdown above it.
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<'all' | 'personal' | string>('all');
  const [doneFilter, setDoneFilter] = useState<'all' | 'done' | 'pending'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [quickText, setQuickText] = useState('');
  // new-to-do sheet: how the reminder arrives, which extra panel is open, and whether the date / time pickers are showing
  const [reminderStyle, setReminderStyle] = useState<'notification' | 'alarm'>('notification');
  const [moreOpen, setMoreOpen] = useState<'note' | 'photo' | 'repeat' | null>(null);
  const [showPickDate, setShowPickDate] = useState(false);
  const [showCustomRemind, setShowCustomRemind] = useState(false);

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [habitStreaksValue] = useCollection(user ? collection(db, 'userPoints', user.uid, 'habitStreaks') : null);

  const [allMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  // Personal todos (mine, whether shared or not) and todos shared to any of my groups (by
  // anyone) are two different query shapes — merged client-side to dedupe overlap (my own
  // shared items show up in both). See recurringExpenses for why this can't be one query.
  const [myTodosValue, myLoading, myError] = useCollection(
    user ? query(collection(db, 'todos'), where('userId', '==', user.uid)) : null,
  );
  const [sharedTodosValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'todos'), where('groupId', 'in', groupIds)) : null,
  );
  const todosById = new Map<string, any>();
  myTodosValue?.docs.forEach((d) => todosById.set(d.id, { id: d.id, ...d.data() }));
  sharedTodosValue?.docs.forEach((d) => todosById.set(d.id, { id: d.id, ...d.data() }));
  const todos = Array.from(todosById.values()).sort((a: any, b: any) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.reminderAt && b.reminderAt) return a.reminderAt.localeCompare(b.reminderAt);
    if (a.reminderAt) return -1;
    if (b.reminderAt) return 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  // Only offer groups that actually have at least one to-do as filter options — no point letting
  // someone pick a group whose list would always be empty. The "share with" dropdown in the form
  // still lists every group (you're allowed to share a first to-do with an empty one).
  const groupIdsWithTodos = new Set(todos.filter((t: any) => t.groupId).map((t: any) => t.groupId));
  const groupsWithTodos = groups.filter((g: any) => groupIdsWithTodos.has(g.id));

  // Matches on task text and notes — shared by both the list and habit-tracker filtering below,
  // so searching finds a to-do regardless of which tab it's currently viewed from.
  const matchesSearch = (todo: any) => {
    if (!searchTerm.trim()) return true;
    const q = searchTerm.trim().toLowerCase();
    return (todo.text || '').toLowerCase().includes(q) || (todo.notes || '').toLowerCase().includes(q);
  };

  // Group/personal filter, done/pending filter, and search all apply to the calendar's due-date
  // dots and the list below it, so the calendar only ever shows dots for to-dos the current
  // filters would actually display.
  const filterMatches = (todo: any) => {
    if (listFilter === 'personal' && todo.groupId) return false;
    if (listFilter !== 'all' && listFilter !== 'personal' && todo.groupId !== listFilter) return false;
    if (doneFilter === 'done' && !todo.done) return false;
    if (doneFilter === 'pending' && todo.done) return false;
    if (!matchesSearch(todo)) return false;
    return true;
  };
  const filteredTodos = todos.filter(filterMatches);
  const displayedTodos = selectedDate ? filteredTodos.filter((t: any) => t.dueDate === selectedDate) : filteredTodos;

  // Habit tracker: respects the group/personal filter and search (same as the list) but not the
  // done/pending one, since a habit whose today's occurrence happens to be marked done shouldn't
  // just vanish from its own tracker.
  const habitTodos = todos.filter(
    (t: any) =>
      t.recurring &&
      (listFilter === 'all' || (listFilter === 'personal' ? !t.groupId : t.groupId === listFilter)) &&
      matchesSearch(t),
  );

  // Per-day breakdown for the visible calendar month — one black dot for personal to-dos, one
  // small group icon per group with a to-do due that day (dimmed once everything from that owner
  // is done). `filteredTodos` is already recomputed fresh every render (not memoized), so this
  // just mirrors that rather than memoizing against a dependency array that could go stale.
  const dueByDate = new Map<string, { personalTotal: number; personalDone: number; groups: Map<string, { total: number; done: number }> }>();
  for (const todo of filteredTodos) {
    if (!todo.dueDate) continue;
    let entry = dueByDate.get(todo.dueDate);
    if (!entry) {
      entry = { personalTotal: 0, personalDone: 0, groups: new Map() };
      dueByDate.set(todo.dueDate, entry);
    }
    if (todo.groupId) {
      const g = entry.groups.get(todo.groupId) || { total: 0, done: 0 };
      g.total += 1;
      if (todo.done) g.done += 1;
      entry.groups.set(todo.groupId, g);
    } else {
      entry.personalTotal += 1;
      if (todo.done) entry.personalDone += 1;
    }
  }

  // Personal (not shared to a group) reminders are scheduled entirely on-device so they fire
  // offline and at the exact moment, instead of depending on the server cron (which only needs
  // to reach *other* members' devices for group-shared items — see processTodoReminders in
  // server.ts). Re-syncing off `myTodosValue` (rather than only from the form submit handler)
  // means create/edit/toggle-done are all covered by one effect, since each of those writes
  // produces a new snapshot here. Deletions are handled separately in handleDelete, since a
  // deleted todo no longer appears in the snapshot for this effect to cancel.
  useEffect(() => {
    if (!myTodosValue) return;
    // a to-do that asked for an alarm rings as one on Android (and then needs no plain notification); everywhere else it is a notification
    const alarms: { id: string; text: string; reminderAt: string }[] = [];
    myTodosValue.docs.forEach((d) => {
      const todo = { id: d.id, ...d.data() } as any;
      const eligible = !todo.done && !todo.groupId && todo.reminderAt;
      if (eligible && todo.reminderStyle === 'alarm' && canRingTodoAlarm()) {
        alarms.push({ id: todo.id, text: todo.text, reminderAt: todo.reminderAt });
        cancelLocalTodoReminder(todo.id);
      } else if (eligible) {
        scheduleLocalTodoReminder({ id: todo.id, text: todo.text, reminderAt: todo.reminderAt });
      } else {
        cancelLocalTodoReminder(todo.id);
      }
    });
    syncTodoAlarms(alarms);
  }, [myTodosValue]);

  const resetForm = () => {
    setEditingId(null);
    setText('');
    setReminderDateInput('');
    setReminderTimeInput('');
    setDueDateInput('');
    setGroupId('');
    setImages([]);
    setNotes('');
    setRecurring(false);
    setFreqConfig({ frequency: 'daily' });
    setReminderOffsetMinutes(null);
    setReminderStyle('notification');
    setMoreOpen(null);
    setShowPickDate(false);
    setShowCustomRemind(false);
    setShowForm(false);
  };

  const openAdd = () => { resetForm(); setShowForm(true); };
  const handleEditStart = (todo: any) => {
    setEditingId(todo.id);
    setText(todo.text);
    if (todo.reminderAt) {
      const d = new Date(todo.reminderAt);
      setReminderDateInput(toDateOnly(d));
      setReminderTimeInput(toTimeOnly(d));
    } else {
      setReminderDateInput('');
      setReminderTimeInput('');
    }
    setDueDateInput(todo.dueDate || '');
    setGroupId(todo.groupId || '');
    setImages(todo.images || []);
    setNotes(todo.notes || '');
    setRecurring(!!todo.recurring);
    setFreqConfig(frequencyConfigFromFields(todo));
    setReminderOffsetMinutes(todo.reminderOffsetMinutes ?? null);
    setReminderStyle(todo.reminderStyle === 'alarm' ? 'alarm' : 'notification');
    setMoreOpen(todo.recurring ? 'repeat' : todo.notes ? 'note' : (todo.images?.length || 0) > 0 ? 'photo' : null);
    setShowPickDate(false);
    setShowCustomRemind(false);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!user || !trimmed) return;

    setSaving(true);
    try {
      // Fired rather than awaited — Firestore write promises don't resolve until the server
      // acks them, which wouldn't happen until back online even though the write is already
      // durably queued locally (see offlineWrite.ts). Awaiting here would leave the Save button
      // stuck showing "Saving…" until connectivity returns instead of resetting right away.
      // A habit has no single due date/time to remind about — it resets on its own schedule
      // instead (see todo.remindBeforeDue) — so due date and the one-shot reminder are forced
      // off rather than just hidden, in case a to-do that already had them gets marked recurring.
      const reminderAt = !recurring && reminderDateInput
        ? new Date(`${reminderDateInput}T${reminderTimeInput || '09:00'}`).toISOString()
        : null;
      const dueDate = recurring ? null : (dueDateInput || null);
      const trimmedNotes = notes.trim();
      const recurringFields = recurring
        ? {
            recurring: true,
            recurringActive: true,
            nextRunDate: firstOccurrenceOnOrAfter(freqConfig, new Date()).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            reminderOffsetMinutes,
            habitReminderSent: false,
          }
        : { recurring: false, reminderOffsetMinutes: null };
      if (editingId) {
        fireWrite(updateDoc(doc(db, 'todos', editingId), {
          text: trimmed,
          reminderAt,
          dueDate,
          reminderSent: false,
          groupId: groupId || null,
          reminderStyle: reminderAt && !groupId ? reminderStyle : null,
          images,
          notes: trimmedNotes || null,
          ...recurringFields,
          ...(recurring ? frequencyConfigForUpdate(freqConfig) : {}),
        }), 'update to-do');
      } else {
        fireWrite(setDoc(doc(collection(db, 'todos')), {
          userId: user.uid,
          text: trimmed,
          done: false,
          status: 'pending',
          reminderAt,
          dueDate,
          reminderSent: false,
          groupId: groupId || null,
          ...(reminderAt && !groupId ? { reminderStyle } : {}),
          createdAt: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
          ...(trimmedNotes ? { notes: trimmedNotes } : {}),
          ...recurringFields,
          ...(recurring ? sanitizeFrequencyConfig(freqConfig) : {}),
        }), 'add to-do');
        if (groupId) {
          notifyGroupActivity({
            groupId,
            action: 'todo_created',
            description: trimmed,
            actorName: profile?.displayName || user.displayName || 'Someone',
          });
        }
      }
      resetForm();
    } catch (err) {
      console.error('Failed to save to-do:', err);
      alert(t('todo.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  // A to-do created by GoalDetail's Recommended Transfers card (Cash Savings -> account) can carry
  // a `linkedTransfer` payload that hasn't been applied yet ("later" timing — see GoalDetail.tsx).
  // Completing that to-do is what actually moves the money: this runs the same transfer
  // executeCashToAccountTransfer already does for the "now" case, then marks it applied so it can
  // never double-execute (a re-check, a retry, or toggling done again later). Returns false (and
  // leaves the todo untouched) on failure — e.g. Cash Savings no longer has enough balance since
  // this was proposed — so the caller aborts the done-toggle rather than marking it complete over a
  // transfer that didn't actually happen. A todo with no linkedTransfer, or one already applied
  // (including every "now"-timing todo, which starts out already executed), is a no-op success.
  const tryExecuteLinkedTransfer = async (todo: any): Promise<boolean> => {
    if (!todo.linkedTransfer || todo.linkedTransferExecuted) return true;
    try {
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      // The to-do's own text is already the clearest possible audit note here ("Transfer ₹X to Y
      // from your savings") — reused as-is so the account's History and Cash Savings' own ledger
      // both explain WHY this balance moved, same as the "now"-timing path already does.
      const { justCompletedGoals } = await executeCashToAccountTransfer(
        todo.linkedTransfer.fromGoalId, todo.linkedTransfer.toAccountId, todo.linkedTransfer.amountMinor, actorName, todo.text,
      );
      notifyGoalsMet(justCompletedGoals);
      await updateDoc(doc(db, 'todos', todo.id), { linkedTransferExecuted: true });
      return true;
    } catch (err) {
      console.error('Failed to execute linked transfer:', err);
      alert(t('todo.linkedTransferFailed'));
      return false;
    }
  };

  const handleToggleDone = async (todo: any) => {
    try {
      const nowDone = !todo.done;
      if (nowDone && !(await tryExecuteLinkedTransfer(todo))) return;
      await updateDoc(doc(db, 'todos', todo.id), {
        done: nowDone, status: nowDone ? 'done' : 'pending',
        ...(nowDone ? { completedAt: new Date().toISOString() } : {}),
      });
      if (nowDone && !todo.recurring) claimPoints('todo_completed', { todoId: todo.id });
      if (nowDone && todo.groupId) {
        notifyGroupActivity({
          groupId: todo.groupId,
          action: 'todo_completed',
          description: todo.text,
          actorName: profile?.displayName || user?.displayName || 'Someone',
        });
      }
    } catch (err) {
      console.error('Failed to update to-do:', err);
    }
  };

  // Inline status control inside the detail sheet — a superset of handleToggleDone's binary
  // done/pending (adds 'na'). `done` stays in sync (true for both 'done' and 'na') so every
  // existing done-based query/filter (the reminder cron's `where('done','==',false)`, the list's
  // done/pending filter) keeps working without needing to know about the third state.
  const handleSetStatus = async (todo: any, status: 'pending' | 'done' | 'na') => {
    try {
      const nowDone = status !== 'pending';
      // Only 'done' triggers the linked transfer — 'na' means "this doesn't apply," which should
      // never move money.
      if (status === 'done' && !(await tryExecuteLinkedTransfer(todo))) return;
      await updateDoc(doc(db, 'todos', todo.id), {
        status, done: nowDone,
        ...(status === 'done' ? { completedAt: new Date().toISOString() } : {}),
      });
      setViewingTodo((prev: any) => (prev && prev.id === todo.id ? { ...prev, status, done: nowDone } : prev));
      if (status === 'done' && !todo.recurring) claimPoints('todo_completed', { todoId: todo.id });
      if (status === 'done' && todo.groupId) {
        notifyGroupActivity({
          groupId: todo.groupId,
          action: 'todo_completed',
          description: todo.text,
          actorName: profile?.displayName || user?.displayName || 'Someone',
        });
      }
    } catch (err) {
      console.error('Failed to update to-do status:', err);
    }
  };

  const handleSaveNotes = async (todo: any) => {
    setSavingNotes(true);
    try {
      const trimmed = notesDraft.trim();
      await updateDoc(doc(db, 'todos', todo.id), { notes: trimmed || null });
      setViewingTodo((prev: any) => (prev && prev.id === todo.id ? { ...prev, notes: trimmed } : prev));
    } catch (err) {
      console.error('Failed to save notes:', err);
      alert(t('todo.failedToSaveNotes'));
    } finally {
      setSavingNotes(false);
    }
  };

  // A habit-tracker cell tap: today's cell just flips the live done/status fields (same as the
  // list view's checkbox); a past cell writes directly into that day's `history` entry instead,
  // since the live fields have already moved on to a later occurrence by then.
  const handleToggleHabitDay = async (todo: any, dateStr: string, nextDone: boolean) => {
    const todayStr = toDateOnly(new Date());
    try {
      if (dateStr === todayStr) {
        await updateDoc(doc(db, 'todos', todo.id), { done: nextDone, status: nextDone ? 'done' : 'pending' });
      } else {
        await updateDoc(doc(db, 'todos', todo.id), { [`history.${dateStr}`]: nextDone });
      }
      if (nextDone) claimPoints('habit_occurrence', { todoId: todo.id, dateStr });
    } catch (err) {
      console.error('Failed to update habit day:', err);
    }
  };

  // Pauses/resumes a habit's own schedule (processRecurringTodos in server.ts skips paused
  // habits entirely) without touching its history or today's live done/status — same "pause
  // without losing progress" idea as RecurringExpenses.tsx's handleToggleActive.
  const handleToggleHabitPause = async (todo: any) => {
    try {
      const willBeActive = todo.recurringActive === false; // true = resuming, false = pausing
      await updateDoc(doc(db, 'todos', todo.id), {
        recurringActive: willBeActive,
        ...(willBeActive ? {} : { pausedAt: new Date().toISOString() }),
      });
      if (willBeActive) claimPoints('habit_resumed', { todoId: todo.id });
    } catch (err) {
      console.error('Failed to toggle habit pause:', err);
    }
  };

  const handleDelete = async (todo: any) => {
    if (!window.confirm(t('todo.confirmDelete'))) return;
    try {
      await deleteDoc(doc(db, 'todos', todo.id));
      await cancelLocalTodoReminder(todo.id);
    } catch (err) {
      console.error('Failed to delete to-do:', err);
    }
  };

  // ---------- "today focus": what needs doing now, then the rest ----------
  const todayStr = toDateOnly(new Date());
  const dayNumber = (dateStr: string) => Math.round(new Date(`${dateStr}T00:00:00`).getTime() / 86_400_000);
  const streakOf = (todoId: string): number => {
    const d: any = habitStreaksValue?.docs.find((x) => x.id === todoId)?.data();
    if (!d || !d.lastDateStr) return 0;
    const gap = dayNumber(todayStr) - dayNumber(d.lastDateStr);
    return gap <= 1 ? Number(d.current) || 0 : 0;
  };
  // habits due today (a habit is a recurring to-do that resets itself on its schedule)
  const habitsToday = todos.filter((td: any) => td.recurring && td.recurringActive !== false && isDueOnDate(frequencyConfigFromFields(td), todayStr, String(td.createdAt || '').slice(0, 10)));
  const plain = displayedTodos.filter((td: any) => !td.recurring);
  const overdue = plain.filter((td: any) => !td.done && td.dueDate && td.dueDate < todayStr).sort((x: any, y: any) => String(x.dueDate).localeCompare(String(y.dueDate)));
  const dueToday = plain.filter((td: any) => td.dueDate === todayStr).sort((x: any, y: any) => Number(!!x.done) - Number(!!y.done) || String(x.reminderAt || '9').localeCompare(String(y.reminderAt || '9')));
  const later = plain.filter((td: any) => !td.done && td.dueDate && td.dueDate > todayStr).sort((x: any, y: any) => String(x.dueDate).localeCompare(String(y.dueDate)));
  const anytime = plain.filter((td: any) => !td.done && !td.dueDate);
  const finished = plain.filter((td: any) => td.done && td.dueDate !== todayStr);
  const todayDone = plain.filter((td: any) => td.dueDate === todayStr && td.done).length + habitsToday.filter((td: any) => td.done).length;
  const todayTotal = plain.filter((td: any) => td.dueDate === todayStr).length + habitsToday.length;
  const todayPct = todayTotal > 0 ? Math.round((todayDone / todayTotal) * 100) : overdue.length > 0 ? 0 : 100;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (profile?.displayName || user?.displayName || '').split(' ')[0];

  // a task typed into the bar at the bottom: a plain personal to-do due today (the full form is for reminders, sharing and habits)
  const handleQuickAdd = () => {
    const txt = quickText.trim();
    if (!user || !txt) return;
    fireWrite(setDoc(doc(collection(db, 'todos')), {
      userId: user.uid, text: txt, done: false, status: 'pending', reminderAt: null, dueDate: todayStr, reminderSent: false,
      groupId: null, createdAt: new Date().toISOString(), recurring: false, reminderOffsetMinutes: null,
    }), 'add to-do');
    setQuickText('');
  };

  const dueChip = (td: any) => {
    if (!td.dueDate) return null;
    const diff = dayNumber(td.dueDate) - dayNumber(todayStr);
    if (diff < 0 && !td.done) return { text: diff === -1 ? 'Yesterday' : `${-diff} days ago`, cls: 'bg-rose-100 text-rose-700' };
    if (diff === 0) {
      const time = td.reminderAt && String(td.reminderAt).slice(0, 10) !== '' ? new Date(td.reminderAt) : null;
      return { text: time && toDateOnly(time) === todayStr ? time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Today', cls: 'bg-amber-100 text-amber-800' };
    }
    return { text: new Date(`${td.dueDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), cls: 'bg-sky-100 text-sky-800' };
  };

  const renderTask = (todo: any) => {
    const group = groups.find((g: any) => g.id === todo.groupId);
    const creator = allMembers.find((m: any) => m.userId === todo.userId);
    const chip = dueChip(todo);
    const reminderPast = todo.reminderAt && !todo.done && new Date(todo.reminderAt) < new Date();
    // the tile colour says how urgent it is; tapping the tile ticks the task off
    const lateNow = !todo.done && todo.dueDate && todo.dueDate < todayStr;
    const tileBg = todo.done ? '#16a34a' : lateNow ? '#ffe4e6' : todo.dueDate === todayStr ? '#fef3c7' : todo.dueDate ? '#e0f2fe' : '#eef2f7';
    return (
      <div key={todo.id} onClick={() => { setViewingTodo(todo); setNotesDraft(todo.notes || ''); }} className={clsx('flex items-center gap-3 px-3 py-2.5 cursor-pointer bg-white rounded-2xl shadow-[0_2px_8px_rgba(30,58,95,0.09)] active:scale-[0.99] transition-all', todo.done && 'opacity-60')}>
        <button
          onClick={(e) => { e.stopPropagation(); handleToggleDone(todo); }}
          className="relative w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-[19px] active:scale-90 transition-transform"
          style={{ background: tileBg }}
          aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
        >
          {todo.done ? <span className="material-symbols-outlined text-[22px] text-white" style={{ fontVariationSettings: "'wght' 700" }}>check</span> : <span>{taskIcon(todo.text)}</span>}
          {!todo.done && <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-white border-2 border-slate-300" />}
        </button>
        {todo.images?.[0] && (
          <button type="button" onClick={(e) => { e.stopPropagation(); setLightboxSrc(todo.images[0]); }} className="shrink-0">
            <img src={todo.images[0]} alt="" className="w-9 h-9 rounded-lg object-cover border border-border-subtle" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className={clsx('text-sm font-bold truncate', todo.done ? 'line-through text-text-muted' : 'text-primary')}>{todo.text}</p>
          <p className="text-[11px] text-text-muted truncate flex items-center gap-1.5">
            {group ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-sky-50 text-sky-800 px-1.5 py-px text-[10px] font-bold shrink-0">{group.photoURL ? <img src={group.photoURL} alt="" className="w-3.5 h-3.5 rounded-sm object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(group.icon)}</span>}{group.name}</span>
            ) : <span>Personal</span>}
            {group && todo.userId !== user?.uid && <span className="truncate">· {creator?.displayName || t('todo.aMember')}</span>}
            {todo.reminderAt && !reminderPast && <span className="shrink-0">· 🔔</span>}
          </p>
          {todo.linkedTransfer && (
            <p className={clsx('text-[10px] font-bold truncate', todo.linkedTransferExecuted ? 'text-text-muted' : 'text-primary')}>
              {t('todo.linkedTransferSummary', { account: todo.linkedTransfer.toAccountName, amount: `${getCurrencySymbol(todo.linkedTransfer.currency)}${fromMinorUnits(todo.linkedTransfer.amountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}` })}
            </p>
          )}
        </div>
        {reminderPast && <span className="material-symbols-outlined text-[16px] text-error shrink-0" title={t('todo.reminderPassed')}>notifications_active</span>}
        {chip && <span className={clsx('shrink-0 rounded-lg px-2 py-0.5 text-[10.5px] font-black whitespace-nowrap', chip.cls)}>{chip.text}</span>}
      </div>
    );
  };

  const section = (key: string, title: string, list: any[], tone?: 'red') => list.length === 0 ? null : (
    <div key={key} className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className={clsx('text-[11px] font-black uppercase tracking-[0.12em]', tone === 'red' ? 'text-rose-600' : 'text-slate-500')}>{title}</h2>
        <span className={clsx('text-[11px] font-black rounded-full px-2 py-px', tone === 'red' ? 'bg-rose-100 text-rose-700' : 'bg-slate-200/70 text-slate-600')}>{list.length}</span>
      </div>
      <div className="space-y-2">{list.map(renderTask)}</div>
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        {/* the day at a glance */}
        <div className="rounded-3xl p-4 text-white flex items-center gap-4 shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)', paddingBottom: viewMode === 'list' && habitsToday.length > 0 ? 62 : 16 }}>
          <div className="shrink-0 rounded-full flex items-center justify-center" style={{ width: 70, height: 70, background: `conic-gradient(#ffd166 0 ${todayPct}%, rgba(255,255,255,.25) 0)` }}>
            <div className="rounded-full flex items-center justify-center text-sm font-black" style={{ width: 56, height: 56, background: '#0d5167' }}>{todayTotal > 0 ? `${todayDone}/${todayTotal}` : '✓'}</div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-black leading-tight">{greeting}{firstName ? `, ${firstName}` : ''}</p>
            <p className="text-[12px] text-white/85 mt-0.5">
              {todayTotal > 0 ? `${todayDone} of ${todayTotal} done today` : 'Nothing due today'}{overdue.length > 0 ? ` · ${overdue.length} overdue` : ''}
            </p>
          </div>
          <button type="button" onClick={() => setShowSearch((v) => !v)} className="shrink-0 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center active:scale-95" title="Search">
            <span className="material-symbols-outlined text-[20px]">search</span>
          </button>
          <button type="button" data-tour="todo-calendar" onClick={() => setShowCalendar((v) => !v)} className={clsx('shrink-0 w-9 h-9 rounded-full flex items-center justify-center active:scale-95', showCalendar || selectedDate ? 'bg-white text-primary' : 'bg-white/15')} title="Calendar">
            <span className="material-symbols-outlined text-[20px]">calendar_month</span>
          </button>
        </div>

        {/* habits due today: solid colour tiles that overlap the hero; tap to tick, with the streak */}
        {viewMode === 'list' && habitsToday.length > 0 && (
          <div className="space-y-2 relative" style={{ marginTop: -50 }}>
            <div className="flex gap-2.5 overflow-x-auto no-scrollbar px-1 pt-1 pb-3">
              {habitsToday.map((hb: any, i: number) => {
                const streak = streakOf(hb.id);
                return (
                  <button
                    key={hb.id}
                    type="button"
                    onClick={() => handleToggleHabitDay(hb, todayStr, !hb.done)}
                    className="shrink-0 w-[96px] rounded-2xl px-2 py-3 text-center text-white shadow-lg active:scale-95 transition-all"
                    style={{ background: HABIT_TONES[i % HABIT_TONES.length], opacity: hb.done ? 0.92 : 1 }}
                  >
                    <span className={clsx('mx-auto mb-1.5 w-7 h-7 rounded-full border-2 flex items-center justify-center', hb.done ? 'bg-white border-white text-emerald-600' : 'border-white/70 text-transparent')}>
                      <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>
                    </span>
                    <span className="block text-[11.5px] font-black truncate">{hb.text}</span>
                    <span className="block text-[10px] font-black text-white/90">{streak > 0 ? `🔥 ${streak}` : 'Start today'}</span>
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={() => setViewMode('habits')} className="block ml-auto -mt-1 px-1 text-[11px] font-black text-primary">All habits ›</button>
          </div>
        )}

        {showSearch && (
          <input
            type="text"
            autoFocus
            placeholder={t('todo.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-white border border-border-subtle rounded-xl py-2.5 px-4 outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm text-primary"
          />
        )}

        {viewMode === 'habits' && (
          <>
            <button type="button" onClick={() => setViewMode('list')} className="text-xs font-black text-primary flex items-center gap-1"><span className="material-symbols-outlined text-[16px]">arrow_back</span>Back to tasks</button>
            <HabitTracker
              todos={habitTodos}
              onToggleDay={handleToggleHabitDay}
              onSelectHabit={(todo) => { setViewingTodo(todo); setNotesDraft(todo.notes || ''); }}
              onTogglePause={handleToggleHabitPause}
              searchActive={!!searchTerm.trim()}
            />
          </>
        )}

        {showForm && (() => {
          // ---- the new-to-do sheet: type it, tap a day, choose how to be reminded ----
          const base = dueDateInput || todayStr;
          const dueKind = !dueDateInput ? 'none' : dueDateInput === todayStr ? 'today' : dueDateInput === addDays(todayStr, 1) ? 'tomorrow' : dueDateInput === comingSaturday(todayStr) ? 'weekend' : dueDateInput === comingMonday(todayStr) ? 'week' : 'pick';
          const remindKind = !reminderDateInput ? 'none' : reminderDateInput === base && reminderTimeInput === '09:00' ? 'morning' : reminderDateInput === base && reminderTimeInput === '18:00' ? 'evening' : 'custom';
          const setDue = (d: string) => {
            setDueDateInput(d);
            if (remindKind === 'morning' || remindKind === 'evening') setReminderDateInput(d || todayStr); // a reminder that was "that morning" follows the day
            if (d) setShowPickDate(false);
          };
          const setRemind = (kind: 'none' | 'morning' | 'evening' | 'custom') => {
            if (kind === 'none') { setReminderDateInput(''); setReminderTimeInput(''); setShowCustomRemind(false); return; }
            if (kind === 'custom') { setShowCustomRemind(true); if (!reminderDateInput) { setReminderDateInput(base); setReminderTimeInput('09:00'); } return; }
            setShowCustomRemind(false);
            setReminderDateInput(base);
            setReminderTimeInput(kind === 'morning' ? '09:00' : '18:00');
          };
          const remindPassed = !!reminderDateInput && new Date(`${reminderDateInput}T${reminderTimeInput || '09:00'}`).getTime() < Date.now();
          const chip = (on: boolean, tone: 'teal' | 'orange' = 'teal') => clsx(
            'rounded-full px-3.5 py-1.5 text-xs font-black border transition-all active:scale-95',
            on ? (tone === 'orange' ? 'text-white border-transparent shadow-sm bg-gradient-to-r from-orange-500 to-rose-500' : 'text-white border-transparent shadow-sm bg-gradient-to-r from-[#0f7a8f] to-[#22c1a5]') : 'bg-white text-slate-600 border-slate-200',
          );
          const cap = (label: string) => <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mt-4 mb-1.5 px-0.5">{label}</p>;
          const moreBtn = (id: 'note' | 'photo' | 'repeat', icon: string, label: string, filled: boolean) => (
            <button key={id} type="button" onClick={() => setMoreOpen(moreOpen === id ? null : id)} className={clsx('flex-1 relative rounded-2xl py-2.5 text-center text-[11px] font-black border transition-all active:scale-95', moreOpen === id ? 'bg-[#0f7a8f]/10 border-[#0f7a8f]/40 text-[#0b5f70]' : 'bg-slate-50 border-transparent text-slate-600')}>
              <span className="block text-[17px] leading-none mb-0.5">{icon}</span>{label}
              {filled && <span className="absolute top-1.5 right-2.5 w-2 h-2 rounded-full bg-orange-500" />}
            </button>
          );
          return (
            <div className="fixed inset-0 bg-black/45 z-[120] flex items-end justify-center" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }} onClick={resetForm}>
              <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
                <form onSubmit={handleSubmit} className="bg-white rounded-t-3xl px-4 pt-3 overflow-y-auto" style={{ maxHeight: 'calc(92vh - 4rem - env(safe-area-inset-bottom))', paddingBottom: '1.25rem' }}>
                  <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3" />
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-base font-black text-primary">{editingId ? t('todo.editToDo') : t('todo.newToDo')}</h2>
                    <button type="button" onClick={resetForm} className="text-xs font-black text-[#0f7a8f]">{t('common.cancel')}</button>
                  </div>

                  {/* what: the icon beside the box is the one the task will get on the list */}
                  <div className="flex items-center gap-3 rounded-2xl bg-slate-50 border-2 border-[#22c1a5] p-2.5">
                    <span className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center text-[22px] shrink-0">{taskIcon(text)}</span>
                    <input
                      type="text"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={t('todo.whatNeedsDoingPlaceholder')}
                      maxLength={300}
                      required
                      autoFocus
                      className="flex-1 min-w-0 bg-transparent text-[15px] font-bold text-primary outline-none placeholder:text-slate-400 placeholder:font-medium"
                    />
                  </div>

                  {!recurring && (
                    <>
                      {cap('When')}
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className={chip(dueKind === 'today')} onClick={() => setDue(todayStr)}>Today</button>
                        <button type="button" className={chip(dueKind === 'tomorrow')} onClick={() => setDue(addDays(todayStr, 1))}>Tomorrow</button>
                        <button type="button" className={chip(dueKind === 'weekend')} onClick={() => setDue(comingSaturday(todayStr))}>This weekend</button>
                        <button type="button" className={chip(dueKind === 'week')} onClick={() => setDue(comingMonday(todayStr))}>Next week</button>
                        <button type="button" className={chip(dueKind === 'pick' || showPickDate)} onClick={() => setShowPickDate((v) => !v)}>
                          📅 {dueKind === 'pick' ? new Date(`${dueDateInput}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'Pick'}
                        </button>
                        <button type="button" className={chip(dueKind === 'none')} onClick={() => setDue('')}>No date</button>
                      </div>
                      {showPickDate && (
                        <input type="date" value={dueDateInput} onChange={(e) => setDue(e.target.value)} className="mt-2 w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                      )}

                      {cap('Remind me')}
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className={chip(remindKind === 'none')} onClick={() => setRemind('none')}>No reminder</button>
                        <button type="button" className={chip(remindKind === 'morning')} onClick={() => setRemind('morning')}>🔔 9:00 am</button>
                        <button type="button" className={chip(remindKind === 'evening')} onClick={() => setRemind('evening')}>🔔 6:00 pm</button>
                        <button type="button" className={chip(remindKind === 'custom')} onClick={() => setRemind('custom')}>⏰ Pick time</button>
                      </div>
                      {(showCustomRemind || remindKind === 'custom') && (
                        <div className="flex gap-2 mt-2">
                          <input type="date" value={reminderDateInput} onChange={(e) => setReminderDateInput(e.target.value)} className="flex-1 min-w-0 bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                          <input type="time" value={reminderTimeInput} onChange={(e) => setReminderTimeInput(e.target.value)} disabled={!reminderDateInput} className="flex-1 min-w-0 bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40" />
                        </div>
                      )}
                      {remindPassed && <p className="text-[11px] font-bold text-rose-600 mt-1.5 px-0.5">That time has already passed, so no reminder will come. Pick a later one.</p>}

                      {/* how the reminder arrives */}
                      {remindKind !== 'none' && (
                        <div className="mt-3 rounded-2xl bg-slate-50 p-2.5">
                          <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1.5 px-0.5">How should it remind you?</p>
                          {groupId ? (
                            <p className="text-[11.5px] text-slate-600 px-0.5">A shared to-do reminds everyone with a notification. Alarms are for tasks that are just yours.</p>
                          ) : (
                            <>
                              <div className="grid grid-cols-2 gap-2">
                                <button type="button" onClick={() => setReminderStyle('notification')} className={clsx('rounded-xl border-2 px-3 py-2 text-left transition-all active:scale-95', reminderStyle === 'notification' ? 'border-[#22c1a5] bg-white' : 'border-transparent bg-white/60')}>
                                  <span className="block text-sm font-black text-primary">🔔 Notification</span>
                                  <span className="block text-[10.5px] text-slate-500 leading-snug">A quiet nudge on your phone</span>
                                </button>
                                <button type="button" onClick={() => setReminderStyle('alarm')} className={clsx('rounded-xl border-2 px-3 py-2 text-left transition-all active:scale-95', reminderStyle === 'alarm' ? 'border-orange-400 bg-orange-50' : 'border-transparent bg-white/60')}>
                                  <span className="block text-sm font-black text-primary">⏰ Alarm</span>
                                  <span className="block text-[10.5px] text-slate-500 leading-snug">Rings until you stop or snooze it</span>
                                </button>
                              </div>
                              {reminderStyle === 'alarm' && (
                                <p className="text-[11px] text-slate-600 mt-1.5 px-0.5">{canRingTodoAlarm() ? 'Rings like an alarm clock with Snooze and Dismiss, even when the phone is on silent.' : 'Alarms ring on Android phones. Here you will get a notification instead.'}</p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {groups.length > 0 && (
                    <>
                      {cap('Who sees it')}
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className={chip(!groupId)} onClick={() => setGroupId('')}>🔒 {t('todo.justMe')}</button>
                        {groups.map((g: any) => (
                          <button key={g.id} type="button" className={clsx(chip(groupId === g.id), 'inline-flex items-center gap-1')} onClick={() => setGroupId(g.id)}>
                            {g.photoURL ? <img src={g.photoURL} alt="" className="w-4 h-4 rounded object-cover" referrerPolicy="no-referrer" /> : <span>{groupIconEmoji(g.icon)}</span>}{g.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* the rest, one tap away: a note, photos, repeating */}
                  <div className="flex gap-2 mt-4 pt-3 border-t border-slate-100">
                    {moreBtn('note', '📝', 'Note', !!notes.trim())}
                    {moreBtn('photo', '📷', 'Photo', images.length > 0)}
                    {moreBtn('repeat', '🔁', 'Repeats', recurring)}
                  </div>
                  {moreOpen === 'note' && (
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('todo.notesPlaceholder')} maxLength={500} rows={3} className="mt-2.5 w-full bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none" />
                  )}
                  {moreOpen === 'photo' && (
                    <div className="mt-2.5"><ImageAttachments images={images} onChange={setImages} /></div>
                  )}
                  {moreOpen === 'repeat' && (
                    <div className="mt-2.5 space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <label className="flex items-center gap-2 text-xs font-bold text-on-surface cursor-pointer">
                        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="w-4 h-4 accent-primary" />
                        <span className="material-symbols-outlined text-[16px] text-primary">autorenew</span>
                        {t('todo.repeatToggle')}
                      </label>
                      {recurring && (
                        <>
                          <p className="text-[10px] text-text-muted px-1">{t('todo.repeatHelp')}</p>
                          <FrequencyPicker config={freqConfig} onChange={setFreqConfig} />
                          <div className="space-y-1">
                            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.remindBeforeDue')}</label>
                            <select value={reminderOffsetMinutes ?? ''} onChange={(e) => setReminderOffsetMinutes(e.target.value ? Number(e.target.value) : null)} className="w-full bg-white p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-primary/20">
                              <option value="">{t('todo.noReminder')}</option>
                              <option value="15">{t('todo.remind15min')}</option>
                              <option value="30">{t('todo.remind30min')}</option>
                              <option value="60">{t('todo.remind1hr')}</option>
                              <option value="240">{t('todo.remind4hr')}</option>
                              <option value="1440">{t('todo.remind1day')}</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <button type="submit" disabled={saving || !text.trim()} className="w-full mt-4 py-3.5 rounded-2xl text-white text-sm font-black bg-gradient-to-r from-orange-500 to-rose-500 shadow-lg shadow-rose-500/30 disabled:opacity-50 active:scale-[0.99]">
                    {saving ? t('common.saving') : editingId ? t('groupExpenses.saveChanges') : 'Add to-do'}
                  </button>
                </form>
              </div>
            </div>
          );
        })()}

        {viewMode === 'list' && (
        <>
        {/* whose tasks: everyone's, just mine, or one group */}
        {groupsWithTodos.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {([{ id: 'all', label: t('groupExpenses.all') }, { id: 'personal', label: t('todo.justMe') }, ...groupsWithTodos.map((g: any) => ({ id: g.id, label: `${groupIconEmoji(g.icon)} ${g.name}` }))] as { id: string; label: string }[]).map((chip) => (
              <button key={chip.id} type="button" onClick={() => setListFilter(chip.id)} className={clsx('shrink-0 rounded-full px-3.5 py-1.5 text-xs font-black border transition-all', listFilter === chip.id ? 'text-white border-transparent shadow-md bg-gradient-to-r from-[#0f7a8f] to-[#22c1a5]' : 'bg-white text-text-muted border-border-subtle')}>
                {chip.label}
              </button>
            ))}
          </div>
        )}

        {(showCalendar || selectedDate) && (
        <div data-tour="todo-calendar-grid">
          <MonthCalendar
            cursor={calendarCursor}
            onCursorChange={setCalendarCursor}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            storageKey="todo-calendar-expanded"
            defaultExpanded
            dayHasActivity={(dateStr) => {
              const entry = dueByDate.get(dateStr);
              return !!entry && (entry.personalTotal > 0 || entry.groups.size > 0);
            }}
            dayTitle={(dateStr) => {
              const entry = dueByDate.get(dateStr);
              return entry ? t('todo.dayTitle', { personal: entry.personalTotal, groups: entry.groups.size }) : undefined;
            }}
            renderDayDots={(dateStr) => {
              const entry = dueByDate.get(dateStr);
              const groupDots = entry ? Array.from(entry.groups.entries()) : [];
              const hasDots = !!entry && (entry.personalTotal > 0 || groupDots.length > 0);
              if (!hasDots) return null;
              return (
                <span className="flex items-center gap-0.5">
                  {entry!.personalTotal > 0 && (
                    <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', entry!.personalDone === entry!.personalTotal ? 'bg-on-surface/30' : 'bg-on-surface')} />
                  )}
                  {groupDots.slice(0, 3).map(([gid, g]) => {
                    const group = groups.find((x: any) => x.id === gid);
                    const done = g.done === g.total;
                    return <span key={gid} className={clsx('text-[10px] leading-none shrink-0', done && 'opacity-40')}>{groupIconEmoji(group?.icon)}</span>;
                  })}
                  {groupDots.length > 3 && <span className="text-[8px] leading-none font-bold shrink-0">+</span>}
                </span>
              );
            }}
          />
        </div>
        )}
        {selectedDate && (
          <div className="flex items-center justify-between px-1">
            <p className="text-[11px] font-bold text-text-muted">
              {new Date(`${selectedDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
            </p>
            <button type="button" onClick={() => setSelectedDate(null)} className="text-[11px] font-bold text-primary">
              {t('common.viewFullList')}
            </button>
          </div>
        )}

        <div className="space-y-4">
          {myLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {myError && <p className="text-sm text-error px-1">{t('todo.couldntLoad', { error: myError.code || myError.message })}</p>}
          {!myLoading && !myError && plain.length === 0 && habitsToday.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">
              {searchTerm.trim() ? t('todo.noSearchResults') : selectedDate ? t('todo.noToDosDueDay') : t('todo.noToDosYet')}
            </p>
          )}
          {section('overdue', 'Overdue', overdue, 'red')}
          {section('today', 'Today', dueToday)}
          {section('later', 'Later', later)}
          {section('anytime', 'Anytime', anytime)}
          {finished.length > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowDone((v) => !v)} className="w-full flex items-center justify-between px-1">
                <span className="text-[11px] font-black uppercase tracking-[0.12em] text-text-muted">Done · {finished.length}</span>
                <span className="material-symbols-outlined text-[18px] text-text-muted" style={{ transform: showDone ? 'rotate(180deg)' : 'none' }}>expand_more</span>
              </button>
              {showDone && <div className="space-y-2">{finished.map(renderTask)}</div>}
            </div>
          )}
        </div>
        </>
        )}

        {/* quick add: sits above the bottom bar. Enter adds a task due today; the + opens the full form for reminders, sharing and habits */}
        {viewMode === 'list' && !showForm && (
          <div className="fixed left-3 right-3 z-30 mx-auto max-w-xl flex items-center gap-2 bg-white border border-border-subtle rounded-full shadow-lg pl-4 pr-1.5 py-1.5" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 10px)' }}>
            <input
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAdd(); }}
              maxLength={120}
              placeholder="Add a task for today…"
              className="flex-1 min-w-0 bg-transparent text-sm outline-none text-primary placeholder:text-text-muted"
            />
            {quickText.trim() ? (
              <button type="button" onClick={handleQuickAdd} className="shrink-0 h-9 px-4 rounded-full bg-gradient-to-br from-orange-500 to-rose-500 text-white text-xs font-black active:scale-95">Add</button>
            ) : (
              <button type="button" data-tour="todo-add" onClick={openAdd} title={t('todo.newToDo')} className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-orange-500 to-rose-500 text-white flex items-center justify-center active:scale-95">
                <span className="material-symbols-outlined text-[20px]">add</span>
              </button>
            )}
          </div>
        )}
      </main>
      {viewingTodo && (() => {
        const group = groups.find((g: any) => g.id === viewingTodo.groupId);
        const creator = allMembers.find((m: any) => m.userId === viewingTodo.userId);
        return (
          <DetailSheet
            aboveNav
            title={t('todo.detailTitle')}
            onClose={() => setViewingTodo(null)}
            onEdit={() => { const td = viewingTodo; setViewingTodo(null); handleEditStart(td); }}
            onDelete={() => { const td = viewingTodo; setViewingTodo(null); handleDelete(td); }}
          >
            <DetailField label={t('todo.task')}>{viewingTodo.text}</DetailField>
            {viewingTodo.linkedTransfer && (
              <DetailField label={t('todo.linkedTransferLabel')}>
                <p className="text-sm font-bold text-on-surface">
                  {t('todo.linkedTransferBreakdown', {
                    account: viewingTodo.linkedTransfer.toAccountName,
                    amount: `${getCurrencySymbol(viewingTodo.linkedTransfer.currency)}${fromMinorUnits(viewingTodo.linkedTransfer.amountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                  })}
                </p>
                <p className={clsx('text-[11px] mt-1', viewingTodo.linkedTransferExecuted ? 'text-text-muted' : 'text-primary font-bold')}>
                  {viewingTodo.linkedTransferExecuted ? t('todo.linkedTransferApplied') : t('todo.linkedTransferPending')}
                </p>
              </DetailField>
            )}
            <DetailField label={t('todo.status')}>
              <div className="flex gap-2">
                {(['pending', 'done', 'na'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSetStatus(viewingTodo, s)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-xs font-bold border transition-all',
                      (viewingTodo.status || (viewingTodo.done ? 'done' : 'pending')) === s
                        ? s === 'done' ? 'bg-success text-white border-success' : s === 'na' ? 'bg-text-muted text-white border-text-muted' : 'bg-primary text-white border-primary'
                        : 'bg-white text-text-muted border-border-subtle',
                    )}
                  >
                    {s === 'done' ? t('todo.statusDone') : s === 'na' ? t('todo.statusNa') : t('todo.statusPending')}
                  </button>
                ))}
              </div>
            </DetailField>
            <DetailField label={t('todo.notes')}>
              <div className="space-y-2">
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  placeholder={t('todo.notesPlaceholder')}
                  maxLength={500}
                  rows={2}
                  className="w-full bg-surface p-2.5 rounded-lg border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
                />
                {notesDraft !== (viewingTodo.notes || '') && (
                  <button
                    type="button"
                    onClick={() => handleSaveNotes(viewingTodo)}
                    disabled={savingNotes}
                    className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50"
                  >
                    {savingNotes ? t('common.saving') : t('todo.saveNotes')}
                  </button>
                )}
              </div>
            </DetailField>
            {viewingTodo.recurring && (
              <DetailField label={t('todo.repeatToggle')}>
                {describeFrequency(frequencyConfigFromFields(viewingTodo))}
                {viewingTodo.nextRunDate && ` · ${t('todo.nextOccurrence', { date: new Date(viewingTodo.nextRunDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })}`}
                {viewingTodo.reminderOffsetMinutes ? ` · ${t('todo.remindBeforeDueSummary', { offset: reminderOffsetLabel(viewingTodo.reminderOffsetMinutes, t) })}` : ''}
              </DetailField>
            )}
            {viewingTodo.dueDate && (
              <DetailField label={t('todo.dueDate')}>
                {new Date(`${viewingTodo.dueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
              </DetailField>
            )}
            {viewingTodo.reminderAt && (
              <DetailField label={t('todo.reminderLabel')}>{new Date(viewingTodo.reminderAt).toLocaleString()}</DetailField>
            )}
            {group && (
              <DetailField label={t('todo.sharedWith')}>
                {group.name}{viewingTodo.userId !== user?.uid && ` · ${t('todo.addedBy', { name: creator?.displayName || t('todo.aMember') })}`}
              </DetailField>
            )}
            {viewingTodo.images?.length > 0 && (
              <DetailField label={t('todo.photos')}>
                <div className="flex flex-wrap gap-2">
                  {viewingTodo.images.map((src: string, i: number) => (
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
