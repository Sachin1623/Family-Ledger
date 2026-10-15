import React, { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';

// Shared look for the health tools (Medicines, Glucose, Blood Pressure, Baby Vaccines): the person switcher, the
// status chips, the progress ring and ONE clean confirm dialog that replaces the browser's grey window.confirm.

export type Tone = 'ok' | 'warn' | 'bad' | 'blue' | 'teal' | 'mute';

const TONE: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  bad: 'bg-red-50 text-red-700',
  blue: 'bg-blue-50 text-blue-700',
  teal: 'bg-teal-50 text-teal-700',
  mute: 'bg-slate-100 text-slate-500',
};

export function StatusChip({ tone = 'teal', children, className }: { key?: React.Key; tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={clsx('inline-block text-[9px] font-extrabold px-2 py-0.5 rounded-full whitespace-nowrap', TONE[tone], className)}>{children}</span>;
}

const AVATAR_COLORS = ['#0f766e', '#c2410c', '#7c3aed', '#db2777', '#2563eb', '#0891b2', '#65a30d'];
const colorFor = (key: string) => AVATAR_COLORS[Math.abs([...key].reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length];

export function PersonAvatar({ name, photoURL, id, size = 24 }: { name: string; photoURL?: string; id: string; size?: number }) {
  return photoURL ? (
    <img src={photoURL} alt="" referrerPolicy="no-referrer" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-full flex items-center justify-center text-white font-black shrink-0" style={{ width: size, height: size, fontSize: size * 0.42, backgroundColor: colorFor(id) }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** "Whose health?" — the pills at the top of every health screen. */
export function PersonSwitcher({ people, activeId, onChange }: { people: { userId: string; displayName: string; photoURL?: string }[]; activeId: string; onChange: (id: string) => void }) {
  if (people.length < 2) return null;
  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5">
      {people.map((p) => {
        const on = p.userId === activeId;
        return (
          <button
            key={p.userId}
            type="button"
            onClick={() => onChange(p.userId)}
            className={clsx('flex items-center gap-1.5 pl-1 pr-3 py-1 rounded-full border-[1.5px] text-[11px] font-extrabold whitespace-nowrap shrink-0 transition-colors', on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200')}
          >
            <PersonAvatar name={p.displayName} photoURL={p.photoURL} id={p.userId} />
            {p.displayName}
          </button>
        );
      })}
    </div>
  );
}

export function ProgressRing({ done, total, size = 62, track = '#e3ecee', color = '#16a34a', label }: { done: number; total: number; size?: number; track?: string; color?: string; label?: string }) {
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const inner = size - 16;
  return (
    <div className="rounded-full flex items-center justify-center shrink-0" style={{ width: size, height: size, background: `conic-gradient(${color} ${pct * 360}deg, ${track} 0deg)` }}>
      <div className="rounded-full bg-white flex items-center justify-center font-black text-slate-800" style={{ width: inner, height: inner, fontSize: size * 0.21 }}>
        {label ?? `${done}/${total}`}
      </div>
    </div>
  );
}

export function SegTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-slate-200/70 rounded-2xl p-1 gap-0.5">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)} className={clsx('flex-1 py-2 rounded-xl text-[11px] font-extrabold transition-all', value === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * `const [confirm, confirmDialog] = useConfirm();` then `if (!(await confirm({ title: 'Delete?' }))) return;` and render
 * `{confirmDialog}` once in the screen. One consistent dialog instead of the browser's window.confirm.
 */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpts(o);
      }),
    [],
  );
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };
  const dialog = opts ? (
    <div className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-[2px] flex items-center justify-center p-5" onClick={() => close(false)}>
      <div className="w-full max-w-sm bg-white rounded-3xl p-5 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className={clsx('w-12 h-12 rounded-2xl mx-auto mb-3 flex items-center justify-center', opts.danger ? 'bg-red-50 text-red-600' : 'bg-teal-50 text-teal-700')}>
          <span className="material-symbols-outlined text-[24px]">{opts.danger ? 'delete' : 'help'}</span>
        </div>
        <p className="text-[15px] font-black text-slate-900">{opts.title}</p>
        {opts.message && <p className="text-[12px] font-semibold text-slate-500 mt-1.5 leading-snug">{opts.message}</p>}
        <div className="mt-4 space-y-2">
          <button onClick={() => close(true)} className={clsx('w-full py-3 rounded-2xl text-[13px] font-black text-white', opts.danger ? 'bg-red-600' : 'bg-teal-700')}>{opts.confirmLabel || (opts.danger ? 'Delete' : 'Confirm')}</button>
          <button onClick={() => close(false)} className="w-full py-3 rounded-2xl text-[13px] font-black bg-slate-100 text-slate-700">{opts.cancelLabel || 'Cancel'}</button>
        </div>
      </div>
    </div>
  ) : null;
  return [confirm, dialog];
}

export interface InsightReading {
  value: number; // the number the trend is about (glucose, or systolic for blood pressure)
  ok: boolean; // inside the person's target range
  windowLabel: string; // "Fasting", "After lunch", "Morning" …
  at: string; // ISO datetime
}

/** Time in range + plain-language notes, worked out from the readings already on the screen. */
export function HealthInsightsCard({ readings, avgLabel, highestLabel, unit, rangeNoun = 'in range' }: { readings: InsightReading[]; avgLabel: string; highestLabel: string; unit: string; rangeNoun?: string }) {
  if (readings.length === 0) return null;
  const total = readings.length;
  const okCount = readings.filter((r) => r.ok).length;
  const pct = Math.round((okCount / total) * 100);
  const overallAvg = readings.reduce((s, r) => s + r.value, 0) / total;

  const notes: { icon: string; text: React.ReactNode }[] = [];

  // The reading window that runs highest compared with the overall average.
  const byWindow = new Map<string, number[]>();
  readings.forEach((r) => byWindow.set(r.windowLabel, [...(byWindow.get(r.windowLabel) || []), r.value]));
  const windows = [...byWindow.entries()].filter(([, v]) => v.length >= 2).map(([label, v]) => ({ label, avg: v.reduce((a, b) => a + b, 0) / v.length }));
  if (windows.length >= 2) {
    const top = windows.sort((a, b) => b.avg - a.avg)[0];
    const diff = Math.round(((top.avg - overallAvg) / overallAvg) * 100);
    if (diff >= 5) notes.push({ icon: '⏱', text: <><b>{top.label}</b> readings run about <b>{diff}% above</b> your average.</> });
  }

  const outCount = total - okCount;
  if (outCount > 0) {
    const outByWindow = new Map<string, number>();
    readings.filter((r) => !r.ok).forEach((r) => outByWindow.set(r.windowLabel, (outByWindow.get(r.windowLabel) || 0) + 1));
    const worst = [...outByWindow.entries()].sort((a, b) => b[1] - a[1])[0];
    notes.push({ icon: '📈', text: <><b>{outCount} of {total}</b> readings were out of range{outByWindow.size > 0 && worst[1] >= 2 ? <> — most often <b>{worst[0]}</b></> : null}.</> });
  }

  // This week against the one before, when both have enough readings to say anything.
  const now = Date.now();
  const week = 7 * 86400000;
  const last = readings.filter((r) => now - new Date(r.at).getTime() <= week);
  const prev = readings.filter((r) => { const d = now - new Date(r.at).getTime(); return d > week && d <= 2 * week; });
  if (last.length >= 3 && prev.length >= 3) {
    const a = last.reduce((s, r) => s + r.value, 0) / last.length;
    const b = prev.reduce((s, r) => s + r.value, 0) / prev.length;
    const d = Math.round(a - b);
    if (Math.abs(d) >= 2) notes.push({ icon: d > 0 ? '🔺' : '🔻', text: <>This week's average is <b>{Math.abs(d)} {d > 0 ? 'higher' : 'lower'}</b> than the week before.</> });
  }

  // Unbroken run of in-range readings, newest first.
  const newest = [...readings].sort((a, b) => b.at.localeCompare(a.at));
  let run = 0;
  for (const r of newest) { if (r.ok) run += 1; else break; }
  if (run >= 3) notes.push({ icon: '✅', text: <>Your last <b>{run}</b> readings in a row were {rangeNoun}.</> });

  return (
    <div className="rounded-3xl bg-white border border-slate-200 p-3.5 shadow-sm space-y-3">
      <div className="flex items-center gap-3.5">
        <div className="w-[88px] h-[88px] rounded-full flex items-center justify-center shrink-0" style={{ background: `conic-gradient(#16a34a ${pct * 3.6}deg, #fca5a5 0deg)` }}>
          <div className="w-[66px] h-[66px] rounded-full bg-white flex flex-col items-center justify-center">
            <p className="text-lg font-black leading-none text-slate-900">{pct}%</p>
            <p className="text-[8px] font-extrabold tracking-[0.1em] text-slate-400 mt-0.5">{rangeNoun.toUpperCase()}</p>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[9.5px] font-extrabold tracking-[0.1em] text-slate-400">AVERAGE</p>
          <p className="text-2xl font-black text-slate-900 leading-tight">{avgLabel} <span className="text-xs font-bold text-slate-400">{unit}</span></p>
          <p className="text-[11px] font-bold text-slate-500">{total} readings · highest {highestLabel}</p>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="border-t border-slate-100 pt-2 space-y-2">
          <p className="text-[9.5px] font-extrabold tracking-[0.1em] text-slate-400">WHAT WE NOTICED</p>
          {notes.slice(0, 3).map((n, i) => (
            <div key={i} className="flex gap-2.5 text-[11.5px] font-semibold text-slate-700 leading-snug">
              <span className="text-base leading-none">{n.icon}</span>
              <span>{n.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
