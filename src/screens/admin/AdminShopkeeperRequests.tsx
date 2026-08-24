import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';

interface ShopRequest {
  uid: string;
  userName: string;
  userEmail: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export default function AdminShopkeeperRequests() {
  const [requests, setRequests] = useState<ShopRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminGet('/api/admin/shopkeeper-requests')
      .then((data) => setRequests(data.requests))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleReview = async (uid: string, approve: boolean) => {
    setBusyUid(uid);
    try {
      await adminPost(`/api/admin/shopkeeper-requests/${uid}/${approve ? 'approve' : 'reject'}`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyUid(null);
    }
  };

  const pending = requests.filter((r) => r.status === 'pending');
  const reviewed = requests.filter((r) => r.status !== 'pending');

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">Shopkeeper Requests</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
      {loading && <p className="text-center text-text-muted py-10">Loading…</p>}

      {!loading && (
        <>
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">Pending ({pending.length})</h2>
            {pending.length === 0 && <p className="text-sm text-text-muted italic px-1">No pending requests.</p>}
            {pending.map((r) => (
              <div key={r.uid} className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-primary truncate">{r.userName}</p>
                  <p className="text-xs text-text-muted truncate">{r.userEmail}</p>
                  <p className="text-[10px] text-text-muted mt-0.5">{new Date(r.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleReview(r.uid, false)}
                    disabled={busyUid === r.uid}
                    className="px-3 py-2 rounded-xl bg-red-50 text-xs font-bold text-red-600 disabled:opacity-50"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => handleReview(r.uid, true)}
                    disabled={busyUid === r.uid}
                    className="px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-50"
                  >
                    {busyUid === r.uid ? '…' : 'Approve'}
                  </button>
                </div>
              </div>
            ))}
          </section>

          {reviewed.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">Reviewed</h2>
              {reviewed.map((r) => (
                <div key={r.uid} className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between gap-3 opacity-70">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-primary truncate">{r.userName}</p>
                    <p className="text-xs text-text-muted truncate">{r.userEmail}</p>
                  </div>
                  <span className={`text-xs font-bold uppercase shrink-0 ${r.status === 'approved' ? 'text-success' : 'text-error'}`}>
                    {r.status}
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
