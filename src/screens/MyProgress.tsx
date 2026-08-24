import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, doc, limit, query, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { getLeaderboard, LeaderboardEntry } from '../lib/pointsApi';

// Cumulative XP required to REACH a given level — must match server.ts's xpForLevel exactly
// (duplicated rather than shared, same reasoning as frequency.ts's nextOccurrenceAfter: client
// (Vite) and server (esbuild) don't share a module graph in this app). No ceiling — the gap
// between consecutive levels grows by a flat 50 XP each time.
function xpForLevel(level: number): number {
  return 25 * level * (level - 1);
}

const ACTION_META: Record<string, { icon: string; labelKey: string }> = {
  expense_logged: { icon: 'receipt_long', labelKey: 'progress.actionExpenseLogged' },
  expense_streak7: { icon: 'local_fire_department', labelKey: 'progress.actionExpenseStreak7' },
  todo_completed: { icon: 'task_alt', labelKey: 'progress.actionTodoCompleted' },
  habit_occurrence: { icon: 'check_circle', labelKey: 'progress.actionHabitOccurrence' },
  habit_streak7: { icon: 'local_fire_department', labelKey: 'progress.actionHabitStreak7' },
  habit_streak7_30: { icon: 'military_tech', labelKey: 'progress.actionHabitStreak30' },
  budget_set: { icon: 'account_balance_wallet', labelKey: 'progress.actionBudgetSet' },
  budget_met: { icon: 'savings', labelKey: 'progress.actionBudgetMet' },
  feature_explorer: { icon: 'explore', labelKey: 'progress.actionFeatureExplorer' },
  group_milestone: { icon: 'groups', labelKey: 'progress.actionGroupMilestone' },
  habit_resumed: { icon: 'restart_alt', labelKey: 'progress.actionHabitResumed' },
  game_played: { icon: 'sports_esports', labelKey: 'progress.actionGamePlayed' },
  game_won: { icon: 'emoji_events', labelKey: 'progress.actionGameWon' },
  friend_accepted: { icon: 'person_add', labelKey: 'progress.actionFriendAccepted' },
  friend_request_converted: { icon: 'group_add', labelKey: 'progress.actionFriendConverted' },
  recurring_confirmed_ontime: { icon: 'event_available', labelKey: 'progress.actionRecurringConfirmed' },
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// A stored streak `current` count only advances the next time a real award goes through (lazy
// reset, see server.ts) — this is the display-time check that treats it as broken once more than
// a day has passed, so the screen never shows a streak that's actually already lapsed.
function isStreakAlive(lastDateStr: string | undefined): boolean {
  if (!lastDateStr) return false;
  const todayStr = new Date().toISOString().slice(0, 10);
  const diffDays = Math.round((new Date(todayStr).getTime() - new Date(lastDateStr).getTime()) / 86400000);
  return diffDays <= 1;
}

export default function MyProgress() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const uid = user?.uid;

  const [tab, setTab] = useState<'overview' | 'leaderboard'>('overview');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);
  useEffect(() => {
    if (tab !== 'leaderboard') return;
    setLoadingLeaderboard(true);
    getLeaderboard('friends')
      .then(setLeaderboard)
      .catch((err) => console.error('getLeaderboard failed:', err))
      .finally(() => setLoadingLeaderboard(false));
  }, [tab]);

  const [pointsDoc] = useDocument(uid ? doc(db, 'userPoints', uid) : null);
  const points = pointsDoc?.data() as any;
  const xp: number = points?.xp || 0;
  const coins: number = points?.coins || 0;
  const level: number = points?.level || 1;

  const [expenseStreakDoc] = useDocument(uid ? doc(db, 'userPoints', uid, 'meta', 'expenseStreak') : null);
  const expenseStreak = expenseStreakDoc?.data() as any;

  const [habitStreaksValue] = useCollection(uid ? collection(db, 'userPoints', uid, 'habitStreaks') : null);
  const [myHabitsValue] = useCollection(
    uid ? query(collection(db, 'todos'), where('userId', '==', uid), where('recurring', '==', true)) : null,
  );
  const habitTitleById = useMemo(() => {
    const map = new Map<string, string>();
    myHabitsValue?.docs.forEach((d) => map.set(d.id, (d.data() as any).text || t('progress.untitledHabit')));
    return map;
  }, [myHabitsValue, t]);
  const habitStreaks = useMemo(() => {
    return (habitStreaksValue?.docs || [])
      .map((d) => ({ todoId: d.id, title: habitTitleById.get(d.id) || t('progress.untitledHabit'), ...(d.data() as any) }))
      .filter((h) => isStreakAlive(h.lastDateStr) && h.current > 0)
      .sort((a, b) => b.current - a.current);
  }, [habitStreaksValue, habitTitleById, t]);

  // No orderBy here deliberately — combining it with the where('uid',...) equality filter would need
  // a composite index that doesn't exist. Over-fetch on the equality filter alone and sort client-side
  // instead, which is cheap at this collection's per-user scale and needs no index provisioning.
  const [ledgerValue] = useCollection(
    uid ? query(collection(db, 'pointsLedger'), where('uid', '==', uid), limit(50)) : null,
  );
  const recentActivity = (ledgerValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
    .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 20);

  const currentThreshold = xpForLevel(level);
  const nextThreshold = xpForLevel(level + 1);
  const progressPct = Math.min(100, Math.round(((xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100));

  const expenseStreakAlive = isStreakAlive(expenseStreak?.lastDateStr) && (expenseStreak?.current || 0) > 0;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('progress.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('progress.subtitle')}</p>
        </div>

        <div className="flex bg-white rounded-2xl border border-border-subtle shadow-sm p-1 gap-1">
          {(['overview', 'leaderboard'] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={clsx(
                'flex-1 py-2 rounded-xl text-xs font-bold transition-colors',
                tab === tabKey ? 'bg-primary text-white' : 'text-text-muted hover:bg-surface',
              )}
            >
              {t(tabKey === 'overview' ? 'progress.overview' : 'progress.leaderboard')}
            </button>
          ))}
        </div>

        {tab === 'leaderboard' && (
          <section className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden">
            {loadingLeaderboard && (
              <p className="p-6 text-sm text-text-muted italic text-center">{t('common.loading')}</p>
            )}
            {!loadingLeaderboard && leaderboard.length === 0 && (
              <p className="p-6 text-sm text-text-muted italic text-center">{t('progress.noLeaderboardData')}</p>
            )}
            {leaderboard.map((entry, idx) => {
              const isMe = entry.uid === uid;
              const podiumIcon = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null;
              return (
                <div
                  key={entry.uid}
                  onClick={() => !isMe && navigate(`/u/${entry.uid}`)}
                  className={clsx('p-4 flex items-center gap-3', !isMe && 'cursor-pointer hover:bg-surface-container/20', isMe && 'bg-primary/5')}
                >
                  <span className={clsx('w-7 text-center font-black shrink-0', podiumIcon ? 'text-lg' : 'text-xs text-text-muted')}>
                    {podiumIcon || idx + 1}
                  </span>
                  <div className={clsx('w-9 h-9 rounded-full bg-surface-container-high overflow-hidden shrink-0', podiumIcon && 'ring-2 ring-warning')}>
                    {entry.photoURL ? (
                      <img src={entry.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-primary text-xs font-bold">{entry.displayName.slice(0, 1)}</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{isMe ? t('progress.you') : entry.displayName}</p>
                    <p className="text-[10px] text-text-muted font-bold">{t('progress.level', { level: String(entry.level) })}</p>
                  </div>
                  <p className="text-xs font-black text-primary shrink-0">{entry.xp} XP</p>
                </div>
              );
            })}
          </section>
        )}

        {tab === 'overview' && (
          <>
        {/* Level / XP */}
        <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🏆</span>
              <div>
                <p className="text-lg font-black text-primary leading-none">{t('progress.level', { level: String(level) })}</p>
                <p className="text-[11px] text-text-muted font-bold mt-0.5">{xp} XP</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-lg font-black text-warning leading-none">🪙 {coins}</p>
              <p className="text-[10px] text-text-muted font-bold uppercase tracking-wider mt-0.5">{t('progress.coins')}</p>
            </div>
          </div>
          <div className="space-y-1">
            <div className="h-2 bg-surface rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="text-[10px] text-text-muted font-bold text-right">
              {t('progress.xpToNext', { current: String(xp), next: String(nextThreshold) })}
            </p>
          </div>
        </section>

        {/* Streaks */}
        {(expenseStreakAlive || habitStreaks.length > 0) && (
          <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2">
            <h3 className="text-[11px] text-text-muted uppercase font-bold tracking-wider">{t('progress.streaks')}</h3>
            {expenseStreakAlive && (
              <div className="flex items-center gap-2.5 p-2 rounded-xl bg-surface/40">
                <span className="text-lg">🔥</span>
                <p className="flex-1 text-xs font-bold text-on-surface">{t('progress.expenseStreak')}</p>
                <span className="text-sm font-black text-warning">{expenseStreak.current}d</span>
              </div>
            )}
            {habitStreaks.map((h) => (
              <div key={h.todoId} className="flex items-center gap-2.5 p-2 rounded-xl bg-surface/40">
                <span className="text-lg">🔥</span>
                <p className="flex-1 text-xs font-bold text-on-surface truncate">{h.title}</p>
                <span className="text-sm font-black text-warning">{h.current}d</span>
              </div>
            ))}
          </section>
        )}

        {/* Recent activity */}
        <section className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden">
          <h3 className="text-[11px] text-text-muted uppercase font-bold tracking-wider p-4 pb-2">{t('progress.recentActivity')}</h3>
          {recentActivity.length === 0 && (
            <p className="p-6 text-sm text-text-muted italic text-center">{t('progress.noActivityYet')}</p>
          )}
          {recentActivity.map((entry) => {
            const meta = ACTION_META[entry.actionType] || { icon: 'stars', labelKey: '' };
            return (
              <div key={entry.id} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-[18px]">{meta.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-on-surface truncate">
                    {meta.labelKey ? t(meta.labelKey) : entry.actionType}
                  </p>
                  <p className="text-[10px] text-text-muted font-bold">{relativeTime(entry.createdAt)}</p>
                </div>
                <p className="text-xs font-black text-success shrink-0">
                  +{entry.xp} XP{entry.coins ? ` · +${entry.coins}` : ''}
                </p>
              </div>
            );
          })}
        </section>
          </>
        )}
      </main>
    </div>
  );
}
