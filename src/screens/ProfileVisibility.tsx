import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { fetchProfile, saveVisibility, VISIBILITY_LABEL, type SectionKey, type Visibility } from '../lib/profileApi';

// Who sees what on my profile. One main setting (Only me, Friends, All members) and one choice per section. A section can be tighter than the main setting,
// never wider: the stricter of the two wins, on the server. "All members" means people signed in to FamilyLedger, never anyone without an account.
// Money is not a choice here on purpose: it is never shown on a profile.

const SECTIONS: { key: SectionKey; icon: string; label: string; hint: string }[] = [
  { key: 'level', icon: '🏆', label: 'Level and XP', hint: 'Your level and progress' },
  { key: 'streaks', icon: '🔥', label: 'Streaks', hint: 'Your logging streak and game streaks' },
  { key: 'badges', icon: '🏅', label: 'Badges', hint: 'The badges you have earned' },
  { key: 'flames', icon: '✨', label: 'Flames', hint: 'The flame styles you own' },
  { key: 'week', icon: '📅', label: "This week's activity", hint: 'Days you logged and how many expenses (never amounts)' },
  { key: 'games', icon: '🎲', label: 'Games and ranks', hint: 'Won and played, with your rank among friends and overall' },
  { key: 'recap', icon: '🧾', label: 'Weekly recap', hint: 'A short summary of your week, counts only' },
  { key: 'journey', icon: '🎯', label: 'Journey', hint: 'Groups, quests and friend streaks (counts only)' },
  { key: 'friends', icon: '👥', label: 'My friends', hint: 'Photos and first names of your friends' },
  { key: 'birthday', icon: '🎂', label: 'Birthday', hint: 'Month and day only, never the year' },
];

const MAIN: { id: Visibility; label: string; hint: string }[] = [
  { id: 'only_me', label: 'Only me', hint: 'Nobody else sees anything beyond your name and photo.' },
  { id: 'friends', label: 'Friends', hint: 'Only people you have added as friends.' },
  { id: 'members', label: 'All members', hint: 'Anyone signed in to FamilyLedger, for example from a leaderboard or before answering a friend invite.' },
];

export default function ProfileVisibility() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [main, setMain] = useState<Visibility>('members');
  const [sections, setSections] = useState<Record<SectionKey, Visibility> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const p = await fetchProfile(user.uid);
      if (p.settings) {
        setMain(p.settings.main);
        setSections(p.settings.sections);
      }
    } catch (e: any) {
      setError(e?.message || 'Could not load your settings.');
    }
  }, [user]);
  useEffect(() => {
    load();
  }, [load]);

  const flash = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const changeMain = async (v: Visibility) => {
    const before = main;
    setMain(v);
    setError(null);
    try {
      await saveVisibility({ main: v });
      flash();
    } catch (e: any) {
      setMain(before);
      setError(e?.message || 'Could not save.');
    }
  };
  const changeSection = async (key: SectionKey, v: Visibility) => {
    if (!sections) return;
    const before = sections[key];
    setSections({ ...sections, [key]: v });
    setError(null);
    try {
      await saveVisibility({ sections: { [key]: v } });
      flash();
    } catch (e: any) {
      setSections((s) => (s ? { ...s, [key]: before } : s));
      setError(e?.message || 'Could not save.');
    }
  };

  const rank: Record<Visibility, number> = { only_me: 0, friends: 1, members: 2 };

  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto space-y-4" style={{ paddingBottom: 'calc(9rem + env(safe-area-inset-bottom))' }}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-surface" aria-label="Back">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <h1 className="text-lg font-black text-primary flex-1">Who sees my profile</h1>
        {saved && <span className="text-xs font-black text-success">Saved ✓</span>}
      </div>

      {!sections ? (
        <p className="text-center text-sm text-text-muted py-8">{error || 'Loading…'}</p>
      ) : (
        <>
          <div className="rounded-2xl bg-white border border-border-subtle p-3.5">
            <p className="text-sm font-black text-primary mb-2">Main setting</p>
            <div className="flex bg-surface-container/60 rounded-xl p-0.5">
              {MAIN.map((m) => (
                <button key={m.id} type="button" onClick={() => changeMain(m.id)} className={clsx('flex-1 py-2 rounded-[10px] text-xs font-black transition-all', main === m.id ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-2 leading-snug">{MAIN.find((m) => m.id === main)?.hint}</p>
            <button type="button" onClick={() => user && navigate(`/u/${user.uid}`)} className="mt-3 text-xs font-black text-primary underline decoration-dotted">See how my profile looks to others</button>
          </div>

          <div className="rounded-2xl bg-white border border-border-subtle overflow-hidden">
            <div className="p-3.5 pb-2">
              <p className="text-sm font-black text-primary">Choose per section</p>
              <p className="text-[11px] text-text-muted">A section can be tighter than your main setting, never wider.</p>
            </div>
            <div className="divide-y divide-border-subtle/70">
              {SECTIONS.map((s) => {
                const chosen = sections[s.key];
                const capped = rank[chosen] > rank[main]; // the main setting is stricter, so it wins
                const effective: Visibility = capped ? main : chosen;
                return (
                  <div key={s.key} className="flex items-center gap-3 px-3.5 py-3">
                    <span className="w-9 h-9 rounded-xl bg-surface flex items-center justify-center text-lg shrink-0">{s.icon}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-black text-primary">{s.label}</span>
                      <span className="block text-[11px] text-text-muted leading-snug">{s.hint}</span>
                      {capped && <span className="block text-[10px] font-bold text-amber-700 mt-0.5">Shown to: {VISIBILITY_LABEL[effective]} (your main setting is stricter)</span>}
                    </span>
                    <select
                      value={chosen}
                      onChange={(e) => changeSection(s.key, e.target.value as Visibility)}
                      className="shrink-0 rounded-xl border border-border-subtle bg-white px-2 py-1.5 text-xs font-black text-primary"
                      aria-label={`${s.label} visibility`}
                    >
                      {MAIN.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl bg-surface border border-border-subtle p-3.5 text-[12px] text-text-muted leading-snug">
            <p className="font-black text-primary mb-1">Never on your profile</p>
            Money amounts, balances, spending totals, coins, goals, accounts, health information and group details. Only counts, days and category names ever appear.
          </div>
        </>
      )}
      {error && sections && <p className="text-xs font-bold text-error px-1">{error}</p>}
    </div>
  );
}
