import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, updateDoc, doc } from 'firebase/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { useLiveQuery } from '../lib/liveCache';
import { claimPoints } from '../lib/pointsApi';
import { isDueOnDate, frequencyConfigFromFields } from '../lib/frequency';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { getCurrencySymbol } from '../lib/constants';
import { PaymentReminder, rings, dueDays } from '../lib/paymentReminders';
import { canPay } from './PaymentRolePicker';

// "Today" on Home: what needs doing today in one place: tasks due today or overdue, habits due today, and shopping lists planned for today.
// To-dos and habits are ticked right here (the same writes the To-Do screen makes); a shopping list opens, since shopping ends in an expense.
// Reads: my own to-dos and the shopping lists scheduled for me or my groups; both are the same live queries the To-Do and Shopping screens
// use, so opening those screens afterwards reads nothing extra.
const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// One-tap birthday wishes: a warm, personal line with their first name, picked by who and which year so it is not the same text for everyone.
const WISHES = [
  (n: string) => `Happy Birthday, ${n}! 🎂🎉 Wishing you a year full of joy, good health and everything you dream of. Have a wonderful day!`,
  (n: string) => `Many happy returns of the day, ${n}! 🥳 May this year bring you happiness, success and lots of laughter. Enjoy every moment!`,
  (n: string) => `Happy Birthday ${n}! 🎈 Thinking of you today. Wishing you love, good times and all the best in the year ahead! 💐`,
  (n: string) => `Wishing you the happiest birthday, ${n}! 🎁 Stay blessed, stay smiling, and may all your wishes come true today! ✨`,
];
const wishFor = (name: string, uid: string, year: number) => {
  const first = (name || '').trim().split(/\s+/)[0] || 'friend';
  const h = Array.from(`${uid}${year}`).reduce((a, c) => a + c.charCodeAt(0), 0);
  return WISHES[h % WISHES.length](first);
};
const dmChatId = (a: string, b: string) => [a, b].sort().join('_');

export default function TodayTile({ groupIds }: { groupIds: string[] }) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [open, setOpen] = useState(false); // collapsed to one line until tapped

  const [todosValue] = useLiveQuery(user ? query(collection(db, 'todos'), where('userId', '==', user.uid)) : null);
  const [myListsValue] = useLiveQuery(user ? query(collection(db, 'shoppingLists'), where('userId', '==', user.uid)) : null);
  const [pendingValue] = useLiveQuery(user ? query(collection(db, 'pendingRecurringExpenses'), where('userId', '==', user.uid)) : null);
  const [rulesValue] = useLiveQuery(groupIds.length > 0 ? query(collection(db, 'recurringExpenses'), where('groupId', 'in', groupIds)) : null);
  const [groupsValue] = useLiveQuery(groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null);
  const todayStr = toDateOnly(new Date());
  // payments I am to make: the reminders that name me, or every reminder of a Payments group where I am marked Payer
  const [myMembersValue] = useLiveQuery(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const payerGroups = useMemo(
    () => Array.from(new Set((myMembersValue?.docs || []).map((d) => d.data() as any).filter((m) => canPay(m.paymentRole)).map((m) => m.groupId as string))).slice(0, 30),
    [myMembersValue],
  );
  const [byRoleValue] = useLiveQuery(payerGroups.length > 0 ? query(collection(db, 'groupPaymentReminders'), where('groupId', 'in', payerGroups)) : null);
  const [byNameValue] = useLiveQuery(user ? query(collection(db, 'groupPaymentReminders'), where('payerUid', '==', user.uid)) : null);
  const payDue = useMemo(() => {
    if (!user) return [] as { r: PaymentReminder; day: string }[];
    const groups = new Set<string>(payerGroups);
    const seen = new Map<string, PaymentReminder>();
    [...(byRoleValue?.docs || []), ...(byNameValue?.docs || [])].forEach((d) => seen.set(d.id, { id: d.id, ...(d.data() as any) }));
    const out: { r: PaymentReminder; day: string }[] = [];
    Array.from(seen.values()).filter((r) => r.active && rings(r, user.uid, groups)).forEach((r) => dueDays(r, todayStr, 7).forEach((day) => out.push({ r, day })));
    return out;
  }, [user?.uid, payerGroups, byRoleValue, byNameValue, todayStr]);
  // payments already added in those groups, to see which dues are settled (only read while something is due)
  const dueGroupIds = Array.from(new Set(payDue.map((x) => x.r.groupId))).slice(0, 30);
  const [paidValue] = useLiveQuery(dueGroupIds.length > 0 ? query(collection(db, 'groupPayments'), where('groupId', 'in', dueGroupIds)) : null);
  const [toast, setToast] = useState<string | null>(null);
  const [groupListsValue] = useLiveQuery(groupIds.length > 0 ? query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)) : null);

  const { overdue, dueToday, habits, lists, birthdays, pendingExp, autoExp } = useMemo(() => {
    const todos = (todosValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) }));
    const thisYear = new Date().getFullYear();
    // birthdays of people in my groups: the app makes a to-do for each on their day (see the daily job); shown until I tick it or wish them
    const birthdays = todos.filter((t: any) => t.systemGenerated && t.birthdayOwnerUid && !t.done && t.birthdayYear === thisYear
      && String(t.createdAt || '').slice(0, 10) >= toDateOnly(new Date(Date.now() - 86_400_000)));
    const plain = todos.filter((t: any) => !t.recurring && !t.birthdayOwnerUid);
    const pendingExp = (pendingValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => p.status === 'pending');
    // expenses that were added by themselves today from my "add automatically" rules
    const autoExp = (rulesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) }))
      .filter((r: any) => r.autoAdd === true && r.userId === user?.uid && r.lastAutoAddedAt && toDateOnly(new Date(r.lastAutoAddedAt)) === todayStr);
    const habits = todos.filter((t: any) => t.recurring && t.recurringActive !== false && !t.groupId
      && isDueOnDate(frequencyConfigFromFields(t), todayStr, String(t.createdAt || '').slice(0, 10)));
    const overdue = plain.filter((t: any) => !t.done && t.dueDate && t.dueDate < todayStr).sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const dueToday = plain.filter((t: any) => t.dueDate === todayStr).sort((a: any, b: any) => Number(!!a.done) - Number(!!b.done) || String(a.reminderAt || '9').localeCompare(String(b.reminderAt || '9')));
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
    const byId = new Map<string, any>();
    [...(myListsValue?.docs || []), ...(groupListsValue?.docs || [])].forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    const lists = Array.from(byId.values())
      .filter((l: any) => !l.completed && l.scheduledAt && new Date(l.scheduledAt) <= endOfToday)
      .sort((a: any, b: any) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    return { overdue, dueToday, habits, lists, birthdays, pendingExp, autoExp };
  }, [todosValue, myListsValue, groupListsValue, pendingValue, rulesValue, todayStr, user?.uid]);
  const groupDoc = (gid: string) => groupsValue?.docs.find((g) => g.id === gid)?.data() as any;
  const currencyOf = (gid: string) => getCurrencySymbol(groupDoc(gid)?.currency);
  const groupName = (gid: string, fallback?: string) => groupDoc(gid)?.name || fallback || '';

  if (!user) return null;
  const loading = todosValue === undefined;
  const pendingTasks = [...overdue, ...dueToday.filter((t: any) => !t.done)];
  const doneTasks = dueToday.filter((t: any) => t.done);
  // a due payment is settled once a payment with the same label is on record from a week before its day onward (paid ahead counts too)
  const dayMinus = (day: string, n: number) => toDateOnly(new Date(new Date(`${day}T00:00:00`).getTime() - n * 86400000));
  const payRows = payDue.map(({ r, day }) => {
    const label = r.label.trim().toLowerCase();
    const paid = (paidValue?.docs || []).some((d) => {
      const x: any = d.data();
      return x.groupId === r.groupId && x.kind !== 'deposit' && String(x.label || '').trim().toLowerCase() === label && String(x.date || '') >= dayMinus(day, 7);
    });
    return { r, day, paid };
  }).sort((a, b) => a.day.localeCompare(b.day));
  const payLeft = payRows.filter((x) => !x.paid);
  const payDone = payRows.filter((x) => x.paid);
  const dayWord = (day: string) => day === todayStr ? 'due today' : `due ${Math.round((new Date(`${todayStr}T00:00:00`).getTime() - new Date(`${day}T00:00:00`).getTime()) / 86400000)} days ago`;
  const total = payRows.length + dueToday.length + habits.length + overdue.length + lists.length + birthdays.length + pendingExp.length + autoExp.length;
  const doneCount = doneTasks.length + habits.filter((h: any) => h.done).length + payDone.length;
  if (loading || total === 0) return null; // nothing to do today: the tile stays out of the way

  const tick = async (todo: any, habit: boolean) => {
    if (busyId) return;
    // a to-do that moves money is completed on its own screen, where the transfer is confirmed and run
    if (todo.linkedTransfer && !todo.linkedTransferExecuted && !todo.done) { navigate('/todo'); return; }
    setBusyId(todo.id);
    try {
      const nowDone = !todo.done;
      await updateDoc(doc(db, 'todos', todo.id), {
        done: nowDone, status: nowDone ? 'done' : 'pending',
        ...(nowDone && !habit ? { completedAt: new Date().toISOString() } : {}),
      });
      if (nowDone) claimPoints(habit ? 'habit_occurrence' : 'todo_completed', habit ? { todoId: todo.id, dateStr: todayStr } : { todoId: todo.id });
      if (nowDone && todo.groupId) {
        notifyGroupActivity({ groupId: todo.groupId, action: 'todo_completed', description: todo.text, actorName: profile?.displayName || user.displayName || 'Someone' });
      }
    } catch (err) {
      console.error('Could not update the to-do from Home:', err);
    } finally {
      setBusyId(null);
    }
  };

  const authedPost = async (path: string, body?: any) => {
    const idToken = await user.getIdToken();
    const res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || 'Request failed');
    return json;
  };
  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3500); };
  const nameOfBirthday = (t: any) => (String(t.text || '').match(/It's (.+?)'s birthday/)?.[1]) || 'them';
  const wish = async (t: any) => {
    if (busyId) return;
    setBusyId(t.id);
    try {
      const name = nameOfBirthday(t);
      await authedPost('/api/chat/send', { collectionName: 'directChats', chatId: dmChatId(user.uid, t.birthdayOwnerUid), text: wishFor(name, t.birthdayOwnerUid, t.birthdayYear) });
      await updateDoc(doc(db, 'todos', t.id), { done: true, status: 'done', completedAt: new Date().toISOString() });
      flash(`Wish sent to ${name} 🎉`);
    } catch (err) {
      console.error('Could not send the birthday wish:', err);
      flash('Could not send the wish. Please try again.');
    } finally {
      setBusyId(null);
    }
  };
  const acceptPending = async (p: any) => {
    if (busyId) return;
    setBusyId(p.id);
    try { await authedPost(`/api/recurring-confirm/${p.id}/accept`); flash(`Added "${p.description}"`); }
    catch (err) { console.error('Could not add the expense:', err); flash('Could not add it. Open it to try again.'); }
    finally { setBusyId(null); }
  };
  const declinePending = async (p: any) => {
    if (busyId || !window.confirm(`Skip "${p.description}" this time? Nothing is added.`)) return;
    setBusyId(p.id);
    try { await authedPost(`/api/recurring-confirm/${p.id}/decline`); }
    catch (err) { console.error('Could not skip the expense:', err); flash('Could not skip it. Please try again.'); }
    finally { setBusyId(null); }
  };

  // what is still left, as the one line shown while the tile is closed
  const leftItems: string[] = [
    ...birthdays.map((t: any) => `🎂 ${nameOfBirthday(t)}`),
    ...pendingExp.map((p: any) => `Confirm ${p.description}`),
    ...payLeft.map((x) => `Pay ${x.r.label}`),
    ...pendingTasks.map((t: any) => String(t.text)),
    ...habits.filter((h: any) => !h.done).map((h: any) => String(h.text)),
    ...lists.map((l: any) => `🛒 ${l.title}`),
  ];
  const summary = leftItems.length === 0 ? '✓ All done for today' : leftItems.slice(0, 3).join(' · ') + (leftItems.length > 3 ? ` · +${leftItems.length - 3} more` : '');

  const check = (done: boolean, busy: boolean) => (
    <span className={clsx('w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors', done ? 'bg-[#12b89a] border-[#12b89a] text-white' : 'border-slate-300 text-transparent', busy && 'opacity-50')}>
      <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>
    </span>
  );

  const taskRow = (t: any, late: boolean) => (
    <button key={t.id} type="button" onClick={() => tick(t, false)} className="w-full flex items-center gap-3 py-2 text-left active:opacity-70">
      {check(!!t.done, busyId === t.id)}
      <span className={clsx('flex-1 min-w-0 text-[13.5px] font-bold truncate', t.done ? 'text-text-muted line-through' : 'text-primary')}>{t.text}</span>
      {late && <span className="text-[10.5px] font-extrabold rounded-full bg-rose-100 text-rose-700 px-2 py-0.5 shrink-0">{new Date(`${t.dueDate}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
      {!late && t.reminderAt && !t.done && <span className="text-[10.5px] font-bold text-text-muted shrink-0">{new Date(t.reminderAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
    </button>
  );

  return (
    <section aria-label="Today" className="rounded-2xl bg-white border border-border-subtle shadow-sm px-3.5 py-2.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-2.5 text-left">
        <span className="text-sm font-extrabold text-primary shrink-0">Today</span>
        <span className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden" aria-label={summary}>
          {leftItems.length === 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#e8faf5] text-[#0b6b5a] px-2.5 py-[3px] whitespace-nowrap">✓ All done</span>}
          {birthdays.length > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#ffe6df] text-[#b8391a] px-2.5 py-[3px] whitespace-nowrap shrink-0">🎂 {birthdays.length}</span>}
          {overdue.length > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#ffe6df] text-[#b8391a] px-2.5 py-[3px] whitespace-nowrap shrink-0">⏰ {overdue.length} overdue</span>}
          {payLeft.length > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#fff1d6] text-[#8a5a00] px-2.5 py-[3px] whitespace-nowrap shrink-0">💸 {payLeft.length} due</span>}
          {pendingExp.length > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#fff1d6] text-[#8a5a00] px-2.5 py-[3px] whitespace-nowrap shrink-0">🔁 {pendingExp.length} confirm</span>}
          {(dueToday.filter((t: any) => !t.done).length + habits.filter((h: any) => !h.done).length) > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#e8faf5] text-[#0b6b5a] px-2.5 py-[3px] whitespace-nowrap shrink-0">✓ {dueToday.filter((t: any) => !t.done).length + habits.filter((h: any) => !h.done).length} to do</span>}
          {lists.length > 0 && <span className="text-[11px] font-extrabold rounded-full bg-[#fff1d6] text-[#8a5a00] px-2.5 py-[3px] whitespace-nowrap shrink-0">🛒 {lists.length}</span>}
        </span>
        <span className={clsx('material-symbols-outlined text-[22px] text-text-muted shrink-0 transition-transform', open && 'rotate-180')}>expand_more</span>
      </button>
      {open && (<>
      <div className="flex justify-end mt-1">
        <button type="button" onClick={() => navigate('/todo')} className="text-xs font-extrabold text-[#0b6b5a]">{doneCount} of {dueToday.length + habits.length + payRows.length} done · Open ›</button>
      </div>
      <div className="divide-y divide-border-subtle/60">
        {birthdays.map((t: any) => (
          <div key={t.id} className="flex items-center gap-3 py-2">
            <span className="w-6 h-6 flex items-center justify-center text-[18px] shrink-0">🎂</span>
            <button type="button" onClick={() => navigate(`/u/${t.birthdayOwnerUid}`)} className="flex-1 min-w-0 text-left">
              <span className="block text-[13.5px] font-bold text-primary truncate">{nameOfBirthday(t)}'s birthday today</span>
            </button>
            <button type="button" onClick={() => wish(t)} disabled={busyId === t.id} className="px-3 h-8 rounded-full bg-[#ff7a59] text-white text-[12px] font-extrabold active:scale-95 disabled:opacity-50 shrink-0">{busyId === t.id ? '…' : 'Wish 🎉'}</button>
          </div>
        ))}
        {pendingExp.map((p: any) => (
          <div key={p.id} className="flex items-center gap-2 py-2">
            <span className="w-6 h-6 flex items-center justify-center text-[18px] shrink-0">🔁</span>
            <button type="button" onClick={() => navigate('/recurring-approvals')} className="flex-1 min-w-0 text-left">
              <span className="block text-[13.5px] font-bold text-primary truncate">{p.description}</span>
              <span className="block text-[11px] text-text-muted truncate">{p.type === 'income' ? '+' : ''}{currencyOf(p.groupId)}{Number(p.amount).toFixed(2)} · {groupName(p.groupId, p.groupName)} · confirm</span>
            </button>
            <button type="button" onClick={() => declinePending(p)} disabled={busyId === p.id} aria-label="Skip this time" className="w-8 h-8 rounded-full text-text-muted flex items-center justify-center active:scale-95 disabled:opacity-50 shrink-0"><span className="material-symbols-outlined text-[18px]">close</span></button>
            <button type="button" onClick={() => acceptPending(p)} disabled={busyId === p.id} className="px-3 h-8 rounded-full bg-primary text-white text-[12px] font-extrabold active:scale-95 disabled:opacity-50 shrink-0">{busyId === p.id ? '…' : 'Add'}</button>
          </div>
        ))}
        {payRows.map(({ r, day, paid }) => (
          <div key={`${r.id}_${day}`} className="flex items-center gap-2 py-2">
            {check(paid, false)}
            <button type="button" onClick={() => navigate(`/groups/${r.groupId}?add=1&label=${encodeURIComponent(r.label)}`)} className="flex-1 min-w-0 text-left">
              <span className={clsx('block text-[13.5px] font-bold truncate', paid ? 'text-text-muted line-through' : 'text-primary')}>💸 {r.label}{r.amount ? ` · ${currencyOf(r.groupId)}${Number(r.amount).toLocaleString()}` : ''}</span>
              <span className="block text-[11px] text-text-muted truncate">{paid ? 'Paid' : dayWord(day)}{r.groupName ? ` · ${r.groupName}` : ''}</span>
            </button>
            {!paid && <button type="button" onClick={() => navigate(`/groups/${r.groupId}?add=1&label=${encodeURIComponent(r.label)}`)} className="px-3 h-8 rounded-full bg-primary text-white text-[12px] font-extrabold active:scale-95 shrink-0">Add payment</button>}
          </div>
        ))}
        {pendingTasks.map((t: any) => taskRow(t, !!t.dueDate && t.dueDate < todayStr))}
        {habits.map((h: any) => (
          <button key={h.id} type="button" onClick={() => tick(h, true)} className="w-full flex items-center gap-3 py-2 text-left active:opacity-70">
            {check(!!h.done, busyId === h.id)}
            <span className={clsx('flex-1 min-w-0 text-[13.5px] font-bold truncate', h.done ? 'text-text-muted line-through' : 'text-primary')}>{h.text}</span>
            <span className="text-[10.5px] font-extrabold rounded-full bg-[#effcf8] text-[#0b6b5a] px-2 py-0.5 shrink-0">Habit</span>
          </button>
        ))}
        {lists.map((l: any) => {
          const left = typeof l.itemCount === 'number' ? Math.max(0, l.itemCount - (l.doneCount || 0)) : null;
          const late = new Date(l.scheduledAt) < new Date();
          return (
            <button key={l.id} type="button" onClick={() => navigate(`/shopping-lists/${l.id}`)} className="w-full flex items-center gap-3 py-2 text-left active:opacity-70">
              <span className="w-6 h-6 flex items-center justify-center text-[18px] shrink-0">{l.icon || '🛒'}</span>
              <span className="flex-1 min-w-0 text-[13.5px] font-bold text-primary truncate">{l.title}{left !== null ? ` · ${left} left` : ''}</span>
              <span className={clsx('text-[10.5px] font-extrabold rounded-full px-2 py-0.5 shrink-0', late ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800')}>
                {new Date(l.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            </button>
          );
        })}
        {autoExp.map((r: any) => (
          <button key={r.id} type="button" onClick={() => navigate('/recurring-expenses')} className="w-full flex items-center gap-3 py-2 text-left active:opacity-70">
            <span className="w-6 h-6 flex items-center justify-center text-[18px] shrink-0">🔁</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13.5px] font-bold text-primary truncate">{r.description || 'Recurring expense'}</span>
              <span className="block text-[11px] text-text-muted truncate">{r.type === 'income' ? '+' : ''}{currencyOf(r.groupId)}{Number(r.amount).toFixed(2)} · {groupName(r.groupId)}</span>
            </span>
            <span className="text-[10.5px] font-extrabold rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 shrink-0">Added automatically</span>
          </button>
        ))}
        {doneTasks.length > 0 && (showAllDone ? doneTasks.map((t: any) => taskRow(t, false)) : (
          <button type="button" onClick={() => setShowAllDone(true)} className="w-full py-2 text-left text-[12px] font-bold text-text-muted">
            ✓ {doneTasks.length} done today · Show
          </button>
        ))}
      </div>
      </>)}
      {toast && <p className="mt-2 text-center text-[12px] font-bold text-[#0b6b5a]">{toast}</p>}
    </section>
  );
}
