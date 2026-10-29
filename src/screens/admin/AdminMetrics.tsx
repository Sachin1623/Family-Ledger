import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { adminGet } from '../../lib/adminApi';
import { fmtDateTime, fmtTime, adminNowParts } from '../../lib/adminTime';

// The admin health dashboard: Today / Growth / Health / Cost / Product. Every number comes from data the app already keeps (users, expenses,
// the sign-in counters, the server's own request counters and the Google Cloud billing export). Things only Google Play knows (installs,
// crash-free users) are linked, not guessed.

type Tab = 'today' | 'growth' | 'health' | 'cost' | 'product' | 'broadcasts';
const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'growth', label: 'Growth' },
  { id: 'health', label: 'Health' },
  { id: 'cost', label: 'Cost' },
  { id: 'product', label: 'Product' },
  { id: 'broadcasts', label: 'Broadcasts' },
];

// Lines that turn a tile amber or red. Edit here to change what counts as "bad".
const GOALS = {
  signInFailure: { good: 8, bad: 15 }, // % of Google taps that error
  serverErrors: { good: 1, bad: 3 }, // % of requests that fail on the server
  p95Ms: { good: 500, bad: 1000 },
  voiceUnderstood: { good: 90, bad: 75 }, // % of voice clips that produced an amount (higher is better)
  costVsLastMonth: 15, // alert when the forecast is this % above last month
};

interface Metrics {
  generatedAt: string;
  revision: string;
  users: { total: number; newToday: number; dau: number; wau: number; mau: number; newByDay: { date: string; count: number }[]; newTotals: { current: number; previous: number } };
  active: { byDay: { date: string; count: number }[]; totals: { current: number; previous: number } };
  retention: Record<'d1' | 'd7' | 'd30', { cohort: number; returned: number }>;
  activation: { cohort: number; firstExpense: number; threeExpenses: number };
  funnel: {
    days?: { date: string; all: Record<string, number>; new: Record<string, number>; ret: Record<string, number>; uAll?: Record<string, number>; uNew?: Record<string, number>; uRet?: Record<string, number>; uSeg?: boolean }[];
    signinDays?: { date: string; taps: number; errors: number; cancels: number; codes: Record<string, number> }[];
    current: Record<string, number>;
    previous: Record<string, number>;
    segments?: { new: { current: Record<string, number>; previous: Record<string, number> }; ret: { current: Record<string, number>; previous: Record<string, number> } };
    segmentsSince?: string | null;
  };
  ops: Array<Record<string, any>>;
  attention: { feedback: number; chatReports: number; shopkeeper: number };
}
interface Cost { tableReady: boolean; hasData?: boolean; currency?: string; thisMonth?: number; lastMonth?: number; last7Days?: number }
interface Breakdown { tableReady: boolean; currency?: string; byService?: { service: string; net: number }[]; daily?: { date: string; net: number }[] }

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const fmtPct = (v: number | null) => (v === null ? '—' : `${v}%`);
const num = (v: number) => v.toLocaleString();

type Level = 'ok' | 'warn' | 'bad' | 'none';
const levelLow = (v: number | null, g: { good: number; bad: number }): Level => (v === null ? 'none' : v <= g.good ? 'ok' : v >= g.bad ? 'bad' : 'warn'); // lower is better
const levelHigh = (v: number | null, g: { good: number; bad: number }): Level => (v === null ? 'none' : v >= g.good ? 'ok' : v <= g.bad ? 'bad' : 'warn'); // higher is better
const LEVEL_STYLE: Record<Level, string> = {
  ok: 'bg-green-100 text-green-800',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-red-800',
  none: 'bg-surface text-text-muted',
};
const LEVEL_WORD: Record<Level, string> = { ok: 'good', warn: 'watch', bad: 'act', none: 'no data' };

function Tile({ label, value, sub, level, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; level?: Level; tone?: 'up' | 'down' | 'flat' }) {
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-3 min-w-0">
      <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider truncate">{label}</p>
      <p className="text-2xl font-black text-primary leading-tight">{value}</p>
      <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
        {level && level !== 'none' && <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${LEVEL_STYLE[level]}`}>{LEVEL_WORD[level]}</span>}
        {sub !== undefined && (
          <span className={`text-[11px] font-bold ${tone === 'up' ? 'text-green-600' : tone === 'down' ? 'text-red-600' : 'text-text-muted'}`}>{sub}</span>
        )}
      </div>
    </div>
  );
}

// A chart with its 30-day total and how that compares with the 30 days before.
function TrendCard({ title, totalLabel, data, totals, color }: { title: string; totalLabel: string; data: { date: string; count: number }[]; totals: { current: number; previous: number }; color?: string }) {
  const change = totals.previous === 0 ? (totals.current > 0 ? null : 0) : Math.round(((totals.current - totals.previous) / totals.previous) * 100);
  const up = (change ?? 0) >= 0;
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-3">
      <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{title}</p>
      <div className="flex items-end justify-between gap-2 flex-wrap mt-1 mb-1">
        <div>
          <p className="text-3xl font-black text-primary leading-none">{totals.current.toLocaleString()}</p>
          <p className="text-[11px] font-bold text-text-muted mt-1">{totalLabel}</p>
        </div>
        <div className="text-right">
          <p className={`text-sm font-black ${change === null ? 'text-text-muted' : up ? 'text-green-600' : 'text-red-600'}`}>
            {change === null ? 'new' : `${up ? '▲' : '▼'} ${Math.abs(change)}%`}
          </p>
          <p className="text-[11px] text-text-muted">vs previous 30 days ({totals.previous.toLocaleString()})</p>
        </div>
      </div>
      <Bars color={color} data={data.map((d) => ({ label: shortDate(d.date), value: d.count, full: d.date }))} />
    </div>
  );
}

function FunnelCard({ title, note, steps, empty }: { title: string; note?: string; steps: { label: string; v: number; ofPrev?: boolean }[]; empty?: string }) {
  const top = Math.max(1, steps[0]?.v || 0);
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-2">
      <p className="text-sm font-black text-primary">{title}</p>
      {note && <p className="text-[11px] text-text-muted -mt-1">{note}</p>}
      {empty && steps[0]?.v === 0 ? (
        <p className="text-xs text-text-muted py-3">{empty}</p>
      ) : (
        <div className="divide-y divide-border-subtle border-t border-border-subtle">
          {steps.map((s, i) => {
            const base = s.ofPrev !== false && i > 0 ? steps[i - 1].v : steps[0].v;
            const share = i > 0 ? pct(s.v, base) : null;
            return (
              <div key={s.label} className="py-3 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-bold text-primary">
                    <span className="w-5 h-5 shrink-0 rounded-full bg-primary/10 text-primary text-[11px] font-black flex items-center justify-center">{i + 1}</span>
                    {s.label}
                  </p>
                  <p className="text-xl font-black text-primary leading-none">{s.v.toLocaleString()}</p>
                </div>
                <div className="h-3 rounded-full bg-surface overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, (s.v / top) * 100)}%`, background: 'linear-gradient(90deg,#4ade80,#3b82f6)' }} />
                </div>
                {i > 0 && (
                  <p className="text-[11px] font-bold text-text-muted">
                    <span className="text-primary">{fmtPct(share)}</span> {s.ofPrev !== false ? 'of the step above' : 'of those who saw the login screen'}
                    {s.ofPrev !== false && base > s.v ? <span className="text-red-600"> · {(base - s.v).toLocaleString()} dropped off</span> : null}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Where people drop off, one row per day (or per week): the bar is everyone who saw the login screen, split into those who signed in (green),
// those who tapped a sign-in button but did not get in (amber) and those who never tapped (red). Newest first.
function FunnelTrend({ days }: { days: NonNullable<Metrics['funnel']['days']> }) {
  const [mode, setMode] = useState<'days' | 'weeks'>('days');
  const [seg, setSeg] = useState<'all' | 'new' | 'ret'>('new');
  const [unique, setUnique] = useState(true);
  type Row = { key: string; label: string; open: number; btn: number; view: number; tap: number; signed: number; fresh: number };
  const tally = (ev: Record<string, number>) => ({
    open: ev.app_open || 0,
    btn: ev.login_button_visible || 0,
    view: ev.login_screen_view || 0,
    tap: (ev.google_tap || 0) + (ev.email_tap || 0) + (ev.apple_tap || 0),
    signed: (ev.google_success_new || 0) + (ev.google_success_existing || 0) + (ev.email_signup_ok || 0) + (ev.email_login_ok || 0) + (ev.apple_success || 0),
    fresh: (ev.google_success_new || 0) + (ev.email_signup_ok || 0),
  });
  const rows: Row[] = useMemo(() => {
    // Unique devices: each phone once a day. New/returning device counts exist only from the day they started being kept; earlier days fall back to all visits.
    const pick = (d: (typeof days)[number]) => {
      if (!unique) return d[seg];
      if (seg === 'all') return d.uAll && Object.keys(d.uAll).length ? { ...d.all, ...d.uAll } : d.all;
      if (!d.uSeg) return d[seg];
      return seg === 'new' ? (d.uNew || {}) : (d.uRet || {});
    };
    const per = days.map((d) => ({ date: d.date, ...tally(pick(d)) }));
    if (mode === 'days') return per.slice(-14).reverse().map((r) => ({ key: r.date, label: shortDate(r.date), open: r.open, btn: r.btn, view: r.view, tap: r.tap, signed: r.signed, fresh: r.fresh }));
    const weeks = new Map<string, Row>();
    per.forEach((r) => {
      const dt = new Date(`${r.date}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const k = dt.toISOString().slice(0, 10);
      const w = weeks.get(k) || { key: k, label: `Week of ${shortDate(k)}`, open: 0, btn: 0, view: 0, tap: 0, signed: 0, fresh: 0 };
      w.open += r.open; w.btn += r.btn; w.view += r.view; w.tap += r.tap; w.signed += r.signed; w.fresh += r.fresh;
      weeks.set(k, w);
    });
    return Array.from(weeks.values()).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 8);
  }, [days, mode, seg, unique]);
  const top = Math.max(1, ...rows.map((r) => Math.max(r.open, r.view, r.tap)));
  const chip = (on: boolean) => `px-3 py-1 rounded-full text-xs font-black border ${on ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'}`;
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
      <div>
        <p className="text-sm font-black text-primary">Drop-off trend · {mode === 'days' ? 'day by day' : 'week by week'}</p>
        <p className="text-[11px] text-text-muted">Each bar is everyone who opened the app that {mode === 'days' ? 'day' : 'week'}, split by how far they got. (Opens are only counted from 29 Oct.){unique ? ' Unique devices counts each phone once a day; the new/returning split of that starts on the day this went live, earlier days show all visits.' : ''}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setMode('days')} className={chip(mode === 'days')}>Daily</button>
        <button type="button" onClick={() => setMode('weeks')} className={chip(mode === 'weeks')}>Weekly</button>
        <span className="w-2" />
        {([['all', 'Everyone'], ['new', 'New devices'], ['ret', 'Returning']] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setSeg(k)} className={chip(seg === k)}>{l}</button>)}
        <span className="w-2" />
        <button type="button" onClick={() => setUnique((u) => !u)} className={chip(unique)}>Unique devices</button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] font-bold text-text-muted">
        <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-green-500" />Signed in</span>
        <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-amber-400" />Tapped, did not get in</span>
        <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-red-400" />Saw login, left without tapping</span>
        <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-slate-400" />Opened, left before the login screen</span>
      </div>
      <div className="divide-y divide-border-subtle border-t border-border-subtle">
        {rows.map((r) => {
          const tapped = Math.min(r.tap, r.view || r.tap);
          const noTap = Math.max(0, r.view - r.tap);
          const hasOpen = r.open > 0;
          const preLogin = hasOpen ? Math.max(0, r.open - r.view) : 0;
          const total = hasOpen ? Math.max(r.open, r.view) : r.view;
          const failTap = Math.max(0, tapped - r.signed);
          const okPct = pct(r.signed, total);
          return (
            <div key={r.key} className="py-2.5 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs font-black text-primary">{r.label}</p>
                <p className="text-[11px] font-bold text-text-muted tabular-nums">{hasOpen ? `${r.open} opened → ` : ''}{r.view} saw login → {r.btn > 0 ? `${r.btn} saw the button → ` : ''}{r.tap} tapped → <span className="text-green-700">{r.signed} in</span>{r.fresh > 0 ? ` (${r.fresh} new)` : ''}</p>
              </div>
              {total === 0 && r.tap === 0 ? (
                <p className="text-[11px] text-text-muted">No visits.</p>
              ) : (
                <>
                  <div className="flex h-3.5 rounded-md overflow-hidden bg-surface" style={{ width: `${Math.max(6, (Math.max(total, r.tap) / top) * 100)}%` }}>
                    <i className="block h-full bg-green-500" style={{ flex: r.signed }} />
                    <i className="block h-full bg-amber-400" style={{ flex: failTap }} />
                    <i className="block h-full bg-red-400" style={{ flex: noTap }} />
                    <i className="block h-full bg-slate-400" style={{ flex: preLogin }} />
                  </div>
                  <p className="text-[11px] font-bold text-text-muted">
                    {hasOpen && <><span className="text-slate-600">{preLogin} opened but left before the login screen ({Math.round((preLogin / total) * 100)}%)</span>{' · '}</>}
                    <span className="text-red-600">{noTap} saw login, left without tapping{r.view > 0 ? ` (${Math.round((noTap / r.view) * 100)}%)` : ''}</span>
                    {' · '}<span className="text-amber-700">{failTap} tapped but did not get in{tapped > 0 ? ` (${Math.round((failTap / tapped) * 100)}% of taps)` : ''}</span>
                    {' · '}<span className="text-green-700">{fmtPct(okPct)} got in</span>
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// What each stored Google sign-in error code means, in plain words.
function explainCode(code: string): { label: string; hint: string } {
  const c = code.replace(/:$/, '');
  if (c.includes('network-request-failed')) return { label: 'Lost connection', hint: 'The phone lost its internet connection during sign-in.' };
  if (c === '8') return { label: 'Google error 8', hint: 'A temporary failure inside Google sign-in, usually a hiccup in Google Play services.' };
  if (c === '12501') return { label: 'Cancelled / not finished', hint: 'The person closed the Google account box without finishing.' };
  if (c === '12500') return { label: 'Google error 12500', hint: 'Google sign-in is misconfigured or Play services is out of date.' };
  if (c === '10') return { label: 'Developer error 10', hint: 'The app signature is not registered with Google (a build or key problem).' };
  if (c.includes('internal-error')) return { label: 'Google internal error', hint: 'Google reported a temporary problem.' };
  if (c.includes('popup')) return { label: 'Sign-in window blocked', hint: 'The browser blocked or closed the Google window.' };
  return { label: code, hint: 'Other error code.' };
}

// The Google sign-in errors: what they were, and how they are trending by day or by week. Collapsed until opened.
function SignInErrors({ days }: { days: NonNullable<Metrics['funnel']['signinDays']> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'days' | 'weeks'>('days');
  const recent = days.slice(-7);
  const taps7 = recent.reduce((n, d) => n + d.taps, 0);
  const errors7 = recent.reduce((n, d) => n + d.errors, 0);
  const codes7: Record<string, number> = {};
  recent.forEach((d) => Object.entries(d.codes).forEach(([k, v]) => { codes7[k] = (codes7[k] || 0) + v; }));
  const codeRows = Object.entries(codes7).sort((a, b) => b[1] - a[1]);

  let series: { label: string; full: string; value: number; taps: number }[];
  if (mode === 'days') {
    series = days.slice(-30).map((d) => ({ label: shortDate(d.date), full: d.date, value: d.errors, taps: d.taps }));
  } else {
    const weeks = new Map<string, { errors: number; taps: number }>();
    days.forEach((d) => {
      const dt = new Date(`${d.date}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const k = dt.toISOString().slice(0, 10);
      const w = weeks.get(k) || { errors: 0, taps: 0 };
      w.errors += d.errors;
      w.taps += d.taps;
      weeks.set(k, w);
    });
    series = Array.from(weeks.entries()).sort().slice(-10).map(([k, w]) => ({ label: shortDate(k), full: `Week of ${shortDate(k)}`, value: w.errors, taps: w.taps }));
  }

  return (
    <div className="bg-white rounded-2xl border border-border-subtle">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left">
        <span>
          <span className="block text-sm font-black text-primary">Sign-in errors · what they were, trend, days, weeks</span>
          <span className="block text-[11px] text-text-muted">{errors7} errors in {taps7} Google taps over the last 7 days</span>
        </span>
        <span className="material-symbols-outlined text-text-muted">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border-subtle pt-3">
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">What the errors were · last 7 days</p>
            {codeRows.length === 0 ? (
              <p className="text-xs text-text-muted">No errors in the last 7 days.</p>
            ) : (
              <div className="divide-y divide-border-subtle">
                {codeRows.map(([code, n]) => {
                  const info = explainCode(code);
                  return (
                    <div key={code} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-primary">{info.label}</p>
                        <p className="text-[11px] text-text-muted">{info.hint}</p>
                      </div>
                      <p className="text-lg font-black text-primary">{n}</p>
                    </div>
                  );
                })}
                {recent.reduce((n, d) => n + d.cancels, 0) > 0 && (
                  <div className="py-2 flex items-start justify-between gap-3">
                    <div><p className="text-sm font-bold text-primary">Cancelled</p><p className="text-[11px] text-text-muted">Closed the Google box (not counted as an error).</p></div>
                    <p className="text-lg font-black text-primary">{recent.reduce((n, d) => n + d.cancels, 0)}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Trend · errors per {mode === 'days' ? 'day' : 'week'}</p>
              <div className="flex rounded-xl border border-border-subtle overflow-hidden text-xs font-bold">
                {(['days', 'weeks'] as const).map((m2) => (
                  <button key={m2} type="button" onClick={() => setMode(m2)} className={`px-3 py-1 ${mode === m2 ? 'bg-primary text-white' : 'bg-white text-text-muted'}`}>{m2 === 'days' ? 'Days' : 'Weeks'}</button>
                ))}
              </div>
            </div>
            <Bars color="#dc2626" data={series.map((s) => ({ label: s.label, value: s.value, full: `${s.full} · ${s.value} errors of ${s.taps} taps (${s.taps ? Math.round((s.value / s.taps) * 100) : 0}%)` }))} />
            <p className="text-[11px] text-text-muted">The retry for dropped connections and the plain error messages went live on 21 Oct. Counters started on 16 Oct.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-2">
    <h2 className="text-[11px] font-black text-text-muted uppercase tracking-[0.14em] px-1">{title}</h2>
    {children}
  </section>
);

const shortDate = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function Bars({ data, color = '#0f766e', money }: { data: { label: string; value: number; full?: string }[]; color?: string; money?: string }) {
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={Math.max(0, Math.ceil(data.length / 7) - 1)} />
          <YAxis allowDecimals={!!money} tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v: number) => [money ? `${money}${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : v, '']} labelFormatter={(_l, p) => (p && p[0] ? (p[0].payload as any).full || (p[0].payload as any).label : '')} cursor={{ fill: 'rgba(15,118,110,0.08)' }} />
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Walks an object of metrics ({ last7, prev7, ... }) and lists every one it finds, so new product metrics show up without editing this file.
function collectUsage(node: any, path: string[] = [], out: { label: string; last7: number; prev7: number; total: number }[] = []) {
  if (node && typeof node === 'object') {
    if (typeof node.last7 === 'number' && typeof node.prev7 === 'number') {
      out.push({ label: path.map((p) => p.replace(/([A-Z])/g, ' $1')).join(' › '), last7: node.last7, prev7: node.prev7, total: Number(node.total) || 0 });
    } else {
      Object.keys(node).forEach((k) => collectUsage(node[k], [...path, k], out));
    }
  }
  return out;
}

export default function AdminMetrics() {
  const [tab, setTab] = useState<Tab>('today');
  const [m, setM] = useState<Metrics | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [product, setProduct] = useState<any | null>(null);
  const [bcast, setBcast] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = (refresh = false) => {
    setRefreshing(true);
    adminGet(`/api/admin/metrics${refresh ? '?refresh=1' : ''}`).then(setM).catch((e) => setError(e.message)).finally(() => setRefreshing(false));
    adminGet('/api/admin/cloud-cost').then(setCost).catch(() => setCost({ tableReady: false }));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (tab === 'cost' && !breakdown) adminGet('/api/admin/cloud-cost/breakdown').then(setBreakdown).catch(() => setBreakdown({ tableReady: false }));
    if (tab === 'broadcasts' && !bcast) adminGet('/api/admin/broadcast/analytics').then((r) => setBcast(r.broadcasts || [])).catch(() => setBcast([]));
    if (tab === 'product' && !product) adminGet('/api/admin/analytics/product').then(setProduct).catch(() => setProduct({}));
  }, [tab, breakdown, product]);

  // ── derived numbers shared by several tabs ──
  const derived = useMemo(() => {
    if (!m) return null;
    const f = m.funnel.current;
    const fp = m.funnel.previous;
    const taps = (f.google_tap || 0);
    const signInFail = pct(f.google_error || 0, taps);
    // The earlier week is only worth quoting once it has enough taps to mean something (the counters only began on 16 Oct).
    const signInFailPrev = (fp.google_tap || 0) >= 10 ? pct(fp.google_error || 0, fp.google_tap || 0) : null;
    const total = m.ops.reduce((a, d) => ({ requests: a.requests + (d.requests || 0), e5: a.e5 + (d.errors5xx || 0), l: [0, 1, 2, 3, 4].map((i) => a.l[i] + (d[`lat${i}`] || 0)), vc: a.vc + (d.voiceCalls || 0), vu: a.vu + (d.voiceUnderstood || 0), ve: a.ve + (d.voiceErrors || 0) }), { requests: 0, e5: 0, l: [0, 0, 0, 0, 0], vc: 0, vu: 0, ve: 0 });
    const serverErr = pct(total.e5, total.requests);
    // The slowest 5%: the first speed bucket that takes the running share past 95%.
    const edges = [100, 250, 500, 1000];
    let p95: number | null = null;
    let p95Label = '—';
    if (total.requests > 0) {
      let run = 0;
      for (let i = 0; i < 5; i++) {
        run += total.l[i];
        if (run / total.requests >= 0.95) { p95 = i < 4 ? edges[i] : 2000; p95Label = i < 4 ? `<${edges[i]}ms` : '>1s'; break; }
      }
    }
    const voiceRate = pct(total.vu, total.vc);
    const now = adminNowParts();
    const dim = new Date(now.year, now.month, 0).getDate();
    const forecast = cost?.thisMonth !== undefined ? (cost.thisMonth / Math.max(1, now.day)) * dim : null;
    const forecastVsLast = forecast !== null && cost?.lastMonth ? Math.round(((forecast - cost.lastMonth) / cost.lastMonth) * 100) : null;
    const avg30 = m.users.newByDay.reduce((n, d) => n + d.count, 0) / Math.max(1, m.users.newByDay.length);
    return { f, fp, taps, signInFail, signInFailPrev, total, serverErr, p95, p95Label, voiceRate, forecast, forecastVsLast, avg30, dim };
  }, [m, cost]);

  const alerts = useMemo(() => {
    const out: { level: 'bad' | 'warn'; text: string }[] = [];
    if (!m || !derived) return out;
    if (derived.taps >= 10 && derived.signInFail !== null && derived.signInFail >= GOALS.signInFailure.bad) out.push({ level: 'bad', text: `Google sign-in fails for ${derived.signInFail}% of taps (7 days)${derived.signInFailPrev !== null ? `, was ${derived.signInFailPrev}%` : ''}` });
    else if (derived.taps >= 10 && derived.signInFail !== null && derived.signInFail > GOALS.signInFailure.good) out.push({ level: 'warn', text: `Google sign-in fails for ${derived.signInFail}% of taps (goal under ${GOALS.signInFailure.good}%)` });
    if (derived.total.requests >= 50 && derived.serverErr !== null && derived.serverErr >= GOALS.serverErrors.bad) out.push({ level: 'bad', text: `Server errors are ${derived.serverErr}% of requests` });
    if (derived.p95 !== null && derived.p95 >= GOALS.p95Ms.bad) out.push({ level: 'bad', text: `The slowest 5% of requests take over ${derived.p95Label.replace('<', '')}` });
    if (derived.total.vc >= 10 && derived.voiceRate !== null && derived.voiceRate < GOALS.voiceUnderstood.bad) out.push({ level: 'warn', text: `Only ${derived.voiceRate}% of voice entries are understood` });
    if (derived.forecastVsLast !== null && derived.forecastVsLast >= GOALS.costVsLastMonth) out.push({ level: 'warn', text: `Cloud cost is heading ${derived.forecastVsLast}% above last month` });
    return out;
  }, [m, derived]);

  const money = (v: number | null | undefined, cur?: string) => (v === null || v === undefined ? '—' : `${cur === 'INR' || !cur ? '₹' : `${cur} `}${Math.round(v).toLocaleString()}`);

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-5 pb-44">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-3xl font-black text-primary">App health</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`shrink-0 px-4 py-2 rounded-full text-sm font-black border ${tab === t.id ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-error">Could not load: {error}</p>}
      {!m && !error && <div className="h-40 rounded-2xl bg-white border border-border-subtle animate-pulse" />}

      {m && derived && tab === 'today' && (
        <div className="space-y-5">
          <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-white ${alerts.some((a) => a.level === 'bad') ? 'bg-red-700' : alerts.length ? 'bg-amber-600' : 'bg-[#0d3b4e]'}`}>
            <span className={`w-3 h-3 rounded-full ${alerts.some((a) => a.level === 'bad') ? 'bg-red-200' : alerts.length ? 'bg-amber-200' : 'bg-green-400'}`} />
            <div className="min-w-0 flex-1">
              <p className="font-black">{alerts.some((a) => a.level === 'bad') ? 'Something needs fixing' : alerts.length ? 'Worth a look' : 'All systems healthy'}</p>
              <p className="text-[11px] opacity-80 truncate">Backend {m.revision.replace('familyledger-backend-', '')} · errors {fmtPct(derived.serverErr)} · slowest 5% {derived.p95Label} · updated {fmtTime(m.generatedAt)}</p>
            </div>
            <button type="button" onClick={() => load(true)} disabled={refreshing} className="shrink-0 px-3 py-1.5 rounded-lg bg-white/20 text-xs font-black disabled:opacity-50">{refreshing ? '…' : 'Refresh'}</button>
          </div>
          {alerts.map((a) => (
            <div key={a.text} className={`rounded-xl px-3 py-2 text-xs font-bold ${a.level === 'bad' ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>⚠ {a.text}</div>
          ))}

          {m.funnel.signinDays && m.funnel.signinDays.length > 0 && <SignInErrors days={m.funnel.signinDays} />}
          <Section title="Growth">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Tile label="New users today" value={m.users.newToday} sub={derived.avg30 > 0 ? `${m.users.newToday >= derived.avg30 ? '▲' : '▼'} avg ${Math.round(derived.avg30 * 10) / 10}/day` : undefined} tone={m.users.newToday >= derived.avg30 ? 'up' : 'down'} />
              <Tile label="Active today" value={m.users.dau} sub={`of ${num(m.users.total)} users`} />
              <Tile label="Active 7 days" value={m.users.wau} sub={fmtPct(pct(m.users.dau, m.users.wau)) + ' daily/weekly'} />
              <Tile label="Active 30 days" value={m.users.mau} sub={fmtPct(pct(m.users.wau, m.users.mau)) + ' weekly/monthly'} />
            </div>
            <TrendCard title="New users · last 30 days" totalLabel="new users in 30 days" data={m.users.newByDay} totals={m.users.newTotals} />
            <TrendCard title="Active users · last 30 days" totalLabel="different people opened the app" data={m.active.byDay} totals={m.active.totals} color="#3b82f6" />
            <Link to="/admin/users" className="text-xs font-bold text-primary underline">Open Users for days and weeks</Link>
          </Section>

          <Section title="Money">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Tile label="Cloud cost this month" value={money(cost?.thisMonth, cost?.currency)} sub={derived.forecast !== null ? `on track ${money(derived.forecast, cost?.currency)}` : undefined} />
              <Tile label="Last month" value={money(cost?.lastMonth, cost?.currency)} />
              <Tile label="Cost per active user" value={cost?.thisMonth !== undefined && m.users.mau ? money(cost.thisMonth / m.users.mau, cost.currency) : '—'} sub="this month ÷ 30-day active" />
            </div>
          </Section>

          <Section title="Needs attention">
            <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle text-sm">
              {[
                { label: 'Feedback waiting', n: m.attention.feedback, to: '/admin/feedback' },
                { label: 'Chat reports to review', n: m.attention.chatReports, to: '/admin/chat-reports' },
                { label: 'Shopkeeper requests', n: m.attention.shopkeeper, to: '/admin/shopkeeper-requests' },
              ].map((r) => (
                <Link key={r.label} to={r.to} className="flex items-center justify-between px-4 py-3">
                  <span className="font-semibold">{r.label}</span>
                  <span className={`font-black ${r.n > 0 ? 'text-amber-700' : 'text-text-muted'}`}>{r.n}</span>
                </Link>
              ))}
            </div>
          </Section>
        </div>
      )}

      {m && derived && tab === 'growth' && (
        <div className="space-y-5">
          <Section title="Sign-in funnels · last 7 days (anonymous counters, Android and web)">
            {(() => {
              const tapsOf = (f: Record<string, number>) => (f.google_tap || 0) + (f.email_tap || 0) + (f.apple_tap || 0);
              const newAcctOf = (f: Record<string, number>) => (f.google_success_new || 0) + (f.email_signup_ok || 0);
              const signedInOf = (f: Record<string, number>) => (f.google_success_new || 0) + (f.google_success_existing || 0) + (f.email_signup_ok || 0) + (f.email_login_ok || 0) + (f.apple_success || 0);
              const f = derived.f;
              const segNew = m.funnel.segments?.new.current || {};
              const segRet = m.funnel.segments?.ret.current || {};
              const since = m.funnel.segmentsSince;
              const splitNote = since ? `Split by device started ${since}.` : 'Split by device starts with the next app update; nothing to show yet.';
              return (
                <div className="space-y-3">
                  <FunnelCard
                    title="Overall"
                    note="Everyone who opened the login screen."
                    steps={[
                      { label: 'Saw the login screen', v: f.login_screen_view || 0 },
                      { label: 'Tapped a sign-in button', v: tapsOf(f) },
                      { label: 'Signed in', v: signedInOf(f) },
                      { label: 'New account created', v: newAcctOf(f), ofPrev: false },
                      { label: 'Created a group', v: f.group_created || 0, ofPrev: false },
                    ]}
                  />
                  <FunnelCard
                    title="New devices"
                    note={`Phones and browsers that had never signed in before. ${splitNote}`}
                    empty="No data yet for new devices."
                    steps={[
                      { label: 'Saw the login screen', v: segNew.login_screen_view || 0 },
                      { label: 'Tapped a sign-in button', v: tapsOf(segNew) },
                      { label: 'Signed in', v: signedInOf(segNew) },
                      { label: 'New account created', v: newAcctOf(segNew), ofPrev: false },
                      { label: 'Created a group (first week)', v: segNew.group_created || 0, ofPrev: false },
                    ]}
                  />
                  <FunnelCard
                    title="Returning devices"
                    note={`Devices that have signed in before (for example after signing out or being signed out). ${splitNote}`}
                    empty="No data yet for returning devices."
                    steps={[
                      { label: 'Saw the login screen', v: segRet.login_screen_view || 0 },
                      { label: 'Tapped a sign-in button', v: tapsOf(segRet) },
                      { label: 'Signed in', v: signedInOf(segRet) },
                    ]}
                  />
                  {m.funnel.days && m.funnel.days.length > 0 && <FunnelTrend days={m.funnel.days} />}
                  <p className="text-[11px] text-text-muted px-1">Store visits and installs are in Google Play Console; the funnels start when someone sees the login screen. A device is counted every time it opens the screen. Reinstalling the app makes a device "new" again.</p>
                </div>
              );
            })()}
          </Section>

          <Section title="Do people come back? (of people who joined at least that long ago)">
            <div className="grid grid-cols-3 gap-2">
              {(['d1', 'd7', 'd30'] as const).map((k) => (
                <React.Fragment key={k}>
                  <Tile label={`Back after day ${k.slice(1)}`} value={fmtPct(pct(m.retention[k].returned, m.retention[k].cohort))} sub={`${m.retention[k].returned} of ${m.retention[k].cohort}`} />
                </React.Fragment>
              ))}
            </div>
            <p className="text-[11px] text-text-muted px-1">"Back" means the account was last active on or after that many days after joining. It is a close stand-in for classic retention, which needs a daily activity log.</p>
          </Section>

          <Section title="Do new people get value? (joined 8 to 45 days ago)">
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Logged an expense in week 1" value={fmtPct(pct(m.activation.firstExpense, m.activation.cohort))} sub={`${m.activation.firstExpense} of ${m.activation.cohort}`} />
              <Tile label="Logged 3+ in week 1" value={fmtPct(pct(m.activation.threeExpenses, m.activation.cohort))} sub={`${m.activation.threeExpenses} of ${m.activation.cohort}`} />
            </div>
          </Section>
        </div>
      )}

      {m && derived && tab === 'health' && (
        <div className="space-y-5">
          <Section title="Reliability · last 7 days">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Tile label="Server errors" value={fmtPct(derived.serverErr)} level={levelLow(derived.serverErr, GOALS.serverErrors)} sub={`${num(derived.total.e5)} of ${num(derived.total.requests)}`} />
              <Tile label="Slowest 5% respond in" value={derived.p95Label} level={levelLow(derived.p95, GOALS.p95Ms)} sub="goal under 500ms" />
              <Tile label="Google sign-in failures" value={fmtPct(derived.signInFail)} level={levelLow(derived.signInFail, GOALS.signInFailure)} sub={derived.signInFailPrev !== null ? `was ${derived.signInFailPrev}%` : undefined} />
              <Tile label="Voice entries understood" value={fmtPct(derived.voiceRate)} level={levelHigh(derived.voiceRate, GOALS.voiceUnderstood)} sub={`${num(derived.total.vc)} tries · ${derived.total.ve} errors`} />
            </div>
            <div className="bg-white rounded-2xl border border-border-subtle p-4 text-sm">
              <p className="font-black text-primary">Crashes and freezes</p>
              <p className="text-text-muted text-xs mt-1">Crash-free users, ANR rate and ratings are measured by Google, so they are not on this page. Check <b>Play Console → Quality → Android vitals</b> and keep crash-free users above 99%.</p>
              <a href="https://play.google.com/console" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); window.open('https://play.google.com/console', '_blank'); }} className="inline-block mt-2 text-xs font-black text-primary underline">Open Play Console</a>
            </div>
          </Section>
          <Section title="Server by day">
            <div className="bg-white rounded-2xl border border-border-subtle overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead><tr className="text-left text-text-muted border-b border-border-subtle"><th className="p-2">Day</th><th className="p-2">Requests</th><th className="p-2">Errors</th><th className="p-2">Under 250ms</th><th className="p-2">Voice tries</th></tr></thead>
                <tbody>
                  {m.ops.length === 0 && <tr><td colSpan={5} className="p-3 text-text-muted">No server counters yet — they start filling in once this version is live.</td></tr>}
                  {[...m.ops].reverse().map((d: any) => (
                    <tr key={d.date} className="border-b border-border-subtle last:border-0">
                      <td className="p-2 font-bold text-primary">{String(d.date).slice(5)}</td>
                      <td className="p-2">{num(d.requests || 0)}</td>
                      <td className={`p-2 ${d.errors5xx ? 'text-red-700 font-bold' : ''}`}>{d.errors5xx || 0}</td>
                      <td className="p-2">{fmtPct(pct((d.lat0 || 0) + (d.lat1 || 0), d.requests || 0))}</td>
                      <td className="p-2">{d.voiceCalls || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}

      {m && derived && tab === 'cost' && (
        <div className="space-y-5">
          <Section title="Google Cloud cost">
            {cost && !cost.tableReady && <p className="text-sm text-text-muted">The billing export is not set up yet, so there is no cost data.</p>}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Tile label="This month so far" value={money(cost?.thisMonth, cost?.currency)} />
              <Tile label="Forecast this month" value={money(derived.forecast, cost?.currency)} level={derived.forecastVsLast === null ? 'none' : derived.forecastVsLast >= GOALS.costVsLastMonth ? 'warn' : 'ok'} sub={derived.forecastVsLast !== null ? `${derived.forecastVsLast >= 0 ? '+' : ''}${derived.forecastVsLast}% vs last month` : undefined} />
              <Tile label="Last month" value={money(cost?.lastMonth, cost?.currency)} />
              <Tile label="Last 7 days" value={money(cost?.last7Days, cost?.currency)} />
              <Tile label="Per active user" value={cost?.thisMonth !== undefined && m.users.mau ? money(cost.thisMonth / m.users.mau, cost.currency) : '—'} sub="30-day active" />
              <Tile label="Per weekly active user" value={cost?.thisMonth !== undefined && m.users.wau ? money(cost.thisMonth / m.users.wau, cost.currency) : '—'} />
            </div>
          </Section>
          <Section title="Where it goes · this month">
            <div className="bg-white rounded-2xl border border-border-subtle p-3">
              {!breakdown && <div className="h-24 animate-pulse bg-surface rounded-xl" />}
              {breakdown?.byService && breakdown.byService.length > 0 && (() => {
                const total = breakdown.byService.reduce((n, r) => n + Math.max(0, r.net), 0) || 1;
                return (
                  <div className="space-y-2">
                    {breakdown.byService.map((r) => (
                      <div key={r.service}>
                        <div className="flex justify-between text-xs font-bold"><span className="truncate">{r.service}</span><span>{money(r.net, breakdown.currency)} · {Math.round((Math.max(0, r.net) / total) * 100)}%</span></div>
                        <div className="h-2 rounded-full bg-surface overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.max(2, (Math.max(0, r.net) / total) * 100)}%` }} /></div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {breakdown && !breakdown.byService?.length && <p className="text-xs text-text-muted">No cost lines yet.</p>}
            </div>
          </Section>
          {breakdown?.daily && breakdown.daily.length > 0 && (
            <Section title="Daily cost · last 30 days">
              <div className="bg-white rounded-2xl border border-border-subtle p-3">
                <Bars money={breakdown.currency === 'INR' || !breakdown.currency ? '₹' : `${breakdown.currency} `} color="#3b82f6" data={breakdown.daily.map((d) => ({ label: shortDate(d.date), value: d.net, full: d.date }))} />
              </div>
            </Section>
          )}
        </div>
      )}

      {tab === 'broadcasts' && (
        <div className="space-y-4">
          <p className="text-[11px] text-text-muted px-1">
            How each broadcast did. "Seen" is people who opened the app and saw it (the push notification itself is counted separately). A tap counts on a link, on a Follow button or on a picture; "people" counts each person once.
          </p>
          {!bcast && <div className="h-28 rounded-2xl bg-white border border-border-subtle animate-pulse" />}
          {bcast && bcast.length === 0 && <p className="text-sm text-text-muted px-1">No broadcast has been sent yet.</p>}
          {bcast?.map((b) => {
            const seenPct = pct(b.views, b.recipients);
            const tapPct = pct(b.clickers, b.views);
            const targets: { key: string; label: string; icon: string }[] = [
              { key: 'instagram', label: 'Instagram', icon: '📸' },
              { key: 'facebook', label: 'Facebook', icon: '👍' },
              { key: 'play', label: 'Google Play', icon: '⭐' },
              { key: 'feedback', label: 'Feedback', icon: '💬' },
              { key: 'other', label: 'Other links', icon: '🔗' },
            ];
            const maxTaps = Math.max(1, ...targets.map((t) => b.byTarget?.[t.key]?.clicks || 0));
            return (
              <div key={b.id} className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
                <div>
                  <p className="text-sm font-black text-primary leading-tight">{b.title}</p>
                  <p className="text-[11px] text-text-muted">{b.sentAt ? fmtDateTime(b.sentAt) : ''}</p>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  <Tile label="Sent to" value={num(b.recipients)} sub={`${num(b.pushSent)} notified`} />
                  <Tile label="Seen" value={num(b.views)} sub={`${fmtPct(seenPct)} of those sent`} />
                  <Tile label="Closed" value={num(b.closes)} sub={`${fmtPct(pct(b.closes, b.views))} of seen`} />
                  <Tile label="People who tapped" value={num(b.clickers)} sub={`${fmtPct(tapPct)} of seen`} level={levelHigh(tapPct, { good: 15, bad: 3 })} />
                  <Tile label="Total taps" value={num(b.clicks)} sub={`links ${num(b.byVia?.link || 0)} · buttons ${num(b.byVia?.button || 0)} · pictures ${num(b.byVia?.image || 0)}`} />
                </div>
                <div className="space-y-1.5">
                  {targets.map((t) => {
                    const v = b.byTarget?.[t.key] || { clicks: 0, people: 0 };
                    if (!v.clicks && t.key === 'other') return null;
                    return (
                      <div key={t.key} className="flex items-center gap-3">
                        <span className="w-28 shrink-0 text-xs font-bold text-primary">{t.icon} {t.label}</span>
                        <div className="flex-1 h-3 rounded-full bg-surface overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-[#4ADE80] to-[#3B82F6]" style={{ width: `${(v.clicks / maxTaps) * 100}%` }} />
                        </div>
                        <span className="w-28 shrink-0 text-right text-[11px] font-bold text-text-muted tabular-nums">{num(v.clicks)} taps · {num(v.people)} people</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {m && derived && tab === 'product' && (
        <div className="space-y-5">
          <Section title="Is it useful?">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Tile label="New users who log an expense in week 1" value={fmtPct(pct(m.activation.firstExpense, m.activation.cohort))} />
              <Tile label="…and log 3 or more" value={fmtPct(pct(m.activation.threeExpenses, m.activation.cohort))} />
              <Tile label="Active in last 7 days" value={m.users.wau} sub={`${fmtPct(pct(m.users.wau, m.users.total))} of all users`} />
              <Tile label="Active in last 30 days" value={m.users.mau} sub={`${fmtPct(pct(m.users.mau, m.users.total))} of all users`} />
            </div>
          </Section>
          <Section title="Feature use · last 7 days vs the 7 before">
            <div className="bg-white rounded-2xl border border-border-subtle overflow-x-auto">
              {!product && <div className="h-24 animate-pulse bg-surface" />}
              {product && (() => {
                const rows = collectUsage(product).filter((r) => r.last7 > 0 || r.prev7 > 0).sort((a, b) => b.last7 - a.last7).slice(0, 16);
                if (rows.length === 0) return <p className="p-3 text-xs text-text-muted">No feature data yet.</p>;
                return (
                  <table className="w-full text-xs min-w-[380px]">
                    <thead><tr className="text-left text-text-muted border-b border-border-subtle"><th className="p-2">Feature</th><th className="p-2">Last 7d</th><th className="p-2">Previous 7d</th><th className="p-2">Change</th></tr></thead>
                    <tbody>
                      {rows.map((r) => {
                        const ch = r.prev7 === 0 ? (r.last7 > 0 ? 100 : 0) : Math.round(((r.last7 - r.prev7) / r.prev7) * 100);
                        return (
                          <tr key={r.label} className="border-b border-border-subtle last:border-0">
                            <td className="p-2 font-bold text-primary capitalize">{r.label}</td>
                            <td className="p-2">{num(r.last7)}</td>
                            <td className="p-2">{num(r.prev7)}</td>
                            <td className={`p-2 font-bold ${ch >= 0 ? 'text-green-600' : 'text-red-600'}`}>{ch >= 0 ? '▲' : '▼'} {Math.abs(ch)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>
            <Link to="/admin/analytics" className="text-xs font-bold text-primary underline px-1">Open Full Analytics</Link>
          </Section>
        </div>
      )}
      <div aria-hidden="true" className="h-24" />
    </div>
  );
}
