import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, setDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { scheduleLocalTodoReminder, cancelLocalTodoReminder } from '../lib/localReminders';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { fireWrite } from '../lib/offlineWrite';
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

// Local YYYY-MM-DD (not UTC) — matches what a `date` input produces/expects, and what we key the
// calendar's per-day due-count map by, so "today" lines up with the user's own calendar day.
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

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
    myTodosValue.docs.forEach((d) => {
      const todo = { id: d.id, ...d.data() } as any;
      const eligible = !todo.done && !todo.groupId && todo.reminderAt;
      if (eligible) {
        scheduleLocalTodoReminder({ id: todo.id, text: todo.text, reminderAt: todo.reminderAt });
      } else {
        cancelLocalTodoReminder(todo.id);
      }
    });
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
    setShowForm(false);
  };

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

  const handleToggleDone = async (todo: any) => {
    try {
      const nowDone = !todo.done;
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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">{t('todo.title')}</h1>
            <p className="text-sm text-text-muted mt-1">
              {t('todo.subtitle')}
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => { resetForm(); setShowForm(true); }}
              title={t('todo.newToDo')}
              data-tour="todo-add"
              className="shrink-0 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">add_task</span>
            </button>
          )}
        </div>

        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-text-muted text-lg">search</span>
          <input
            type="text"
            placeholder={t('todo.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-white border border-border-subtle rounded-xl py-3 pl-11 pr-4 outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium text-sm text-primary shadow-sm"
          />
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">{editingId ? t('todo.editToDo') : t('todo.newToDo')}</h2>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.whatNeedsDoing')}</label>
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('todo.whatNeedsDoingPlaceholder')}
                maxLength={300}
                required
                autoFocus
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.notesOptional')}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('todo.notesPlaceholder')}
                maxLength={500}
                rows={2}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
              />
            </div>

            <div className="space-y-2 bg-surface p-3 rounded-xl border border-border-subtle">
              <label className="flex items-center gap-2 text-xs font-bold text-on-surface cursor-pointer">
                <input
                  type="checkbox"
                  checked={recurring}
                  onChange={(e) => setRecurring(e.target.checked)}
                  className="w-4 h-4 accent-primary"
                />
                <span className="material-symbols-outlined text-[16px] text-primary">autorenew</span>
                {t('todo.repeatToggle')}
              </label>
              {recurring && (
                <>
                  <p className="text-[10px] text-text-muted px-1">{t('todo.repeatHelp')}</p>
                  <FrequencyPicker config={freqConfig} onChange={setFreqConfig} />
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.remindBeforeDue')}</label>
                    <select
                      value={reminderOffsetMinutes ?? ''}
                      onChange={(e) => setReminderOffsetMinutes(e.target.value ? Number(e.target.value) : null)}
                      className="w-full bg-white p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    >
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

            {!recurring && (
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.dueDateOptional')}</label>
              <input
                type="date"
                value={dueDateInput}
                onChange={(e) => setDueDateInput(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            )}

            {!recurring && (
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.remindMeOptional')}</label>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={reminderDateInput}
                  onChange={(e) => setReminderDateInput(e.target.value)}
                  className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                <input
                  type="time"
                  value={reminderTimeInput}
                  onChange={(e) => setReminderTimeInput(e.target.value)}
                  disabled={!reminderDateInput}
                  placeholder="09:00"
                  className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40"
                />
              </div>
            </div>
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.photoOptional')}</label>
              <ImageAttachments images={images} onChange={setImages} />
            </div>

            {groups.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.shareWithGroupOptional')}</label>
                <select
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('todo.justMe')}</option>
                  {groups.map((g: any) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !text.trim()}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
              >
                {saving ? t('common.saving') : editingId ? t('groupExpenses.saveChanges') : t('todo.add')}
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-1 bg-surface-container rounded-xl p-1 w-fit">
          {(['list', 'habits'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setViewMode(m)}
              className={clsx(
                'px-4 py-1.5 rounded-lg text-xs font-bold transition-all',
                viewMode === m ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
              )}
            >
              {m === 'list' ? t('todo.listView') : t('todo.habitsView')}
            </button>
          ))}
        </div>

        {viewMode === 'habits' && (
          <HabitTracker
            todos={habitTodos}
            onToggleDay={handleToggleHabitDay}
            onSelectHabit={(todo) => { setViewingTodo(todo); setNotesDraft(todo.notes || ''); }}
            onTogglePause={handleToggleHabitPause}
            searchActive={!!searchTerm.trim()}
          />
        )}

        {viewMode === 'list' && (
        <>
        <div className="flex items-center gap-4 flex-wrap bg-white rounded-xl border border-border-subtle px-3 py-2.5">
          {groupsWithTodos.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('todo.show')}</label>
              <select
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                className="bg-surface px-2 py-1.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="all">{t('groupExpenses.all')}</option>
                <option value="personal">{t('todo.justMe')}</option>
                {groupsWithTodos.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('todo.status')}</span>
            <div className="flex items-center gap-2.5">
              {(['all', 'pending', 'done'] as const).map((opt) => (
                <label
                  key={opt}
                  className={clsx(
                    'flex items-center gap-1 text-[10px] font-bold capitalize cursor-pointer',
                    doneFilter === opt ? 'text-primary' : 'text-text-muted',
                  )}
                >
                  <input
                    type="radio"
                    name="todoStatusFilter"
                    checked={doneFilter === opt}
                    onChange={() => setDoneFilter(opt)}
                    className="w-3 h-3 accent-primary"
                  />
                  {opt === 'all' ? t('groupExpenses.all') : opt === 'pending' ? t('todo.statusPending') : t('todo.statusDone')}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div data-tour="todo-calendar">
          <MonthCalendar
            cursor={calendarCursor}
            onCursorChange={setCalendarCursor}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            storageKey="todo-calendar-expanded"
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
                    <span
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full shrink-0',
                        entry!.personalDone === entry!.personalTotal ? 'bg-on-surface/30' : 'bg-on-surface',
                      )}
                    />
                  )}
                  {groupDots.slice(0, 3).map(([gid, g]) => {
                    const group = groups.find((x: any) => x.id === gid);
                    const done = g.done === g.total;
                    return (
                      <span key={gid} className={clsx('text-[10px] leading-none shrink-0', done && 'opacity-40')}>
                        {groupIconEmoji(group?.icon)}
                      </span>
                    );
                  })}
                  {groupDots.length > 3 && <span className="text-[8px] leading-none font-bold shrink-0">+</span>}
                </span>
              );
            }}
          />
        </div>
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

        <section className="space-y-2">
          {myLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {myError && (
            <p className="text-sm text-error px-1">{t('todo.couldntLoad', { error: myError.code || myError.message })}</p>
          )}
          {!myLoading && !myError && displayedTodos.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">
              {searchTerm.trim() ? t('todo.noSearchResults') : selectedDate ? t('todo.noToDosDueDay') : t('todo.noToDosYet')}
            </p>
          )}
          {displayedTodos.map((todo: any) => {
            const group = groups.find((g: any) => g.id === todo.groupId);
            const creator = allMembers.find((m: any) => m.userId === todo.userId);
            const reminderPast = todo.reminderAt && !todo.done && new Date(todo.reminderAt) < new Date();
            return (
              <div
                key={todo.id}
                onClick={() => { setViewingTodo(todo); setNotesDraft(todo.notes || ''); }}
                className={clsx(
                  'bg-white rounded-2xl border p-3 flex items-center gap-3 cursor-pointer',
                  todo.done ? 'border-border-subtle opacity-60' : 'border-border-subtle'
                )}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleDone(todo); }}
                  className={clsx(
                    'w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0',
                    todo.done ? 'bg-success border-success text-white' : 'border-border-subtle text-transparent'
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">check</span>
                </button>
                {todo.images?.[0] && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setLightboxSrc(todo.images[0]); }} className="shrink-0">
                    <img src={todo.images[0]} alt="" className="w-10 h-10 rounded-lg object-cover border border-border-subtle" />
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <p className={clsx('text-sm font-bold truncate flex items-center gap-1', todo.done ? 'line-through text-text-muted' : 'text-on-surface')}>
                    {todo.recurring && (
                      <span className="material-symbols-outlined text-[14px] text-primary shrink-0 no-underline" title={t('todo.repeatToggle')}>autorenew</span>
                    )}
                    {todo.text}
                  </p>
                  <p className="text-[10px] text-text-muted truncate">
                    {group && t('todo.shared', { name: group.name })}
                    {group && todo.userId !== user?.uid && ` · ${t('todo.addedBy', { name: creator?.displayName || t('todo.aMember') })}`}
                    {todo.dueDate && (group ? ' · ' : '') + t('todo.due', { date: new Date(`${todo.dueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })}
                    {todo.reminderAt && (group || todo.dueDate ? ' · ' : '') + t('todo.reminder', { time: new Date(todo.reminderAt).toLocaleString() })}
                  </p>
                </div>
                {reminderPast && (
                  <span className="material-symbols-outlined text-[16px] text-error shrink-0" title={t('todo.reminderPassed')}>notifications_active</span>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={(e) => { e.stopPropagation(); handleEditStart(todo); }} title={t('common.edit')} className="p-1.5 text-text-muted hover:text-primary">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(todo); }} className="p-1.5 text-error">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </section>
        </>
        )}
      </main>
      {viewingTodo && (() => {
        const group = groups.find((g: any) => g.id === viewingTodo.groupId);
        const creator = allMembers.find((m: any) => m.userId === viewingTodo.userId);
        return (
          <DetailSheet
            title={t('todo.detailTitle')}
            onClose={() => setViewingTodo(null)}
            onEdit={() => { const td = viewingTodo; setViewingTodo(null); handleEditStart(td); }}
            onDelete={() => { const td = viewingTodo; setViewingTodo(null); handleDelete(td); }}
          >
            <DetailField label={t('todo.task')}>{viewingTodo.text}</DetailField>
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
