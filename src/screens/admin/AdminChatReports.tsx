import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost, adminDelete } from '../../lib/adminApi';

interface ChatReport {
  id: string;
  gameType: string;
  gameId: string;
  commentId: string;
  messageText: string;
  messageUserId: string;
  messageUserName: string;
  reportedBy: string;
  reportedByName: string;
  createdAt: string;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  messageDeleted?: boolean;
}

const GAME_LABEL: Record<string, string> = {
  ludoGames: 'Ludo',
  rummyGames: '27-Hand Rummy',
  businessGames: 'Business',
  sweepGames: 'Sweep',
  chessGames: 'Chess',
  sequenceGames: 'Sequence',
};

export default function AdminChatReports() {
  const [items, setItems] = useState<ChatReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = () => {
    setLoading(true);
    adminGet('/api/admin/chat-reports')
      .then((data) => setItems(data.reports))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleResolve = async (id: string) => {
    setBusyId(id);
    try {
      await adminPost(`/api/admin/chat-reports/${id}/resolve`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteMessage = async (id: string) => {
    if (!window.confirm('Delete this message from the game chat? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await adminPost(`/api/admin/chat-reports/${id}/delete-message`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteReport = async (id: string) => {
    if (!window.confirm('Delete this report? This only removes the report entry, not the message.')) return;
    setBusyId(id);
    try {
      await adminDelete(`/api/admin/chat-reports/${id}`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const visible = items.filter((i) => showResolved || !i.resolved);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">Game Chat Reports</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      <label className="flex items-center gap-2 text-sm font-bold text-text-muted">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        Show resolved
      </label>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
      {loading && <div className="text-center text-text-muted py-10">Loading reports…</div>}

      <div className="space-y-3">
        {visible.map((item) => (
          <div key={item.id} className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] font-black text-primary uppercase tracking-wider">
                    {GAME_LABEL[item.gameType] || item.gameType}
                  </span>
                  {item.resolved && (
                    <span className="text-[9px] font-bold text-success bg-success/10 px-2 py-0.5 rounded-full uppercase">
                      Resolved{item.messageDeleted ? ' · message deleted' : ''}
                    </span>
                  )}
                </div>
                <p className="text-sm font-bold text-primary">From: {item.messageUserName}</p>
                <p className="text-xs text-text-muted">
                  Reported by {item.reportedByName} · {new Date(item.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
            <p className="text-sm text-on-surface whitespace-pre-wrap bg-surface rounded-xl p-3 border border-border-subtle">
              {item.messageText}
            </p>

            <div className="flex flex-wrap gap-2">
              {!item.resolved && (
                <>
                  <button
                    onClick={() => handleDeleteMessage(item.id)}
                    disabled={busyId === item.id}
                    className="px-3 py-1.5 rounded-lg bg-red-50 text-xs font-bold text-red-600 disabled:opacity-50"
                  >
                    Delete Message &amp; Resolve
                  </button>
                  <button
                    onClick={() => handleResolve(item.id)}
                    disabled={busyId === item.id}
                    className="px-3 py-1.5 rounded-lg bg-surface-container text-xs font-bold text-primary disabled:opacity-50"
                  >
                    Dismiss (no action)
                  </button>
                </>
              )}
              <button
                onClick={() => handleDeleteReport(item.id)}
                disabled={busyId === item.id}
                className="px-3 py-1.5 rounded-lg bg-red-50 text-xs font-bold text-red-600 disabled:opacity-50"
              >
                Delete Report
              </button>
            </div>
          </div>
        ))}
        {!loading && visible.length === 0 && (
          <p className="text-center text-text-muted py-10">No reports.</p>
        )}
      </div>
    </div>
  );
}
