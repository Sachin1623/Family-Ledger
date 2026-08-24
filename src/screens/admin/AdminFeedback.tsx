import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost, adminDelete } from '../../lib/adminApi';
import { auth } from '../../lib/firebase';
import Comments from '../../components/Comments';

interface FeedbackItem {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  type?: 'feedback' | 'suggestion' | 'bug';
  text: string;
  screenshot?: string;
  createdAt: string;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
}

const TYPE_INFO: Record<string, { label: string; icon: string }> = {
  suggestion: { label: 'Suggestion', icon: 'lightbulb' },
  feedback: { label: 'Feedback', icon: 'chat' },
  bug: { label: 'Bug Report', icon: 'bug_report' },
};

async function notifyFeedbackComment(feedbackId: string, commentText: string) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return;
  fetch('/api/notify-feedback-comment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedbackId, commentText }),
  }).catch((err) => console.error('notify-feedback-comment failed:', err));
}

export default function AdminFeedback() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminGet('/api/admin/feedback')
      .then((data) => setItems(data.feedback))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleResolve = async (id: string) => {
    setBusyId(id);
    try {
      await adminPost(`/api/admin/feedback/${id}/resolve`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this feedback item?')) return;
    setBusyId(id);
    try {
      await adminDelete(`/api/admin/feedback/${id}`);
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
        <h1 className="text-2xl font-black text-primary">Feedback &amp; Support</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      <label className="flex items-center gap-2 text-sm font-bold text-text-muted">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        Show resolved
      </label>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
      {loading && <div className="text-center text-text-muted py-10">Loading feedback…</div>}

      <div className="space-y-3">
        {visible.map((item) => {
          const info = TYPE_INFO[item.type || 'feedback'] || TYPE_INFO.feedback;
          const isOpen = expandedId === item.id;
          return (
            <div key={item.id} className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[16px] text-primary">{info.icon}</span>
                    <span className="text-[10px] font-black text-primary uppercase tracking-wider">{info.label}</span>
                    {item.resolved && (
                      <span className="text-[9px] font-bold text-success bg-success/10 px-2 py-0.5 rounded-full uppercase">Resolved</span>
                    )}
                  </div>
                  <p className="text-sm font-bold text-primary">{item.displayName}</p>
                  <p className="text-xs text-text-muted">{item.email} · {new Date(item.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <p className="text-sm text-on-surface whitespace-pre-wrap">{item.text}</p>

              {item.screenshot && (
                <img
                  src={item.screenshot}
                  alt="Attached screenshot"
                  className="max-h-40 rounded-xl border border-border-subtle cursor-pointer"
                  onClick={() => setLightboxImage(item.screenshot!)}
                />
              )}

              <div className="flex gap-2">
                {!item.resolved && (
                  <button
                    onClick={() => handleResolve(item.id)}
                    disabled={busyId === item.id}
                    className="px-3 py-1.5 rounded-lg bg-surface-container text-xs font-bold text-primary disabled:opacity-50"
                  >
                    Mark Resolved
                  </button>
                )}
                <button
                  onClick={() => setExpandedId(isOpen ? null : item.id)}
                  className="px-3 py-1.5 rounded-lg bg-primary/5 text-xs font-bold text-primary"
                >
                  {isOpen ? 'Hide replies' : 'View / Reply'}
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  disabled={busyId === item.id}
                  className="px-3 py-1.5 rounded-lg bg-red-50 text-xs font-bold text-red-600 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>

              {isOpen && (
                <Comments
                  pathSegments={['feedback', item.id, 'comments']}
                  label="Replies"
                  placeholder="Reply to this user…"
                  emptyText="No replies yet."
                  onPosted={(commentText) => notifyFeedbackComment(item.id, commentText)}
                />
              )}
            </div>
          );
        })}
        {!loading && visible.length === 0 && (
          <p className="text-center text-text-muted py-10">No feedback yet.</p>
        )}
      </div>

      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
          <img
            src={lightboxImage}
            alt="Attached screenshot, expanded"
            className="max-w-full max-h-full rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
