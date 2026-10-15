import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { collection, documentId, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useAllGroupMembers } from '../lib/useAllGroupMembers';
import { useFriendships } from '../lib/useFriendships';
import { groupIconEmoji } from '../lib/groupIcons';

export const FORWARD_MAX = 10;

interface Target {
  key: string; // `dm:{uid}` or `group:{id}`
  collectionName: 'directChats' | 'groups';
  chatId: string;
  name: string;
  photoURL?: string;
  emoji?: string;
}

// "Forward" — pick up to 10 other chats (people and groups) and send the message text to each. Only mounted while open,
// so its lists are read only when you actually forward something.
export default function ForwardPicker({ text, image, excludeKey, onClose }: { text: string; image?: string | null; excludeKey: string; onClose: () => void }) {
  const { user } = useAuth();
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId as string) || [], [membershipsValue]);
  const [groupsValue] = useCollection(groupIds.length > 0 ? query(collection(db, 'groups'), where(documentId(), 'in', groupIds.slice(0, 30))) : null);
  const { sortedMembers } = useAllGroupMembers(groupIds, user?.uid);
  const { accepted, usersByUid } = useFriendships(user?.uid);

  const targets: Target[] = useMemo(() => {
    if (!user) return [];
    const list: Target[] = [];
    (groupsValue?.docs || []).forEach((d) => {
      const g = d.data() as any;
      if (g.archived) return;
      list.push({ key: `group:${d.id}`, collectionName: 'groups', chatId: d.id, name: g.name || 'Group', emoji: groupIconEmoji(g.icon) });
    });
    const seen = new Set<string>();
    const addPerson = (uid: string, name: string, photoURL?: string) => {
      if (seen.has(uid) || uid === user.uid) return;
      seen.add(uid);
      list.push({ key: `dm:${uid}`, collectionName: 'directChats', chatId: [user.uid, uid].sort().join('_'), name, photoURL });
    };
    sortedMembers.forEach((m: any) => addPerson(m.userId, m.displayName || 'Someone', m.photoURL));
    accepted.forEach(({ friendUid }) => addPerson(friendUid, usersByUid.get(friendUid)?.displayName || 'Someone', usersByUid.get(friendUid)?.photoURL));
    return list.filter((tg) => tg.key !== excludeKey);
  }, [groupsValue, sortedMembers, accepted, usersByUid, user, excludeKey]);

  const q = search.trim().toLowerCase();
  const shown = q ? targets.filter((tg) => tg.name.toLowerCase().includes(q)) : targets;

  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= FORWARD_MAX ? p : [...p, key]));

  const send = async () => {
    if (!user || picked.length === 0 || sending) return;
    setSending(true);
    let ok = 0;
    try {
      const idToken = await user.getIdToken();
      for (const key of picked) {
        const tg = targets.find((x) => x.key === key);
        if (!tg) continue;
        try {
          const res = await fetch('/api/chat/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ collectionName: tg.collectionName, chatId: tg.chatId, text, ...(image ? { image } : {}), forwarded: true }),
          });
          if (res.ok) ok += 1;
        } catch (err) {
          console.error('Forward failed for', key, err);
        }
      }
    } finally {
      setSending(false);
    }
    setResult(ok === picked.length ? `Forwarded to ${ok} chat${ok === 1 ? '' : 's'}` : `Forwarded to ${ok} of ${picked.length} chats`);
    setTimeout(onClose, 1300);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white">
      <div className="px-3 py-2.5 flex items-center gap-2 text-white shrink-0" style={{ background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' }}>
        <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-white/15 flex items-center justify-center" aria-label="Close">
          <span className="material-symbols-outlined text-[22px]">close</span>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-[14.5px] font-black leading-tight">Forward to…</p>
          <p className="text-[10.5px] font-bold text-teal-100/90">{picked.length} of {FORWARD_MAX} chats selected</p>
        </div>
      </div>
      <div className="px-3 py-2 border-b border-slate-100 shrink-0">
        <div className="bg-slate-100 rounded-full px-3 py-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-slate-400">search</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people and groups…" className="flex-1 min-w-0 bg-transparent outline-none text-[13px] font-semibold" />
        </div>
        <p className="mt-2 text-[11px] font-semibold text-slate-500 truncate px-1">{image ? '📷 Photo' : ''}{image && text ? ' · ' : ''}{text ? `“${text.length > 90 ? `${text.slice(0, 90)}…` : text}”` : ''}</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="p-6 text-sm text-slate-500 italic text-center">No chats to show.</p>}
        {shown.map((tg) => {
          const on = picked.includes(tg.key);
          const disabled = !on && picked.length >= FORWARD_MAX;
          return (
            <button key={tg.key} type="button" onClick={() => toggle(tg.key)} disabled={disabled} className={clsx('w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-slate-50', disabled && 'opacity-40')}>
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-teal-700 to-slate-800 text-white font-black flex items-center justify-center shrink-0 text-base">
                {tg.photoURL ? <img src={tg.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : tg.emoji || tg.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-extrabold text-slate-900 truncate">{tg.name}</p>
                <p className="text-[10.5px] font-semibold text-slate-400">{tg.collectionName === 'groups' ? 'Group' : 'Person'}</p>
              </div>
              <span className={clsx('w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0', on ? 'bg-teal-700 border-teal-700 text-white' : 'border-slate-300')}>
                {on && <span className="material-symbols-outlined text-[16px]">check</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="px-3 py-3 border-t border-slate-100 shrink-0" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {result ? (
          <p className="text-center text-sm font-black text-teal-700 py-2.5">{result}</p>
        ) : (
          <button onClick={send} disabled={picked.length === 0 || sending} className="w-full py-3 rounded-2xl bg-teal-700 text-white text-[14px] font-black disabled:opacity-40 shadow-[0_6px_16px_rgba(15,118,110,0.3)]">
            {sending ? 'Forwarding…' : picked.length === 0 ? 'Pick up to 10 chats' : `Forward to ${picked.length} chat${picked.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </div>
  );
}
