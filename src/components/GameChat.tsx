import { pushModalBackHandler, popModalBackHandler } from '../lib/modalBackHandler';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, arrayRemove, arrayUnion, collection, deleteDoc, doc, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  photoURL?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
}

// Bare icon, matching the Help/Leave pair's "only icons" header treatment — the small dot is a
// session-only "there's something new" hint (not a persisted unread count/read-receipt system,
// which would need a lot more machinery than a casual family-game chat warrants).
export const ChatButton: React.FC<{ onClick: () => void; hasUnseen?: boolean; className?: string }> = ({
  onClick,
  hasUnseen,
  className,
}) => (
  <button onClick={onClick} className={`relative p-2 shrink-0 ${className || ''}`} aria-label="Chat">
    <span className="text-[18px] leading-none block">💬</span>
    {hasUnseen && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-error" />}
  </button>
);

// Tracks a game's `comments` subcollection and reports whether a NEW (non-blocked, non-muted)
// message has arrived since this hook first mounted, so `ChatButton` can show a dot without the
// panel being open. Block/mute state lives on the viewer's OWN `users/{uid}` doc (read here via
// `useAuth()`'s `profile`, app-wide — not scoped to just this one game) rather than being passed
// down from each game screen, so blocking/muting works everywhere the instant it's set, and none
// of the four game screens need to know this feature exists.
export function useGameChat(collectionName: string, gameId: string | undefined) {
  const { user, profile } = useAuth();
  const [messagesValue, loading] = useCollection(
    gameId ? query(collection(db, collectionName, gameId, 'comments'), orderBy('createdAt', 'asc')) : null,
  );
  const allMessages: ChatMessage[] = messagesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as ChatMessage)) || [];

  const blockedUsers: string[] = profile?.blockedUsers || [];
  const mutedUsers: string[] = profile?.mutedUsers || [];
  const mutedGameChats: string[] = profile?.mutedGameChats || [];
  const chatMuted = gameId ? mutedGameChats.includes(`${collectionName}:${gameId}`) : false;

  // Blocked senders' messages are filtered out entirely — that's the whole point of "block."
  const messages = allMessages.filter((m) => !blockedUsers.includes(m.userId));

  // Muted senders' messages still show if the panel is opened, they just never trigger the "new
  // message" dot; muting the whole chat suppresses the dot regardless of who sent it. Your OWN
  // messages never count either — sending a message was already something you just did, not
  // something new to notify yourself about.
  const countable = chatMuted ? [] : messages.filter((m) => m.userId !== user?.uid && !mutedUsers.includes(m.userId));

  // Delivery receipts: written the moment new messages arrive via THIS listener — which is
  // always subscribed (used for the unread dot below), unlike ChatPanel's read-receipt write,
  // which only happens while the panel is actually open. That's what makes "delivered" (message
  // reached your device) a genuinely different, earlier moment than "read" (you opened the chat
  // and saw it) — the two-gray-ticks vs two-blue-ticks distinction below depends on it.
  useEffect(() => {
    if (!user || !gameId || allMessages.length === 0) return;
    const deliveredId = `${collectionName}_${gameId}_${user.uid}`;
    setDoc(
      doc(db, 'chatDelivered', deliveredId),
      { collectionName, chatId: gameId, uid: user.uid, lastDeliveredAt: new Date().toISOString() },
      { merge: true },
    ).catch(() => {});
  }, [collectionName, gameId, user?.uid, allMessages.length]);

  const [hasUnseen, setHasUnseen] = useState(false);
  const seenCountRef = useRef<number | null>(null);

  useEffect(() => {
    // `useCollection` reports `loading: true` with `messagesValue` still `undefined` for the
    // first render(s) before Firestore's snapshot actually arrives — `countable.length` is 0 on
    // that render regardless of how many real messages exist. Capturing THAT as the "seen"
    // baseline (rather than waiting for the real snapshot) meant every fresh mount — a Dashboard
    // reload, navigating into GroupAnalysisSummary — saw the count jump from 0 to N once the real
    // data landed and lit the dot for messages that were already there, not new ones.
    if (loading) return;
    if (seenCountRef.current === null) {
      seenCountRef.current = countable.length;
      return;
    }
    if (countable.length > seenCountRef.current) setHasUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countable.length, loading]);

  const markSeen = () => {
    seenCountRef.current = countable.length;
    setHasUnseen(false);
  };

  return { messages, loading, hasUnseen, markSeen };
}

// WhatsApp's own convention: a clock while still in flight, one gray check once durably written,
// two gray checks once every other participant's device has received it, two BLUE checks once
// they've actually opened the chat and read it.
const MessageStatusTicks: React.FC<{ status: 'sending' | 'sent' | 'delivered' | 'read' }> = ({ status }) => {
  if (status === 'sending') {
    return <span className="material-symbols-outlined text-[12px] text-text-muted/60" aria-label="Sending">schedule</span>;
  }
  if (status === 'sent') {
    return <span className="material-symbols-outlined text-[14px] text-text-muted/60" aria-label="Sent">done</span>;
  }
  return (
    <span
      className={`material-symbols-outlined text-[14px] ${status === 'read' ? 'text-primary' : 'text-text-muted/60'}`}
      aria-label={status === 'read' ? 'Read' : 'Delivered'}
    >
      done_all
    </span>
  );
};

interface ChatPanelProps {
  collectionName: string;
  gameId: string;
  messages: ChatMessage[];
  loading: boolean;
  myUid: string;
  myDisplayName: string;
  myPhotoURL?: string;
  onClose: () => void;
  title?: string;
  // Every other participant's uid (group members / game players / the other DM party, minus
  // yourself) — used purely to compute "Read" status on your own last message. Optional and
  // read-receipts are simply skipped if omitted (older/simpler callers don't need to know this
  // exists).
  otherUids?: string[];
}

const SENDER_TINTS = [
  { bg: '#e6eefc', border: '#d3e0f7', name: '#2b6fd6' },
  { bg: '#e3f4f1', border: '#cbe8e2', name: '#0f8a7a' },
  { bg: '#fdeee4', border: '#f5d9c6', name: '#c2410c' },
  { bg: '#f3e8fd', border: '#e4d1f7', name: '#7c3aed' },
  { bg: '#fde8f1', border: '#f6cfe1', name: '#be185d' },
  { bg: '#eef5dc', border: '#dbe8b8', name: '#4d7c0f' },
];
const hashIndex = (key: string, mod: number) => Math.abs([...key].reduce((a, c) => a + c.charCodeAt(0), 0)) % mod;

// Same bottom-sheet-on-mobile / centered-card-on-larger-screens shell as GameHelpModal, so it
// feels native to the rest of the games screens rather than introducing a third modal style.
// Moderation (report/mute/block a sender, mute this whole chat) lives entirely in here, reading
// and writing the viewer's own `users/{uid}` doc directly via `useAuth()` — the parent game
// screens just render this panel and don't need to know any of it exists.
export const ChatPanel: React.FC<ChatPanelProps> = ({
  collectionName,
  gameId,
  messages,
  loading,
  myUid,
  myDisplayName,
  myPhotoURL,
  onClose,
  title = 'Game Chat',
  otherUids,
}) => {
  const { user, profile } = useAuth();
  // Back (Android gesture / browser back) closes this sheet instead of leaving the game screen behind it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handler = () => onCloseRef.current();
    pushModalBackHandler(handler);
    return () => popModalBackHandler(handler);
  }, []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Optimistic "sending" bubbles — shown immediately on tap (clock icon) rather than waiting for
  // the server round trip + live listener to actually surface the real message, which otherwise
  // left Send feeling laggy with no feedback at all in the meantime. `realId` is filled in once
  // the server responds with the actual Firestore doc id it just wrote (see handleSend) — the
  // effect below then removes this placeholder the moment `messages` (the live listener) actually
  // contains that id, so there's never a visible moment with BOTH a "shadow" pending bubble and
  // the real confirmed message on screen at once.
  interface PendingMessage { tempId: string; text: string; realId: string | null }
  const [pending, setPending] = useState<PendingMessage[]>([]);

  useEffect(() => {
    setPending((p) => p.filter((item) => !item.realId || !messages.some((m) => m.id === item.realId)));
  }, [messages]);

  const mutedUsers: string[] = profile?.mutedUsers || [];
  const mutedGameChats: string[] = profile?.mutedGameChats || [];
  const chatKey = `${collectionName}:${gameId}`;
  const chatMuted = mutedGameChats.includes(chatKey);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pending.length]);

  // Read receipts: while this panel is open (and every time a new message arrives while it's
  // still open), record "I've read up to now" for this chat — one doc per (chat, viewer), doc id
  // deterministic so this is always an update-in-place, never a growing history. Only actually
  // useful for the "Read" status below when the OTHER participant does the same from their side.
  useEffect(() => {
    if (!myUid || !gameId) return;
    const readId = `${collectionName}_${gameId}_${myUid}`;
    setDoc(
      doc(db, 'chatReads', readId),
      { collectionName, chatId: gameId, uid: myUid, lastReadAt: new Date().toISOString() },
      { merge: true },
    ).catch(() => {});
  }, [collectionName, gameId, myUid, messages.length]);

  // DM-only: zero out my own unread counter on the `directChats/{chatId}` parent doc the moment
  // this panel is open (and again whenever a new message arrives while it stays open) — this is
  // what clears the per-member badge in MembersChat.tsx and the nav bar's chat count. Restricted
  // to `directChats` since group/game chats don't have a parent-doc unread counter at all (see
  // firestore.rules — only `directChats/{chatId}` allows this client update).
  useEffect(() => {
    if (collectionName !== 'directChats' || !myUid || !gameId) return;
    updateDoc(doc(db, 'directChats', gameId), { [`unreadFor.${myUid}`]: 0 }).catch(() => {});
  }, [collectionName, gameId, myUid, messages.length]);

  // Other participants' read/delivery receipts for THIS chat — filtered to this collection/chat
  // client-side rather than a composite `where` (avoids needing a Firestore composite index for a
  // feature this lightweight; `chatId` values are Firestore auto-IDs, collision across
  // collections is a non-concern). Only fetched when there's actually someone to check against.
  const [readsValue] = useCollection(
    otherUids && otherUids.length > 0 ? query(collection(db, 'chatReads'), where('chatId', '==', gameId)) : null,
  );
  const readAtByUid = useMemo(() => {
    const map = new Map<string, string>();
    readsValue?.docs.forEach((d) => {
      const data = d.data() as any;
      if (data.collectionName === collectionName) map.set(data.uid, data.lastReadAt);
    });
    return map;
  }, [readsValue, collectionName]);

  const [deliveredValue] = useCollection(
    otherUids && otherUids.length > 0 ? query(collection(db, 'chatDelivered'), where('chatId', '==', gameId)) : null,
  );
  const deliveredAtByUid = useMemo(() => {
    const map = new Map<string, string>();
    deliveredValue?.docs.forEach((d) => {
      const data = d.data() as any;
      if (data.collectionName === collectionName) map.set(data.uid, data.lastDeliveredAt);
    });
    return map;
  }, [deliveredValue, collectionName]);

  // WhatsApp-style per-message status — every one of YOUR OWN messages gets its own ticks (not
  // just the latest), each compared independently against every other participant's read/
  // delivered timestamps as of THAT message's own createdAt.
  const getMessageStatus = (msg: ChatMessage): 'sent' | 'delivered' | 'read' => {
    if (!otherUids || otherUids.length === 0) return 'sent';
    if (otherUids.every((uid) => (readAtByUid.get(uid) || '') >= msg.createdAt)) return 'read';
    if (otherUids.every((uid) => (deliveredAtByUid.get(uid) || '') >= msg.createdAt)) return 'delivered';
    return 'sent';
  };

  // Posted through the server (not a direct Firestore write) so the other participants can get a
  // push notification in the same request — see /api/chat/send in server.ts. The message itself
  // still shows up here purely via the live `comments` listener in useGameChat, same as before.
  const handleSend = () => sendText(text);
  const sendText = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || sending || !user) return;
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending((p) => [...p, { tempId, text: trimmed, realId: null }]);
    setText('');
    setSending(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionName, chatId: gameId, text: trimmed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to send message.');
      // Tag this placeholder with the real doc id the server just wrote — the effect above takes
      // it from here, clearing the placeholder the instant that id shows up in `messages`.
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, realId: json?.id || null } : m)));
    } catch (err) {
      console.error('Failed to send message:', err);
      setPending((p) => p.filter((m) => m.tempId !== tempId));
    } finally {
      setSending(false);
    }
  };

  const toggleMuteChat = async () => {
    await updateDoc(doc(db, 'users', myUid), {
      mutedGameChats: chatMuted ? arrayRemove(chatKey) : arrayUnion(chatKey),
    }).catch((err) => console.error('Failed to toggle chat mute:', err));
  };

  const toggleMuteUser = async (uid: string) => {
    await updateDoc(doc(db, 'users', myUid), {
      mutedUsers: mutedUsers.includes(uid) ? arrayRemove(uid) : arrayUnion(uid),
    }).catch((err) => console.error('Failed to toggle user mute:', err));
  };

  // Blocking removes the sender from view immediately for the blocker (the `messages` prop is
  // already filtered against `blockedUsers` upstream in `useGameChat`, which re-renders as soon
  // as this write lands) — always a block, never a toggle-to-unblock from inside the chat itself,
  // since an unblock needs the person's messages to be visible again to pick them back out, which
  // by definition they no longer are here. Unblocking lives in Profile settings instead.
  const blockUser = async (uid: string) => {
    if (!window.confirm('Block this player? You will no longer see their messages in any game chat.')) return;
    await updateDoc(doc(db, 'users', myUid), { blockedUsers: arrayUnion(uid) }).catch((err) =>
      console.error('Failed to block user:', err),
    );
    // A block silently drops any existing friendship — firestore.rules lets either participant
    // delete a friendships doc directly, no server round-trip needed. Best-effort: if this fails
    // (e.g. no friendship existed) it's not worth surfacing, the block itself already succeeded.
    const friendshipDocId = myUid < uid ? `${myUid}_${uid}` : `${uid}_${myUid}`;
    deleteDoc(doc(db, 'friendships', friendshipDocId)).catch(() => {});
  };

  // Deleting your own message is a direct client write, not a moderation action — Firestore
  // rules already let a comment's author delete it themselves (same as every other comment
  // thread in this app).
  const handleDeleteMessage = async (commentId: string) => {
    if (!window.confirm('Delete this message?')) return;
    try {
      await deleteDoc(doc(db, collectionName, gameId, 'comments', commentId));
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  };

  // Editing, same as delete, is a direct client write restricted (by the Firestore rules) to just
  // the `text` + `editedAt` fields of your OWN message — never `userId`/`createdAt`/etc.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const startEdit = (m: ChatMessage) => {
    setMenuForId(null);
    setEditingId(m.id);
    setEditText(m.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleSaveEdit = async () => {
    const trimmed = editText.trim();
    if (!editingId || !trimmed) return;
    try {
      await updateDoc(doc(db, collectionName, gameId, 'comments', editingId), {
        text: trimmed,
        editedAt: new Date().toISOString(),
      });
      cancelEdit();
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  };

  const reportMessage = async (m: ChatMessage) => {
    if (!window.confirm(`Report this message from ${m.displayName} for review?`)) return;
    try {
      await addDoc(collection(db, 'chatReports'), {
        gameType: collectionName,
        gameId,
        commentId: m.id,
        messageText: m.text,
        messageUserId: m.userId,
        messageUserName: m.displayName,
        reportedBy: myUid,
        reportedByName: myDisplayName,
        createdAt: new Date().toISOString(),
        resolved: false,
      });
    } catch (err) {
      console.error('Failed to report message:', err);
    }
  };

  // ── Look of the conversation ────────────────────────────────────────────────────────────────────
  // Group chats (more than one other person) give every sender their own tint and show names; a one-to-one chat
  // stays plain white-vs-navy. Day separators and a time on each bubble, like any messenger.
  const isGroupChat = (otherUids?.length || 0) > 1;
  const initial = (title || '?').trim().slice(0, 1).toUpperCase();
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const QUICK_REPLIES = ['👍', 'Sounds good', 'On my way', 'Thanks!'];

  return (
    <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm hidden sm:block" onClick={onClose} />
      <div className="relative w-full h-full sm:h-[640px] sm:max-w-md bg-white sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] sm:pt-0">
        <div className="px-3 py-2.5 border-b border-slate-200 flex items-center gap-2.5 shrink-0 bg-white">
          <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-700 shrink-0" aria-label="Back">
            <span className="material-symbols-outlined text-[22px]">arrow_back</span>
          </button>
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-700 to-slate-800 text-white font-black flex items-center justify-center shrink-0">{initial}</div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-black text-slate-900 truncate leading-tight">{title}</h2>
            <p className="text-[10.5px] font-bold text-slate-500 leading-tight">{isGroupChat ? `${(otherUids?.length || 0) + 1} people` : chatMuted ? 'Muted' : 'Tap ⋮ on a message for options'}</p>
          </div>
          <button
            onClick={toggleMuteChat}
            className={`w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center ${chatMuted ? 'text-red-600' : 'text-slate-500'}`}
            aria-label={chatMuted ? 'Unmute this chat' : 'Mute this chat'}
            title={chatMuted ? 'Unmute this chat' : 'Mute this chat'}
          >
            <span className="material-symbols-outlined text-[20px]">{chatMuted ? 'notifications_off' : 'notifications'}</span>
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 bg-gradient-to-b from-[#eef4f5] to-[#f6f9f9]">
          {loading && <p className="text-sm text-slate-500 text-center">Loading…</p>}
          {!loading && messages.length === 0 && (
            <p className="text-sm text-slate-500 italic text-center py-6">No messages yet — say hi!</p>
          )}
          {messages.map((m, idx) => {
            const mine = m.userId === myUid;
            const isMuted = mutedUsers.includes(m.userId);
            const isEditing = editingId === m.id;
            const showDay = idx === 0 || new Date(messages[idx - 1].createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const prev = messages[idx - 1];
            const firstOfRun = !prev || prev.userId !== m.userId || showDay;
            const tint = SENDER_TINTS[hashIndex(m.userId, SENDER_TINTS.length)];
            return (
              <React.Fragment key={m.id}>
                {showDay && (
                  <div className="flex justify-center py-1.5">
                    <span className="text-[9.5px] font-extrabold text-slate-500 bg-slate-200/80 rounded-full px-3 py-0.5">{dayLabel(m.createdAt)}</span>
                  </div>
                )}
                <div className={`flex ${mine ? 'justify-end' : 'justify-start'} gap-1.5`}>
                  {!mine && isGroupChat && (
                    <div className="w-6 h-6 rounded-full shrink-0 self-end overflow-hidden text-white text-[9px] font-black flex items-center justify-center" style={{ backgroundColor: tint.name }}>
                      {m.photoURL ? <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (m.displayName || '?').slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className={`max-w-[78%] ${mine ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
                    {!mine && (isGroupChat ? firstOfRun : false) && (
                      <div className="flex items-center gap-1 px-1">
                        <p className="text-[10px] font-black" style={{ color: tint.name }}>{m.displayName}</p>
                        {isMuted && <span className="text-[9px] font-bold text-slate-400 uppercase">Muted</span>}
                      </div>
                    )}
                    {mine && isEditing && (
                      <div className="w-full min-w-[220px] space-y-1.5">
                        <input
                          type="text"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                          maxLength={500}
                          autoFocus
                          className="w-full text-sm px-3 py-2 rounded-2xl border border-teal-600/50 outline-none bg-white"
                        />
                        <div className="flex justify-end gap-2">
                          <button onClick={cancelEdit} className="text-[10px] font-black text-slate-500 px-2 py-1">Cancel</button>
                          <button onClick={handleSaveEdit} disabled={!editText.trim()} className="text-[10px] font-black text-white bg-teal-700 px-3 py-1 rounded-full disabled:opacity-40">Save</button>
                        </div>
                      </div>
                    )}
                    {!isEditing && (
                      <div className={`flex items-end gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                        {mine && (
                          <button onClick={() => setMenuForId(menuForId === m.id ? null : m.id)} className="mb-1 shrink-0 text-slate-400" aria-label="Message options">
                            <span className="material-symbols-outlined text-[15px] block">more_vert</span>
                          </button>
                        )}
                        <div
                          className={`px-3 py-2 rounded-[18px] break-words text-[13px] font-semibold leading-snug shadow-[0_1px_1.5px_rgba(0,0,0,0.06)] ${
                            mine
                              ? 'bg-[#0b3b4f] text-white rounded-br-md'
                              : `${isGroupChat ? '' : 'bg-white border border-slate-200 text-slate-900'} rounded-bl-md text-slate-900 ${isMuted ? 'opacity-50' : ''}`
                          }`}
                          style={!mine && isGroupChat ? { backgroundColor: tint.bg, border: `1px solid ${tint.border}` } : undefined}
                        >
                          {m.text}
                          <span className={`block text-right text-[9px] font-bold mt-0.5 ${mine ? 'text-white/60' : 'text-slate-400'}`}>
                            {timeOf(m.createdAt)}{m.editedAt ? ' · edited' : ''}
                          </span>
                        </div>
                        {!mine && (
                          <button onClick={() => setMenuForId(menuForId === m.id ? null : m.id)} className="mb-1 shrink-0 text-slate-400" aria-label="Message options">
                            <span className="material-symbols-outlined text-[15px] block">more_vert</span>
                          </button>
                        )}
                      </div>
                    )}
                    {!mine && menuForId === m.id && (
                      <div className="flex gap-1.5 px-1 pt-0.5 flex-wrap justify-start">
                        <button onClick={() => { reportMessage(m); setMenuForId(null); }} className="text-[10px] font-black text-red-600 px-2 py-1 bg-red-50 rounded-full">Report</button>
                        <button onClick={() => { toggleMuteUser(m.userId); setMenuForId(null); }} className="text-[10px] font-black text-slate-600 px-2 py-1 bg-slate-100 rounded-full">{isMuted ? 'Unmute' : 'Mute'} {m.displayName}</button>
                        <button onClick={() => { blockUser(m.userId); setMenuForId(null); }} className="text-[10px] font-black text-red-600 px-2 py-1 bg-red-50 rounded-full">Block {m.displayName}</button>
                      </div>
                    )}
                    {mine && menuForId === m.id && !isEditing && (
                      <div className="flex gap-1.5 px-1 pt-0.5 justify-end">
                        <button onClick={() => startEdit(m)} className="text-[10px] font-black text-teal-700 px-2 py-1 bg-teal-50 rounded-full">Edit</button>
                        <button onClick={() => { handleDeleteMessage(m.id); setMenuForId(null); }} className="text-[10px] font-black text-red-600 px-2 py-1 bg-red-50 rounded-full">Delete</button>
                      </div>
                    )}
                    {mine && !isEditing && (
                      <div className="self-end flex items-center gap-0.5 px-1 -mt-0.5">
                        <MessageStatusTicks status={getMessageStatus(m)} />
                      </div>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {pending.map((p) => (
            <div key={p.tempId} className="flex justify-end">
              <div className="max-w-[78%] items-end flex flex-col gap-0.5">
                <div className="px-3 py-2 rounded-[18px] rounded-br-md break-words text-[13px] font-semibold bg-[#0b3b4f]/60 text-white">{p.text}</div>
                <div className="self-end flex items-center gap-0.5 px-1">
                  <MessageStatusTicks status="sending" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {!text && !loading && (
          <div className="px-3 pt-2 pb-1 flex gap-1.5 overflow-x-auto no-scrollbar bg-white border-t border-slate-100 shrink-0">
            {QUICK_REPLIES.map((q) => (
              <button key={q} onClick={() => sendText(q)} disabled={sending} className="shrink-0 text-[11px] font-extrabold text-teal-700 bg-teal-50 rounded-full px-3 py-1.5 disabled:opacity-50">{q}</button>
            ))}
          </div>
        )}
        <div
          className="px-3 py-2.5 bg-white border-t border-slate-100 flex items-center gap-2 shrink-0"
          style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}
        >
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            placeholder={`Message${title && title !== 'Game Chat' ? ` ${title}` : ''}…`}
            maxLength={500}
            className="flex-1 min-w-0 bg-slate-100 px-4 py-2.5 rounded-full text-[13px] font-semibold outline-none focus:ring-2 focus:ring-teal-600/20"
          />
          <button
            onClick={handleSend}
            disabled={sending || !text.trim()}
            className="w-10 h-10 bg-teal-700 text-white rounded-full disabled:opacity-40 shrink-0 flex items-center justify-center shadow-[0_4px_12px_rgba(15,118,110,0.3)]"
            aria-label="Send"
          >
            <span className="material-symbols-outlined text-[20px] block">send</span>
          </button>
        </div>
      </div>
    </div>
  );
};
