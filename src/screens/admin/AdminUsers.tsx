import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';

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
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black text-primary">Users</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-xs text-text-muted -mt-4">
        To grant or revoke admin access, use <Link to="/admin/manage-admins" className="font-bold text-primary underline">Manage Admins</Link>.
      </p>

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
                <td className="p-3 text-xs text-text-muted">{u.joinedAt ? new Date(u.joinedAt).toLocaleDateString() : '—'}</td>
                <td className="p-3 text-xs text-text-muted">{u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : '—'}</td>
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
