import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { adminGet } from '../../lib/adminApi';

interface TopEntry { groupId?: string; uid?: string; name: string; totalSpend: number; entryCount: number }
interface TrendPoint { day: string; logins: number; activeUsers: number }
interface InactiveUser { uid: string; email: string; displayName: string; daysInactive: number }
interface GameStats {
  key: string;
  label: string;
  totalGames: number;
  finishedGames: number;
  inProgressGames: number;
  uniquePlayers: number;
  totalHours: number;
}
interface GameStatsSummary { totalGames: number; totalUniquePlayers: number; totalHours: number }


// ---- Product analytics (goals, accounts, health tools, splits) — see /api/admin/analytics/product ----
interface Metric {
  total: number;
  uniqueUsers: number | null;
  today: number;
  yesterday: number;
  last7: number;
  prev7: number;
  daily: { date: string; value: number }[];
  weekly: { label: string; value: number }[];
}
interface ProductStats {
  generatedAt: string;
  goalsAccounts: {
    goals: { created: Metric; completed: Metric; active: number; shared: number };
    accounts: { created: Metric; archived: number; byType: { type: string; count: number }[] };
  };
  health: {
    bp: Metric;
    glucose: Metric;
    medicines: Metric & { active: number; remindersOn: number };
    medicineLogs: Metric & { byStatus: { status: string; count: number }[] };
    incidents: Metric;
    babies: Metric;
    vaccinesGiven: Metric & { totalDoses: number };
    delegations: Metric & { accepted: number; pending: number };
  };
  splits: {
    expenses: Metric;
    amount: Metric;
    enabledGroups: number;
    activeGroups30: number;
    participantsAll: number;
    participants30: number;
    avgParticipants: number;
  };
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

// Change vs the previous period, as a small coloured badge.
function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0 && cur === 0) return <span className="text-[10px] font-bold text-text-muted">no change</span>;
  if (prev === 0) return <span className="text-[10px] font-bold text-success">new</span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  return (
    <span className={`text-[10px] font-bold ${pct > 0 ? 'text-success' : pct < 0 ? 'text-error' : 'text-text-muted'}`}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '•'} {Math.abs(pct)}%
    </span>
  );
}

const StatTile: React.FC<{ label: string; value: string; sub?: React.ReactNode }> = ({ label, value, sub }) => {
  return (
    <div className="bg-surface rounded-xl p-3">
      <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-black text-primary mt-0.5">{value}</p>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
};

// A metric's headline numbers (total, today, 7 days vs the 7 before) plus a daily / weekly bar chart.
function TrendCard({ title, metric, color = '#0f4761', unit = '', note, extra }: {
  title: string; metric: Metric; color?: string; unit?: string; note?: string; extra?: React.ReactNode;
}) {
  const [view, setView] = useState<'daily' | 'weekly'>('daily');
  const data = view === 'daily' ? metric.daily.map((d) => ({ x: d.date.slice(5), value: d.value })) : metric.weekly.map((w) => ({ x: w.label, value: w.value }));
  return (
    <section className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-primary">{title}</h3>
          {note && <p className="text-[11px] text-text-muted">{note}</p>}
        </div>
        <div className="flex bg-surface rounded-lg p-0.5 shrink-0">
          {(['daily', 'weekly'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${view === v ? 'bg-white text-primary shadow-sm' : 'text-text-muted'}`}
            >
              {v === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Total" value={`${fmt(metric.total)}${unit}`} sub={metric.uniqueUsers != null ? `${fmt(metric.uniqueUsers)} users` : undefined} />
        <StatTile label="Today" value={`${fmt(metric.today)}${unit}`} sub={<>yesterday {fmt(metric.yesterday)} <Delta cur={metric.today} prev={metric.yesterday} /></>} />
        <StatTile label="Last 7 days" value={`${fmt(metric.last7)}${unit}`} sub={<>prev 7: {fmt(metric.prev7)} <Delta cur={metric.last7} prev={metric.prev7} /></>} />
        <StatTile label={view === 'daily' ? '30-day total' : '12-week total'} value={`${fmt((view === 'daily' ? metric.daily : metric.weekly).reduce((s, d: any) => s + d.value, 0))}${unit}`} />
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis dataKey="x" fontSize={9} tick={{ fill: '#6B7280' }} interval={view === 'daily' ? 4 : 0} />
            <YAxis fontSize={9} tick={{ fill: '#6B7280' }} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} name={title} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {extra}
    </section>
  );
}

function Chips({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i.label} className="px-2.5 py-1 rounded-full bg-surface text-[11px] font-bold text-text-muted">
          {i.label}: <span className="text-primary">{fmt(i.value)}</span>
        </span>
      ))}
    </div>
  );
}

export default function AdminAnalytics() {
  const [tab, setTab] = useState<'summary' | 'goals' | 'health' | 'splits' | 'usage'>('summary');
  const [product, setProduct] = useState<ProductStats | null>(null);
  const [productLoading, setProductLoading] = useState(true);
  const [topGroups, setTopGroups] = useState<TopEntry[]>([]);
  const [topUsers, setTopUsers] = useState<TopEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [inactive, setInactive] = useState<InactiveUser[]>([]);
  const [gameStats, setGameStats] = useState<GameStats[]>([]);
  const [gameStatsSummary, setGameStatsSummary] = useState<GameStatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProduct = (refresh = false) => {
    setProductLoading(true);
    adminGet(`/api/admin/analytics/product${refresh ? '?refresh=1' : ''}`)
      .then((data) => setProduct(data))
      .catch((err) => setError(err.message))
      .finally(() => setProductLoading(false));
  };

  useEffect(() => {
    loadProduct();
    Promise.all([
      adminGet('/api/admin/analytics/top'),
      adminGet('/api/admin/analytics/usage-trend?days=30'),
      adminGet('/api/admin/analytics/inactive'),
      adminGet('/api/admin/analytics/games'),
    ])
      .then(([top, usage, inactiveData, games]) => {
        setTopGroups(top.topGroups);
        setTopUsers(top.topUsers);
        setTrend(usage.trend);
        setInactive(inactiveData.users);
        setGameStats(games.games);
        setGameStatsSummary(games.summary);
      })
      .catch((err) => setError(err.message));
  }, []);

  const agingBuckets = [
    { label: '0-2 days', min: 0, max: 2 },
    { label: '3-5 days', min: 3, max: 5 },
    { label: '6-14 days', min: 6, max: 14 },
    { label: '15-30 days', min: 15, max: 30 },
    { label: '30+ days', min: 31, max: Infinity },
  ].map((bucket) => ({
    ...bucket,
    count: inactive.filter((u) => u.daysInactive >= bucket.min && u.daysInactive <= bucket.max).length,
  }));

  const TABS = [
    ['summary', 'Summary'],
    ['goals', 'Goals & Accounts'],
    ['health', 'Health'],
    ['splits', 'Splits'],
    ['usage', 'Usage & Games'],
  ] as const;

  // Summary: one row per product area — total, today, this week vs last week.
  const summaryRows = product
    ? [
        { group: 'Goals & Accounts', label: 'Goals created', m: product.goalsAccounts.goals.created },
        { group: 'Goals & Accounts', label: 'Goals completed', m: product.goalsAccounts.goals.completed },
        { group: 'Goals & Accounts', label: 'Accounts added', m: product.goalsAccounts.accounts.created },
        { group: 'Health', label: 'BP readings', m: product.health.bp },
        { group: 'Health', label: 'Glucose readings', m: product.health.glucose },
        { group: 'Health', label: 'Medicines added', m: product.health.medicines },
        { group: 'Health', label: 'Dose logs', m: product.health.medicineLogs },
        { group: 'Health', label: 'Medical incidents', m: product.health.incidents },
        { group: 'Health', label: 'Baby profiles', m: product.health.babies },
        { group: 'Health', label: 'Vaccines given', m: product.health.vaccinesGiven },
        { group: 'Health', label: 'Health sharing invites', m: product.health.delegations },
        { group: 'Splits', label: 'Split expenses', m: product.splits.expenses },
        { group: 'Splits', label: 'Amount split', m: product.splits.amount },
      ]
    : [];

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black text-primary">Analytics</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

      <div className="flex gap-1 overflow-x-auto bg-white rounded-2xl border border-border-subtle p-1">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap ${tab === key ? 'bg-primary text-white' : 'text-text-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== 'usage' && (
        <div className="flex items-center justify-between text-[11px] text-text-muted">
          <span>{product ? `Updated ${new Date(product.generatedAt).toLocaleTimeString()} · days are UTC, a "week" is a rolling 7 days` : ''}</span>
          <button onClick={() => loadProduct(true)} disabled={productLoading} className="font-bold text-primary underline disabled:opacity-50">
            {productLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      )}
      {tab !== 'usage' && productLoading && !product && <p className="text-center text-text-muted py-10">Loading…</p>}

      {/* ---------------- Summary ---------------- */}
      {tab === 'summary' && product && (
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary mb-1">This week vs last week</h2>
            <p className="text-xs text-text-muted mb-3">Last 7 days against the 7 before, for everything below.</p>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summaryRows.map((r) => ({ name: r.label, 'Last 7 days': r.m.last7, 'Previous 7': r.m.prev7 }))} margin={{ top: 6, right: 6, left: -10, bottom: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis dataKey="name" fontSize={9} tick={{ fill: '#6B7280' }} interval={0} angle={-35} textAnchor="end" />
                  <YAxis fontSize={9} tick={{ fill: '#6B7280' }} allowDecimals={false} />
                  <Tooltip />
                  <Legend verticalAlign="top" height={24} />
                  <Bar dataKey="Previous 7" fill="#CBD5E1" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Last 7 days" fill="#0f4761" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {(['Goals & Accounts', 'Health', 'Splits'] as const).map((group) => (
            <section key={group} className="bg-white rounded-2xl border border-border-subtle p-5">
              <h2 className="text-lg font-bold text-primary mb-3">{group}</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {summaryRows.filter((r) => r.group === group).map((r) => (
                  <StatTile
                    key={r.label}
                    label={r.label}
                    value={fmt(r.m.total)}
                    sub={
                      <>
                        today {fmt(r.m.today)} · 7d {fmt(r.m.last7)} <Delta cur={r.m.last7} prev={r.m.prev7} />
                      </>
                    }
                  />
                ))}
              </div>
            </section>
          ))}

          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary mb-3">Splits at a glance</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile label="Groups with splits on" value={fmt(product.splits.enabledGroups)} />
              <StatTile label="Active split groups (30d)" value={fmt(product.splits.activeGroups30)} />
              <StatTile label="Split users" value={fmt(product.splits.participantsAll)} sub={`${fmt(product.splits.participants30)} active in 30d`} />
              <StatTile label="Total split" value={fmt(product.splits.amount.total)} sub="face value, mixed currencies" />
            </div>
          </section>
        </div>
      )}

      {/* ---------------- Goals & Accounts ---------------- */}
      {tab === 'goals' && product && (
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary mb-3">Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile label="Goals" value={fmt(product.goalsAccounts.goals.created.total)} sub={`${fmt(product.goalsAccounts.goals.created.uniqueUsers || 0)} users`} />
              <StatTile label="Active goals" value={fmt(product.goalsAccounts.goals.active)} sub={`${fmt(product.goalsAccounts.goals.shared)} shared`} />
              <StatTile label="Accounts" value={fmt(product.goalsAccounts.accounts.created.total)} sub={`${fmt(product.goalsAccounts.accounts.created.uniqueUsers || 0)} users`} />
              <StatTile label="Archived accounts" value={fmt(product.goalsAccounts.accounts.archived)} />
            </div>
          </section>
          <TrendCard title="Goals created" metric={product.goalsAccounts.goals.created} />
          <TrendCard title="Goals completed" metric={product.goalsAccounts.goals.completed} color="#16A34A" />
          <TrendCard
            title="Accounts added"
            metric={product.goalsAccounts.accounts.created}
            color="#7C3AED"
            extra={<Chips items={product.goalsAccounts.accounts.byType.map((t) => ({ label: t.type.replace('_', ' '), value: t.count }))} />}
          />
        </div>
      )}

      {/* ---------------- Health ---------------- */}
      {tab === 'health' && product && (
        <div className="space-y-6">
          <TrendCard title="Blood pressure readings" metric={product.health.bp} color="#DC2626" />
          <TrendCard title="Glucose readings" metric={product.health.glucose} color="#F59E0B" />
          <TrendCard
            title="Medicines added"
            metric={product.health.medicines}
            color="#0f4761"
            extra={<Chips items={[{ label: 'Active', value: product.health.medicines.active }, { label: 'With reminders on', value: product.health.medicines.remindersOn }]} />}
          />
          <TrendCard
            title="Medicine dose logs"
            metric={product.health.medicineLogs}
            color="#16A34A"
            extra={<Chips items={product.health.medicineLogs.byStatus.map((s) => ({ label: s.status, value: s.count }))} />}
          />
          <TrendCard title="Medical incidents" metric={product.health.incidents} color="#7C3AED" />
          <TrendCard title="Baby profiles" metric={product.health.babies} color="#EC4899" />
          <TrendCard
            title="Vaccines given"
            metric={product.health.vaccinesGiven}
            color="#0891B2"
            note="By the date the dose was marked given."
            extra={<Chips items={[{ label: 'Doses scheduled', value: product.health.vaccinesGiven.totalDoses }]} />}
          />
          <TrendCard
            title="Health sharing invites"
            metric={product.health.delegations}
            color="#64748B"
            note="Delegate and caregiver invites sent."
            extra={<Chips items={[{ label: 'Accepted', value: product.health.delegations.accepted }, { label: 'Pending', value: product.health.delegations.pending }]} />}
          />
        </div>
      )}

      {/* ---------------- Splits ---------------- */}
      {tab === 'splits' && product && (
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary mb-3">Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatTile label="Groups with splits on" value={fmt(product.splits.enabledGroups)} />
              <StatTile label="Active split groups (30d)" value={fmt(product.splits.activeGroups30)} sub="had a split expense in the last 30 days" />
              <StatTile label="Split users (all time)" value={fmt(product.splits.participantsAll)} sub="paid or shared in a split" />
              <StatTile label="Split users (30d)" value={fmt(product.splits.participants30)} />
              <StatTile label="Avg people per split" value={String(product.splits.avgParticipants)} />
              <StatTile label="Total expense split" value={fmt(product.splits.amount.total)} sub="face value, mixed currencies" />
            </div>
          </section>
          <TrendCard title="Split expenses" metric={product.splits.expenses} note="Number of expenses divided between people." />
          <TrendCard title="Amount split" metric={product.splits.amount} color="#16A34A" note="Sum of split expenses' amounts (face value — currencies aren't converted)." />
        </div>
      )}

      {/* ---------------- Usage & Games (the original analytics) ---------------- */}
      {tab === 'usage' && (
        <div className="space-y-8">
      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-4">Usage Trend (last 30 days)</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="day" fontSize={10} tick={{ fill: '#6B7280' }} />
              <YAxis fontSize={10} tick={{ fill: '#6B7280' }} />
              <Tooltip />
              <Line type="monotone" dataKey="logins" stroke="#0f4761" strokeWidth={2} dot={false} name="Logins" />
              <Line type="monotone" dataKey="activeUsers" stroke="#16A34A" strokeWidth={2} dot={false} name="Active Users" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="bg-white rounded-2xl border border-border-subtle p-5">
          <h2 className="text-lg font-bold text-primary mb-4">Top Groups by Spend</h2>
          <div className="space-y-2">
            {topGroups.map((g) => (
              <div key={g.groupId} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
                <span className="truncate">{g.name}</span>
                <span className="font-bold shrink-0 ml-2">{g.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({g.entryCount})</span>
              </div>
            ))}
            {topGroups.length === 0 && <p className="text-sm text-text-muted">No data yet.</p>}
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-border-subtle p-5">
          <h2 className="text-lg font-bold text-primary mb-4">Top Individuals by Spend</h2>
          <div className="space-y-2">
            {topUsers.map((u) => (
              <div key={u.uid} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
                <span className="truncate">{u.name}</span>
                <span className="font-bold shrink-0 ml-2">{u.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({u.entryCount})</span>
              </div>
            ))}
            {topUsers.length === 0 && <p className="text-sm text-text-muted">No data yet.</p>}
          </div>
        </section>
      </div>

      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-4">Inactive User Aging</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={agingBuckets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="label" fontSize={10} tick={{ fill: '#6B7280' }} />
              <YAxis fontSize={10} tick={{ fill: '#6B7280' }} />
              <Tooltip />
              <Bar dataKey="count" fill="#0f4761" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 max-h-64 overflow-y-auto space-y-1">
          {inactive.slice(0, 30).map((u) => (
            <div key={u.uid} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
              <span>{u.displayName || u.email}</span>
              <span className="text-text-muted">{u.daysInactive} days inactive</span>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-1">Game Stats</h2>
        <p className="text-xs text-text-muted mb-4">
          "Hours" only counts finished games (time from creation to finish) — an abandoned or still-open game has no real end time to measure.
        </p>
        {gameStatsSummary && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Games Played</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalGames}</p>
            </div>
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Unique Players</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalUniquePlayers}</p>
            </div>
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Hours Played</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalHours.toLocaleString()}</p>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-text-muted border-b border-border-subtle">
                <th className="p-2">Game</th>
                <th className="p-2">Total</th>
                <th className="p-2">Finished</th>
                <th className="p-2">In Progress</th>
                <th className="p-2">Unique Players</th>
                <th className="p-2">Hours Played</th>
              </tr>
            </thead>
            <tbody>
              {gameStats.map((g) => (
                <tr key={g.key} className="border-b border-border-subtle last:border-0">
                  <td className="p-2 font-bold text-primary">{g.label}</td>
                  <td className="p-2">{g.totalGames}</td>
                  <td className="p-2">{g.finishedGames}</td>
                  <td className="p-2">{g.inProgressGames}</td>
                  <td className="p-2">{g.uniquePlayers}</td>
                  <td className="p-2 font-bold">{g.totalHours.toLocaleString()}</td>
                </tr>
              ))}
              {gameStats.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-text-muted text-center">No games played yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
        </div>
      )}
    </div>
  );
}
