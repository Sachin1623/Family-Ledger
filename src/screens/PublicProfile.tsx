import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { getPublicPoints, PublicPoints } from '../lib/pointsApi';

// Same open-ended level formula as server.ts's xpForLevel / MyProgress.tsx — duplicated for the
// same client/server module-graph reason noted there.
function xpForLevel(level: number): number {
  return 25 * level * (level - 1);
}

const GAME_LABELS: Record<string, string> = {
  rummy: '27-Hand Rummy', sweep: 'Sweep', sequence: 'Sequence', ludo: 'Ludo',
};

export default function PublicProfile() {
  const { uid } = useParams();
  const { t } = useLanguage();
  const [profile, setProfile] = useState<{ displayName: string; photoURL: string } | null>(null);
  const [points, setPoints] = useState<PublicPoints | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/public-profile/${uid}`).then((r) => (r.ok ? r.json() : null)),
      getPublicPoints(uid),
    ])
      .then(([profileData, pointsData]) => {
        setProfile(profileData);
        setPoints(pointsData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load.'))
      .finally(() => setLoading(false));
  }, [uid]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || !points) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 text-center">
        <p className="text-sm text-text-muted">{error || t('progress.noActivityYet')}</p>
      </div>
    );
  }

  const level = points.level;
  const currentThreshold = xpForLevel(level);
  const nextThreshold = xpForLevel(level + 1);
  const progressPct = Math.min(100, Math.round(((points.xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  const gameStreakEntries = Object.entries(points.gameStreaks || {}).filter(([, v]) => (v as number) > 0);

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-6 space-y-4">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-20 h-20 rounded-full bg-surface-container-high overflow-hidden border-2 border-primary/20">
              {profile?.photoURL ? (
                <img src={profile.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-primary text-2xl font-black">
                  {profile?.displayName?.slice(0, 1) || '?'}
                </div>
              )}
            </div>
            <div>
              <p className="text-lg font-black text-primary">{profile?.displayName || t('common.someone')}</p>
              <p className="text-xs text-text-muted font-bold">{t('progress.level', { level: String(level) })}</p>
            </div>
          </div>
          <div className="space-y-1">
            <div className="h-2 bg-surface rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="text-[10px] text-text-muted font-bold text-right">
              {t('progress.xpToNext', { current: String(points.xp), next: String(nextThreshold) })}
            </p>
          </div>
        </section>

        {points.badges.length > 0 && (
          <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2">
            <h3 className="text-[11px] text-text-muted uppercase font-bold tracking-wider">{t('progress.badges')}</h3>
            <div className="grid grid-cols-4 gap-3">
              {points.badges.map((b) => (
                <div key={b.id} className="flex flex-col items-center gap-1">
                  <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center text-2xl">🏅</div>
                  <p className="text-[9px] text-text-muted font-bold text-center">{b.streakDays ? `${b.streakDays}d` : ''}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {(points.expenseStreakLongest > 0 || gameStreakEntries.length > 0) && (
          <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2">
            <h3 className="text-[11px] text-text-muted uppercase font-bold tracking-wider">{t('progress.streaks')}</h3>
            {points.expenseStreakLongest > 0 && (
              <div className="flex items-center gap-2.5 p-2 rounded-xl bg-surface/40">
                <span className="text-lg">🔥</span>
                <p className="flex-1 text-xs font-bold text-on-surface">{t('progress.expenseStreak')}</p>
                <span className="text-sm font-black text-warning">{points.expenseStreakLongest}d {t('progress.best')}</span>
              </div>
            )}
            {gameStreakEntries.map(([game, streak]) => (
              <div key={game} className="flex items-center gap-2.5 p-2 rounded-xl bg-surface/40">
                <span className="text-lg">🎮</span>
                <p className="flex-1 text-xs font-bold text-on-surface">{GAME_LABELS[game] || game}</p>
                <span className="text-sm font-black text-warning">{streak}</span>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
