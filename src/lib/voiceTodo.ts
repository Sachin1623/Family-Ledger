import { collection, deleteDoc, doc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { db, trackEvent } from './firebase';
import { fireWrite } from './offlineWrite';
import { combineLocalDateAndTime, todayLocalDateString, toLocalDateString } from './dateUtils';
import { cancelLocalTodoReminder, canRingTodoAlarm, scheduleLocalTodoReminder, syncTodoAlarms } from './localReminders';
import type { SpokenStructured } from './voiceExpense';

// "Talk to add" from the global mic can also set an alarm or add a to-do, not only log an expense. The voice service says which of the three it
// heard (and the task and the time); when it could not do the listening, the words alone are checked for the obvious phrases below.
//   alarm : a personal to-do whose reminder rings like an alarm on Android (a normal reminder notification on iPhone and web)
//   todo  : a personal to-do, with a reminder notification when a time was said
// Both show in the To-do list, so they can be edited or removed there.

export type VoiceIntent = 'expense' | 'todo' | 'alarm';

export type QuickTaskResult =
  | { ok: true; kind: 'todo' | 'alarm'; id: string; text: string; whenLabel: string; rings: boolean; undo: () => Promise<void> }
  | { ok: false; reason: 'no-time' | 'no-task' | 'failed'; kind: 'todo' | 'alarm'; sentence: string };

/** A quick guess from the words alone, used only when the voice service did not do the listening. */
export function detectIntentFromText(sentence: string): VoiceIntent {
  const s = ` ${sentence.toLowerCase()} `;
  if (/\b(alarm|wake me|wake up at|jagana|jaga dena)\b/.test(s)) return 'alarm';
  if (/\b(remind me|reminder|to-?do|add (a )?task|yaad dila|yaad dilana)\b/.test(s)) return 'todo';
  return 'expense';
}

// "6:30 pm", "6 pm", "at 18:30", "tomorrow" / "kal"
function parseWhen(sentence: string, now: Date): { time?: string; date?: string } {
  const s = sentence.toLowerCase();
  const out: { time?: string; date?: string } = {};
  const pad = (n: number) => String(n).padStart(2, '0');
  const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/) || s.match(/\bat (\d{1,2})(?::(\d{2}))?\b/) || s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    const mer = (m[3] || '').replace(/\./g, '');
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) out.time = `${pad(h)}:${pad(min)}`;
  }
  if (/\b(tomorrow|kal)\b/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    out.date = toLocalDateString(d);
  }
  return out;
}

// the task with the "remind me to" / "add a to-do" part taken off
function taskFromSentence(sentence: string): string {
  const t = sentence
    .replace(/^\s*(please\s+)?(remind me (to|about)?|add (a )?(to-?do|task)( to)?|set (an )?alarm( for| at| to)?|wake me up( at)?)\s*/i, '')
    .replace(/\b(at|by)\s+\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/gi, '')
    .replace(/\b(tomorrow|today|kal)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// Reminders armed straight away, so a to-do made by voice rings even when the To-do screen is never opened. The alarm sync replaces the whole set the
// phone has armed, so it is given every personal alarm-style to-do, not only the new one.
async function personalAlarms(uid: string, add?: { id: string; text: string; reminderAt: string }, excludeId?: string) {
  const list = new Map<string, { id: string; text: string; reminderAt: string }>();
  try {
    const snap = await getDocs(query(collection(db, 'todos'), where('userId', '==', uid)));
    snap.docs.forEach((d) => {
      const t: any = d.data();
      if (!t.done && !t.groupId && t.reminderAt && t.reminderStyle === 'alarm') list.set(d.id, { id: d.id, text: t.text, reminderAt: t.reminderAt });
    });
  } catch { /* the new one is still armed below */ }
  if (add) list.set(add.id, add);
  if (excludeId) list.delete(excludeId);
  return Array.from(list.values());
}

export async function quickTaskFromSpeech(params: {
  kind: 'todo' | 'alarm';
  sentence: string;
  structured?: SpokenStructured;
  user: { uid: string };
}): Promise<QuickTaskResult> {
  const { kind, sentence, structured, user } = params;
  try {
    const now = new Date();
    const when = parseWhen(sentence, now);
    const time = structured?.time || when.time || null;
    const explicitDate = structured?.date || when.date || null;
    const text = (kind === 'alarm' ? structured?.task || taskFromSentence(sentence) || 'Alarm' : structured?.task || taskFromSentence(sentence)).trim();
    if (kind === 'todo' && !text) return { ok: false, reason: 'no-task', kind, sentence };
    if (kind === 'alarm' && !time) return { ok: false, reason: 'no-time', kind, sentence };

    // with a time but no day (or today): today if it is still ahead, otherwise tomorrow
    let day = explicitDate || todayLocalDateString();
    let reminderAt: string | null = null;
    if (time) {
      let at = combineLocalDateAndTime(day, time);
      // (the voice service sometimes answers "today" for a time that has passed: that also means the next one)
      if ((!explicitDate || explicitDate === todayLocalDateString()) && at.getTime() <= now.getTime() + 30_000) {
        at = new Date(at.getTime() + 24 * 60 * 60 * 1000);
        day = toLocalDateString(at);
      }
      reminderAt = at.toISOString();
    }

    const style = kind === 'alarm' ? 'alarm' : 'notification';
    const ref = doc(collection(db, 'todos'));
    fireWrite(
      setDoc(ref, {
        userId: user.uid, text, done: false, status: 'pending', reminderAt, dueDate: day, reminderSent: false,
        groupId: null, createdAt: new Date().toISOString(), recurring: false, reminderOffsetMinutes: null,
        ...(reminderAt ? { reminderStyle: style } : {}),
        viaVoice: true,
      }),
      kind === 'alarm' ? 'set alarm by voice' : 'add to-do by voice',
    );
    const rings = kind === 'alarm' && canRingTodoAlarm();
    if (reminderAt) {
      if (rings) void syncTodoAlarms(await personalAlarms(user.uid, { id: ref.id, text, reminderAt }));
      else void scheduleLocalTodoReminder({ id: ref.id, text, reminderAt });
    }
    trackEvent(kind === 'alarm' ? 'voice_alarm_set' : 'voice_todo_added', { via: 'voice' });

    const todayStr = todayLocalDateString();
    const tomorrow = toLocalDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const dayWord = day === todayStr ? 'today' : day === tomorrow ? 'tomorrow' : new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const clock = reminderAt ? new Date(reminderAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    const whenLabel = clock ? `${clock} ${dayWord}` : `Due ${dayWord}`;

    const undo = async () => {
      await deleteDoc(ref);
      cancelLocalTodoReminder(ref.id);
      if (reminderAt && rings) void syncTodoAlarms(await personalAlarms(user.uid, undefined, ref.id));
    };
    return { ok: true, kind, id: ref.id, text, whenLabel, rings, undo };
  } catch (err) {
    console.error('quick task by voice failed:', err);
    return { ok: false, reason: 'failed', kind, sentence };
  }
}
