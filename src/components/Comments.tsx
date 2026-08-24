import React, { useState } from 'react';
import { db } from '../lib/firebase';
import { collection, query, orderBy, addDoc, deleteDoc, doc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { clsx } from 'clsx';

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Generic comment thread, reused for both expense-level and group-level discussions.
// `pathSegments` is the Firestore path to the parent doc's `comments` subcollection, e.g.
// ['expenses', expenseId, 'comments'] or ['groups', groupId, 'comments'].
export default function Comments({
  pathSegments,
  onPosted,
  label,
  placeholder,
  emptyText,
  className,
}: {
  pathSegments: string[];
  // Called after a comment is successfully posted, with the trimmed text — lets the caller
  // trigger whatever notification makes sense for this thread (group members, feedback
  // admins/submitter, etc.) without this generic component needing to know about any of it.
  onPosted?: (text: string) => void;
  label?: string;
  placeholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const resolvedLabel = label ?? t('comments.label');
  const resolvedPlaceholder = placeholder ?? t('comments.placeholder');
  const resolvedEmptyText = emptyText ?? t('comments.emptyText');
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const commentsRef = collection(db, pathSegments[0], ...pathSegments.slice(1));

  const [commentsValue, loading] = useCollection(query(commentsRef, orderBy('createdAt', 'asc')));
  const comments = commentsValue?.docs.map(d => ({ id: d.id, ...d.data() })) || [] as any[];

  const handlePost = async () => {
    const trimmed = text.trim();
    if (!trimmed || !user || posting) return;
    setPosting(true);
    try {
      await addDoc(commentsRef, {
        userId: user.uid,
        displayName: profile?.displayName || user.displayName || 'Someone',
        photoURL: profile?.photoURL || user.photoURL || '',
        text: trimmed,
        createdAt: new Date().toISOString(),
      });
      setText('');
      onPosted?.(trimmed);
    } catch (err) {
      console.error('Failed to post comment:', err);
      alert(t('comments.postFailed'));
    } finally {
      setPosting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!window.confirm(t('comments.deleteConfirm'))) return;
    try {
      await deleteDoc(doc(db, pathSegments[0], ...pathSegments.slice(1), commentId));
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  };

  return (
    <div className={clsx('space-y-3 border-t border-border-subtle pt-4 mt-2', className)}>
      <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">
        {resolvedLabel} {comments.length > 0 && `(${comments.length})`}
      </label>

      <div className="space-y-2 max-h-56 overflow-y-auto">
        {loading && <p className="text-xs text-text-muted px-1">{t('comments.loading')}</p>}
        {!loading && comments.length === 0 && (
          <p className="text-xs text-text-muted italic px-1">{resolvedEmptyText}</p>
        )}
        {comments.map((c: any) => (
          <div key={c.id} className="flex items-start gap-2 bg-surface p-2.5 rounded-xl border border-border-subtle">
            <div className="w-6 h-6 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center text-[9px] font-bold text-primary">
              {c.photoURL ? (
                <img src={c.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (c.displayName || '?').slice(0, 1)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-primary truncate">
                  {c.userId === user?.uid ? t('common.me') : c.displayName}
                </span>
                <span className="text-[9px] text-text-muted">{timeAgo(c.createdAt)}</span>
              </div>
              <p className="text-xs text-on-surface break-words">{c.text}</p>
            </div>
            {c.userId === user?.uid && (
              <button
                type="button"
                onClick={() => handleDelete(c.id)}
                className="text-text-muted hover:text-error shrink-0"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handlePost();
            }
          }}
          placeholder={resolvedPlaceholder}
          maxLength={500}
          className="flex-1 h-10 bg-surface px-3 rounded-xl border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button
          type="button"
          onClick={handlePost}
          disabled={!text.trim() || posting}
          className={clsx(
            'h-10 w-10 rounded-xl flex items-center justify-center transition-all shrink-0',
            text.trim() ? 'bg-primary text-white' : 'bg-surface-container text-text-muted'
          )}
        >
          <span className="material-symbols-outlined text-[18px]">send</span>
        </button>
      </div>
    </div>
  );
}
