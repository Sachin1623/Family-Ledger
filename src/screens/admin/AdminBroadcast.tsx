import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost, adminDelete } from '../../lib/adminApi';

const MAX_IMAGES = 5;
const MAX_MESSAGE_LENGTH = 800;

interface BroadcastRecord {
  id: string;
  title: string;
  message: string;
  images?: string[];
  status: 'sent' | 'scheduled' | 'canceled';
  createdAt: string;
  createdBy?: string;
  scheduledFor?: string | null;
  sentAt?: string | null;
  canceledAt?: string | null;
  recipientCount?: number;
  pushSent?: number;
}

// Resized + JPEG-compressed to a data URI, same technique as CreateGroup.tsx/Profile.tsx's
// photo uploads — kept smaller here (600px, lower quality) since a broadcast can carry up to
// MAX_IMAGES of these in one Firestore document, which has a hard 1MB size cap (server.ts also
// defensively rejects an oversized combination rather than trusting client-side compression alone).
function resizeImage(file: File, maxWidth = 600, maxHeight = 600): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onerror = reject;
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
    };
  });
}

// datetime-local inputs work in the browser's LOCAL wall-clock time with no timezone suffix —
// `new Date(...)` parses that as local time correctly, and toISOString() converts it to the UTC
// timestamp the server compares scheduledFor against.
function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minDatetimeLocalValue(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 60_000).toISOString());
}

const STATUS_BADGE: Record<BroadcastRecord['status'], string> = {
  sent: 'bg-success/10 text-success',
  scheduled: 'bg-primary/10 text-primary',
  canceled: 'bg-error/10 text-error',
};

export default function AdminBroadcast() {
  const [title, setTitle] = useState('FamilyLedger');
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [processingImages, setProcessingImages] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledForLocal, setScheduledForLocal] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const [current, setCurrent] = useState<any>(null);
  const [history, setHistory] = useState<BroadcastRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ recipientCount: number; pushSent: number } | null>(null);

  const loadAll = () => {
    setLoading(true);
    Promise.all([adminGet('/api/admin/broadcast'), adminGet('/api/admin/broadcast/history')])
      .then(([currentData, historyData]) => {
        setCurrent(currentData);
        setHistory(historyData.broadcasts || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadAll, []);

  const resetForm = () => {
    setEditingId(null);
    setTitle('FamilyLedger');
    setMessage('');
    setImages([]);
    setScheduleEnabled(false);
    setScheduledForLocal('');
  };

  const handleAddImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    const files: File[] = [];
    if (fileList) {
      for (let i = 0; i < fileList.length && files.length < MAX_IMAGES - images.length; i++) {
        const f = fileList.item(i);
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    setProcessingImages(true);
    try {
      const resized = await Promise.all(files.map((f) => resizeImage(f)));
      setImages((prev) => [...prev, ...resized].slice(0, MAX_IMAGES));
    } catch (err) {
      console.error('Image resize failed:', err);
    } finally {
      setProcessingImages(false);
      e.target.value = '';
    }
  };

  const handleReuse = (b: BroadcastRecord) => {
    setEditingId(null);
    setTitle(b.title);
    setMessage(b.message);
    setImages(b.images || []);
    setScheduleEnabled(false);
    setScheduledForLocal('');
    setResult(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEditScheduled = (b: BroadcastRecord) => {
    setEditingId(b.id);
    setTitle(b.title);
    setMessage(b.message);
    setImages(b.images || []);
    setScheduleEnabled(true);
    setScheduledForLocal(toDatetimeLocalValue(b.scheduledFor));
    setResult(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelScheduled = async (b: BroadcastRecord) => {
    if (!window.confirm(`Cancel this scheduled broadcast (was set for ${new Date(b.scheduledFor!).toLocaleString()})?`)) return;
    try {
      await adminDelete(`/api/admin/broadcast/${b.id}`);
      if (editingId === b.id) resetForm();
      loadAll();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    const scheduledFor = scheduleEnabled && scheduledForLocal ? new Date(scheduledForLocal).toISOString() : null;
    if (scheduleEnabled && (!scheduledFor || new Date(scheduledFor).getTime() <= Date.now())) {
      setError('Pick a future date/time to schedule for.');
      return;
    }

    const confirmText = editingId
      ? `Update this scheduled broadcast for ${new Date(scheduledFor!).toLocaleString()}?`
      : scheduleEnabled
      ? `Schedule this message to send to every user at ${new Date(scheduledFor!).toLocaleString()}?`
      : 'Send this message to every user right now? This cannot be undone or recalled.';
    if (!window.confirm(confirmText)) return;

    setSending(true);
    setError(null);
    setResult(null);
    try {
      if (editingId) {
        await adminPost(`/api/admin/broadcast/${editingId}`, { title, message: message.trim(), images, scheduledFor });
      } else {
        const data = await adminPost('/api/admin/broadcast', { title, message: message.trim(), images, scheduledFor });
        if (!scheduledFor) {
          setResult({ recipientCount: data.recipientCount, pushSent: data.pushSent });
          setCurrent({ id: data.broadcastId, title, message: message.trim(), images, createdAt: new Date().toISOString() });
        }
      }
      resetForm();
      loadAll();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const submitLabel = sending
    ? editingId
      ? 'Updating…'
      : scheduleEnabled
      ? 'Scheduling…'
      : 'Sending…'
    : editingId
    ? 'Update Scheduled Broadcast'
    : scheduleEnabled
    ? 'Schedule'
    : 'Send to Everyone';

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">Broadcast Message</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-sm text-text-muted">
        Sends a push notification to every user and shows an in-app announcement the next time
        (or right now, if they're already using it) they open the app — it stays on screen until
        they tap Close. Each message is shown to a given user exactly once. Schedule a broadcast for
        later instead, or reuse/edit a past one below.
      </p>

      {loading && <p className="text-center text-text-muted py-10">Loading…</p>}

      {!loading && (
        <>
          {current?.message && (
            <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-2">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Currently showing to users</p>
              <p className="text-sm font-bold text-primary">{current.title}</p>
              <p className="text-sm text-on-surface whitespace-pre-wrap">{current.message}</p>
              {current.images && current.images.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {current.images.map((src: string, idx: number) => (
                    <img key={idx} src={src} alt="" className="h-20 w-20 object-cover rounded-xl border border-border-subtle shrink-0" />
                  ))}
                </div>
              )}
              {current.createdAt && (
                <p className="text-[11px] text-text-muted">{new Date(current.createdAt).toLocaleString()}</p>
              )}
            </div>
          )}

          <form onSubmit={handleSend} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            {editingId && (
              <div className="flex items-center justify-between p-2.5 bg-primary/10 rounded-xl">
                <p className="text-xs font-bold text-primary">Editing a scheduled broadcast</p>
                <button type="button" onClick={resetForm} className="text-xs font-bold text-primary underline">Cancel edit</button>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="What should every user see?"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
              />
              <p className="text-[10px] text-text-muted px-1 text-right">{message.length}/{MAX_MESSAGE_LENGTH}</p>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                Images (optional, up to {MAX_IMAGES})
              </label>
              {images.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {images.map((src, idx) => (
                    <div key={idx} className="relative">
                      <img src={src} alt="" className="h-20 w-20 object-cover rounded-xl border border-border-subtle" />
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-error text-white rounded-full flex items-center justify-center shadow-sm"
                      >
                        <span className="material-symbols-outlined text-[12px]">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {images.length < MAX_IMAGES && (
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-primary cursor-pointer">
                  <span className="material-symbols-outlined text-[16px]">add_photo_alternate</span>
                  {processingImages ? 'Processing…' : 'Add Image'}
                  <input type="file" accept="image/*" multiple className="hidden" onChange={handleAddImages} disabled={processingImages} />
                </label>
              )}
            </div>

            <div className="space-y-2 border-t border-border-subtle pt-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(e) => {
                    setScheduleEnabled(e.target.checked);
                    if (e.target.checked && !scheduledForLocal) setScheduledForLocal(minDatetimeLocalValue());
                  }}
                  className="w-4 h-4 accent-primary"
                />
                <span className="text-sm font-bold text-on-surface">Schedule for later</span>
              </label>
              {scheduleEnabled && (
                <input
                  type="datetime-local"
                  value={scheduledForLocal}
                  min={minDatetimeLocalValue()}
                  onChange={(e) => setScheduledForLocal(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              )}
            </div>

            {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
            {result && (
              <div className="p-3 bg-success/10 text-success text-sm rounded-xl border border-success/20">
                Sent to {result.recipientCount} users ({result.pushSent} push notifications delivered).
              </div>
            )}
            <button
              type="submit"
              disabled={sending || !message.trim() || processingImages}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </form>

          <div className="space-y-3">
            <h2 className="text-sm font-black text-primary uppercase tracking-wider px-1">History</h2>
            {history.length === 0 && <p className="text-sm text-text-muted px-1">No broadcasts yet.</p>}
            {history.map((b) => (
              <div key={b.id} className="bg-white rounded-2xl border border-border-subtle p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-primary truncate">{b.title}</p>
                    <p className="text-sm text-on-surface whitespace-pre-wrap line-clamp-3">{b.message}</p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${STATUS_BADGE[b.status]}`}>
                    {b.status}
                  </span>
                </div>
                {b.images && b.images.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {b.images.map((src, idx) => (
                      <img key={idx} src={src} alt="" className="h-16 w-16 object-cover rounded-xl border border-border-subtle shrink-0" />
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-text-muted">
                  {b.status === 'scheduled' && b.scheduledFor && <>Scheduled for {new Date(b.scheduledFor).toLocaleString()}</>}
                  {b.status === 'sent' && b.sentAt && <>Sent {new Date(b.sentAt).toLocaleString()} · {b.recipientCount ?? 0} recipients</>}
                  {b.status === 'canceled' && b.canceledAt && <>Canceled {new Date(b.canceledAt).toLocaleString()}</>}
                </p>
                <div className="flex gap-2 pt-1">
                  {b.status === 'scheduled' && (
                    <>
                      <button type="button" onClick={() => handleEditScheduled(b)} className="text-xs font-bold text-primary underline">Edit</button>
                      <button type="button" onClick={() => handleCancelScheduled(b)} className="text-xs font-bold text-error underline">Cancel</button>
                    </>
                  )}
                  {b.status !== 'scheduled' && (
                    <button type="button" onClick={() => handleReuse(b)} className="text-xs font-bold text-primary underline">Reuse</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
