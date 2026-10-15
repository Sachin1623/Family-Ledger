import { pushModalBackHandler, popModalBackHandler } from '../lib/modalBackHandler';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, arrayRemove, arrayUnion, collection, deleteDoc, doc, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { isPresenceOnline, lastSeenLabel } from '../lib/presence';
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
  reactions?: Record<string, string>; // uid → emoji, one per person
  replyTo?: { id: string; displayName: string; text: string };
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
const MessageStatusTicks: React.FC<{ status: 'sending' | 'sent' | 'delivered' | 'read'; onDark?: boolean }> = ({ status, onDark }) => {
  const dim = onDark ? 'text-white/70' : 'text-text-muted/60';
  if (status === 'sending') {
    return <span className={`material-symbols-outlined text-[11px] ${dim}`} aria-label="Sending">schedule</span>;
  }
  if (status === 'sent') {
    return <span className={`material-symbols-outlined text-[13px] ${dim}`} aria-label="Sent">done</span>;
  }
  return (
    <span
      className={`material-symbols-outlined text-[13px] ${status === 'read' ? (onDark ? 'text-sky-300' : 'text-primary') : dim}`}
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
  // The message being answered (set from the press-and-hold menu); shown above the message box, sent with the message.
  const [replyTarget, setReplyTarget] = useState<{ id: string; displayName: string; text: string } | null>(null);
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
  interface PendingMessage { tempId: string; text: string; realId: string | null; at: number; replyTo?: { id: string; displayName: string; text: string } | null }
  const [pending, setPending] = useState<PendingMessage[]>([]);

  useEffect(() => {
    setPending((p) => p.filter((item) => !item.realId || !messages.some((m) => m.id === item.realId)));
  }, [messages]);

  const mutedUsers: string[] = profile?.mutedUsers || [];
  const mutedGameChats: string[] = profile?.mutedGameChats || [];
  // The live listener can deliver the real message BEFORE the send request returns (so before a placeholder is tagged
  // with its real id) — for those moments both the placeholder and the real message would show. Pair each placeholder
  // with a message of mine that has the same text and arrived after it was sent, and hide the placeholder at once.
  const visiblePending = useMemo(() => {
    const used = new Set<string>();
    return pending.filter((p) => {
      const match = messages.find((m) => !used.has(m.id) && m.userId === myUid && m.text === p.text && new Date(m.createdAt).getTime() >= p.at - 120000);
      if (match) { used.add(match.id); return false; }
      return true;
    });
  }, [pending, messages, myUid]);

  const chatKey = `${collectionName}:${gameId}`;
  const chatMuted = mutedGameChats.includes(chatKey);

  // Stick to the bottom for new messages — unless you've scrolled up to read older ones, in which case a "Latest" button
  // (with a count of what arrived) appears instead of yanking you down. Your own messages always scroll into view.
  const [newBelow, setNewBelow] = useState(0);
  const prevCountRef = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const added = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 260;
    const last = messages[messages.length - 1];
    if (nearBottom || added <= 0 || last?.userId === myUid) {
      el.scrollTo({ top: el.scrollHeight });
    } else {
      setNewBelow((n) => n + added);
    }
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [pending.length]);

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
    setPending((p) => [...p, { tempId, text: trimmed, realId: null, at: Date.now(), replyTo: replyTarget }]);
    const replyPayload = replyTarget;
    setReplyTarget(null);
    setText('');
    setSending(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionName, chatId: gameId, text: trimmed, ...(replyPayload ? { replyTo: replyPayload } : {}) }),
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

  // ── Look of the conversation (cosy theme) ───────────────────────────────────────────────────────
  // Teal header with the person's photo and live status, a faintly patterned wallpaper, small avatars beside the other
  // person's messages, reactions on any message, an emoji picker, and a jump-to-latest arrow when scrolled up.
  const isGroupChat = (otherUids?.length || 0) > 1;
  const dmOtherUid = collectionName === 'directChats' && otherUids?.length === 1 ? otherUids[0] : null;
  const [otherUserSnap] = useDocument(dmOtherUid ? doc(db, 'users', dmOtherUid) : null);
  const otherUser = otherUserSnap?.data() as any;
  const displayTitle = (title || '').replace(/^Chat with /, '') || 'Chat';
  const headerPhoto: string | undefined = otherUser?.photoURL;
  const online = isPresenceOnline(otherUser);
  const headerSub = dmOtherUid
    ? online ? 'Online' : lastSeenLabel(otherUser) === 'Never active' ? '' : `Last seen ${lastSeenLabel(otherUser)}`
    : isGroupChat ? `${(otherUids?.length || 0) + 1} people` : '';
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };

  // Reactions: one emoji per person per message, saved through the server (it checks you're in the chat).
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤔', '😅', '😉', '🙂', '🙃', '😴', '😢', '😭', '😡', '🥳', '🤩', '😇', '🤗', '😋', '😬', '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '👌', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '🎉', '✅', '❌', '⭐', '💯', '🍕', '☕', '🎂', '🚗'];
  const [reactionOverrides, setReactionOverrides] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setReactionOverrides((o) => {
      const next: Record<string, string | null> = {};
      let changed = false;
      (Object.entries(o) as [string, string | null][]).forEach(([id, v]) => {
        const server = messages.find((m) => m.id === id)?.reactions?.[myUid] ?? null;
        if (server === v) changed = true; else next[id] = v;
      });
      return changed ? next : o;
    });
  }, [messages, myUid]);
  const reactionsOf = (m: ChatMessage): Record<string, string> => {
    const base: Record<string, string> = { ...(m.reactions || {}) };
    if (m.id in reactionOverrides) {
      const v = reactionOverrides[m.id];
      if (v) base[myUid] = v; else delete base[myUid];
    }
    return base;
  };
  const reactTo = async (m: ChatMessage, emoji: string) => {
    setMenuForId(null);
    if (!user) return;
    const current = reactionsOf(m)[myUid] || null;
    const next = current === emoji ? null : emoji; // tapping your own reaction again removes it
    setReactionOverrides((o) => ({ ...o, [m.id]: next }));
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/chat/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionName, chatId: gameId, commentId: m.id, emoji: next }),
      });
      if (!res.ok) throw new Error('react failed');
    } catch (err) {
      console.error('Failed to react:', err);
      setReactionOverrides((o) => { const { [m.id]: _drop, ...rest } = o; return rest; });
    }
  };

  const [showEmoji, setShowEmoji] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(away > 260);
    if (away < 80) setNewBelow(0);
  };
  const menuMessage = menuForId ? messages.find((x) => x.id === menuForId) || null : null;

  // The quoted message at the top of a reply; tapping it scrolls to the original (when it's still in the chat).
  const jumpToMessage = (id: string) => {
    const el = listRef.current?.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-amber-300');
    setTimeout(() => el.classList.remove('ring-2', 'ring-amber-300'), 1400);
  };
  const quoteBlock = (q: { id: string; displayName: string; text: string }, onDarkBubble: boolean) => (
    <div
      onClick={(e) => { e.stopPropagation(); jumpToMessage(q.id); }}
      className={`mb-1 rounded-lg border-l-[3px] px-2 py-1 cursor-pointer ${onDarkBubble ? 'bg-white/15 border-sky-300' : 'bg-black/5 border-teal-500'}`}
    >
      <p className={`text-[10px] font-black truncate ${onDarkBubble ? 'text-sky-200' : 'text-teal-700'}`}>{q.displayName || 'Message'}</p>
      <p className={`text-[11.5px] font-semibold line-clamp-2 ${onDarkBubble ? 'text-white/85' : 'text-slate-600'}`}>{q.text}</p>
    </div>
  );

  // Press and hold a message (about half a second) to open its menu — a plain tap does nothing, so scrolling and
  // selecting never opens it by accident.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const holdHandlers = (id: string) => ({
    onTouchStart: () => { cancelHold(); holdTimer.current = setTimeout(() => { holdTimer.current = null; setMenuForId(id); try { navigator.vibrate?.(15); } catch { /* not supported */ } }, 450); },
    onTouchEnd: cancelHold,
    onTouchMove: cancelHold,
    onTouchCancel: cancelHold,
    onMouseDown: () => { cancelHold(); holdTimer.current = setTimeout(() => { holdTimer.current = null; setMenuForId(id); }, 450); },
    onMouseUp: cancelHold,
    onMouseLeave: cancelHold,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); cancelHold(); setMenuForId(id); },
  });

  return (
    <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm hidden sm:block" onClick={onClose} />
      <div className="relative w-full h-full sm:h-[640px] sm:max-w-md bg-white sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] sm:pt-0">
        <div className="px-3 py-2.5 flex items-center gap-2.5 shrink-0 text-white" style={{ background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' }}>
          <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-white/15 flex items-center justify-center shrink-0" aria-label="Back">
            <span className="material-symbols-outlined text-[22px]">arrow_back</span>
          </button>
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-full bg-white/20 overflow-hidden flex items-center justify-center font-black">
              {headerPhoto ? <img src={headerPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : displayTitle.slice(0, 1).toUpperCase()}
            </div>
            {dmOtherUid && online && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#0f766e]" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-black truncate leading-tight">{displayTitle}</h2>
            {headerSub && <p className={`text-[10.5px] font-bold leading-tight ${online ? 'text-emerald-200' : 'text-teal-100/80'}`}>{headerSub}</p>}
          </div>
          <button
            onClick={toggleMuteChat}
            className={`w-9 h-9 rounded-full hover:bg-white/15 flex items-center justify-center ${chatMuted ? 'text-red-200' : 'text-white/90'}`}
            aria-label={chatMuted ? 'Unmute this chat' : 'Mute this chat'}
            title={chatMuted ? 'Unmute this chat' : 'Mute this chat'}
          >
            <span className="material-symbols-outlined text-[20px]">{chatMuted ? 'notifications_off' : 'notifications'}</span>
          </button>
        </div>

        <div className="relative flex-1 min-h-0">
          <div
            ref={listRef}
            onScroll={onListScroll}
            className="absolute inset-0 overflow-y-auto px-2.5 py-3 space-y-[3px]"
            style={{ backgroundColor: '#eaf3f2', backgroundImage: 'radial-gradient(rgba(15,118,110,0.09) 1.5px, transparent 1.5px)', backgroundSize: '22px 22px' }}
          >
            {loading && <p className="text-sm text-slate-500 text-center">Loading…</p>}
            {!loading && messages.length === 0 && <p className="text-sm text-slate-500 italic text-center py-6">No messages yet — say hi!</p>}
            {messages.map((m, idx) => {
              const mine = m.userId === myUid;
              const isMuted = mutedUsers.includes(m.userId);
              const isEditing = editingId === m.id;
              const prev = messages[idx - 1];
              const next = messages[idx + 1];
              const showDay = idx === 0 || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const firstOfRun = !prev || prev.userId !== m.userId || showDay;
              const lastOfRun = !next || next.userId !== m.userId || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const tint = SENDER_TINTS[hashIndex(m.userId, SENDER_TINTS.length)];
              const rx = reactionsOf(m);
              const rxCounts = Object.values(rx).reduce<Record<string, number>>((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {});
              return (
                <React.Fragment key={m.id}>
                  {showDay && (
                    <div className="flex justify-center py-1.5">
                      <span className="text-[9.5px] font-extrabold text-slate-500 bg-white/80 rounded-full px-3 py-0.5 shadow-sm">{dayLabel(m.createdAt)}</span>
                    </div>
                  )}
                  {firstOfRun && idx > 0 && !showDay && <div className="h-1.5" />}
                  <div className={`flex ${mine ? 'justify-end' : 'justify-start'} gap-1.5 items-end`}>
                    {!mine && (
                      <div className="w-6 shrink-0">
                        {lastOfRun && (
                          <div className="w-6 h-6 rounded-full overflow-hidden text-white text-[9px] font-black flex items-center justify-center" style={{ backgroundColor: isGroupChat ? tint.name : '#0f766e' }}>
                            {m.photoURL ? <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (m.displayName || '?').slice(0, 1).toUpperCase()}
                          </div>
                        )}
                      </div>
                    )}
                    <div className={`max-w-[78%] flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                      {!mine && isGroupChat && firstOfRun && (
                        <p className="text-[10px] font-black px-1 mb-0.5" style={{ color: tint.name }}>{m.displayName}{isMuted && <span className="ml-1 text-[9px] font-bold text-slate-400 uppercase">Muted</span>}</p>
                      )}
                      {mine && isEditing ? (
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
                      ) : (
                        <div
                          {...holdHandlers(m.id)}
                          data-msg-id={m.id}
                          className={`select-none [-webkit-touch-callout:none] px-3 pt-1.5 pb-1 break-words text-[13px] font-semibold leading-snug shadow-[0_1px_1.5px_rgba(0,0,0,0.08)] active:brightness-95 ${
                            mine
                              ? `text-white rounded-[17px] ${firstOfRun ? 'rounded-tr-[6px]' : ''} ${lastOfRun ? 'rounded-br-[6px]' : ''}`
                              : `${isGroupChat ? '' : 'bg-white'} text-slate-900 rounded-[17px] ${firstOfRun ? 'rounded-tl-[6px]' : ''} ${lastOfRun ? 'rounded-bl-[6px]' : ''} ${isMuted ? 'opacity-50' : ''}`
                          }`}
                          style={mine ? { background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' } : isGroupChat ? { backgroundColor: tint.bg, border: `1px solid ${tint.border}` } : undefined}
                        >
                          {m.replyTo && quoteBlock(m.replyTo, mine)}
                          {m.text}
                          <span className={`flex items-center justify-end gap-0.5 text-[9px] font-bold mt-0.5 ${mine ? 'text-white/70' : 'text-slate-400'}`}>
                            {timeOf(m.createdAt)}{m.editedAt ? ' · edited' : ''}
                            {mine && <MessageStatusTicks status={getMessageStatus(m)} onDark />}
                          </span>
                        </div>
                      )}
                      {Object.keys(rxCounts).length > 0 && (
                        <div className={`flex gap-1 -mt-1.5 z-[1] ${mine ? 'mr-1' : 'ml-1'}`}>
                          {Object.entries(rxCounts).map(([e, n]) => (
                            <button key={e} onClick={() => reactTo(m, e)} className={`flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-extrabold bg-white shadow border ${rx[myUid] === e ? 'border-teal-500' : 'border-slate-200'}`}>
                              {e}{n > 1 && <span className="text-[9.5px] text-slate-500">{n}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            {visiblePending.map((p) => (
              <div key={p.tempId} className="flex justify-end">
                <div className="max-w-[78%] px-3 pt-1.5 pb-1 rounded-[17px] rounded-br-[6px] break-words text-[13px] font-semibold text-white shadow-[0_1px_1.5px_rgba(0,0,0,0.08)]" style={{ background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' }}>
                  {p.replyTo && quoteBlock(p.replyTo, true)}
                  {p.text}
                  <span className="flex items-center justify-end gap-0.5 text-[9px] font-bold mt-0.5 text-white/70"><MessageStatusTicks status="sending" onDark /></span>
                </div>
              </div>
            ))}
          </div>
          {showJump && (
            <button
              onClick={() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); setNewBelow(0); }}
              className="absolute right-3 bottom-3 h-10 pl-3 pr-2.5 rounded-full bg-white shadow-lg flex items-center gap-1 text-[11px] font-black text-teal-700 active:scale-95"
              aria-label="Go to latest message"
            >
              {newBelow > 0 ? `${newBelow} new` : 'Latest'}
              <span className="material-symbols-outlined text-[22px]">keyboard_arrow_down</span>
            </button>
          )}
        </div>

        {showEmoji && (
          <div className="bg-white border-t border-slate-100 px-2 py-2 grid grid-cols-8 gap-1 shrink-0 max-h-[148px] overflow-y-auto">
            {EMOJIS.map((e) => (
              <button key={e} onClick={() => setText((t) => (t + e).slice(0, 500))} className="text-[22px] py-1 rounded-lg active:bg-slate-100">{e}</button>
            ))}
          </div>
        )}
        {replyTarget && (
          <div className="px-3 pt-2 bg-white border-t border-slate-100 shrink-0">
            <div className="flex items-center gap-2 rounded-xl bg-teal-50 border-l-[3px] border-teal-600 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-black text-teal-700 truncate">Replying to {replyTarget.displayName}</p>
                <p className="text-[11.5px] font-semibold text-slate-600 truncate">{replyTarget.text}</p>
              </div>
              <button onClick={() => setReplyTarget(null)} className="text-slate-400 shrink-0" aria-label="Cancel reply"><span className="material-symbols-outlined text-[20px] block">close</span></button>
            </div>
          </div>
        )}
        <div className="px-2.5 py-2.5 bg-white border-t border-slate-100 flex items-center gap-2 shrink-0" style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}>
          <button onClick={() => setShowEmoji((v) => !v)} className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${showEmoji ? 'bg-teal-50 text-teal-700' : 'text-slate-500'}`} aria-label="Emoji">
            <span className="material-symbols-outlined text-[24px]">mood</span>
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            onFocus={() => setShowEmoji(false)}
            placeholder={`Message${displayTitle && displayTitle !== 'Game Chat' ? ` ${displayTitle}` : ''}…`}
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

        {/* Press and hold a message: react, copy, and (yours) edit or delete — (theirs) report, mute or block */}
        {menuMessage && (
          <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/35" onClick={() => setMenuForId(null)}>
            <div className="w-full bg-white rounded-t-3xl p-3 space-y-2 shadow-2xl" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
              <div className="flex justify-between px-1">
                {REACTIONS.map((e) => (
                  <button key={e} onClick={() => reactTo(menuMessage, e)} className={`text-[28px] w-11 h-11 rounded-full flex items-center justify-center active:scale-90 transition-transform ${reactionsOf(menuMessage)[myUid] === e ? 'bg-teal-50' : ''}`}>{e}</button>
                ))}
              </div>
              <div className="border-t border-slate-100 pt-1">
                <button onClick={() => { setReplyTarget({ id: menuMessage.id, displayName: menuMessage.userId === myUid ? 'You' : menuMessage.displayName, text: menuMessage.text.slice(0, 140) }); setMenuForId(null); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-slate-800 active:bg-slate-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px] text-slate-500">reply</span>Reply</button>
                <button onClick={() => { navigator.clipboard?.writeText(menuMessage.text).catch(() => {}); setMenuForId(null); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-slate-800 active:bg-slate-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px] text-slate-500">content_copy</span>Copy</button>
                {menuMessage.userId === myUid ? (
                  <>
                    <button onClick={() => startEdit(menuMessage)} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-slate-800 active:bg-slate-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px] text-slate-500">edit</span>Edit</button>
                    <button onClick={() => { const id = menuMessage.id; setMenuForId(null); handleDeleteMessage(id); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-red-600 active:bg-red-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px]">delete</span>Delete</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { const mm = menuMessage; setMenuForId(null); reportMessage(mm); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-red-600 active:bg-red-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px]">flag</span>Report</button>
                    <button onClick={() => { const mm = menuMessage; setMenuForId(null); toggleMuteUser(mm.userId); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-slate-800 active:bg-slate-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px] text-slate-500">volume_off</span>{mutedUsers.includes(menuMessage.userId) ? 'Unmute' : 'Mute'} {menuMessage.displayName}</button>
                    <button onClick={() => { const mm = menuMessage; setMenuForId(null); blockUser(mm.userId); }} className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-extrabold text-red-600 active:bg-red-50 flex items-center gap-3"><span className="material-symbols-outlined text-[20px]">block</span>Block {menuMessage.displayName}</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
