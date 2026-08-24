import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import FrequencyPicker from '../components/FrequencyPicker';
import MonthCalendar from '../components/MonthCalendar';
import { FrequencyConfig, firstOccurrenceOnOrAfter, describeFrequency, sanitizeFrequencyConfig, frequencyConfigForUpdate } from '../lib/frequency';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { groupIconEmoji } from '../lib/groupIcons';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';
import DetailSheet, { DetailField } from '../components/DetailSheet';
import { useLanguage } from '../context/LanguageContext';

const toDatetimeLocalValue = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Local YYYY-MM-DD (not UTC) — same helper as the to-do list / recurring expenses calendars, so
// "today" and each reminder's nextRunDate line up with the user's own calendar day.
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// For expenses that happen often but not on a strict, predictable schedule (e.g. groceries) —
// a nudge to log one, rather than something that gets added automatically. Any of group/
// category/amount can be pre-set (or left blank); tapping the notification opens Add Expense
// with whatever was preset filled in, leaving the rest for the user.
export default function ExpenseReminders() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [freqConfig, setFreqConfig] = useState<FrequencyConfig>({ frequency: 'weekly', daysOfWeek: [1] });
  const [oneTime, setOneTime] = useState(false);
  const [oneTimeInput, setOneTimeInput] = useState('');
  const [presetImages, setPresetImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [viewingReminder, setViewingReminder] = useState<any | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Calendar (month grid + click-a-date filter), group-preset filter, and active/paused status
  // filter — same UX as the to-do list's calendar. A reminder's `presetGroupId` is just a
  // form-fill hint (the reminder itself always only ever notifies the creator), so "personal"
  // here means "no group preset" rather than "not shared."
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<'all' | 'personal' | string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [remindersValue, remindersLoading] = useCollection(
    user ? query(collection(db, 'expenseReminders'), where('userId', '==', user.uid)) : null,
  );
  const reminders = remindersValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  // Only offer group presets that at least one reminder actually uses.
  const groupIdsWithReminders = new Set(reminders.filter((r: any) => r.presetGroupId).map((r: any) => r.presetGroupId));
  const groupsWithReminders = groups.filter((g: any) => groupIdsWithReminders.has(g.id));

  const filterMatches = (reminder: any) => {
    if (listFilter === 'personal' && reminder.presetGroupId) return false;
    if (listFilter !== 'all' && listFilter !== 'personal' && reminder.presetGroupId !== listFilter) return false;
    if (statusFilter === 'active' && !reminder.active) return false;
    if (statusFilter === 'paused' && reminder.active) return false;
    return true;
  };
  const filteredReminders = reminders.filter(filterMatches);
  const displayedReminders = selectedDate
    ? filteredReminders.filter((r: any) => toDateOnly(new Date(r.nextRunDate)) === selectedDate)
    : filteredReminders;

  // Per-day breakdown for the visible calendar month — one black dot for reminders with no group
  // preset, one small group icon per preset group with a reminder due that day (dimmed once every
  // reminder from that owner due that day is paused).
  const dueByDate = new Map<string, { personalTotal: number; personalActive: number; groups: Map<string, { total: number; activeCount: number }> }>();
  for (const reminder of filteredReminders) {
    const dateStr = toDateOnly(new Date(reminder.nextRunDate));
    let entry = dueByDate.get(dateStr);
    if (!entry) {
      entry = { personalTotal: 0, personalActive: 0, groups: new Map() };
      dueByDate.set(dateStr, entry);
    }
    if (reminder.presetGroupId) {
      const g = entry.groups.get(reminder.presetGroupId) || { total: 0, activeCount: 0 };
      g.total += 1;
      if (reminder.active) g.activeCount += 1;
      entry.groups.set(reminder.presetGroupId, g);
    } else {
      entry.personalTotal += 1;
      if (reminder.active) entry.personalActive += 1;
    }
  }

  const resetForm = () => {
    setEditingId(null);
    setGroupId('');
    setCategory('');
    setAmount('');
    setOneTime(false);
    setOneTimeInput('');
    setPresetImages([]);
    setFreqConfig({ frequency: 'weekly', daysOfWeek: [1] });
    setShowForm(false);
  };

  const handleEditStart = (reminder: any) => {
    setEditingId(reminder.id);
    setGroupId(reminder.presetGroupId || '');
    setCategory(reminder.presetCategory || '');
    setAmount(reminder.presetAmount != null ? String(reminder.presetAmount) : '');
    setOneTime(!!reminder.oneTime);
    setOneTimeInput(reminder.oneTime ? toDatetimeLocalValue(reminder.nextRunDate) : '');
    setPresetImages(reminder.presetImages || []);
    setFreqConfig(
      reminder.oneTime
        ? { frequency: 'weekly', daysOfWeek: [1] }
        : {
            frequency: reminder.frequency,
            dayOfWeek: reminder.dayOfWeek,
            daysOfWeek: reminder.daysOfWeek,
            dayOfMonth: reminder.dayOfMonth,
            month: reminder.month,
            hour: reminder.hour,
            minute: reminder.minute,
          },
    );
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (oneTime && !oneTimeInput) return;
    setSaving(true);
    try {
      const nextRunDate = oneTime
        ? new Date(oneTimeInput).toISOString()
        : firstOccurrenceOnOrAfter(freqConfig, new Date()).toISOString();
      // Firestore rejects explicit `undefined` values in writes, which FrequencyPicker/
      // handleEditStart produce for whichever optional fields don't apply to the current
      // frequency (see sanitizeFrequencyConfig/frequencyConfigForUpdate in lib/frequency.ts).
      // Creates just drop those fields; updates turn them into deleteField() so switching
      // frequency types actually clears the now-irrelevant old fields instead of leaving them
      // stale (deleteField() itself isn't valid on a plain create, hence the two branches).
      const freqFields = oneTime
        ? { frequency: null, dayOfWeek: null, daysOfWeek: null, dayOfMonth: null, month: null, hour: null, minute: null, timezone: null }
        : editingId
          ? { ...frequencyConfigForUpdate(freqConfig), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : { ...sanitizeFrequencyConfig(freqConfig), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      const payload = {
        ...(groupId ? { presetGroupId: groupId } : { presetGroupId: null }),
        ...(category ? { presetCategory: category } : { presetCategory: null }),
        ...(amount ? { presetAmount: evaluateAmountSum(amount) } : { presetAmount: null }),
        presetImages,
        oneTime,
        // Only recurring reminders need this — a one-time nextRunDate is an absolute instant
        // (already computed from the browser's local time) that's never recalculated server-side.
        ...freqFields,
        nextRunDate,
      };

      if (editingId) {
        await updateDoc(doc(db, 'expenseReminders', editingId), payload);
      } else {
        await addDoc(collection(db, 'expenseReminders'), {
          userId: user.uid,
          ...payload,
          active: true,
          createdAt: new Date().toISOString(),
        });
      }
      resetForm();
    } catch (err) {
      console.error('Failed to save reminder:', err);
      alert(t('reminders.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (reminder: any) => {
    try {
      await updateDoc(doc(db, 'expenseReminders', reminder.id), { active: !reminder.active });
    } catch (err) {
      console.error('Failed to toggle reminder:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('reminders.confirmDelete'))) return;
    try {
      await deleteDoc(doc(db, 'expenseReminders', id));
    } catch (err) {
      console.error('Failed to delete reminder:', err);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">{t('reminders.title')}</h1>
            <p className="text-sm text-text-muted mt-1">
              {t('reminders.subtitle')}
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => { resetForm(); setShowForm(true); }}
              title={t('reminders.newReminder')}
              data-tour="reminders-add"
              className="shrink-0 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">notifications_active</span>
            </button>
          )}
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">{editingId ? t('reminders.editReminder') : t('reminders.newReminder')}</h2>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('reminders.groupOptional')}</label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">{t('reminders.anyGroup')}</option>
                {groups.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('reminders.categoryOptional')}</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('reminders.anyCategory')}</option>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{t(`category.${c.id}`)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('reminders.amountOptional')}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t('reminders.anyAmount')}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                {hasAmountSumOperator(amount) && evaluateAmountSum(amount) !== null && (
                  <p className="text-xs font-bold text-success px-1">= {evaluateAmountSum(amount)!.toFixed(2)}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOneTime(false)}
                className={clsx(
                  "h-10 rounded-xl text-xs font-bold border",
                  !oneTime ? "bg-primary text-white border-primary" : "bg-white border-border-subtle text-on-surface"
                )}
              >
                {t('reminders.repeats')}
              </button>
              <button
                type="button"
                onClick={() => setOneTime(true)}
                className={clsx(
                  "h-10 rounded-xl text-xs font-bold border",
                  oneTime ? "bg-primary text-white border-primary" : "bg-white border-border-subtle text-on-surface"
                )}
              >
                {t('reminders.oneTime')}
              </button>
            </div>

            {oneTime ? (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('reminders.remindMeOn')}</label>
                <input
                  type="datetime-local"
                  value={oneTimeInput}
                  onChange={(e) => setOneTimeInput(e.target.value)}
                  required
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            ) : (
              <FrequencyPicker config={freqConfig} onChange={setFreqConfig} />
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.photoOptional')}</label>
              <ImageAttachments images={presetImages} onChange={setPresetImages} label={t('reminders.addReferencePhoto')} />
            </div>

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
                disabled={saving || (oneTime && !oneTimeInput)}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
              >
                {saving ? t('common.saving') : editingId ? t('groupExpenses.saveChanges') : t('reminders.saveReminder')}
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-4 flex-wrap bg-white rounded-xl border border-border-subtle px-3 py-2.5">
          {groupsWithReminders.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('todo.show')}</label>
              <select
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                className="bg-surface px-2 py-1.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="all">{t('groupExpenses.all')}</option>
                <option value="personal">{t('reminders.noGroupPreset')}</option>
                {groupsWithReminders.map((g: any) => (
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
                    name="reminderStatusFilter"
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
          storageKey="expense-reminders-calendar-expanded"
          dayHasActivity={(dateStr) => {
            const entry = dueByDate.get(dateStr);
            return !!entry && (entry.personalTotal > 0 || entry.groups.size > 0);
          }}
          dayTitle={(dateStr) => {
            const entry = dueByDate.get(dateStr);
            return entry ? t('reminders.dayTitle', { personal: entry.personalTotal, groups: entry.groups.size }) : undefined;
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
                      entry!.personalActive === 0 ? 'bg-on-surface/30' : 'bg-on-surface',
                    )}
                  />
                )}
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
          {remindersLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {!remindersLoading && displayedReminders.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">
              {selectedDate ? t('reminders.noRemindersDueDay') : t('reminders.noRemindersYet')}
            </p>
          )}
          {displayedReminders.map((reminder: any) => {
            const group = groups.find((g: any) => g.id === reminder.presetGroupId);
            const catInfo = EXPENSE_CATEGORIES.find((c) => c.id === reminder.presetCategory);
            const presets = [
              group?.name,
              catInfo ? t(`category.${catInfo.id}`) : null,
              reminder.presetAmount ? `${getCurrencySymbol(group?.currency)}${reminder.presetAmount.toFixed(2)}` : null,
            ].filter(Boolean);
            return (
              <div
                key={reminder.id}
                onClick={() => setViewingReminder(reminder)}
                className={clsx(
                  "bg-white rounded-2xl border p-4 flex items-center justify-between gap-3 cursor-pointer",
                  reminder.active ? "border-border-subtle" : "border-border-subtle opacity-60"
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center text-primary shrink-0">
                    <span className="material-symbols-outlined text-lg">notifications_active</span>
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-primary text-sm truncate flex items-center gap-1">
                      {reminder.oneTime ? t('reminders.oneTimeReminder') : describeFrequency(reminder)}
                      {reminder.presetImages?.length > 0 && (
                        <span className="material-symbols-outlined text-[13px] text-text-muted/70 shrink-0" title={t('reminders.hasPhoto')}>photo_camera</span>
                      )}
                    </p>
                    <p className="text-[11px] text-text-muted truncate">{presets.length > 0 ? presets.join(' · ') : t('reminders.noPresetsBlankForm')}</p>
                    <p className="text-[10px] text-text-muted">
                      {t(reminder.oneTime ? 'reminders.on' : 'reminders.next')}: {reminder.oneTime ? new Date(reminder.nextRunDate).toLocaleString() : new Date(reminder.nextRunDate).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEditStart(reminder); }}
                    title={t('common.edit')}
                    className="p-2 text-text-muted hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-lg">edit</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleActive(reminder); }}
                    title={t(reminder.active ? 'reminders.pause' : 'reminders.resume')}
                    className="p-2 text-text-muted hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-lg">{reminder.active ? 'pause_circle' : 'play_circle'}</span>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(reminder.id); }} className="text-error p-2">
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      </main>
      {viewingReminder && (() => {
        const group = groups.find((g: any) => g.id === viewingReminder.presetGroupId);
        const catInfo = EXPENSE_CATEGORIES.find((c) => c.id === viewingReminder.presetCategory);
        return (
          <DetailSheet
            title={t('reminders.detailTitle')}
            onClose={() => setViewingReminder(null)}
            onEdit={() => { const r = viewingReminder; setViewingReminder(null); handleEditStart(r); }}
          >
            <DetailField label={t('reminders.type')}>{viewingReminder.oneTime ? t('reminders.oneTimeReminder') : t('reminders.repeats')}</DetailField>
            <DetailField label={viewingReminder.oneTime ? t('reminders.on') : t('reminders.frequency')}>
              {viewingReminder.oneTime ? new Date(viewingReminder.nextRunDate).toLocaleString() : describeFrequency(viewingReminder)}
            </DetailField>
            {!viewingReminder.oneTime && (
              <DetailField label={t('reminders.next')}>{new Date(viewingReminder.nextRunDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</DetailField>
            )}
            <DetailField label={t('todo.status')}>{viewingReminder.active ? t('reminders.active') : t('reminders.paused')}</DetailField>
            {group && <DetailField label={t('reminders.presetGroup')}>{group.name}</DetailField>}
            {catInfo && <DetailField label={t('reminders.presetCategory')}>{catInfo.icon} {t(`category.${catInfo.id}`)}</DetailField>}
            {viewingReminder.presetAmount != null && (
              <DetailField label={t('reminders.presetAmount')}>{getCurrencySymbol(group?.currency)}{viewingReminder.presetAmount.toFixed(2)}</DetailField>
            )}
            {!group && !catInfo && viewingReminder.presetAmount == null && (
              <DetailField label={t('reminders.presets')}>{t('reminders.noneBlankForm')}</DetailField>
            )}
            {viewingReminder.presetImages?.length > 0 && (
              <DetailField label={t('todo.photos')}>
                <div className="flex flex-wrap gap-2">
                  {viewingReminder.presetImages.map((src: string, i: number) => (
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
