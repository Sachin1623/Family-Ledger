import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import StreakFlame from '../components/StreakFlame';
import ProfileTabs from '../components/ProfileTabs';
import BadgeMedal from '../components/BadgeMedal';
import { fetchProfile, readCachedProfile, VISIBILITY_LABEL, type ProfileData } from '../lib/profileApi';
import { inviteToStreak } from '../lib/streakApi';
import { EXPENSE_CATEGORIES } from '../lib/constants';

// A person's profile, as FamilyLedger members see it. What shows is decided by its owner (see publicProfile.ts): a section the viewer may not see simply does
// not come back from the server. Money is never part of it, only counts, days and category names.

const GAMES: Record<string, { name: string; icon: string }> = {
  rummy: { name: '27-Hand Rummy', icon: '🃏' },
  rummy13: { name: '13-Card Rummy', icon: '🃏' },
  sweep: { name: 'Sweep', icon: '🧹' },
  sequence: { name: 'Sequence', icon: '🔷' },
  ludo: { name: 'Ludo', icon: '🎲' },
  chess: { name: 'Chess', icon: '♟️' },
  business: { name: 'Business', icon: '🏙️' },
  spadePledge: { name: 'Spade Pledge', icon: '♠️' },
  scramble: { name: 'Scramble', icon: '🔤' },
};

const WEEKDAY = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Card({ title, tag, children, dark }: { title: string; tag?: string; children: ReactNode; dark?: boolean }) {
  return (
    <section className={clsx('rounded-2xl p-3.5', dark ? 'text-white' : 'bg-white border border-border-subtle')} style={dark ? { background: 'linear-gradient(135deg,#1e1b4b,#4c1d95 60%,#7c3aed)' } : undefined}>
      <div className="flex items-center justify-between mb-2.5">
        <h3 className={clsx('text-[11px] font-black uppercase tracking-[0.14em]', dark ? 'text-violet-200' : 'text-text-muted')}>{title}</h3>
        {tag && <span className={clsx('text-[10px] font-black rounded-lg px-2 py-0.5', dark ? 'bg-white/20' : 'bg-primary/10 text-primary')}>{tag}</span>}
      </div>
      {children}
    </section>
  );
}

export default function PublicProfile() {
  const { uid } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState<ProfileData | null>(() => (uid ? readCachedProfile(uid) : null));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!uid) return;
    // open from the saved copy at once (if there is one), then refresh it from the server
    const saved = readCachedProfile(uid);
    setP(saved);
    setError(null);
    let live = true;
    fetchProfile(uid)
      .then((fresh) => live && setP(fresh))
      .catch((e) => live && !saved && setError(e?.message || 'Could not load this profile.'));
    return () => { live = false; };
  }, [uid]);

  if (error) return <div className="p-8 text-center text-sm text-text-muted">{error}</div>;
  if (!p) return <div className="p-8 text-center"><div className="mx-auto animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;

  const self = p.relation === 'self';
  const name = p.header.displayName;
  const first = name.split(' ')[0];
  const flame = p.style.flame;
  const ring = flame === 'classic' ? '#f59e0b' : flame === 'blue' ? '#38bdf8' : flame === 'gold' ? '#fbbf24' : flame === 'green' ? '#34d399' : flame === 'purple' ? '#a78bfa' : '#7dd3fc';
  const since = p.header.memberSince ? `${MONTHS[Number(p.header.memberSince.slice(5, 7)) - 1] || ''} ${p.header.memberSince.slice(0, 4)}`.trim() : null;
  const topCat = p.recap?.topCategory ? EXPENSE_CATEGORIES.find((c) => c.id === p.recap!.topCategory)?.name || p.recap.topCategory : null;
  const hiddenCount = (Object.keys(p.sections) as (keyof typeof p.sections)[]).filter((k) => !p.sections[k] && k !== 'birthday').length;

  const startStreak = async () => {
    setBusy(true);
    setNote(null);
    try {
      await inviteToStreak(p.header.uid);
      setNote(`Streak invite sent to ${first} 🔥`);
    } catch (e: any) {
      setNote(e?.message || 'Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto pb-40" style={{ paddingBottom: 'calc(9rem + env(safe-area-inset-bottom))' }}>
      {self && <div className="px-4 pt-3 pb-2"><ProfileTabs active="profile" /></div>}
      {/* cover and photo */}
      <div className="relative h-32 sm:rounded-b-3xl overflow-hidden" style={{ background: 'linear-gradient(135deg,#0f2b3d,#1d4e6f 55%,#2b8f9c)' }}>
        <button type="button" onClick={() => navigate(-1)} className="absolute left-3 top-3 w-9 h-9 rounded-full bg-black/35 text-white flex items-center justify-center" aria-label="Back">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="absolute right-3 top-3 text-[11px] font-black text-white bg-black/35 rounded-full px-3 py-1">
          {self ? `Visible to: ${VISIBILITY_LABEL[p.visibleTo]}` : p.relation === 'friend' ? '👥 Friend' : 'FamilyLedger member'}
        </span>
      </div>
      <div className="-mt-12 flex flex-col items-center px-4">
        <div className="relative">
          <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white bg-primary/10 flex items-center justify-center text-4xl font-black text-primary shadow-lg" style={{ boxShadow: `0 0 0 3px ${ring}, 0 6px 14px #0003` }}>
            {p.header.photoURL ? <img src={p.header.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : name.slice(0, 1).toUpperCase()}
          </div>
          {p.level && <span className="absolute -right-2 -bottom-1 bg-amber-500 text-white text-xs font-black rounded-full px-2 py-0.5 border-2 border-white">Lv {p.level.level}</span>}
        </div>
        <h1 className="mt-3 text-2xl font-black text-primary text-center">{name} {p.style.badges.length > 0 && <span className="text-xl">{p.style.badges.join('')}</span>}</h1>
        <p className="text-xs text-text-muted">{since ? `Member since ${since} · ` : ''}{p.header.friends} friend{p.header.friends === 1 ? '' : 's'}</p>

        {self ? (
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => navigate('/profile/visibility')} className="px-4 py-2 rounded-2xl bg-orange-500 text-white text-xs font-black active:scale-95">Who sees what</button>
            <button type="button" onClick={() => navigate('/my-style')} className="px-4 py-2 rounded-2xl bg-surface text-primary text-xs font-black active:scale-95">🎨 My style</button>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            {p.relation === 'member' && <button type="button" onClick={() => navigate(`/add-friend/${p.header.uid}`)} className="px-4 py-2 rounded-2xl bg-orange-500 text-white text-xs font-black active:scale-95">Add friend</button>}
            {p.relation === 'friend' && <button type="button" disabled={busy} onClick={startStreak} className="px-4 py-2 rounded-2xl bg-orange-500 text-white text-xs font-black active:scale-95 disabled:opacity-60">🔥 Start a streak</button>}
          </div>
        )}
        {note && <p className="mt-2 text-xs font-bold text-primary">{note}</p>}
        {self && <p className="mt-2 text-[11px] text-text-muted text-center">This is how others see you. Sections marked private are only visible to you.</p>}
      </div>

      <div className="px-4 mt-4 space-y-3">
        {/* headline numbers */}
        {(p.streaks || p.week || p.level) && (
          <div className="grid grid-cols-3 gap-2">
            {p.streaks && (
              <div className="rounded-2xl bg-white border border-border-subtle py-2.5 text-center">
                <div className="flex justify-center items-center gap-1"><div style={{ width: 18, height: 22 }}><StreakFlame state={p.streaks.current > 0 ? 'lit' : 'out'} size={18} flame={flame} /></div><b className="text-lg font-black text-primary">{p.streaks.current}</b></div>
                <p className="text-[9px] font-black uppercase tracking-wider text-text-muted">Day streak</p>
              </div>
            )}
            {p.week && (
              <div className="rounded-2xl bg-white border border-border-subtle py-2.5 text-center">
                <b className="text-lg font-black text-primary block">{p.week.expenses}</b>
                <p className="text-[9px] font-black uppercase tracking-wider text-text-muted">Logged this week</p>
              </div>
            )}
            {p.level && (
              <div className="rounded-2xl bg-white border border-border-subtle py-2.5 text-center">
                <b className="text-lg font-black text-primary block">{p.level.xp}</b>
                <p className="text-[9px] font-black uppercase tracking-wider text-text-muted">XP</p>
              </div>
            )}
          </div>
        )}

        {p.week && (
          <Card title="This week" tag={self ? VISIBILITY_LABEL[p.settings!.sections.week] : undefined}>
            <div className="flex justify-between">
              {p.week.days.map((d, i) => (
                <div key={d.date} className="w-9 text-center text-[10px] font-bold text-text-muted">
                  {WEEKDAY(d.date)}
                  <span className={clsx('mt-1 mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[13px]', d.logged ? 'bg-amber-400 text-orange-950' : 'bg-surface', i === 6 && 'ring-2 ring-amber-300')}>{d.logged ? '✓' : ''}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-text-muted text-center mt-2">{p.week.expenses} expense{p.week.expenses === 1 ? '' : 's'} logged on {p.week.daysLogged} of 7 days</p>
          </Card>
        )}

        {p.badges && (
          <Card title="Badges" tag={self ? VISIBILITY_LABEL[p.settings!.sections.badges] : undefined}>
            {p.badges.earned.length > 0 ? (
              <div className="flex flex-wrap gap-2.5">
                {p.badges.earned.map((b) => <span key={b.id}><BadgeMedal badge={{ icon: b.icon, tier: b.tier, earned: true, progress: 1, target: 1 }} size={52} /></span>)}
              </div>
            ) : <p className="text-xs text-text-muted">No badges yet.</p>}
            <p className="text-[11px] text-text-muted mt-2">{p.badges.earned.length} of {p.badges.total} earned</p>
          </Card>
        )}

        {p.flames && (
          <Card title="Flames" tag={self ? VISIBILITY_LABEL[p.settings!.sections.flames] : undefined}>
            <div className="flex gap-2 overflow-x-auto">
              {p.flames.owned.map((f) => (
                <div key={f.id} className={clsx('shrink-0 w-24 rounded-xl border-2 text-center py-2', f.id === p.flames!.equipped ? 'border-orange-500 bg-orange-50' : 'border-border-subtle')}>
                  <div className="flex justify-center" style={{ height: 44 }}><StreakFlame state="lit" size={34} flame={f.id} /></div>
                  <p className="text-[11px] font-black text-primary">{f.name}</p>
                  {f.id === p.flames!.equipped && <p className="text-[9px] font-bold text-orange-600">In use</p>}
                </div>
              ))}
            </div>
          </Card>
        )}

        {p.games && (
          <Card title="Games" tag={self ? VISIBILITY_LABEL[p.settings!.sections.games] : undefined}>
            {p.games.length === 0 ? <p className="text-xs text-text-muted">No games played yet.</p> : (
              <div className="divide-y divide-border-subtle/60">
                {p.games.map((g) => {
                  const meta = GAMES[g.game] || { name: g.game, icon: '🎮' };
                  return (
                    <div key={g.game} className="flex items-center gap-3 py-2">
                      <span className="w-9 h-9 rounded-xl bg-surface flex items-center justify-center text-lg shrink-0">{meta.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-black text-primary truncate">{meta.name}</span>
                        <span className="block text-[11px] text-text-muted">{g.won} won of {g.played} played</span>
                      </span>
                      <span className="text-right shrink-0">
                        {g.friends && <span className="block text-xs font-black text-amber-700">#{g.friends.rank} <span className="text-text-muted font-bold">of {g.friends.of} friends</span></span>}
                        {g.everyone && <span className="block text-[10px] font-bold text-text-muted">#{g.everyone.rank} of {g.everyone.of} overall</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {p.recap && (
          <Card title="Weekly recap" tag={self ? VISIBILITY_LABEL[p.settings!.sections.recap] : undefined} dark>
            <p className="text-2xl font-black">{p.recap.daysLogged >= 6 ? 'A steady week' : p.recap.daysLogged >= 3 ? 'A good week' : p.recap.daysLogged > 0 ? 'A quiet week' : 'A rest week'}</p>
            <p className="text-sm text-violet-100">Logged on {p.recap.daysLogged} of 7 days</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[`${p.recap.expenses} expenses`, topCat && `Top: ${topCat}`, p.recap.vsLastWeek !== 0 && `${p.recap.vsLastWeek > 0 ? '+' : ''}${p.recap.vsLastWeek} vs last week`, p.recap.streakKept && '🔥 streak kept', p.recap.questsDone > 0 && `${p.recap.questsDone} quest${p.recap.questsDone === 1 ? '' : 's'} done`].filter(Boolean).map((t) => (
                <span key={String(t)} className="text-[11px] font-black bg-white/20 rounded-full px-2.5 py-1">{t}</span>
              ))}
            </div>
          </Card>
        )}

        {p.journey && (
          <Card title="Journey" tag={self ? VISIBILITY_LABEL[p.settings!.sections.journey] : undefined}>
            {[
              ['🏠', 'Groups', `Member of ${p.journey.groups} group${p.journey.groups === 1 ? '' : 's'}`],
              ['🎯', 'Quests', `${p.journey.questsDone} completed`],
              ['👯', 'Friend streaks', `${p.journey.friendStreaksRunning} running · best ${p.journey.bestFriendStreak} days together`],
              ...(p.birthday ? [['🎂', 'Birthday', `${MONTHS[Number(p.birthday.slice(0, 2)) - 1]} ${Number(p.birthday.slice(3))}`]] : []),
            ].map(([icon, title, sub]) => (
              <div key={title} className="flex items-center gap-3 py-1.5">
                <span className="w-9 h-9 rounded-xl bg-surface flex items-center justify-center text-lg shrink-0">{icon}</span>
                <span><span className="block text-sm font-black text-primary">{title}</span><span className="block text-[11px] text-text-muted">{sub}</span></span>
              </div>
            ))}
          </Card>
        )}

        {p.friendList && (
          <Card title={`Friends (${p.friendList.total})`} tag={self ? VISIBILITY_LABEL[p.settings!.sections.friends] : undefined}>
            {p.friendList.people.length === 0 ? <p className="text-xs text-text-muted">No friends added yet.</p> : (
              <div className="grid grid-cols-4 gap-2">
                {p.friendList.people.map((f) => (
                  <button key={f.uid} type="button" onClick={() => navigate(`/u/${f.uid}`)} className="flex flex-col items-center gap-1 active:scale-95">
                    <span className="relative w-14 h-14 rounded-full overflow-hidden bg-primary/10 flex items-center justify-center text-lg font-black text-primary border-2" style={{ borderColor: f.flame === 'classic' ? '#f59e0b' : f.flame === 'blue' ? '#38bdf8' : f.flame === 'gold' ? '#fbbf24' : f.flame === 'green' ? '#34d399' : f.flame === 'purple' ? '#a78bfa' : '#7dd3fc' }}>
                      {f.photoURL ? <img src={f.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : f.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="text-[10px] font-bold text-primary truncate w-full text-center">{f.name.split(' ')[0]}</span>
                  </button>
                ))}
              </div>
            )}
            {p.friendList.total > p.friendList.people.length && <p className="text-[11px] text-text-muted mt-2 text-center">and {p.friendList.total - p.friendList.people.length} more</p>}
          </Card>
        )}

        {hiddenCount > 0 && !self && (
          <p className="text-[11px] text-text-muted text-center px-4">🔒 {first} keeps {hiddenCount === 1 ? 'one section' : `${hiddenCount} sections`} private{p.relation === 'member' ? '. Add them as a friend to see more, if they allow it.' : '.'}</p>
        )}
        <p className="text-[11px] text-text-muted text-center px-4">Money, goals, health and group details never appear on a profile.</p>
      </div>
    </div>
  );
}
