import React, { useEffect, useRef, useState } from 'react';
import { collection, deleteDoc, doc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

interface InviteNotice {
  id: string;
  toUid: string;
  type: 'group' | 'game' | 'chat' | 'friend';
  title: string;
  body: string;
  to: string;
  photoURL?: string | null;
  createdAt: string;
}

// Drop-down banner for group/game invites that arrive WHILE the app is already open — server.ts
// writes an `inviteNotices` doc (alongside the push notification) whenever an existing account
// gets invited. Only notices created AFTER this component mounted are ever shown (anything
// already pending from before the app was opened is what the native push notification already
// covers — this is purely the "live, in-app" experience the push can't reliably provide since
// foreground delivery behavior varies by platform). No composite index needed: sorts client-side
// rather than combining `where` + `orderBy` in the query, since this collection per user is tiny
// (docs get deleted the moment they're shown or dismissed).
export default function InviteBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [noticesValue] = useCollection(
    user ? query(collection(db, 'inviteNotices'), where('toUid', '==', user.uid)) : null,
  );
  const [visible, setVisible] = useState<InviteNotice | null>(null);
  const mountedAtRef = useRef(new Date().toISOString());
  const shownIdsRef = useRef<Set<string>>(new Set());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!noticesValue) return;
    const notices = noticesValue.docs
      .map((d) => ({ id: d.id, ...d.data() } as InviteNotice))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const fresh = notices.find((n) => n.createdAt > mountedAtRef.current && !shownIdsRef.current.has(n.id));
    if (fresh) {
      shownIdsRef.current.add(fresh.id);
      setVisible(fresh);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => setVisible(null), 8000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticesValue]);

  const dismiss = (notice: InviteNotice) => {
    setVisible(null);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    deleteDoc(doc(db, 'inviteNotices', notice.id)).catch(() => {});
  };

  const handleTap = () => {
    if (!visible) return;
    const notice = visible;
    dismiss(notice);
    navigate(notice.to);
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-[290] flex justify-center px-3 pt-3 pointer-events-none">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ y: -80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -80, opacity: 0 }}
            transition={{ type: 'spring', damping: 22, stiffness: 300 }}
            className="pointer-events-auto w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-border-subtle p-3 flex items-center gap-3 cursor-pointer"
            onClick={handleTap}
          >
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0 overflow-hidden">
              {visible.photoURL ? (
                <img src={visible.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="material-symbols-outlined">
                  {visible.type === 'chat' ? 'chat' : visible.type === 'game' ? 'sports_esports' : visible.type === 'friend' ? 'person_add' : 'group_add'}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-primary truncate">{visible.title}</p>
              <p className="text-xs text-text-muted truncate">{visible.body}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismiss(visible); }}
              className="p-1.5 text-text-muted hover:bg-surface rounded-full shrink-0"
              aria-label="Dismiss"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
