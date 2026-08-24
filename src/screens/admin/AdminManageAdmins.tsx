import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';
import { useAuth } from '../../context/AuthContext';

interface AdminEntry {
  uid: string;
  email: string;
  grantedAt: string;
  grantedBy: string;
}

export default function AdminManageAdmins() {
  const { admin } = useAuth();
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    adminGet('/api/admin/admins')
      .then((data) => setAdmins(data.admins))
      .catch((err) => setError(err.message));
  };

  useEffect(load, []);

  if (!admin.isSuperAdmin) {
    return <Navigate to="/admin" replace />;
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      await adminPost('/api/admin/manage-admin', { email: email.trim().toLowerCase(), action: 'add' });
      setEmail('');
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (targetEmail: string) => {
    if (!window.confirm(`Remove admin access for ${targetEmail}?`)) return;
    setBusy(true);
    try {
      await adminPost('/api/admin/manage-admin', { email: targetEmail, action: 'remove' });
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">Manage Admins</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-sm text-text-muted">
        Only sachin.rajputs@gmail.com can grant or revoke secondary admin access. Secondary admins
        get full access to the admin panel (users, resets, deletions, analytics) but cannot grant
        or revoke admin access themselves.
      </p>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="account@example.com"
          className="flex-1 rounded-2xl border border-border-subtle px-4 py-3 text-sm focus:border-primary focus:outline-none"
        />
        <button type="submit" disabled={busy} className="px-6 py-3 bg-primary text-white rounded-2xl font-bold text-sm disabled:opacity-50">
          Grant Access
        </button>
      </form>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

      <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle">
        {admins.map((a) => (
          <div key={a.uid} className="flex items-center justify-between p-4">
            <div>
              <p className="font-bold text-primary text-sm">{a.email}</p>
              <p className="text-xs text-text-muted">
                Granted {new Date(a.grantedAt).toLocaleDateString()} by {a.grantedBy}
              </p>
            </div>
            <button
              onClick={() => handleRemove(a.email)}
              disabled={busy}
              className="text-xs font-bold text-red-600 disabled:opacity-40"
            >
              Revoke
            </button>
          </div>
        ))}
        {admins.length === 0 && <p className="p-4 text-sm text-text-muted">No secondary admins yet.</p>}
      </div>
    </div>
  );
}
