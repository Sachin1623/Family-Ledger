import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFriendships } from '../lib/useFriendships';
import { acceptFriendRequest } from '../lib/friendsApi';

// "Your people" on Home: the people in my circle as avatars with a "+" to bring someone new, and a banner when a friend request is waiting for me
// (Accept right there). With nobody in the circle yet it becomes one friendly line with one button. It is how friends, family and invites stay in
// front of people instead of three taps deep.
//   quiet: while the Welcome checklist is showing, the empty "bring someone along" version stays hidden (the checklist already asks for an invite).
const HIDE_KEY = 'fl:peopleStripHiddenUntil';

export default function PeopleStrip({ quiet = false }: { quiet?: boolean }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { accepted, incomingPending, outgoingPending, usersByUid } = useFriendships(user?.uid);
  const [busy, setBusy] = useState(false);
  const [hiddenUntil, setHiddenUntil] = useState<number>(() => { try { return Number(localStorage.getItem(HIDE_KEY)) || 0; } catch { return 0; } });
  if (!user) return null;

  const first = incomingPending[0];
  const firstUser = first ? usersByUid.get(first.friendUid) : undefined;
  const hasCircle = accepted.length > 0;
  const emptyHidden = quiet || Date.now() < hiddenUntil;

  const accept = async () => {
    if (!first || busy) return;
    setBusy(true);
    try { await acceptFriendRequest(first.friendUid); } catch (err) { console.error('Could not accept the friend request:', err); } finally { setBusy(false); }
  };
  const hideForAWeek = () => {
    const until = Date.now() + 7 * 24 * 60 * 60 * 1000;
    setHiddenUntil(until);
    try { localStorage.setItem(HIDE_KEY, String(until)); } catch { /* storage unavailable */ }
  };

  const colors = ['#e07a5f', '#3d85c6', '#8e7cc3', '#f0a04b', '#2fa38a', '#c2578f'];
  const avatar = (uid: string, i: number) => {
    const u = usersByUid.get(uid);
    const name = u?.displayName || '?';
    return (
      <span key={uid} className="w-11 h-11 rounded-full overflow-hidden flex items-center justify-center text-white font-extrabold text-[15px] shrink-0" style={{ background: u?.photoURL ? undefined : colors[(name.charCodeAt(0) + i) % colors.length], boxShadow: '0 0 0 2.5px #fff, 0 0 0 4.5px #12b89a' }}>
        {u?.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : name.slice(0, 1).toUpperCase()}
      </span>
    );
  };

  // nothing to show: no circle yet and the quiet or hidden rules say stay away, and no request is waiting
  if (!first && !hasCircle && emptyHidden) return null;

  return (
    <section className="space-y-2.5" aria-label="Your people">
      {first && (
        <div className="flex items-center gap-3 rounded-2xl bg-[#effcf8] border border-[#b9ece0] px-3.5 py-2.5">
          <span className="w-9 h-9 rounded-full overflow-hidden bg-white flex items-center justify-center text-[#0b6b5a] font-extrabold shrink-0">
            {firstUser?.photoURL ? <img src={firstUser.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (firstUser?.displayName || '?').slice(0, 1).toUpperCase()}
          </span>
          <button type="button" onClick={() => navigate('/friends')} className="flex-1 min-w-0 text-left">
            <span className="block text-[13px] font-extrabold text-primary leading-tight truncate">{firstUser?.displayName || 'Someone'} wants to be your friend</span>
            {incomingPending.length > 1 && <span className="block text-[11.5px] text-text-muted">+{incomingPending.length - 1} more {incomingPending.length - 1 === 1 ? 'request' : 'requests'}</span>}
          </button>
          <button type="button" onClick={accept} disabled={busy} className="px-4 h-9 rounded-full bg-[#12b89a] text-[#06222f] text-xs font-extrabold disabled:opacity-50 active:scale-95 shrink-0">{busy ? '…' : 'Accept'}</button>
        </div>
      )}

      {hasCircle ? (
        <div className="rounded-2xl bg-white border border-border-subtle shadow-sm p-3.5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-extrabold text-primary">Your people</h3>
            <button type="button" onClick={() => navigate('/friends')} className="text-xs font-extrabold text-[#0b6b5a]">See all ›</button>
          </div>
          <div className="flex items-center gap-3.5 overflow-x-auto no-scrollbar py-1 px-1">
            {accepted.slice(0, 5).map((f, i) => avatar(f.friendUid, i))}
            <button type="button" onClick={() => navigate('/friends')} aria-label="Invite family or a friend" className="w-11 h-11 rounded-full flex items-center justify-center text-[#0b6b5a] border-2 border-dashed border-[#12b89a] shrink-0 active:scale-95">
              <span className="material-symbols-outlined text-[24px]">add</span>
            </button>
          </div>
          {(incomingPending.length > 0 || outgoingPending.length > 0) && (
            <div className="flex flex-wrap gap-2 mt-3 text-[11.5px] font-bold">
              {incomingPending.length > 0 && <span className="rounded-full bg-[#effcf8] text-[#0b6b5a] px-2.5 py-1">⏳ {incomingPending.length} waiting on you</span>}
              {outgoingPending.length > 0 && <span className="rounded-full bg-surface-container text-text-muted px-2.5 py-1">{outgoingPending.length} sent, not answered yet</span>}
            </div>
          )}
        </div>
      ) : !emptyHidden && (
        <div className="rounded-2xl bg-white border border-border-subtle shadow-sm p-3.5 flex items-center gap-3">
          <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0" style={{ background: 'linear-gradient(135deg,#effcf8,#fff7e6)' }}>👨‍👩‍👧‍👦</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-primary leading-tight">Bring someone along</p>
            <p className="text-xs text-text-muted leading-snug mt-0.5">Expenses are easier with family or a friend.</p>
          </div>
          <button type="button" onClick={() => navigate('/friends')} className="px-4 h-10 rounded-full bg-primary text-white text-xs font-extrabold active:scale-95 shrink-0">Invite</button>
          <button type="button" onClick={hideForAWeek} aria-label="Hide for a week" className="w-7 h-7 -mr-1 rounded-full text-text-muted flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-[18px]">close</span></button>
        </div>
      )}
    </section>
  );
}
