import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet } from '../../lib/adminApi';
import { useAuth } from '../../context/AuthContext';

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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm">
      <p className="text-xs font-bold text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-3xl font-black text-primary mt-1">{value}</p>
    </div>
  );
}

function formatMoney(n: number, currency?: string) {
  return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
}

export default function AdminDashboard() {
  const { admin } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [cloudCost, setCloudCost] = useState<CloudCost | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGet('/api/admin/overview')
      .then(setOverview)
      .catch((err) => setError(err.message));
    adminGet('/api/admin/cloud-cost')
      .then(setCloudCost)
      .catch(() => setCloudCost(null));
  }, []);

  const tiles = [
    { to: '/admin/users', icon: 'group', label: 'Users', description: 'Browse, edit, reset passwords, wipe data' },
    { to: '/admin/analytics', icon: 'analytics', label: 'Analytics', description: 'Top groups/individuals, usage trends, inactivity, game stats' },
    { to: '/admin/feedback', icon: 'forum', label: 'Feedback & Support', description: 'Suggestions, feedback & bug reports from users' },
    { to: '/admin/chat-reports', icon: 'report', label: 'Game Chat Reports', description: 'Reported messages from Ludo/Rummy/Business/Sweep chat' },
    { to: '/admin/app-version', icon: 'system_update', label: 'App Version', description: 'Set release notes and force-update prompt' },
    { to: '/admin/broadcast', icon: 'campaign', label: 'Broadcast Message', description: 'Send a push + in-app announcement to every user' },
    { to: '/admin/shopkeeper-requests', icon: 'storefront', label: 'Shopkeeper Requests', description: 'Review and approve requests to enable Shopkeeper mode' },
  ];
  if (admin.isSuperAdmin) {
    tiles.push({ to: '/admin/manage-admins', icon: 'admin_panel_settings', label: 'Manage Admins', description: 'Grant or revoke secondary admin access' });
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 pb-24">
      <div>
        <h1 className="text-3xl font-black text-primary">Admin Panel</h1>
        <p className="text-sm text-text-muted font-medium">
          Signed in as {admin.isSuperAdmin ? 'primary admin' : admin.isPrimaryAdmin ? 'primary admin' : 'secondary admin'}
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>
      )}

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
                Since {cloudCost.earliest ? new Date(cloudCost.earliest).toLocaleDateString() : 'export started'}
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
          <StatCard label="Total Users" value={overview.totalUsers} />
          <StatCard label="Total Groups" value={overview.totalGroups} />
          <StatCard label="Total Expenses" value={overview.totalExpenses} />
          <StatCard label="Lifetime Spend Logged" value={overview.totalSpendAllTime.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
          <StatCard label="Active Today" value={overview.activeUsersToday} />
          <StatCard label="Active This Week" value={overview.activeUsersThisWeek} />
          <StatCard label="New Users Today" value={overview.newUsersToday} />
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
    </div>
  );
}
