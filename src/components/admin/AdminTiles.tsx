import React, { useEffect } from 'react';
import clsx from 'clsx';
import { fmtDate } from '../../lib/adminTime';
import { adminGet } from '../../lib/adminApi';
import { useRememberedState } from '../../lib/liveCache';
import { inNum } from '../../lib/adminNumbers';
import { PlatformLogo } from './PlatformLogo';

// The admin summary tiles (a figure with its trend, and the Google Cloud cost card), shared by the Admin Overview tab and the admin's own Profile page.

export interface CloudCost {
  tableReady: boolean;
  hasData?: boolean;
  currency?: string;
  thisMonth?: number;
  lastMonth?: number;
  last7Days?: number;
  earliest?: string;
}

export function formatMoney(n: number, currency?: string) {
  return n.toLocaleString(currency === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
}

export const sumOf = (a: number[]) => a.reduce((x, y) => x + y, 0);

// "▲ 40%" / "▼ 12%" / "—" for a figure against the one before it; "new" when there was nothing before.
export function Arrow({ now, before }: { now: number; before: number }) {
  if (before === 0) return now > 0 ? <span className="font-black text-primary">new</span> : <span className="text-text-muted">—</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="text-text-muted">— steady</span>;
  return <span className={clsx('font-black', pct > 0 ? 'text-success' : 'text-error')}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

// The last 14 days as a small line; days with no figure (null) are skipped.
export function Spark({ values }: { values: (number | null)[] }) {
  const w = 64, h = 22;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <span className="text-[10px] text-text-muted">no trend yet</span>;
  const max = Math.max(...nums), min = Math.min(...nums);
  const span = Math.max(1, max - min);
  const pts = values
    .map((v, i) => (v == null ? null : `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#0f4761" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// A tile: the big number, the 14-day line, then today against yesterday and this week against last week.
// - default: `series` is what was added each day, so "this week" is the sum of 7 days.
// - `level`: a count at a moment (people active today), so only today against yesterday, never summed.
// - `weekSeries`: a rolling 7-day count saved each day, compared with the one from 7 days ago.
export function StatCard({ label, value, series, level, weekSeries, format }: {
  label: string;
  value: string | number;
  series?: (number | null)[];
  level?: boolean;
  weekSeries?: (number | null)[];
  format?: (n: number) => string;
}) {
  const f = format || ((n: number) => inNum(n));
  const signed = (n: number) => (level || weekSeries ? f(n) : `${n > 0 ? '+' : ''}${f(n)}`);
  const shown = weekSeries || series;
  const n = shown?.length || 0;
  const at = (i: number) => shown?.[n - 1 - i] ?? null;
  const num = (v: number | null) => (v == null ? '–' : signed(v));
  const flowSum = (from: number, to: number) => sumOf((series || []).slice(n - to, n - from).map((v) => v || 0));
  const pair = (a: number | null, b: number | null) => a != null && b != null && <Arrow now={a} before={b} />;

  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-text-muted uppercase tracking-wider">{label}</p>
          <p className="text-3xl font-black text-primary mt-1 truncate">{value}</p>
        </div>
        {shown && <div className="pt-1 shrink-0"><Spark values={shown} /></div>}
      </div>
      {shown && (
        <div className="mt-2 space-y-1 text-[11px] text-text-muted">
          {weekSeries ? (
            <p className="flex items-center justify-between gap-2">
              <span>Now <b className="text-on-surface">{num(at(0))}</b> · 7 days ago <b className="text-on-surface">{num(at(7))}</b></span>
              {pair(at(0), at(7))}
            </p>
          ) : (
            <>
              <p className="flex items-center justify-between gap-2">
                <span>Today <b className="text-on-surface">{num(at(0))}</b> · Yesterday <b className="text-on-surface">{num(at(1))}</b></span>
                {pair(at(0), at(1))}
              </p>
              {!level && (
                <p className="flex items-center justify-between gap-2">
                  <span>This week <b className="text-on-surface">{signed(flowSum(0, 7))}</b> · Last week <b className="text-on-surface">{signed(flowSum(7, 14))}</b></span>
                  <Arrow now={flowSum(0, 7)} before={flowSum(7, 14)} />
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Total users, split into three parts: everyone, Android, iPhone. A total banner (number, 14-day bars, split bar, today/yesterday, this week/last week with
// the % change), then a green Android tile and a black Apple tile that each repeat all of those figures, so the split loses nothing.
export interface UsersOverview {
  total: number;
  series?: number[];
  platforms?: { android: { total: number; trend: number[] }; ios: { total: number; trend: number[] }; web: number; unknown: number };
}

// today / yesterday / this week / last week from a per-day series of new users (oldest first, last = today)
function periodsOf(series?: number[]) {
  const a = series || [];
  const n = a.length;
  return { today: a[n - 1] ?? 0, yest: a[n - 2] ?? 0, week: sumOf(a.slice(Math.max(0, n - 7))), last: sumOf(a.slice(Math.max(0, n - 14), Math.max(0, n - 7))) };
}
const signedNum = (n: number) => `${n > 0 ? '+' : ''}${inNum(n)}`;

// the % change as a small coloured pill; `onColour` for use on the green / black tiles
function ChangePill({ now, before, onColour, small }: { now: number; before: number; onColour?: boolean; small?: boolean }) {
  const base: React.CSSProperties = { borderRadius: 999, padding: small ? '1px 6px' : '2px 8px', fontSize: small ? 10 : 11, fontWeight: 800, whiteSpace: 'nowrap', display: 'inline-block', lineHeight: 1.35 };
  const neutral = { background: onColour ? 'rgba(255,255,255,.18)' : '#f1f5f9', color: onColour ? '#fff' : '#64748b' };
  if (before === 0) return <span style={{ ...base, ...(now > 0 ? { background: onColour ? 'rgba(255,255,255,.2)' : '#e0f2fe', color: onColour ? '#fff' : '#0369a1' } : neutral) }}>{now > 0 ? 'new' : '—'}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span style={{ ...base, ...neutral }}>steady</span>;
  const up = pct > 0;
  const colours = up ? { background: onColour ? 'rgba(255,255,255,.22)' : '#dcfce7', color: onColour ? '#fff' : '#15803d' } : { background: onColour ? 'rgba(0,0,0,.28)' : '#fee2e2', color: onColour ? '#fecaca' : '#b91c1c' };
  return <span style={{ ...base, ...colours }}>{up ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

// the last 14 days as small bars; the newest day is full strength
function MiniBars({ values, color, w = 96, h = 28 }: { values: number[]; color: string; w?: number; h?: number }) {
  const max = Math.max(...values, 1);
  const bw = w / Math.max(1, values.length);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {values.map((v, i) => {
        const bh = Math.max(2, (v / max) * (h - 2));
        return <rect key={i} x={i * bw + 1} y={h - bh} width={Math.max(1, bw - 2)} height={bh} rx={1.5} fill={color} opacity={i === values.length - 1 ? 1 : 0.5} />;
      })}
    </svg>
  );
}

function PlatformTile({ kind, total, share, series }: { kind: 'android' | 'ios'; total: number; share: number; series?: number[] }) {
  const s = periodsOf(series);
  const android = kind === 'android';
  const row = (name: string, value: string, pill?: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 48px', alignItems: 'center', columnGap: 4, fontSize: 11 }}>
      <span style={{ opacity: 0.8 }}>{name}</span>
      <b style={{ textAlign: 'right' }}>{value}</b>
      <span style={{ textAlign: 'right' }}>{pill}</span>
    </div>
  );
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 16, padding: 12, color: '#fff', background: android ? 'linear-gradient(150deg,#3DDC84,#0b9d57)' : 'linear-gradient(150deg,#3a3a3f,#0b0b0d)' }}>
      <div style={{ position: 'absolute', right: -14, top: -14, opacity: 0.14 }}><PlatformLogo kind={kind} size={92} color="#fff" /></div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 800, fontSize: 13 }}><PlatformLogo kind={kind} size={17} color="#fff" />{android ? 'Android' : 'iPhone'}</span>
        <span style={{ fontSize: 10.5, opacity: 0.85 }}>{share}%</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6, margin: '6px 0 8px' }}>
        <span style={{ fontSize: 28, fontWeight: 900, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{inNum(total)}</span>
        {series && <MiniBars values={series} color="#fff" w={56} h={22} />}
      </div>
      <div style={{ position: 'relative', display: 'grid', gap: 3 }}>
        {row('Today', signedNum(s.today))}
        {row('Yesterday', signedNum(s.yest), <ChangePill now={s.today} before={s.yest} onColour small />)}
        {row('This week', signedNum(s.week))}
        {row('Last week', signedNum(s.last), <ChangePill now={s.week} before={s.last} onColour small />)}
      </div>
    </div>
  );
}

export function UsersSplitCard({ users }: { users: UsersOverview }) {
  const p = users.platforms;
  const s = periodsOf(users.series);
  const other = (p?.web || 0) + (p?.unknown || 0);
  const share = (v: number) => (users.total > 0 ? Math.round((v / users.total) * 100) : 0);
  const seg = p ? ([[p.android.total, '#3DDC84'], [p.ios.total, '#111827'], [other, '#cbd5e1']] as const) : null;
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-4 shadow-sm">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Total Users</p>
          <p className="text-4xl font-black text-primary leading-none mt-1.5 tabular-nums">{inNum(users.total)}</p>
        </div>
        {users.series && <MiniBars values={users.series} color="#0f4761" w={104} h={32} />}
      </div>
      {seg && (
        <div className="flex h-2.5 rounded-full overflow-hidden bg-surface mt-3" title="Android, iPhone, web / not recorded">
          {seg.map(([v, c], i) => <div key={i} style={{ width: `${(v / Math.max(1, users.total)) * 100}%`, background: c, minWidth: v > 0 ? 4 : 0, marginRight: i < 2 ? 2 : 0 }} />)}
        </div>
      )}
      {users.series && (
        <div className="mt-2.5 space-y-1.5 text-[11.5px] text-text-muted">
          <div className="flex items-center justify-between gap-2"><span>Today <b className="text-on-surface">{signedNum(s.today)}</b> · Yesterday <b className="text-on-surface">{signedNum(s.yest)}</b></span><ChangePill now={s.today} before={s.yest} /></div>
          <div className="flex items-center justify-between gap-2"><span>This week <b className="text-on-surface">{signedNum(s.week)}</b> · Last week <b className="text-on-surface">{signedNum(s.last)}</b></span><ChangePill now={s.week} before={s.last} /></div>
        </div>
      )}
      {p && (
        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <PlatformTile kind="android" total={p.android.total} share={share(p.android.total)} series={p.android.trend} />
          <PlatformTile kind="ios" total={p.ios.total} share={share(p.ios.total)} series={p.ios.trend} />
        </div>
      )}
      {p && other > 0 && (
        <p className="mt-2.5 text-[10px] text-text-muted" title="Everyone not in the Android or iPhone tile. Platform is saved the next time a person opens the updated app.">
          Web {inNum(p.web)} · not recorded yet {inNum(p.unknown)} · fills in as people open the app
        </p>
      )}
    </div>
  );
}

// ---- Cost trend: the cost of each finished day (or week) as bars. Finished days are kept on the phone and never fetched again; once an Indian day
// ends, only the days from two before the newest saved one are asked for (the latest days can still be adjusted by billing), and merged in.
type CostDay = { date: string; net: number };
const TREND_KEY = 'fl_admin_cost_trend';
const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const shiftDay = (d: string, by: number) => new Date(Date.parse(`${d}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (d: string) => shiftDay(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

function readTrendCache(): CostDay[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TREND_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.date === 'string' && typeof x.net === 'number') : [];
  } catch { return []; }
}

function useCostTrend(enabled: boolean) {
  const [days, setDays] = useRememberedState<CostDay[]>('adminTiles:costTrend', readTrendCache());
  const [loading, setLoading] = React.useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = () => {
      const have = readTrendCache();
      const last = have.length ? have[have.length - 1].date : null;
      const yesterday = istDay(Date.now() - 86_400_000);
      if (last && last >= yesterday) return; // everything up to yesterday is already on the phone
      setLoading(true);
      adminGet(`/api/admin/cloud-cost/trend${last ? `?since=${shiftDay(last, -2)}` : ''}`)
        .then((r) => {
          if (cancelled || !Array.isArray(r?.days)) return;
          const byDate = new Map(have.map((d) => [d.date, d.net]));
          r.days.forEach((d: CostDay) => byDate.set(d.date, d.net));
          const merged = Array.from(byDate, ([date, net]) => ({ date, net })).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-400);
          try { localStorage.setItem(TREND_KEY, JSON.stringify(merged)); } catch { /* storage may be blocked: the chart still shows */ }
          setDays(merged);
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    refresh();
    // the app can stay open past midnight: check again when it comes back to the front
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); };
    // the setter is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { days, loading };
}

function CostTrend({ currency }: { currency?: string }) {
  const [mode, setMode] = React.useState<'daily' | 'weekly'>('daily');
  const [picked, setPicked] = React.useState<number | null>(null);
  const { days, loading } = useCostTrend(true);

  // a bar for every day (a day with no cost is a zero bar), or for every week from Monday
  const bars = React.useMemo(() => {
    if (days.length === 0) return [] as { label: string; short: string; net: number }[];
    const byDate = new Map(days.map((d) => [d.date, d.net]));
    const last = days[days.length - 1].date;
    const out: { label: string; short: string; net: number }[] = [];
    if (mode === 'daily') {
      for (let i = 29; i >= 0; i--) {
        const d = shiftDay(last, -i);
        out.push({ label: new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), short: d.slice(8), net: byDate.get(d) || 0 });
      }
    } else {
      const weeks = new Map<string, number>();
      for (let i = 0; i < 84; i++) { const d = shiftDay(last, -i); weeks.set(mondayOf(d), (weeks.get(mondayOf(d)) || 0) + (byDate.get(d) || 0)); }
      Array.from(weeks.keys()).sort().slice(-12).forEach((m) => {
        out.push({ label: `Week of ${new Date(`${m}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}${m === mondayOf(last) ? ' (so far)' : ''}`, short: m.slice(8), net: weeks.get(m) || 0 });
      });
    }
    return out;
  }, [days, mode]);

  if (days.length === 0) return <p className="text-[11px] text-text-muted">{loading ? 'Loading the cost trend…' : 'No daily costs recorded yet.'}</p>;
  const w = 300, h = 96, pad = 4;
  const max = Math.max(...bars.map((b) => b.net), 0.01);
  const avg = bars.reduce((s, b) => s + b.net, 0) / Math.max(1, bars.length);
  const sel = picked ?? bars.length - 1;
  const slot = (w - pad * 2) / bars.length;
  const y = (v: number) => h - 14 - (v / max) * (h - 26);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-text-muted min-w-0 truncate"><b className="text-primary">{bars[sel]?.label}</b> · <b className="text-primary">{formatMoney(bars[sel]?.net || 0, currency)}</b></p>
        <div className="shrink-0 flex rounded-lg bg-surface p-0.5 text-[11px] font-black">
          {(['daily', 'weekly'] as const).map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setPicked(null); }} className={clsx('px-2.5 py-1 rounded-md', mode === m ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}>{m === 'daily' ? 'Daily' : 'Weekly'}</button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24" role="img" aria-label={`${mode} cloud cost`}>
        {[0, 0.5, 1].map((f) => <line key={f} x1={pad} x2={w - pad} y1={y(max * f)} y2={y(max * f)} stroke="#e2e8f0" strokeWidth="0.6" />)}
        <line x1={pad} x2={w - pad} y1={y(avg)} y2={y(avg)} stroke="#f59e0b" strokeWidth="0.8" strokeDasharray="3 2" />
        {bars.map((b, i) => (
          <g key={i} onClick={() => setPicked(i)} className="cursor-pointer">
            <rect x={pad + i * slot} y={0} width={slot} height={h} fill="transparent" />
            <rect x={pad + i * slot + slot * 0.15} y={y(b.net)} width={slot * 0.7} height={Math.max(1, h - 14 - y(b.net))} rx={1.5} fill={i === sel ? '#0f4761' : '#7fb3c8'} />
          </g>
        ))}
        <text x={pad} y={h - 2} fontSize="7" fill="#64748b">{bars[0]?.short}</text>
        <text x={w - pad} y={h - 2} fontSize="7" fill="#64748b" textAnchor="end">{bars[bars.length - 1]?.short}</text>
        <text x={w - pad} y={y(avg) - 2} fontSize="6.5" fill="#b45309" textAnchor="end">avg {formatMoney(avg, currency)}</text>
      </svg>
      <p className="text-[10px] text-text-muted">Finished days only, up to yesterday. Tap a bar for its figure. New days are added after midnight (Indian time).</p>
    </div>
  );
}

// Real spend, read from the BigQuery Billing Export dataset (see server.ts's /api/admin/cloud-cost). `tableReady`/`hasData` gate a "still setting up" state
// instead of showing a blank or fake number; the Billing Console link stays as a fallback for the full itemized report.
export function CloudCostCard({ cloudCost }: { cloudCost: CloudCost | null }) {
  return (
          <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined">payments</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-bold text-primary">Cloud Costs</h3>
                  {cloudCost?.tableReady && cloudCost.hasData ? (
                    <p className="text-sm text-text-muted">
                      Since {cloudCost.earliest ? fmtDate(cloudCost.earliest) : 'export started'}
                    </p>
                  ) : (
                    <p className="text-sm text-text-muted">
                      {cloudCost === null ? 'Loading…' : cloudCost.tableReady === false ? 'Billing export is still being set up by Google — usually ready within 1-2 days.' : 'No cost data recorded yet.'}
                    </p>
                  )}
                </div>
                <a
                  href="https://console.cloud.google.com/billing/01D335-F8A67C-2D5527/reports?project=familyledgerta"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-text-muted hover:text-primary"
                  title="Open full billing report"
                >
                  <span className="material-symbols-outlined">open_in_new</span>
                </a>
              </div>
              {cloudCost?.tableReady && cloudCost.hasData && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">This Month</p>
                    <p className="text-xl font-black text-primary">{formatMoney(cloudCost.thisMonth || 0, cloudCost.currency)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Last Month</p>
                    <p className="text-xl font-black text-primary">{formatMoney(cloudCost.lastMonth || 0, cloudCost.currency)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Last 7 Days</p>
                    <p className="text-xl font-black text-primary">{formatMoney(cloudCost.last7Days || 0, cloudCost.currency)}</p>
                  </div>
                </div>
              )}
              {cloudCost?.tableReady && cloudCost.hasData && <CostTrend currency={cloudCost.currency} />}
            </div>
  );
}

// What the admin sees on their own Profile page: the cloud cost card and the total users tile. The last figures are kept, so they are there at once on return.
export function AdminProfileTiles() {
  const [cloudCost, setCloudCost] = useRememberedState<CloudCost | null>('adminTiles:cost', null);
  const [users, setUsers] = useRememberedState<UsersOverview | null>('adminTiles:users2', null);
  useEffect(() => {
    let cancelled = false;
    adminGet('/api/admin/cloud-cost').then((c) => { if (!cancelled) setCloudCost(c); }).catch(() => {});
    adminGet('/api/admin/overview').then((o) => { if (!cancelled) setUsers({ total: o.totalUsers, series: o.trend?.users, platforms: o.platforms }); }).catch(() => {});
    return () => { cancelled = true; };
    // the setters are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-4">
      <CloudCostCard cloudCost={cloudCost} />
      {users && <UsersSplitCard users={users} />}
    </div>
  );
}
