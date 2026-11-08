import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { useEdgeDock } from '../lib/useEdgeDock';

// The shopping-list icon on the home page, above the to-do icon (which is above the quest trophy). It shows how many items are still left to buy across
// your active lists, turns green when everything on them is bought, and is a quiet dashed "+" when you have no list yet. It opens the lists.
// It listens to your lists only while the home page is open, and uses the item counts each list keeps for itself (see ShoppingListDetail.tsx), so it
// never reads the items themselves.

type ListLite = { id: string; completed: boolean; itemCount: number | null; doneCount: number };

export default function ShoppingFab() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const onHome = location.pathname === '/';
  const [mine, setMine] = useState<ListLite[]>([]);
  const [shared, setShared] = useState<ListLite[]>([]);
  const [fromFriends, setFromFriends] = useState<ListLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const dock = useEdgeDock(52);

  useEffect(() => {
    if (!user || !onHome) return;
    const lite = (d: any): ListLite => {
      const data = d.data();
      return { id: d.id, completed: !!data.completed, itemCount: typeof data.itemCount === 'number' ? data.itemCount : null, doneCount: Number(data.doneCount) || 0 };
    };
    const unsubs: (() => void)[] = [];
    unsubs.push(onSnapshot(query(collection(db, 'shoppingLists'), where('userId', '==', user.uid)), (snap) => { setMine(snap.docs.map(lite)); setLoaded(true); }, () => setLoaded(true)));
    // lists friends shared with me directly
    unsubs.push(onSnapshot(query(collection(db, 'shoppingLists'), where('sharedWith', 'array-contains', user.uid)), (snap) => setFromFriends(snap.docs.map(lite)), () => setFromFriends([])));
    // lists shared into my groups
    unsubs.push(onSnapshot(query(collection(db, 'members'), where('userId', '==', user.uid)), (snap) => {
      const groupIds = snap.docs.map((d) => d.data().groupId).filter(Boolean).slice(0, 30);
      unsubs.push(groupIds.length > 0
        ? onSnapshot(query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)), (s) => setShared(s.docs.map(lite)), () => setShared([]))
        : () => {});
      if (groupIds.length === 0) setShared([]);
    }, () => {}));
    return () => unsubs.forEach((u) => u());
  }, [user?.uid, onHome]);

  if (!user || !onHome || !loaded) return null;

  const byId = new Map<string, ListLite>();
  [...mine, ...shared, ...fromFriends].forEach((l) => byId.set(l.id, l));
  const active = Array.from(byId.values()).filter((l) => !l.completed);
  const itemsLeft = active.reduce((sum, l) => sum + (l.itemCount === null ? 0 : Math.max(0, l.itemCount - l.doneCount)), 0);

  let state: 'left' | 'ready' | 'idle' | 'none';
  if (itemsLeft > 0) state = 'left';
  else if (active.some((l) => (l.itemCount || 0) > 0)) state = 'ready'; // everything on the active lists is bought
  else if (active.length > 0) state = 'idle'; // lists with nothing on them yet
  else state = 'none';

  const look = {
    left: { border: '#0f7a8f', icon: 'shopping_cart', color: '#0f7a8f', fill: 1, label: `${itemsLeft} item${itemsLeft === 1 ? '' : 's'} left to buy` },
    ready: { border: '#22c55e', icon: 'shopping_cart_checkout', color: '#16a34a', fill: 1, label: 'Everything is bought, finish shopping' },
    idle: { border: '#38bdf8', icon: 'shopping_cart', color: '#0284c7', fill: 1, label: 'Shopping lists' },
    none: { border: '#cbd5e1', icon: 'add_shopping_cart', color: '#64748b', fill: 0, label: 'Start a shopping list' },
  }[state];

  // above the to-do icon (52px + gap), which is above the quest trophy (60px + gap) when that is showing
  const lift = (profile?.questsEnabled !== false ? 72 : 0) + 64;

  return (
    <button
      type="button"
      onClick={() => navigate(state === 'none' ? '/shopping-lists?new=1' : '/shopping-lists')}
      aria-label={look.label}
      title={look.label}
      {...dock.handlers}
      className="fixed left-4 z-40 w-[52px] h-[52px] rounded-full bg-white shadow-lg flex items-center justify-center"
      style={{ ...dock.style, bottom: `calc(4rem + env(safe-area-inset-bottom) + 12px + ${lift}px)`, border: `3px ${state === 'none' ? 'dashed' : 'solid'} ${look.border}` }}
    >
      <span className="material-symbols-outlined text-[26px]" style={{ color: look.color, fontVariationSettings: `'FILL' ${look.fill}` }}>{look.icon}</span>
      {state === 'left' && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-[#0f7a8f] text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white">{itemsLeft > 99 ? '99+' : itemsLeft}</span>
      )}
      {state === 'ready' && (
        <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-green-500 ring-2 ring-white flex items-center justify-center">
          <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>
        </span>
      )}
    </button>
  );
}
