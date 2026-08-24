import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminGet, adminDelete } from '../../lib/adminApi';

interface Detail {
  profile: any;
  groups: Array<{ groupId: string; role: string; name: string; currency: string | null }>;
  expenses: Array<{ id: string; description: string; amount: number; category: string; createdAt: string; groupId: string }>;
  activities: Array<{ id: string; type: string; description?: string; createdAt: string }>;
}

const CATEGORY_LABELS: Record<'expenses' | 'activities' | 'groups', string> = {
  expenses: 'all expenses',
  activities: 'all activity feed entries',
  groups: 'owned groups (and their members/expenses)',
};

export default function AdminUserDetail() {
  const { uid } = useParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmType, setConfirmType] = useState<'expenses' | 'activities' | 'groups' | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const load = () => {
    if (!uid) return;
    adminGet(`/api/admin/users/${uid}`)
      .then(setDetail)
      .catch((err) => setError(err.message));
  };

  useEffect(load, [uid]);

  const handleDeleteConfirmed = async () => {
    if (!uid || !confirmType) return;
    setBusy(true);
    try {
      await adminDelete(`/api/admin/users/${uid}/data?type=${confirmType}`);
      setConfirmType(null);
      setConfirmText('');
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!detail) return <div className="p-8 text-text-muted">Loading…</div>;

  const targetEmail = detail.profile.email;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">{detail.profile.displayName || detail.profile.email}</h1>
        <Link to="/admin/users" className="text-sm font-bold text-primary underline">Back to Users</Link>
      </div>
      <p className="text-sm text-text-muted">{detail.profile.email} · uid: {detail.profile.uid}</p>

      <section className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-primary">Groups ({detail.groups.length})</h2>
          <button
            onClick={() => setConfirmType('groups')}
            disabled={busy}
            className="text-xs font-bold text-red-600 disabled:opacity-40"
          >
            Delete owned groups
          </button>
        </div>
        {detail.groups.map((g) => (
          <div key={g.groupId} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
            <span>{g.name}</span>
            <span className="text-text-muted">{g.role}</span>
          </div>
        ))}
        {detail.groups.length === 0 && <p className="text-sm text-text-muted">No groups.</p>}
      </section>

      <section className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-primary">Expenses ({detail.expenses.length}, last 200)</h2>
          <button
            onClick={() => setConfirmType('expenses')}
            disabled={busy}
            className="text-xs font-bold text-red-600 disabled:opacity-40"
          >
            Delete all expenses
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto space-y-1">
          {detail.expenses.map((e) => (
            <div key={e.id} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
              <div>
                <p className="font-medium">{e.description}</p>
                <p className="text-xs text-text-muted">{e.category} · {new Date(e.createdAt).toLocaleDateString()}</p>
              </div>
              <span className="font-bold">{e.amount.toLocaleString()}</span>
            </div>
          ))}
        </div>
        {detail.expenses.length === 0 && <p className="text-sm text-text-muted">No expenses.</p>}
      </section>

      <section className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-primary">Activity Feed ({detail.activities.length}, last 100)</h2>
          <button
            onClick={() => setConfirmType('activities')}
            disabled={busy}
            className="text-xs font-bold text-red-600 disabled:opacity-40"
          >
            Delete all activities
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto space-y-1">
          {detail.activities.map((a) => (
            <div key={a.id} className="text-sm border-b border-border-subtle last:border-0 py-2">
              <p>{a.description || a.type}</p>
              <p className="text-xs text-text-muted">{new Date(a.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
        {detail.activities.length === 0 && <p className="text-sm text-text-muted">No activity.</p>}
      </section>

      {confirmType && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full space-y-4">
            <h3 className="text-lg font-bold text-red-600">Delete {CATEGORY_LABELS[confirmType]}?</h3>
            <p className="text-sm text-text-muted">
              This permanently deletes {CATEGORY_LABELS[confirmType]} for <strong>{targetEmail}</strong>. This cannot be undone.
            </p>
            <p className="text-sm font-bold">Type the email address to confirm:</p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={targetEmail}
              className="w-full rounded-xl border border-border-subtle px-4 py-2 text-sm"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setConfirmType(null); setConfirmText(''); }}
                className="px-4 py-2 rounded-xl text-sm font-bold text-text-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirmed}
                disabled={confirmText !== targetEmail || busy}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-red-600 text-white disabled:opacity-40"
              >
                Permanently Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
