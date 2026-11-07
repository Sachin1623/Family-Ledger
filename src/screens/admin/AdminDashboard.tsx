import React, { Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { adminGet } from '../../lib/adminApi';
import { useAuth } from '../../context/AuthContext';
import { fmtDate, getAdminTz, setAdminTzMode } from '../../lib/adminTime';
import { Arrow, CloudCostCard, StatCard, formatMoney, sumOf, type CloudCost } from '../../components/admin/AdminTiles';

// the Growth tab shows the full report itself (charts included), loaded only when that tab is opened
const AdminGrowth = React.lazy(() => import('./AdminGrowth'));

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
  trend?: { days: string[]; users: number[]; groups: number[]; expenses: number[]; spend: number[]; active: (number | null)[]; activeWeek: (number | null)[] };
  newUsers?: { invite: number[]; organic: number[] };
  changes?: {
    users: { today: number; week: number };
    groups: { today: number; week: number };
    expenses: { today: number; week: number };
    spend: { today: number; week: number };
    active: { today: number | null; week: number | null };
  };
}

interface Tile {
  to: string;
  icon: string;
  label: string;
  description: string;
}

// Today's new people against yesterday's, split by how they arrived. Google Ads is not recorded in the app yet, so its row says so instead of showing a made-up zero.
function NewUsersCard({ invite, organic }: { invite: number[]; organic: number[] }) {
  const n = invite.length;
  const total = invite.map((v, i) => v + organic[i]);
  const win = (a: number[]) => ({ today: a[n - 1], yesterday: a[n - 2], week: sumOf(a.slice(n - 7)), lastWeek: sumOf(a.slice(n - 14, n - 7)) });
  const rows = [
    { label: 'All new users', w: win(total), strong: true },
    { label: 'Through an invite', hint: 'WhatsApp / SMS join link, or an email invite', w: win(invite) },
    { label: 'Organic', hint: 'Found the app and signed up on their own', w: win(organic) },
  ];
  const cell = (v: number, strong?: boolean) => <span className={clsx('text-center tabular-nums', strong ? 'text-xl font-black text-primary' : 'text-sm font-bold text-on-surface', v === 0 && 'opacity-40')}>{v}</span>;
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm">
      <h2 className="text-lg font-bold text-primary">New users</h2>
      <p className="text-xs text-text-muted">Who joined today compared with yesterday, and how they arrived. Indian time.</p>
      <div className="grid grid-cols-4 gap-1 mt-4 mb-1 text-[10px] font-bold uppercase tracking-wide text-text-muted text-center">
        <span>Today</span><span>Yesterday</span><span>This week</span><span>Last week</span>
      </div>
      <div className="divide-y divide-border-subtle">
        {rows.map((r) => (
          <div key={r.label} className={clsx('py-2.5', r.strong && 'bg-surface rounded-xl px-3 -mx-1 mb-1 divide-y-0')}>
            <div className="flex items-center justify-between mb-1">
              <span className={clsx('text-sm', r.strong ? 'font-black text-primary' : 'text-on-surface')}>{r.label}</span>
              <span className="text-[11px]"><Arrow now={r.w.today} before={r.w.yesterday} /></span>
            </div>
            {r.hint && <p className="text-[10px] text-text-muted -mt-0.5 mb-1">{r.hint}</p>}
            <div className="grid grid-cols-4 gap-1">{cell(r.w.today, r.strong)}{cell(r.w.yesterday, r.strong)}{cell(r.w.week, r.strong)}{cell(r.w.lastWeek, r.strong)}</div>
          </div>
        ))}
        <div className="py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface">From Google Ads</span>
            <span className="text-[11px] font-bold text-text-muted">not tracked yet</span>
          </div>
          <p className="text-[10px] text-text-muted mt-0.5">The app does not record which ad a person came from, so these people are counted under Organic for now.</p>
        </div>
      </div>
    </div>
  );
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
  // the tab lives in the URL (?tab=support) so Back from a sub-page returns to the same tab, not Overview
  const [searchParams, setSearchParams] = useSearchParams();
  type Tab = 'overview' | 'users' | 'support' | 'announcements' | 'growth';
  const TAB_KEYS: Tab[] = ['overview', 'users', 'support', 'announcements', 'growth'];
  const tabParam = searchParams.get('tab') as Tab | null;
  const activeTab: Tab = tabParam && TAB_KEYS.includes(tabParam) ? tabParam : 'overview';
  const setActiveTab = (t: Tab) => setSearchParams(t === 'overview' ? {} : { tab: t }, { replace: true });

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
          <CloudCostCard cloudCost={cloudCost} />

          {overview && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              <StatCard label="Total Users" value={overview.totalUsers} series={overview.trend?.users} />
              <StatCard label="Total Groups" value={overview.totalGroups} series={overview.trend?.groups} />
              <StatCard label="Total Expenses" value={overview.totalExpenses} series={overview.trend?.expenses} />
              <StatCard label="Lifetime Spend Logged" value={overview.totalSpendAllTime.toLocaleString(undefined, { maximumFractionDigits: 0 })} series={overview.trend?.spend} format={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
              <StatCard label="Active Today" value={overview.activeUsersToday} series={overview.trend?.active} level />
              <StatCard label="Active This Week" value={overview.activeUsersThisWeek} weekSeries={overview.trend?.activeWeek} />
            </div>
          )}

          {overview?.newUsers && <NewUsersCard invite={overview.newUsers.invite} organic={overview.newUsers.organic} />}

          <TileGrid tiles={[{ to: '/admin/analytics', icon: 'analytics', label: 'Full Analytics', description: 'Top groups/individuals, usage trends, inactivity, game stats' }]} />

          {overview && overview.countryBreakdown.length > 0 && (
            <details className="group bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <summary className="px-5 py-4 cursor-pointer list-none flex items-center justify-between gap-3 group-open:border-b group-open:border-border-subtle">
                <span>
                  <span className="block text-lg font-bold text-primary">By Country</span>
                  <span className="block text-xs text-text-muted">Sorted by user count. Country is approximated from device timezone. Tap to open.</span>
                </span>
                <span className="material-symbols-outlined text-text-muted transition-transform group-open:rotate-180">expand_more</span>
              </summary>
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
            </details>
          )}
        </div>
      )}

      {activeTab === 'users' && <TileGrid tiles={userTiles} />}
      {activeTab === 'support' && <TileGrid tiles={supportTiles} />}
      {activeTab === 'announcements' && <TileGrid tiles={announcementTiles} />}
      {activeTab === 'growth' && (
        <Suspense fallback={<p className="text-sm text-text-muted">Loading…</p>}>
          <AdminGrowth embedded />
        </Suspense>
      )}
    </div>
  );
}
