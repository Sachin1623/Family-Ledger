import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { db, auth } from '../lib/firebase';
import { collection, addDoc, query, where, orderBy } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import Comments from '../components/Comments';
import { resizeImageFile } from '../lib/imageUtils';

const TYPES = [
  { id: 'suggestion', label: 'Suggestion', icon: 'lightbulb' },
  { id: 'feedback', label: 'Feedback', icon: 'chat' },
  { id: 'bug', label: 'Report a Bug', icon: 'bug_report' },
] as const;

type FeedbackType = typeof TYPES[number]['id'];

async function notifyFeedbackComment(feedbackId: string, commentText: string) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return;
  fetch('/api/notify-feedback-comment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedbackId, commentText }),
  }).catch((err) => console.error('notify-feedback-comment failed:', err));
}

export default function Feedback() {
  const { user, profile } = useAuth();
  const [type, setType] = useState<FeedbackType>('suggestion');
  const [text, setText] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [myItemsValue, myItemsLoading] = useCollection(
    user ? query(collection(db, 'feedback'), where('userId', '==', user.uid), orderBy('createdAt', 'desc')) : null,
  );
  const myItems = myItemsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const handleScreenshotChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScreenshotError(null);
    try {
      const resized = await resizeImageFile(file);
      if (resized.length > 1_000_000) {
        setScreenshotError('That image is too large even after compression. Try a smaller screenshot.');
        return;
      }
      setScreenshot(resized);
    } catch (err) {
      console.error('Screenshot resize failed:', err);
      setScreenshotError('Could not process that image. Please try another.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const docRef = await addDoc(collection(db, 'feedback'), {
        userId: user.uid,
        email: user.email || '',
        displayName: profile?.displayName || user.displayName || 'Someone',
        type,
        text: text.trim(),
        ...(screenshot ? { screenshot } : {}),
        createdAt: new Date().toISOString(),
      });

      const idToken = await user.getIdToken();
      fetch('/api/notify-new-feedback', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackId: docRef.id }),
      }).catch((err) => console.error('notify-new-feedback failed:', err));

      setSubmitted(true);
      setText('');
      setScreenshot(null);
    } catch (err) {
      console.error('Feedback submit failed:', err);
      setError('Could not send your feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const typeInfo = (t: string) => TYPES.find((x) => x.id === t) || TYPES[1];

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">Feedback &amp; Support</h1>
          <p className="text-sm text-text-muted mt-1">
            Suggest an idea, share feedback, or report a bug — the admin team reads every
            message and can reply here.
          </p>
        </div>

        {submitted ? (
          <div className="bg-white rounded-2xl border border-border-subtle p-6 text-center space-y-3">
            <span className="material-symbols-outlined text-4xl text-success">check_circle</span>
            <p className="font-bold text-primary">Thanks — we got it!</p>
            <p className="text-sm text-text-muted">Check "Your submissions" below for replies.</p>
            <button
              onClick={() => setSubmitted(false)}
              className="px-4 py-2 rounded-xl text-sm font-bold bg-primary text-white"
            >
              Send another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setType(t.id)}
                  className={clsx(
                    'flex flex-col items-center gap-1 py-3 rounded-xl border text-[11px] font-bold transition-all',
                    type === t.id
                      ? 'bg-primary/10 border-primary text-primary'
                      : 'bg-surface border-border-subtle text-text-muted hover:bg-surface-container',
                  )}
                >
                  <span className="material-symbols-outlined text-[20px]">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                type === 'bug'
                  ? 'What went wrong? Steps to reproduce help a lot.'
                  : type === 'suggestion'
                  ? 'What would make FamilyLedger more useful for you?'
                  : 'Tell us what you think.'
              }
              maxLength={2000}
              rows={6}
              className="w-full bg-surface p-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
            <p className="text-[11px] text-text-muted text-right">{text.length}/2000</p>

            <div className="space-y-2">
              {screenshot ? (
                <div className="relative inline-block">
                  <img src={screenshot} alt="Screenshot preview" className="max-h-40 rounded-xl border border-border-subtle" />
                  <button
                    type="button"
                    onClick={() => setScreenshot(null)}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-white rounded-full shadow-md border border-border-subtle flex items-center justify-center text-error"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </div>
              ) : (
                <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-border-subtle text-xs font-bold text-primary cursor-pointer hover:bg-surface">
                  <span className="material-symbols-outlined text-[18px]">add_photo_alternate</span>
                  Attach a screenshot (optional)
                  <input type="file" accept="image/*" className="hidden" onChange={handleScreenshotChange} />
                </label>
              )}
              {screenshotError && <p className="text-[11px] text-error font-bold">{screenshotError}</p>}
            </div>

            {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
            <button
              type="submit"
              disabled={!text.trim() || submitting}
              className="w-full py-4 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {submitting ? 'Sending…' : `Send ${typeInfo(type).label}`}
            </button>
          </form>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-black text-primary uppercase tracking-wider px-1">Your submissions</h2>
          {myItemsLoading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!myItemsLoading && myItems.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">Nothing sent yet.</p>
          )}
          <div className="space-y-2">
            {myItems.map((item) => {
              const info = typeInfo(item.type);
              const isOpen = expandedId === item.id;
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-border-subtle overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : item.id)}
                    className="w-full p-4 flex items-start gap-3 text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/5 flex items-center justify-center text-primary shrink-0">
                      <span className="material-symbols-outlined text-[18px]">{info.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-primary uppercase tracking-wider">{info.label}</span>
                        {item.resolved ? (
                          <span className="text-[9px] font-bold text-success bg-success/10 px-2 py-0.5 rounded-full uppercase">Resolved</span>
                        ) : (
                          <span className="text-[9px] font-bold text-text-muted bg-surface px-2 py-0.5 rounded-full uppercase">Open</span>
                        )}
                      </div>
                      <p className="text-sm text-on-surface truncate">{item.text}</p>
                      <p className="text-[10px] text-text-muted mt-0.5">{new Date(item.createdAt).toLocaleString()}</p>
                    </div>
                    <span className="material-symbols-outlined text-text-muted shrink-0">{isOpen ? 'expand_less' : 'expand_more'}</span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm text-on-surface whitespace-pre-wrap bg-surface p-3 rounded-xl border border-border-subtle">{item.text}</p>
                      {item.screenshot && (
                        <img src={item.screenshot} alt="Your screenshot" className="max-h-52 rounded-xl border border-border-subtle" />
                      )}
                      <Comments
                        pathSegments={['feedback', item.id, 'comments']}
                        label="Replies"
                        placeholder="Reply…"
                        emptyText="No replies yet."
                        onPosted={(commentText) => notifyFeedbackComment(item.id, commentText)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
