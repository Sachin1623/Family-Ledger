import React, { useEffect } from 'react';
import clsx from 'clsx';
import { fmtDate } from '../../lib/adminTime';
import { adminGet } from '../../lib/adminApi';
import { useRememberedState } from '../../lib/liveCache';

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
  return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
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
  const f = format || ((n: number) => n.toLocaleString());
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
            </div>
  );
}

// What the admin sees on their own Profile page: the cloud cost card and the total users tile. The last figures are kept, so they are there at once on return.
export function AdminProfileTiles() {
  const [cloudCost, setCloudCost] = useRememberedState<CloudCost | null>('adminTiles:cost', null);
  const [users, setUsers] = useRememberedState<{ total: number; series?: number[] } | null>('adminTiles:users', null);
  useEffect(() => {
    let cancelled = false;
    adminGet('/api/admin/cloud-cost').then((c) => { if (!cancelled) setCloudCost(c); }).catch(() => {});
    adminGet('/api/admin/overview').then((o) => { if (!cancelled) setUsers({ total: o.totalUsers, series: o.trend?.users }); }).catch(() => {});
    return () => { cancelled = true; };
    // the setters are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-4">
      <CloudCostCard cloudCost={cloudCost} />
      {users && <StatCard label="Total Users" value={users.total} series={users.series} />}
    </div>
  );
}
