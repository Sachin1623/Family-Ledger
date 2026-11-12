import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// "Getting started" card on Home for people who joined recently. One obvious next step at a time, with a progress bar, so a first-time
// person is never left wondering what to do. It goes away by itself once every step is done. "Hide" folds it into a one-line bar that still shows the progress; tapping the bar opens it again.
const DISMISS_KEY = 'fl:welcomeChecklistHidden';
const NEW_USER_DAYS = 14;

type Props = {
  groupIds: string[];             // the person's active groups
  hasOtherMembers: boolean;       // any of those groups has more than one member
  onTour?: () => void;
  onHide?: () => void;
};

// The card is never fully hidden any more (Hide only folds it into a bar), so the rest of the page can always rely on it being there.
export function isWelcomeHidden(): boolean {
  return false;
}

export function useIsNewUser(): boolean {
  const { user } = useAuth();
  const created = user?.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : NaN;
  return Number.isFinite(created) && Date.now() - created < NEW_USER_DAYS * 86_400_000;
}

export default function WelcomeChecklist({ groupIds, hasOtherMembers, onTour, onHide }: Props) {
  const navigate = useNavigate();
  const { profile, user } = useAuth();
  const isNew = useIsNewUser();
  const [minimized, setMinimized] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
  const [hasExpense, setHasExpense] = useState<boolean | null>(null);
  // "I'll go solo": someone who does not want to invite anyone can close that step themselves (remembered on this phone)
  const soloKey = `fl:welcomeSolo:${user?.uid || ''}`;
  const [solo, setSolo] = useState(() => { try { return localStorage.getItem(soloKey) === '1'; } catch { return false; } });
  const goSolo = () => { setSolo(true); try { localStorage.setItem(soloKey, '1'); } catch { /* storage unavailable */ } };
  const firstGroupId = groupIds[0];

  // One read of at most one document, only while the card is showing and there is a group to look in.
  useEffect(() => {
    if (!firstGroupId || !isNew) { setHasExpense(null); return; }
    let cancelled = false;
    getDocs(query(collection(db, 'expenses'), where('groupId', '==', firstGroupId), limit(1)))
      .then((s) => { if (!cancelled) setHasExpense(!s.empty); })
      .catch(() => { if (!cancelled) setHasExpense(null); });
    return () => { cancelled = true; };
  }, [firstGroupId, isNew]);

  const hasGroup = groupIds.length > 0;
  const steps = [
    { key: 'profile', done: true, title: 'Set up your profile', sub: 'Name, currency, country', action: null as null | (() => void), cta: '' },
    { key: 'group', done: hasGroup, title: 'Create a group', sub: 'Family, trip, roommates… takes 30 seconds', action: () => navigate('/create-group'), cta: 'Start' },
    { key: 'expense', done: !!hasExpense, title: 'Add your first expense', sub: hasGroup ? 'Type it, or just speak it' : 'Unlocks after you create a group', action: hasGroup ? () => navigate(`/add-expense?groupId=${firstGroupId}`) : null, cta: 'Add' },
    { key: 'invite', done: hasOtherMembers || solo, title: hasOtherMembers || !solo ? 'Invite someone' : 'Going solo', sub: hasOtherMembers ? 'Your people are in' : solo ? 'You can invite family or friends anytime' : hasGroup ? 'Splitting works best together' : 'Unlocks after you create a group', action: hasGroup ? () => navigate(`/groups/${firstGroupId}/manage?tab=invite`) : null, cta: 'Invite' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const currentIdx = steps.findIndex((s) => !s.done);

  if (!isNew || doneCount === steps.length) return null;
  // Group exists but we are still checking for an expense: don't flash a wrong state
  if (hasGroup && hasExpense === null) return null;

  const firstName = (profile?.displayName || user?.displayName || '').split(' ')[0];
  const minimize = () => { setMinimized(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch {} };
  const expand = () => { setMinimized(false); try { localStorage.removeItem(DISMISS_KEY); } catch {} };

  if (minimized) {
    return (
      <button
        type="button"
        onClick={expand}
        aria-label={`Getting started, ${doneCount} of ${steps.length} done. Tap to open`}
        aria-expanded={false}
        className="w-full rounded-2xl bg-[#06222f] text-white px-4 h-12 flex items-center gap-3 text-left shadow-sm active:scale-[0.99] transition-transform"
      >
        <span className="text-sm font-extrabold shrink-0">Getting started</span>
        <span className="flex-1 h-1.5 rounded-full bg-[#244555] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
          <span className="block h-full rounded-full bg-[#12b89a] transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </span>
        <span className="text-xs font-bold text-[#8fb2c0] shrink-0 tabular-nums">{doneCount}/{steps.length}</span>
        <span className="material-symbols-outlined text-[20px] text-[#8fb2c0] shrink-0">expand_more</span>
      </button>
    );
  }

  return (
    <section className="space-y-3" aria-label="Getting started">
      <div className="rounded-2xl bg-[#06222f] text-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xl font-extrabold leading-tight">{firstName ? `Welcome, ${firstName} 👋` : 'Welcome 👋'}</h3>
            <p className="text-sm text-[#b8d2dc] mt-1 leading-snug">Quick steps and your family is tracking money together.</p>
          </div>
          <button type="button" onClick={minimize} className="shrink-0 text-xs font-bold text-[#8fb2c0] px-2 py-1 -mr-1 -mt-1 active:opacity-70">Hide</button>
        </div>
        <div className="h-1.5 rounded-full bg-[#244555] mt-3 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
          <div className="h-full rounded-full bg-[#12b89a] transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <p className="text-[11px] font-bold tracking-wide text-[#8fb2c0] mt-1.5">{doneCount} OF {steps.length} DONE</p>
      </div>

      <div className="rounded-2xl bg-white border border-border-subtle p-1.5">
        {steps.map((s, i) => {
          const isCurrent = i === currentIdx;
          return (
            <div
              key={s.key}
              className={clsx('flex items-center gap-3 rounded-xl px-3 py-3', isCurrent && 'bg-[#effcf8] border border-[#b9ece0]')}
            >
              <div
                className={clsx(
                  'w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-extrabold border-2',
                  s.done ? 'bg-[#12b89a] border-[#12b89a] text-white' : isCurrent ? 'border-[#12b89a] text-[#0b6b5a]' : 'border-[#b8c7d0] text-text-muted',
                )}
              >
                {s.done ? <span className="material-symbols-outlined text-[18px]">check</span> : i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className={clsx('text-[15px] font-bold leading-tight', !s.done && !isCurrent && 'text-text-muted')}>{s.title}</p>
                <p className="text-xs text-text-muted mt-0.5 leading-snug">{s.sub}</p>
                {s.key === 'invite' && isCurrent && hasGroup && (
                  <button type="button" onClick={goSolo} className="mt-1.5 text-xs font-extrabold text-[#0b6b5a] underline underline-offset-2 active:opacity-70">
                    I'll go solo for now
                  </button>
                )}
              </div>
              {isCurrent && s.action && (
                <button
                  type="button"
                  onClick={s.action}
                  className="shrink-0 bg-[#12b89a] text-[#06222f] font-extrabold text-sm px-4 h-10 rounded-full active:scale-95 transition-transform"
                >
                  {s.cta}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {onTour && (
        <p className="text-center text-xs text-text-muted">
          Just exploring?{' '}
          <button type="button" onClick={onTour} className="font-bold text-[#0b6b5a] underline underline-offset-2">Take a 30-second tour</button>
        </p>
      )}
    </section>
  );
}
