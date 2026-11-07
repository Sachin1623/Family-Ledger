import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { adminGet, adminPost } from '../../lib/adminApi';
import { fmtDateTime, fmtDate } from '../../lib/adminTime';

interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  country: string;
  joinedAt: string | null;
  lastActiveAt: string | null;
  groupCount: number;
  expenseCount: number;
  totalSpend: number;
  hasPassword: boolean;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
}

type SortKey = 'joinedAt' | 'lastActiveAt' | 'expenseCount' | 'groupCount' | 'totalSpend';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'joinedAt', label: 'Joined' },
  { key: 'lastActiveAt', label: 'Last Active' },
  { key: 'expenseCount', label: 'Expenses' },
  { key: 'groupCount', label: 'Groups' },
  { key: 'totalSpend', label: 'Total Spend' },
];

const PAGE_SIZE = 20;

// ── New sign-ups trend (daily / weekly) ─────────────────────────────────────────────────────────────────────────────────────────────
interface SignupDay { date: string; count: number }

function weekStart(dateStr: string): string {
  // Monday of that date's week (dates are IST calendar days, so plain UTC arithmetic on the date string is exact).
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

const shortDate = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function SignupTrend() {
  const [days, setDays] = useState<SignupDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily');
  const [range, setRange] = useState<14 | 30 | 90>(30);

  useEffect(() => {
    adminGet('/api/admin/users/signups?days=120')
      .then((d) => setDays(d.days || []))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-xs text-error">Could not load the sign-up trend: {error}</p>;
  if (!days) return <div className="h-48 rounded-2xl bg-white border border-border-subtle animate-pulse" />;

  const sum = (list: SignupDay[]) => list.reduce((n, d) => n + d.count, 0);
  const today = days[days.length - 1]?.count || 0;
  const last7 = sum(days.slice(-7));
  const prev7 = sum(days.slice(-14, -7));
  const monthPrefix = days[days.length - 1]?.date.slice(0, 7);
  const thisMonth = sum(days.filter((d) => d.date.startsWith(monthPrefix)));
  const delta = prev7 === 0 ? (last7 > 0 ? 100 : 0) : Math.round(((last7 - prev7) / prev7) * 100);

  let chartData: { label: string; count: number; full: string }[];
  if (mode === 'daily') {
    chartData = days.slice(-range).map((d) => ({ label: shortDate(d.date), count: d.count, full: d.date }));
  } else {
    const weeks = new Map<string, number>();
    days.forEach((d) => weeks.set(weekStart(d.date), (weeks.get(weekStart(d.date)) || 0) + d.count));
    chartData = Array.from(weeks.entries()).sort().slice(-13).map(([start, count]) => ({ label: shortDate(start), count, full: `Week of ${shortDate(start)}` }));
    // The first and last weeks of the window can be partial; the current week is still in progress.
  }
  const avg = chartData.length ? Math.round((sum(chartData.map((c) => ({ date: '', count: c.count }))) / chartData.length) * 10) / 10 : 0;

  return (
    <section className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold text-primary">New users</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border-subtle overflow-hidden text-xs font-bold">
            {(['daily', 'weekly'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`px-3 py-1.5 ${mode === m ? 'bg-primary text-white' : 'bg-white text-text-muted'}`}>
                {m === 'daily' ? 'Days' : 'Weeks'}
              </button>
            ))}
          </div>
          {mode === 'daily' && (
            <select value={range} onChange={(e) => setRange(Number(e.target.value) as 14 | 30 | 90)} className="rounded-xl border border-border-subtle px-2 py-1.5 text-xs font-bold text-primary bg-white">
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          { label: 'Today', value: today, sub: 'IST day' },
          { label: 'Last 7 days', value: last7, sub: `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs previous 7` },
          { label: 'This month', value: thisMonth, sub: monthPrefix },
          { label: `Avg per ${mode === 'daily' ? 'day' : 'week'}`, value: avg, sub: mode === 'daily' ? `last ${range} days` : 'last 13 weeks' },
        ].map((t) => (
          <div key={t.label} className="rounded-xl bg-surface p-3">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t.label}</p>
            <p className="text-2xl font-black text-primary">{t.value}</p>
            <p className="text-[10px] text-text-muted">{t.sub}</p>
          </div>
        ))}
      </div>

      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={mode === 'daily' ? Math.max(0, Math.ceil(chartData.length / 7) - 1) : 0} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
            <Tooltip
              formatter={(v: number) => [v, 'New users']}
              labelFormatter={(_l, p) => (p && p[0] ? (p[0].payload as any).full : '')}
              cursor={{ fill: 'rgba(15,118,110,0.08)' }}
            />
            <Bar dataKey="count" fill="#0f766e" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-text-muted">Days are Indian (IST) calendar days. {mode === 'weekly' ? 'Weeks start on Monday; the latest week is still in progress.' : ''}</p>
    </section>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [wipeEmail, setWipeEmail] = useState<string | null>(null);
  const [wipeConfirmText, setWipeConfirmText] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('joinedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [hasMore, setHasMore] = useState(false);

  // `append: true` is used by "Load next 20" to grow the list instead of replacing it; a fresh
  // search, sort change, or initial load always starts a new page-0 list. Sorting is done
  // server-side (see /api/admin/users) — it has to rank the FULL matched set before paging, since
  // client-side re-sorting can only ever reorder whatever page happens to already be loaded.
  const load = (searchTerm = '', offset = 0, append = false, key: SortKey = sortKey, dir: 'asc' | 'desc' = sortDir) => {
    (append ? setLoadingMore : setLoading)(true);
    adminGet(
      `/api/admin/users?limit=${PAGE_SIZE}&offset=${offset}&sortKey=${key}&sortDir=${dir}${searchTerm ? `&search=${encodeURIComponent(searchTerm)}` : ''}`,
    )
      .then((data) => {
        setUsers((prev) => (append ? [...prev, ...data.users] : data.users));
        setHasMore(!!data.hasMore);
      })
      .catch((err) => setError(err.message))
      .finally(() => (append ? setLoadingMore(false) : setLoading(false)));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load(search, 0, false);
  };

  const handleLoadMore = () => {
    load(search, users.length, true);
  };

  const handleSortKeyChange = (key: SortKey) => {
    setSortKey(key);
    load(search, 0, false, key, sortDir);
  };

  const handleSortDirToggle = () => {
    const next = sortDir === 'asc' ? 'desc' : 'asc';
    setSortDir(next);
    load(search, 0, false, sortKey, next);
  };

  const handleResetPassword = async (email: string) => {
    const newPassword = window.prompt(`New password for ${email} (min 6 characters):`);
    if (!newPassword) return;
    setBusyUid(email);
    try {
      const result = await adminPost('/api/admin/users/reset-password', { email, newPassword });
      alert(result.message || 'Password reset.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyUid(null);
    }
  };

  const handleWipeConfirmed = async () => {
    if (!wipeEmail) return;
    setBusyUid(wipeEmail);
    try {
      await adminPost('/api/admin/wipe-by-email', { email: wipeEmail });
      setWipeEmail(null);
      setWipeConfirmText('');
      load(search);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black text-primary">Users</h1>
        <Link to="/admin?tab=users" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-xs text-text-muted -mt-4">
        To grant or revoke admin access, use <Link to="/admin/manage-admins" className="font-bold text-primary underline">Manage Admins</Link>.
      </p>

      <SignupTrend />

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="flex-1 rounded-2xl border border-border-subtle px-4 py-3 text-sm focus:border-primary focus:outline-none"
        />
        <button type="submit" className="px-6 py-3 bg-primary text-white rounded-2xl font-bold text-sm">Search</button>
      </form>

      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-text-muted uppercase tracking-wider">Sort by</span>
        <div className="relative">
          <select
            value={sortKey}
            onChange={(e) => handleSortKeyChange(e.target.value as SortKey)}
            className="bg-white border border-border-subtle rounded-xl pl-3 pr-8 py-2 text-xs font-bold text-primary appearance-none outline-none cursor-pointer"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>
          <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-[16px] pointer-events-none">expand_more</span>
        </div>
        <button
          type="button"
          onClick={handleSortDirToggle}
          className="p-2 bg-white border border-border-subtle rounded-xl text-primary"
          title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
        >
          <span className="material-symbols-outlined text-[18px]">
            {sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
          </span>
        </button>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
      {loading && <div className="text-center text-text-muted py-10">Loading users…</div>}

      <div className="bg-white rounded-2xl border border-border-subtle overflow-x-auto">
        <table className="w-full text-sm min-w-[1050px]">
          <thead>
            <tr className="text-left text-text-muted border-b border-border-subtle">
              <th className="p-3">User</th>
              <th className="p-3">Joined</th>
              <th className="p-3">Last Active</th>
              <th className="p-3">Groups</th>
              <th className="p-3">Expenses</th>
              <th className="p-3">Total Spend</th>
              <th className="p-3">Role</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.uid} className="border-b border-border-subtle last:border-0">
                <td className="p-3">
                  <Link to={`/admin/users/${u.uid}`} className="font-bold text-primary hover:underline">
                    {u.displayName || '(no name)'}
                  </Link>
                  <p className="text-xs text-text-muted">{u.email}</p>
                </td>
                <td className="p-3 text-xs text-text-muted">{u.joinedAt ? fmtDate(u.joinedAt) : '—'}</td>
                <td className="p-3 text-xs text-text-muted">{u.lastActiveAt ? fmtDateTime(u.lastActiveAt) : '—'}</td>
                <td className="p-3">{u.groupCount}</td>
                <td className="p-3">{u.expenseCount}</td>
                <td className="p-3 font-bold">{u.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                <td className="p-3">
                  {u.isPrimaryAdmin ? (
                    <span className="text-xs font-bold text-primary">Primary</span>
                  ) : u.isAdmin ? (
                    <span className="text-xs font-bold text-success">Secondary</span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    {u.hasPassword && (
                      <button
                        onClick={() => handleResetPassword(u.email)}
                        disabled={busyUid === u.email}
                        className="px-3 py-1.5 rounded-lg bg-surface-container text-xs font-bold text-primary disabled:opacity-50"
                      >
                        Reset PW
                      </button>
                    )}
                    {!u.isPrimaryAdmin && (
                      <button
                        onClick={() => setWipeEmail(u.email)}
                        className="px-3 py-1.5 rounded-lg bg-red-50 text-xs font-bold text-red-600"
                      >
                        Wipe
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && users.length === 0 && (
          <div className="text-center text-text-muted py-10">No users found.</div>
        )}
      </div>

      {!loading && hasMore && (
        <div className="flex justify-center">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="px-6 py-2.5 bg-white border border-border-subtle rounded-xl font-bold text-sm text-primary disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : `Load Next ${PAGE_SIZE}`}
          </button>
        </div>
      )}

      {wipeEmail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full space-y-4 max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-red-600">Wipe all data for {wipeEmail}?</h3>
            <p className="text-sm text-text-muted">
              This permanently deletes the account, profile, group memberships, owned groups (and
              their members/expenses), expenses, and activities for this email. This cannot be undone.
            </p>
            <p className="text-sm font-bold">Type the email address to confirm:</p>
            <input
              value={wipeConfirmText}
              onChange={(e) => setWipeConfirmText(e.target.value)}
              className="w-full rounded-xl border border-border-subtle px-4 py-2 text-sm"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setWipeEmail(null); setWipeConfirmText(''); }}
                className="px-4 py-2 rounded-xl text-sm font-bold text-text-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleWipeConfirmed}
                disabled={wipeConfirmText !== wipeEmail || busyUid === wipeEmail}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-red-600 text-white disabled:opacity-40"
              >
                Permanently Wipe
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
