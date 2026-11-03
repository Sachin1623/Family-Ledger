import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { adminGet } from '../../lib/adminApi';
import { useAuth } from '../../context/AuthContext';
import { fmtDate, getAdminTz, setAdminTzMode } from '../../lib/adminTime';

interface CountryStats {
  country: string;
  users: number;
  groups: number;
  expenses: number;
  totalSpend: number;
  activeToday: number;
}

interface Overview {
  totalUsers: number;
  totalGroups: number;
  totalExpenses: number;
  totalSpendAllTime: number;
  activeUsersToday: number;
  activeUsersThisWeek: number;
  newUsersToday: number;
  countryBreakdown: CountryStats[];
  changes?: {
    users: { today: number; week: number };
    groups: { today: number; week: number };
    expenses: { today: number; week: number };
    spend: { today: number; week: number };
    active: { today: number | null; week: number | null };
  };
}

interface CloudCost {
  tableReady: boolean;
  hasData?: boolean;
  currency?: string;
  thisMonth?: number;
  lastMonth?: number;
  last7Days?: number;
  earliest?: string;
}

interface Tile {
  to: string;
  icon: string;
  label: string;
  description: string;
}

// One small "+14" pill with what it is measured against. Green when up, red when down, grey when unchanged, a dash when there is nothing to compare with yet.
function Delta({ value, label, format }: { value: number | null | undefined; label: string; format?: (n: number) => string }) {
  const text = value == null ? '–' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${(format || ((n: number) => n.toLocaleString()))(Math.abs(value))}`;
  const tone = value == null || value === 0 ? 'bg-surface text-text-muted' : value > 0 ? 'bg-success/15 text-success' : 'bg-error/10 text-error';
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-black whitespace-nowrap', tone)}>
      {text} <span className="font-bold opacity-80">{label}</span>
    </span>
  );
}

function StatCard({ label, value, today, week, todayLabel = 'today', weekLabel = 'this week', format }: { label: string; value: string | number; today?: number | null; week?: number | null; todayLabel?: string; weekLabel?: string; format?: (n: number) => string }) {
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm">
      <p className="text-xs font-bold text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-3xl font-black text-primary mt-1">{value}</p>
      {(today !== undefined || week !== undefined) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {today !== undefined && <Delta value={today} label={todayLabel} format={format} />}
          {week !== undefined && <Delta value={week} label={weekLabel} format={format} />}
        </div>
      )}
    </div>
  );
}

function formatMoney(n: number, currency?: string) {
  return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
}

function TileGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {tiles.map((tile) => (
        <Link
          key={tile.to}
          to={tile.to}
          className="bg-white rounded-2xl border border-border-subtle p-6 shadow-sm hover:shadow-md transition-all flex flex-col gap-2"
        >
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <span className="material-symbols-outlined">{tile.icon}</span>
          </div>
          <h3 className="text-lg font-bold text-primary">{tile.label}</h3>
          <p className="text-sm text-text-muted">{tile.description}</p>
        </Link>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  const { admin } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [cloudCost, setCloudCost] = useState<CloudCost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'support' | 'announcements' | 'growth'>('overview');

  useEffect(() => {
    adminGet('/api/admin/overview')
      .then(setOverview)
      .catch((err) => setError(err.message));
    adminGet('/api/admin/cloud-cost')
      .then(setCloudCost)
      .catch(() => setCloudCost(null));
  }, []);

  const userTiles: Tile[] = [
    { to: '/admin/users', icon: 'group', label: 'Users', description: 'Browse, edit, reset passwords, wipe data' },
  ];
  if (admin.isSuperAdmin) {
    userTiles.push({ to: '/admin/manage-admins', icon: 'admin_panel_settings', label: 'Manage Admins', description: 'Grant or revoke secondary admin access' });
  }

  const supportTiles: Tile[] = [
    { to: '/admin/feedback', icon: 'forum', label: 'Feedback & Support', description: 'Suggestions, feedback & bug reports from users' },
    { to: '/admin/chat-reports', icon: 'report', label: 'Game Chat Reports', description: 'Reported messages from Ludo/Rummy/Business/Sweep chat' },
    { to: '/admin/vaccine-mapping', icon: 'vaccines', label: 'Vaccine Mapping', description: 'Map each shot to the vaccines it covers, find unmapped shots, check with AI' },
    { to: '/admin/shopkeeper-requests', icon: 'storefront', label: 'Shopkeeper Requests', description: 'Review and approve requests to enable Shopkeeper mode' },
  ];

  const announcementTiles: Tile[] = [
    { to: '/admin/app-version', icon: 'system_update', label: 'App Version', description: 'Set release notes and force-update prompt' },
    { to: '/admin/builds', icon: 'android', label: 'App Builds', description: 'Download test APKs and release bundles (admins only)' },
    { to: '/admin/broadcast', icon: 'campaign', label: 'Broadcast Message', description: 'Send a push + in-app announcement to every user' },
  ];

  const growthTiles: Tile[] = [
    { to: '/admin/growth', icon: 'trending_up', label: 'Invites & Spread the Word', description: 'This week vs last week, by channel — is anyone actually using these?' },
  ];

  const TABS = [
    ['overview', 'Overview'],
    ['users', 'Users'],
    ['support', 'Support'],
    ['announcements', 'Announcements'],
    ['growth', 'Growth'],
  ] as const;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 pb-24 md:pb-24">
      <div>
        <h1 className="text-3xl font-black text-primary">Admin Panel</h1>
        <p className="text-sm text-text-muted font-medium">
          Signed in as {admin.isSuperAdmin ? 'primary admin' : admin.isPrimaryAdmin ? 'primary admin' : 'secondary admin'}
        </p>
        <p className="text-xs text-text-muted mt-1">
          Times shown in {getAdminTz() ? 'Indian time (IST)' : 'your device time'} ·{' '}
          <button type="button" className="font-bold text-primary underline" onClick={() => { setAdminTzMode(getAdminTz() ? 'device' : 'ist'); window.location.reload(); }}>
            {getAdminTz() ? 'Use my device time' : 'Back to IST'}
          </button>
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>
      )}

      {/* Tab bar — was one long page (cloud cost, stats, country table, then every tool as a
          flat grid of tiles) that kept growing as more admin tools got added. Grouped into
          categories so a visit only shows what's relevant, same pattern as ManageGroup.tsx's
          tab bar. Each tile still links out to its own dedicated page — only the DASHBOARD's
          own layout changed, not the 9 tool pages themselves. */}
      <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1 sticky top-[calc(0.5rem+env(safe-area-inset-top))] z-10">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={clsx(
              'flex-1 py-2 rounded-lg text-xs font-bold transition-all',
              activeTab === key ? 'bg-primary text-white' : 'text-text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <Link to="/admin/metrics" className="flex items-center gap-3 rounded-2xl px-4 py-3 text-white" style={{ background: 'linear-gradient(135deg,#0d3b4e,#1E3A8A)' }}>
            <span className="material-symbols-outlined">monitor_heart</span>
            <span className="flex-1"><span className="block font-black">App health dashboard</span><span className="block text-[11px] opacity-80">Growth, retention, server health, cost and product use — with alerts</span></span>
            <span className="material-symbols-outlined">chevron_right</span>
          </Link>
          {/* Real spend, read from the BigQuery Billing Export dataset (enabled manually in the
              Billing Console — see server.ts's /api/admin/cloud-cost). The export table itself takes
              ~24-48h to appear after being turned on, and data only accumulates from that point
              forward (no backfill), so `tableReady`/`hasData` gate a "still setting up" state instead
              of showing a blank or fake number. The Billing Console link stays as a fallback for the
              full itemized report this summary doesn't replace. */}
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

          {overview && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Total Users" value={overview.totalUsers} today={overview.changes?.users.today} week={overview.changes?.users.week} />
              <StatCard label="Total Groups" value={overview.totalGroups} today={overview.changes?.groups.today} week={overview.changes?.groups.week} />
              <StatCard label="Total Expenses" value={overview.totalExpenses} today={overview.changes?.expenses.today} week={overview.changes?.expenses.week} />
              <StatCard label="Lifetime Spend Logged" value={overview.totalSpendAllTime.toLocaleString(undefined, { maximumFractionDigits: 0 })} today={overview.changes?.spend.today} week={overview.changes?.spend.week} format={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
              <StatCard label="Active Today" value={overview.activeUsersToday} today={overview.changes?.active.today} todayLabel="vs yesterday" />
              <StatCard label="Active This Week" value={overview.activeUsersThisWeek} week={overview.changes?.active.week} weekLabel="vs last week" />
            </div>
          )}

          {overview && overview.countryBreakdown.length > 0 && (
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-border-subtle">
                <h2 className="text-lg font-bold text-primary">By Country</h2>
                <p className="text-xs text-text-muted">Sorted by user count, descending. Country is approximated from device timezone.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    <tr className="text-left text-text-muted border-b border-border-subtle">
                      <th className="p-3">Country</th>
                      <th className="p-3">Users</th>
                      <th className="p-3">Active Today</th>
                      <th className="p-3">Groups</th>
                      <th className="p-3">Expenses</th>
                      <th className="p-3">Total Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.countryBreakdown.map((c) => (
                      <tr key={c.country} className="border-b border-border-subtle last:border-0">
                        <td className="p-3 font-bold text-primary">{c.country}</td>
                        <td className="p-3">{c.users}</td>
                        <td className="p-3">{c.activeToday}</td>
                        <td className="p-3">{c.groups}</td>
                        <td className="p-3">{c.expenses}</td>
                        <td className="p-3 font-bold">{c.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <TileGrid tiles={[{ to: '/admin/analytics', icon: 'analytics', label: 'Full Analytics', description: 'Top groups/individuals, usage trends, inactivity, game stats' }]} />
        </div>
      )}

      {activeTab === 'users' && <TileGrid tiles={userTiles} />}
      {activeTab === 'support' && <TileGrid tiles={supportTiles} />}
      {activeTab === 'announcements' && <TileGrid tiles={announcementTiles} />}
      {activeTab === 'growth' && <TileGrid tiles={growthTiles} />}
    </div>
  );
}
