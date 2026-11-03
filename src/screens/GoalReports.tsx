import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db, auth } from '../lib/firebase';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { Goal, GoalLedgerEntry, goalHorizonDate, goalTargetReachedAt, goalTotalMinor, fromMinorUnits, decryptGoalsList, decryptLedgerEntries } from '../lib/goals';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { useReportsSharing } from '../lib/useReportsSharing';

// Reports & Timeline (Horizon View) — a chronological ladder of every active goal's projected
// completion, plus total accumulated + total-still-targeted wealth. Two view modes, driven by the
// `viewingUid` prop (owned by GoalsHub.tsx, which also renders the Mine/switcher pills shared
// across all 4 tabs — see its own comment for why this couldn't stay local to just this screen):
//  - "Mine" (viewingUid === my own uid, or omitted — the standalone /goals/reports route has no
//    switcher, so this always defaults to "mine" there): totals/chart/Horizon View are OWN goals
//    ONLY — a separate "Shared With Me" section below lists whatever's individually shared with me
//    (group or friend), same split GoalsHub.tsx's own Goals tab already uses. Blending shared items
//    into "Mine"'s own totals used to make an account with zero goals of its own show someone
//    else's totals as if they were hers — reported directly by a real user testing this.
//  - Someone else's switcher pill selected (viewingUid !== my uid): ONLY that person's goals/
//    accounts that are ALSO individually shared with me (friendUids/groupId) — NOT their whole
//    portfolio. "Share My Reports" only controls whether a person's pill appears in the switcher at
//    all; it is NOT a blanket access grant (a real user caught this in testing: a reports-share
//    recipient could see goals that were never actually shared with them). Same friendUids/groupId
//    read permission as everywhere else in this app — see firestore.rules' isGoalViewer().
// If goals use different currencies, the aggregate totals below display in whichever currency the
// FIRST goal uses (a simplification — this app has no cross-currency conversion anywhere).
export default function GoalReports({ embedded = false, viewingUid: viewingUidProp }: { embedded?: boolean; viewingUid?: string } = {}) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const { saving: savingShare, save: saveReportsShare } = useReportsSharing(user?.uid);
  const viewingUid = viewingUidProp ?? user?.uid;
  const isOwnView = viewingUid === user?.uid;

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const cappedGroupIds = (membershipsValue?.docs.map((d) => d.data().groupId) || []).slice(0, 30);
  // Own + individually-shared-with-me queries run regardless of isOwnView now — the shared ones
  // are also how a specific person's switcher view gets its data (filtered to that one owner
  // below), not just "Mine"'s separate Shared-With-Me section.
  const [ownGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const [groupSharedGoalsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'goals'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('friendUids', 'array-contains', user.uid)) : null);
  const [ownGoals, setOwnGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = ownGoalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setOwnGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [ownGoalsValue]);
  const [sharedGoals, setSharedGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    groupSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    friendSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    decryptGoalsList(Array.from(byId.values())).then((decrypted) => { if (!cancelled) setSharedGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt shared goals:', err));
    return () => { cancelled = true; };
  }, [groupSharedGoalsValue, friendSharedGoalsValue, user?.uid]);

  const reportableGoals = (isOwnView ? ownGoals : sharedGoals.filter((g) => g.userId === viewingUid)).filter((g) => g.status !== 'archived');
  // Only populated in "Mine" mode — a specific person's switcher view IS already "shared with me,"
  // so a second copy of the same distinction inside it would be redundant.
  const sharedReportableGoals = isOwnView ? sharedGoals.filter((g) => g.status !== 'archived') : [];
  const currencySymbol = getCurrencySymbol(reportableGoals[0]?.currency);

  const [ledgersByGoal, setLedgersByGoal] = useState<Map<string, GoalLedgerEntry[]>>(new Map());
  // Tracks whether ledgersByGoal above reflects the CURRENT goal set, not a stale/empty Map left
  // over from before they loaded — the chart/horizon below gate on this instead of rendering the
  // instant goals arrive. Ledger entries feed goalHorizonDate()'s real projection; rendering one
  // frame before they're in produced a "no ledger yet" projection (often a different date,
  // sometimes none at all), then a second, different-looking render once they arrived a moment
  // later — visually a "for a second it's fine, then the chart crumbles/repositions" glitch, worse
  // (and more visible) on a switch to someone else's shared view, where nothing is cached yet and
  // this fetch is slower than the goal list itself.
  const ledgerGoals = useMemo(() => [...reportableGoals, ...sharedReportableGoals], [reportableGoals, sharedReportableGoals]);
  const [ledgersReady, setLedgersReady] = useState(false);
  useEffect(() => {
    setLedgersReady(false);
    if (ledgerGoals.length === 0) { setLedgersByGoal(new Map()); setLedgersReady(true); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        ledgerGoals.map(async (g) => {
          const snap = await getDocs(collection(db, 'goals', g.id, 'ledger'));
          const raw = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
          return [g.id, await decryptLedgerEntries(g.id, raw)] as const;
        }),
      );
      if (!cancelled) { setLedgersByGoal(new Map(entries)); setLedgersReady(true); }
    })();
    return () => { cancelled = true; };
  }, [ledgerGoals.map((g) => g.id).join(',')]);

  // Every account visible to the viewer — decrypted, feeds goalHorizonDate() below with each
  // linked account's interest rate/compounding and SIP schedule, not just its balance. Same
  // own-vs-shared split as goals above: "Mine" projects off own+shared (a goal she owns can
  // legitimately be funded by a jointly-shared account); a specific person's switcher view projects
  // off only accounts THAT PERSON has individually shared with me.
  const [ownAccountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [groupSharedAccountsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'financialAccounts'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedAccountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('friendUids', 'array-contains', user.uid)) : null);
  const [ownAccounts, setOwnAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = ownAccountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setOwnAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [ownAccountsValue]);
  const [sharedAccounts, setSharedAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    groupSharedAccountsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    friendSharedAccountsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    decryptAccountsList(Array.from(byId.values())).then((decrypted) => { if (!cancelled) setSharedAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt shared accounts:', err));
    return () => { cancelled = true; };
  }, [groupSharedAccountsValue, friendSharedAccountsValue, user?.uid]);
  const accounts = useMemo(() => {
    if (isOwnView) {
      const byId = new Map<string, FinancialAccount>();
      [...ownAccounts, ...sharedAccounts].forEach((a) => byId.set(a.id, a));
      return Array.from(byId.values());
    }
    return sharedAccounts.filter((a) => a.userId === viewingUid);
  }, [isOwnView, ownAccounts, sharedAccounts, viewingUid]);

  const buildHorizon = (goals: Goal[]) => goals
    // Cash Savings has no target and no projection (see goalProgressPct/goalHorizonDate — both
    // already resolve to "nothing" for a target-0 goal), so it'd only clutter this timeline. Its
    // balance still counts toward Total Accumulated below — it's real money, just untargeted.
    .filter((g) => g.status === 'active' && !g.isCashHolding)
    .map((g) => {
      const ledger = ledgersByGoal.get(g.id) || [];
      return { goal: g, projected: goalHorizonDate(g, ledger, accounts), reachedDate: goalTargetReachedAt(g, ledger) };
    })
    .sort((a, b) => {
      const aDate = a.reachedDate || a.projected;
      const bDate = b.reachedDate || b.projected;
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.localeCompare(bDate);
    });
  const horizon = useMemo(() => buildHorizon(reportableGoals), [reportableGoals, ledgersByGoal, accounts]);
  const sharedHorizon = useMemo(() => buildHorizon(sharedReportableGoals), [sharedReportableGoals, ledgersByGoal, accounts]);

  // --- "Goal Horizon" chart: a single year-axis timeline with every placeable goal's icon plotted
  // at its own completion date. A goal with a real projected date (goalHorizonDate) plots there,
  // solid-dotted; one with no projection yet but a user-set targetDate falls back to THAT instead
  // (hollow-dotted, so it visually reads as "aimed for," not "calculated") — same idea as the
  // vertical Horizon View list below, just laid out on a real timeline instead of a plain ladder.
  // A goal with neither simply can't be placed and is left off the chart (still shown below).
  const chartMarkers = useMemo(
    () =>
      horizon
        .map(({ goal, projected, reachedDate }) => {
          // A goal already at/past its target plots at the date it actually got there, never at
          // the (now-irrelevant) forward projection or the originally-aimed-for target date.
          const dateStr = reachedDate || projected || goal.targetDate;
          if (!dateStr) return null;
          // Same "how far off target" comparison as the Horizon View list and GoalsHub's own goal
          // cards — only meaningful when there's a real target date AND a real projection to
          // weigh it against; a goal already reached has nothing left to compare (it's done).
          const monthsBehindTarget = !reachedDate && goal.targetDate && projected
            ? (() => {
                const [ty, tm] = goal.targetDate.split('-').map(Number);
                const [py, pm] = projected.split('-').map(Number);
                return (py - ty) * 12 + (pm - tm);
              })()
            : null;
          return { goal, dateStr, isProjected: !!projected, isReached: !!reachedDate, monthsBehindTarget };
        })
        .filter((m): m is { goal: Goal; dateStr: string; isProjected: boolean; isReached: boolean; monthsBehindTarget: number | null } => !!m)
        .sort((a, b) => a.dateStr.localeCompare(b.dateStr)),
    [horizon],
  );
  // --- "Goal Horizon" roadmap: every placeable goal is one bar running from today to its own date on a single shared
  // time axis, the filled part being how much of the target is saved. The axis is a square-root scale, so a goal
  // three months away and one sixteen years away both stay readable (a straight scale squashed every near goal
  // into a sliver). Year ticks are only drawn where they would not collide.
  const todayFrac = useMemo(() => {
    const n = new Date();
    return n.getFullYear() + n.getMonth() / 12 + (n.getDate() - 1) / 365;
  }, []);
  const yearsFromNow = (dateStr: string): number => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Math.max(0.15, y + ((m || 1) - 1) / 12 + ((d || 1) - 1) / 365 - todayFrac);
  };
  const roadmap = useMemo(() => {
    if (chartMarkers.length === 0) return null;
    const maxYears = Math.max(1, ...chartMarkers.map((m) => yearsFromNow(m.dateStr)));
    const xPct = (yrs: number) => (Math.sqrt(yrs) / Math.sqrt(maxYears)) * 100;
    const rows = chartMarkers.map((m) => {
      const target = m.goal.targetAmountMinor;
      const progress = m.isReached ? 100 : target > 0 ? Math.max(0, Math.min(100, Math.round((goalTotalMinor(m.goal) / target) * 100))) : 0;
      return { ...m, width: Math.max(14, m.isReached ? 14 : xPct(yearsFromNow(m.dateStr))), progress };
    });
    const ticks: { year: string; left: number }[] = [];
    Array.from(new Set<string>(chartMarkers.map((m) => m.dateStr.slice(0, 4)))).forEach((year) => {
      const left = xPct(yearsFromNow(`${year}-06-30`));
      if (ticks.every((t) => Math.abs(t.left - left) >= 14) && left < 96) ticks.push({ year, left });
    });
    return { rows, ticks };
  }, [chartMarkers, todayFrac]);
  const barTone = (m: { isProjected: boolean; isReached: boolean; monthsBehindTarget: number | null }) => {
    if (m.isReached || (m.monthsBehindTarget !== null && m.monthsBehindTarget <= 0)) return { fill: 'bg-success', frame: 'border-success bg-success/10', text: 'text-success' };
    if (m.monthsBehindTarget !== null) return { fill: 'bg-warning', frame: 'border-warning bg-warning/10', text: 'text-warning' };
    return { fill: 'bg-primary', frame: 'border-primary/50 bg-primary/10', text: 'text-primary' };
  };

  const totalAccumulatedMinor = reportableGoals.reduce((s, g) => s + goalTotalMinor(g), 0);
  const totalTargetMinor = reportableGoals.reduce((s, g) => s + g.targetAmountMinor, 0);
  const completedCount = reportableGoals.filter((g) => g.status === 'completed').length;

  // --- "Share my Reports" picker — friends + family only (no groups, always view-only; see this
  // plan's own confirmed answer: a reports-share is all-or-nothing, never edit). Seeded from
  // profile.reportsSharedWith (already live via useAuth(), no separate query needed for MY OWN
  // current grant list) each time the picker opens, so re-opening after a save shows the truth.
  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(user?.uid);
  const { families: myFamilies, membersByFamilyId } = useFamilies(user?.uid);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [pickerSelectedUids, setPickerSelectedUids] = useState<string[]>([]);
  const openSharePicker = () => {
    setPickerSelectedUids(profile?.reportsSharedWith || []);
    setShowSharePicker(true);
  };
  const togglePickerUid = (uid: string) => {
    setPickerSelectedUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  };
  const handleSaveShare = async () => {
    // Only the newly-added uids get notified — re-saving with the same selection (or removing
    // someone) shouldn't re-notify anyone already in the list.
    const previouslyShared = new Set(profile?.reportsSharedWith || []);
    const newlyAdded = pickerSelectedUids.filter((uid) => !previouslyShared.has(uid));
    await saveReportsShare(pickerSelectedUids);
    setShowSharePicker(false);
    if (newlyAdded.length > 0) {
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      auth.currentUser
        ?.getIdToken()
        .then((idToken) =>
          fetch('/api/health/notify-glucose-shared', {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendUids: newlyAdded, readingLabel: '', kind: 'reports', actorName }),
          }),
        )
        .catch((err) => console.error('notify reports-shared failed:', err));
    }
  };

  // Shared by both the "Mine" Horizon View list and the "Shared With Me" list below it — same
  // ladder-item look either way; `shared` just adds the small "shared with you" group badge next
  // to the name, matching GoalsHub.tsx's own goal-card convention for the same distinction.
  const renderHorizonItem = ({ goal, projected, reachedDate }: { goal: Goal; projected: string | null; reachedDate: string | null }, shared: boolean) => {
    // Same "how far off target" reasoning as GoalsHub.tsx's own goal cards — only shown when
    // there's a real target date AND a real projection to compare it to; a goal already at/past
    // target has nothing left to compare (it's done).
    const monthsBehindTarget = !reachedDate && goal.targetDate && projected
      ? (() => {
          const [ty, tm] = goal.targetDate.split('-').map(Number);
          const [py, pm] = projected.split('-').map(Number);
          return (py - ty) * 12 + (pm - tm);
        })()
      : null;
    return (
      <div key={goal.id} className="relative cursor-pointer" onClick={() => navigate(`/goals/${goal.id}?from=reports`)}>
        <span className={clsx('absolute -left-6 top-1 w-4 h-4 rounded-full border-2 border-white shadow', reachedDate ? 'bg-success' : projected ? 'bg-primary' : 'bg-border-subtle')} />
        <div className="bg-white rounded-xl border border-border-subtle shadow-sm p-3 flex items-center gap-3">
          <span className="text-xl shrink-0">{goal.icon || '🎯'}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-on-surface truncate flex items-center gap-1">
              {goal.name}
              {shared && <span className="material-symbols-outlined text-[13px] text-text-muted shrink-0" title={t('goals.sharedWithYou')}>group</span>}
            </p>
            <p className="text-[11px] text-text-muted flex items-center gap-1">
              {reachedDate
                ? t('goals.metOn', { date: reachedDate })
                : (projected ? t('goals.projectedMet', { date: projected }) : t('goals.projectionUnavailable'))}
              {reachedDate && (
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-black shrink-0 bg-success/10 text-success">
                  {t('goals.statusCompleted')}
                </span>
              )}
              {monthsBehindTarget !== null && (
                <span className={clsx(
                  'px-1.5 py-0.5 rounded-full text-[9px] font-black shrink-0',
                  monthsBehindTarget <= 0 ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
                )}>
                  {monthsBehindTarget <= 0
                    ? (monthsBehindTarget <= -1 ? t('goals.aheadOfTarget', { months: Math.abs(monthsBehindTarget) }) : t('goals.onTrack'))
                    : t('goals.behindTarget', { months: monthsBehindTarget })}
                </span>
              )}
            </p>
          </div>
          <span className="text-xs font-bold text-primary shrink-0">
            {getCurrencySymbol(goal.currency)}{formatAmountCompact(fromMinorUnits(Math.max(0, goal.targetAmountMinor - goalTotalMinor(goal))), goal.currency, profile?.numberSystem)} {t('goals.toGo')}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={embedded ? 'space-y-5' : 'p-4 md:p-8 max-w-2xl mx-auto space-y-5 pb-24 md:pb-24'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-primary">{t('goals.reportsTitle')}</h1>
          <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>
      )}

      {isOwnView && (
        <button
          type="button" onClick={openSharePicker}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-primary/20 bg-primary/5 text-primary text-xs font-bold"
        >
          <span className="material-symbols-outlined text-[16px]">share</span>
          {(profile?.reportsSharedWith || []).length > 0 ? t('goals.reportsSharedCount', { count: (profile?.reportsSharedWith || []).length }) : t('goals.shareMyReports')}
        </button>
      )}

      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-text-muted">
          {t('goals.totalAccumulated')} <span className="text-success font-black">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalAccumulatedMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</span>
        </span>
        <span className="text-xs font-bold text-text-muted text-right">
          {t('goals.totalTargeted')} <span className="text-primary font-black">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalTargetMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</span>
        </span>
      </div>

      {completedCount > 0 && (
        <p className="text-xs font-bold text-success text-center">{t('goals.completedCount', { count: completedCount })}</p>
      )}

      {reportableGoals.length > 0 && !ledgersReady && (
        <div className="rounded-2xl border border-border-subtle shadow-sm p-4 h-40 bg-surface animate-pulse" />
      )}

      {roadmap && ledgersReady && (
        <div className="rounded-2xl border border-primary-container/20 shadow-sm p-4 pt-3 space-y-2 bg-gradient-to-br from-primary-container/10 via-white to-success/10 overflow-hidden" data-tour="goals-horizon-chart">
          <h2 className="text-sm font-bold text-primary">{t('goals.goalHorizonChart')}</h2>
          <div className="flex items-center justify-between text-[10px] font-bold text-text-muted">
            <span>{t('goals.chartToday')}</span>
            <span>{t('goals.chartStretched')}</span>
          </div>
          <div className="relative h-4">
            {roadmap.ticks.map((tk) => (
              <span key={tk.year} className="absolute text-[10px] font-black text-primary -translate-x-1/2" style={{ left: `${tk.left}%` }}>{tk.year}</span>
            ))}
          </div>
          <div className="relative">
            <div className="absolute left-0 top-0 bottom-0 border-l-2 border-dashed border-primary/40" />
            {roadmap.ticks.map((tk) => (
              <div key={`g-${tk.year}`} className="absolute top-0 bottom-0 border-l border-dashed border-border-subtle" style={{ left: `${tk.left}%` }} />
            ))}
            {roadmap.rows.map((m) => {
              const tone = barTone(m);
              const toGoMinor = Math.max(0, m.goal.targetAmountMinor - goalTotalMinor(m.goal));
              return (
                <button
                  key={m.goal.id} type="button"
                  onClick={() => navigate(`/goals/${m.goal.id}?from=reports`)}
                  className="relative block w-full text-left py-1.5 active:opacity-70"
                >
                  <div className="flex items-baseline gap-1.5 pl-1.5 pr-0.5 mb-1">
                    <span className="text-xs font-bold text-on-surface truncate">{m.goal.icon || '🎯'} {m.goal.name}</span>
                    <span className="text-[10px] font-bold text-text-muted shrink-0">· {m.dateStr.slice(0, 7)}</span>
                    <span className={clsx('ml-auto text-[10px] font-black shrink-0', tone.text)}>
                      {m.isReached
                        ? t('goals.statusCompleted')
                        : `${m.progress}% · ${getCurrencySymbol(m.goal.currency)}${formatAmountCompact(fromMinorUnits(toGoMinor), m.goal.currency, profile?.numberSystem)} ${t('goals.toGo')}`}
                    </span>
                  </div>
                  <div className={clsx('h-5 rounded-full border-[1.5px] overflow-hidden', tone.frame)} style={{ width: `${m.width}%`, minWidth: 56 }}>
                    <div className={clsx('h-full rounded-full', tone.fill)} style={{ width: `${m.progress}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-success inline-block" />{t('goals.onTrack')}</span>
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-warning inline-block" />{t('goals.chartLegendBehind')}</span>
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-primary inline-block" />{t('goals.chartLegendProjected')}</span>
            <span className="text-[10px] text-text-muted">{t('goals.chartFilledSaved')}</span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-primary px-1">{t('goals.horizonView')}</h2>
        {!ledgersReady && reportableGoals.length > 0 ? (
          <div className="space-y-2">
            {reportableGoals.slice(0, 3).map((g) => <div key={g.id} className="h-16 rounded-xl bg-surface animate-pulse" />)}
          </div>
        ) : horizon.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-8">{t('goals.noActiveGoalsForAllocation')}</p>
        ) : (
          <div className="relative pl-6">
            <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-border-subtle" />
            <div className="space-y-4">
              {horizon.map((entry) => renderHorizonItem(entry, false))}
            </div>
          </div>
        )}
      </div>

      {isOwnView && sharedReportableGoals.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-primary px-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">group</span>
            {t('goals.sharedWithMe')}
          </h2>
          {!ledgersReady ? (
            <div className="space-y-2">
              {sharedReportableGoals.slice(0, 3).map((g) => <div key={g.id} className="h-16 rounded-xl bg-surface animate-pulse" />)}
            </div>
          ) : (
            <div className="relative pl-6">
              <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-border-subtle" />
              <div className="space-y-4">
                {sharedHorizon.map((entry) => renderHorizonItem(entry, true))}
              </div>
            </div>
          )}
        </div>
      )}

      {showSharePicker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !savingShare && setShowSharePicker(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.shareMyReports')}</h3>
            <p className="text-xs text-text-muted">{t('goals.shareMyReportsDesc')}</p>
            <div className="flex-1 overflow-y-auto space-y-3">
              {myFamilies.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('goals.family')}</p>
                  {myFamilies.map((fam: any) => {
                    const fmembers: any[] = membersByFamilyId.get(fam.id) || [];
                    return fmembers.filter((m) => m.userId !== user?.uid).map((m) => {
                      const selected = pickerSelectedUids.includes(m.userId);
                      return (
                        <button
                          key={m.userId} type="button" onClick={() => togglePickerUid(m.userId)}
                          className={clsx('w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}
                        >
                          <img src={m.photoURL || `https://ui-avatars.com/api/?name=${m.displayName}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                          <span className="flex-1 min-w-0 text-xs font-bold truncate">{m.displayName}</span>
                          <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                            {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                          </span>
                        </button>
                      );
                    });
                  })}
                </div>
              )}
              {acceptedFriends.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('goals.friends')}</p>
                  {acceptedFriends.map(({ friendUid }) => {
                    const friend = friendUsersByUid.get(friendUid);
                    const selected = pickerSelectedUids.includes(friendUid);
                    return (
                      <button
                        key={friendUid} type="button" onClick={() => togglePickerUid(friendUid)}
                        className={clsx('w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}
                      >
                        <img src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                        <span className="flex-1 min-w-0 text-xs font-bold truncate">{friend?.displayName || t('common.someone')}</span>
                        <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                          {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {myFamilies.length === 0 && acceptedFriends.length === 0 && (
                <p className="text-xs text-text-muted text-center py-4">{t('goals.noFriendsOrFamilyYet')}</p>
              )}
            </div>
            <button onClick={handleSaveShare} disabled={savingShare} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingShare ? t('goals.saving') : t('common.save')}
            </button>
            <button onClick={() => setShowSharePicker(false)} disabled={savingShare} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
