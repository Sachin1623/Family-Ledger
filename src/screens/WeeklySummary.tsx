import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { renderRecapCard } from '../lib/recapCardImage';
import { buildRecapView } from '../lib/recapFeatures';
import { installLinksText } from '../lib/cardCanvas';
import { shareOrDownloadFiles, shareText } from '../lib/fileShare';
import { thoughtFor, recapHabits, guardianLevel, GUARDIAN_DAYS_NAME } from '../lib/recapThoughts';
import type { RecapVariant } from '../lib/recapCardImage';
import { shareImageToApp, DirectShareTarget } from '../lib/appShare';
import { logGrowthEvent } from '../lib/growthEvents';
import type { ShareTarget } from '../lib/spreadTheWord';
import ShareAppButtons from '../components/ShareAppButtons';
import { collection, query, where, orderBy, limit } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// Points at server.ts's `/share` landing page (real Open Graph tags + share-banner.png), NOT the
// raw Play Store URL directly — the listing isn't published yet (confirmed 404 while building
// this), so linking straight to it would send every share to a dead page. `/share` is already
// live and always resolves; its own "Get it on Google Play" button is what carries the Play Store
// link once that listing actually goes public, with zero code changes needed here when it does.
const SHARE_LANDING_URL = `${window.location.origin}/share`;

interface SummaryBucket {
  gamesPlayed: number;
  coPlayers: number;
  groupsEngaged: number;
  expensesTracked: number;
  expenseLinesAdded: number;
  chatGroups: number;
  chatPeople: number;
  // Newer fields (older recaps don't have them — treated as 0).
  bpReadings?: number;
  glucoseReadings?: number;
  medicineDoses?: number;
  vaccinesGiven?: number;
  todosAdded?: number;
  shoppingLists?: number;
  goalsCreated?: number;
}

interface SummaryDoc {
  id: string;
  userId: string;
  generatedAt: string;
  periodLabel: string;
  week: SummaryBucket;
  prevWeek: SummaryBucket;
  month: SummaryBucket;
  prevMonth: SummaryBucket;
  // Standing snapshot ("as of this recap"), not a this-week-vs-last-week activity count like the
  // buckets above — undefined on any recap generated before this field existed.
  goalsTracked?: number;
  accountsMonitored?: number;
  kudos: string;
  // How consistently this person looked after the family's money and health (see computeRecapPraise on the server). Older recaps lack it.
  praise?: { loggedDays30: number; streakDays: number; healthDays30: number; weeksActive8: number; activeDays?: number; topPercent: number | null; members: number };
}

// The proud opening line of every shared caption: who this person is being (top X%, streak, habits), true to their own numbers.
function buildPraiseLead(summary: SummaryDoc): string {
  const p = summary.praise;
  if (!p) return '';
  const lines: string[] = [];
  if (p.topPercent != null) lines.push(`🏆 I'm in the top ${p.topPercent}% of FamilyLedger members for keeping track of my family's money.`);
  else if (p.streakDays >= 2) lines.push(`🔥 ${p.streakDays} days in a row watching my family's spending.`);
  const bits: string[] = [];
  if (p.streakDays >= 2 && p.topPercent != null) bits.push(`${p.streakDays} days in a row`);
  if ((p.activeDays ?? 0) > 0) bits.push(`${p.activeDays} ${GUARDIAN_DAYS_NAME} (${guardianLevel(p.activeDays!).title})`);
  if (p.loggedDays30 > 0) bits.push(`${p.loggedDays30} of the last 30 days logged`);
  if (p.healthDays30 > 0) bits.push(`${p.healthDays30} days caring for the family's health`);
  if (bits.length) lines.push(`📈 ${bits.join(' · ')}.`);
  if (lines.length) lines.push('Planning, awareness and small daily habits are what make a family financially steady. 💚');
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function buildShortShareMessage(summary: SummaryDoc): string {
  const w = summary.week;
  const p = summary.praise;
  if (p && (p.topPercent != null || p.streakDays >= 2)) {
    return `🏆 ${p.topPercent != null ? `Top ${p.topPercent}% of FamilyLedger members` : `${p.streakDays} days in a row`} for looking after my family's money — all in one family app 👇\n${installLinksText()}`;
  }
  return `🙌 My week on FamilyLedger: ${w.gamesPlayed} game${w.gamesPlayed === 1 ? '' : 's'} played, ${w.expensesTracked} expense${w.expensesTracked === 1 ? '' : 's'} tracked, ${w.chatPeople} ${w.chatPeople === 1 ? 'person' : 'people'} chatted with — all in one family app 👇\n${installLinksText()}`;
}

function buildShareMessage(summary: SummaryDoc): string {
  const w = summary.week;
  const trackingLine = summary.goalsTracked || summary.accountsMonitored
    ? ` I'm also tracking ${summary.goalsTracked ?? 0} savings goal${(summary.goalsTracked ?? 0) === 1 ? '' : 's'} across ${summary.accountsMonitored ?? 0} account${(summary.accountsMonitored ?? 0) === 1 ? '' : 's'}.`
    : '';
  return `${buildPraiseLead(summary)}🙌 This week FamilyLedger helped me stay connected — I played ${w.gamesPlayed} game${w.gamesPlayed === 1 ? '' : 's'} with ${w.coPlayers} family member${w.coPlayers === 1 ? '' : 's'}/friend${w.coPlayers === 1 ? '' : 's'}, tracked ${w.expensesTracked} expense${w.expensesTracked === 1 ? '' : 's'} across ${w.groupsEngaged} group${w.groupsEngaged === 1 ? '' : 's'}, and chatted with ${w.chatPeople} ${w.chatPeople === 1 ? 'person' : 'people'} — all in one app!${trackingLine}\n\n✅ Split bills equally, by %, or exact amounts\n🔄 Never forget a recurring bill\n🎲 Play Ludo, Rummy, Chess & more together\n📊 Budgets, smart reminders & to-do/shopping lists\n\nTry it with your family 👇\n${installLinksText()}`;
}


function AppreciationCard({ summary }: { summary: SummaryDoc }) {
  const p = summary.praise;
  const w = summary.week;
  const thought = thoughtFor(summary.generatedAt);
  const trackedMoney = (p?.loggedDays30 ?? 0) > 0 || w.expenseLinesAdded > 0 || w.expensesTracked > 0;
  const planning = (summary.goalsTracked ?? 0) > 0 || (summary.accountsMonitored ?? 0) > 0;
  const health = (p?.healthDays30 ?? 0) > 0 || (w.bpReadings ?? 0) + (w.glucoseReadings ?? 0) + (w.medicineDoses ?? 0) + (w.vaccinesGiven ?? 0) > 0;

  const headline = p?.topPercent != null
    ? `You are in the top ${p.topPercent}%`
    : (p?.streakDays ?? 0) >= 2 ? `${p!.streakDays} days in a row` : 'You are taking charge';
  const sub = p?.topPercent != null
    ? `of FamilyLedger members for keeping a close eye on your family's money this month.`
    : 'of your family\'s money. That is exactly how good habits start.';

  const badges: { icon: string; value: string; label: string }[] = [];
  if (p && (p.activeDays ?? 0) > 0) badges.push({ icon: 'shield', value: String(p.activeDays), label: `${GUARDIAN_DAYS_NAME} · ${guardianLevel(p.activeDays!).title}` });
  if (p && p.streakDays > 0) badges.push({ icon: 'local_fire_department', value: String(p.streakDays), label: p.streakDays === 1 ? 'day watching your spending' : 'days in a row watching your spending' });
  if (p && p.loggedDays30 > 0) badges.push({ icon: 'calendar_month', value: `${p.loggedDays30}/30`, label: 'days you logged expenses' });
  if (p && p.weeksActive8 > 0) badges.push({ icon: 'event_available', value: `${p.weeksActive8}/8`, label: 'recent weeks you stayed on top of it' });
  if (p && p.healthDays30 > 0) badges.push({ icon: 'favorite', value: String(p.healthDays30), label: 'days you looked after family health' });

  const habits = recapHabits({ trackedMoney, planning, health, goalsTracked: summary.goalsTracked ?? 0, accountsMonitored: summary.accountsMonitored ?? 0 });

  return (
    <div className="space-y-3">
      <div className="rounded-3xl p-5 text-white shadow-md" style={{ background: 'linear-gradient(135deg,#0d3b4e 0%,#1E3A8A 100%)' }}>
        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#4ADE80]">Well done</p>
        <p className="text-2xl font-black leading-tight mt-1">{headline}</p>
        <p className="text-sm text-white/85 mt-1 leading-snug">{sub}</p>
        <p className="text-sm text-white/90 mt-3 leading-snug">
          Looking after a family's finances takes patience and care. You believe in planning, you stay aware of every rupee, and that quiet consistency is what builds financial peace of mind.
        </p>
        {badges.length > 0 && (
          <div className="grid grid-cols-2 gap-2 mt-4">
            {badges.map((b) => (
              <div key={b.label} className="rounded-2xl bg-white/10 px-3 py-2.5 flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[#F59E0B] text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>{b.icon}</span>
                <div className="min-w-0">
                  <p className="text-lg font-black leading-none">{b.value}</p>
                  <p className="text-[10px] text-white/75 leading-tight mt-0.5">{b.label}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border-subtle bg-white p-4 space-y-2.5">
        <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Habits of financially steady families</p>
        {habits.map((h) => (
          <div key={h.title} className="flex items-start gap-3">
            <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${h.done ? 'bg-green-100 text-green-700' : 'bg-surface text-text-muted'}`}>
              <span className="material-symbols-outlined text-[18px]">{h.done ? 'check' : h.icon}</span>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-black text-primary leading-tight">{h.title}</p>
              <p className="text-[12px] text-text-muted leading-snug">{h.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 flex items-start gap-3">
        <span className="material-symbols-outlined text-amber-600 text-[22px] shrink-0">{thought.icon}</span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">A thought for this week</p>
          <p className="text-[13px] text-amber-950 leading-snug mt-0.5">{thought.text}</p>
          <p className="text-[10px] text-amber-700/80 mt-1">{thought.source}</p>
        </div>
      </div>
    </div>
  );
}

function StatRow({ icon, label, current, previous }: { icon: string; label: string; current: number; previous: number }) {
  const diff = current - previous;
  return (
    <div className="bg-surface rounded-xl p-3 flex items-center gap-2.5">
      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-on-surface leading-tight">{current}</p>
        <p className="text-[10px] text-text-muted font-bold leading-tight">{label}</p>
      </div>
      {diff !== 0 && (
        <span className={`text-[10px] font-bold shrink-0 flex items-center gap-0.5 ${diff > 0 ? 'text-success' : 'text-error'}`}>
          <span className="material-symbols-outlined text-[12px]">{diff > 0 ? 'arrow_upward' : 'arrow_downward'}</span>
          {Math.abs(diff)}
        </span>
      )}
    </div>
  );
}

// No diff arrow — unlike StatRow's period-over-period rows, goalsTracked/accountsMonitored are a
// standing count as of this recap, not a this-period-vs-last-period activity delta.
function SnapshotStat({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="bg-surface rounded-xl p-3 flex items-center gap-2.5">
      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-on-surface leading-tight">{value}</p>
        <p className="text-[10px] text-text-muted font-bold leading-tight">{label}</p>
      </div>
    </div>
  );
}

function PeriodStats({ current, previous }: { current: SummaryBucket; previous: SummaryBucket }) {
  return (
    <div className="space-y-1.5">
      <StatRow icon="sports_esports" label={`Games played · with ${current.coPlayers} ${current.coPlayers === 1 ? 'person' : 'people'}`} current={current.gamesPlayed} previous={previous.gamesPlayed} />
      <StatRow icon="groups" label="Family groups engaged in" current={current.groupsEngaged} previous={previous.groupsEngaged} />
      <StatRow icon="receipt_long" label="Total expenses tracked" current={current.expensesTracked} previous={previous.expensesTracked} />
      <StatRow icon="edit_note" label="Expense lines you added" current={current.expenseLinesAdded} previous={previous.expenseLinesAdded} />
      <StatRow icon="chat" label="Groups/games you chatted in" current={current.chatGroups} previous={previous.chatGroups} />
      <StatRow icon="diversity_3" label="People you connected with via chat" current={current.chatPeople} previous={previous.chatPeople} />
      {/* Newer stats — only shown once there's something to show, so older recaps look unchanged. */}
      {((current.bpReadings ?? 0) > 0 || (previous.bpReadings ?? 0) > 0) && <StatRow icon="favorite" label="BP readings logged" current={current.bpReadings ?? 0} previous={previous.bpReadings ?? 0} />}
      {((current.glucoseReadings ?? 0) > 0 || (previous.glucoseReadings ?? 0) > 0) && <StatRow icon="water_drop" label="Glucose readings logged" current={current.glucoseReadings ?? 0} previous={previous.glucoseReadings ?? 0} />}
      {((current.medicineDoses ?? 0) > 0 || (previous.medicineDoses ?? 0) > 0) && <StatRow icon="medication" label="Medicine doses taken" current={current.medicineDoses ?? 0} previous={previous.medicineDoses ?? 0} />}
      {((current.vaccinesGiven ?? 0) > 0 || (previous.vaccinesGiven ?? 0) > 0) && <StatRow icon="vaccines" label="Vaccines recorded" current={current.vaccinesGiven ?? 0} previous={previous.vaccinesGiven ?? 0} />}
      {((current.todosAdded ?? 0) > 0 || (previous.todosAdded ?? 0) > 0) && <StatRow icon="task_alt" label="To-dos added" current={current.todosAdded ?? 0} previous={previous.todosAdded ?? 0} />}
      {((current.shoppingLists ?? 0) > 0 || (previous.shoppingLists ?? 0) > 0) && <StatRow icon="shopping_cart" label="Shopping lists made" current={current.shoppingLists ?? 0} previous={previous.shoppingLists ?? 0} />}
      {((current.goalsCreated ?? 0) > 0 || (previous.goalsCreated ?? 0) > 0) && <StatRow icon="flag" label="New goals set" current={current.goalsCreated ?? 0} previous={previous.goalsCreated ?? 0} />}
    </div>
  );
}



const RECAP_BUILD_STEPS = [
  'Counting your games…',
  'Adding up your expenses…',
  'Checking in on your goals and health logs…',
  'Finding your week’s highlights…',
  'Polishing your picture…',
];

// Shown while the recap picture is being drawn (a second or two, longer on a slow phone): a branded card the same shape as the
// picture, a gentle shimmer, and a line that changes so it clearly feels like something is happening. If drawing fails it says so
// and offers a retry instead of leaving an empty box.
function RecapPreviewPlaceholder({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    if (failed) return;
    const t = setInterval(() => setStep((n) => Math.min(n + 1, RECAP_BUILD_STEPS.length - 1)), 1400);
    return () => clearInterval(t);
  }, [failed]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative w-full aspect-[4/5] rounded-2xl overflow-hidden shadow-md flex flex-col items-center justify-center text-center px-8 gap-4 text-white"
      style={{ background: 'radial-gradient(ellipse at 50% 30%, #0f5a6b 0%, #0b3a4f 55%, #072436 100%)' }}
    >
      <style>{`@keyframes recapSheen{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}@keyframes recapBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}`}</style>
      {!failed && (
        <div aria-hidden className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/10 to-transparent" style={{ animation: 'recapSheen 1.8s ease-in-out infinite' }} />
      )}
      <span className="material-symbols-outlined text-[44px] text-amber-300" style={{ animation: failed ? undefined : 'recapBob 1.6s ease-in-out infinite', fontVariationSettings: "'FILL' 1" }}>
        {failed ? 'error' : 'auto_awesome'}
      </span>
      {failed ? (
        <>
          <p className="text-base font-black">We couldn’t draw your picture</p>
          <p className="text-xs text-white/70">Your numbers below are fine. Give it another try.</p>
          <button onClick={onRetry} className="px-5 py-2.5 rounded-xl bg-white text-primary text-sm font-black active:scale-95">Try again</button>
        </>
      ) : (
        <>
          <p className="text-base font-black">Creating your weekly recap…</p>
          <p className="text-xs text-white/75 min-h-[1.25rem] transition-opacity">{RECAP_BUILD_STEPS[step]}</p>
          <div className="w-40 h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div className="h-full rounded-full bg-amber-300 transition-all duration-1000 ease-out" style={{ width: `${((step + 1) / RECAP_BUILD_STEPS.length) * 100}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

export default function WeeklySummary() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  // The pictures that can be shared, drawn on a canvas (see recapCardImage.ts). Each is shown as a tappable thumbnail and the person ticks
  // the ones to send, so what they see is exactly what goes out.
  const [pictures, setPictures] = React.useState<Partial<Record<RecapVariant, { url: string; blob: Blob }>>>({});
  const [failedVariants, setFailedVariants] = React.useState<Set<RecapVariant>>(new Set());
  const [chosen, setChosen] = React.useState<RecapVariant[]>(['achievement']);
  const [previewAttempt, setPreviewAttempt] = React.useState(0);
  const [zoomed, setZoomed] = React.useState<RecapVariant | null>(null);

  const [summariesSnap, loading] = useCollection(
    user ? query(collection(db, 'userWeeklySummaries'), where('userId', '==', user.uid), orderBy('generatedAt', 'desc'), limit(20)) : null,
  );
  const summaries: SummaryDoc[] = React.useMemo(
    () => summariesSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as SummaryDoc)) || [],
    [summariesSnap],
  );
  const active = summaries.find((s) => s.id === selectedId) || summaries[0] || null;

  const close = () => navigate('/');

  // The picture styles available for this recap. The caring-for-family one only appears when there is health data to show.
  const variantsFor = (summary: SummaryDoc): { id: RecapVariant; title: string; blurb: string }[] => {
    const w = summary.week;
    const hasHealth = (summary.praise?.healthDays30 ?? 0) > 0 || (w.bpReadings ?? 0) + (w.glucoseReadings ?? 0) + (w.medicineDoses ?? 0) + (w.vaccinesGiven ?? 0) > 0;
    const list: { id: RecapVariant; title: string; blurb: string }[] = [
      { id: 'achievement', title: 'My achievement', blurb: 'Top ranking, streak and week' },
      { id: 'numbers', title: 'My week in numbers', blurb: 'What I did, vs last week' },
      { id: 'habits', title: 'Steady family habits', blurb: 'Habits and a money thought' },
    ];
    if (hasHealth) list.push({ id: 'care', title: 'Caring for my family', blurb: 'Health and care this week' });
    return list;
  };

  // What the picture features depends on where THIS person was most engaged this week (health, games,
  // money, planning, chat...) — at least six different features, most-used first.
  const buildRecapBlob = (summary: SummaryDoc, variant: RecapVariant) => {
    const w = summary.week;
    const p = summary.praise;
    const habits = recapHabits({
      trackedMoney: (p?.loggedDays30 ?? 0) > 0 || w.expenseLinesAdded > 0 || w.expensesTracked > 0,
      planning: (summary.goalsTracked ?? 0) > 0 || (summary.accountsMonitored ?? 0) > 0,
      health: (p?.healthDays30 ?? 0) > 0 || (w.bpReadings ?? 0) + (w.glucoseReadings ?? 0) + (w.medicineDoses ?? 0) + (w.vaccinesGiven ?? 0) > 0,
      goalsTracked: summary.goalsTracked ?? 0,
      accountsMonitored: summary.accountsMonitored ?? 0,
    });
    const t = thoughtFor(summary.generatedAt);
    return renderRecapCard({
      variant,
      periodLabel: summary.periodLabel,
      kudos: summary.kudos,
      view: buildRecapView(summary.week, summary.prevWeek, { goalsTracked: summary.goalsTracked, accountsMonitored: summary.accountsMonitored }),
      praise: summary.praise,
      habits: habits.map((h) => ({ done: h.done, emoji: h.emoji, title: h.title, text: h.text })),
      thought: { emoji: t.emoji, text: t.text, source: t.source },
      care: { medicineDoses: w.medicineDoses ?? 0, bpReadings: w.bpReadings ?? 0, glucoseReadings: w.glucoseReadings ?? 0, vaccinesGiven: w.vaccinesGiven ?? 0 },
    });
  };

  // Draw every picture for the selected recap, one after another, and show each as soon as it is ready.
  React.useEffect(() => {
    if (!active) {
      setPictures({});
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    setPictures({});
    setFailedVariants(new Set());
    setChosen(variantsFor(active).map((v) => v.id)); // every picture starts selected; tap one to leave it out
    (async () => {
      for (const v of variantsFor(active)) {
        try {
          const blob = await buildRecapBlob(active, v.id);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPictures((prev) => ({ ...prev, [v.id]: { url, blob } }));
        } catch (err) {
          console.error('Recap picture failed:', v.id, err);
          if (!cancelled) setFailedVariants((prev) => new Set(prev).add(v.id));
        }
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, previewAttempt]);

  const toggleChosen = (id: RecapVariant) => setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // The chosen pictures, in the order they are listed, that have finished drawing.
  const chosenBlobs = (): { blob: Blob; filename: string }[] =>
    (active ? variantsFor(active) : [])
      .filter((v) => chosen.includes(v.id) && pictures[v.id])
      .map((v) => ({ blob: pictures[v.id]!.blob, filename: `familyledger-recap-${v.id}.png` }));

  // All three buttons below try the SAME best path first — hand the chosen picture(s) (plus the full text) to the phone's own share
  // sheet, so whichever app the user picks (WhatsApp — a contact or Status, Facebook, Instagram, anything else registered as a share
  // target) receives the actual image(s) with real numbers baked in. On the installed app this goes through the native share plugin; in a
  // browser it uses the Web Share API. One picture can also open a brand app's own composer directly; several always use the share sheet.
  const shareViaOsSheet = async (message: string): Promise<boolean> => {
    const files = chosenBlobs();
    if (!active || files.length === 0) return false;
    const nav = navigator as any;
    if (!Capacitor.isNativePlatform() && !nav.share) return false;
    try {
      await shareOrDownloadFiles(files, 'image/png', message);
      return true;
    } catch (err) {
      console.error('Image share failed, falling back:', err);
      return false;
    }
  };

  const [shareNote, setShareNote] = React.useState<string | null>(null);

  // Same flow as Profile's "Spread the Word": a brand button opens that app's own composer with the recap picture when the
  // phone supports it, otherwise the phone's share sheet carries the picture and text, otherwise a text-only fallback.
  const handleShareApp = async (target: ShareTarget) => {
    if (!active) return;
    setShareNote(null);
    const message = buildShareMessage(active);
    const text = target === 'twitter' ? buildShortShareMessage(active) : message;
    logGrowthEvent(`share_${target}` as Parameters<typeof logGrowthEvent>[0], user?.uid);
    const picked = chosenBlobs();
    if (picked.length === 0) {
      setShareNote('Tap at least one picture above to choose what to share.');
      return;
    }
    const blob = picked.length === 1 ? picked[0].blob : null;
    if (picked.length > 1) setShareNote(`Sharing ${picked.length} pictures: pick the app in your phone's share sheet.`);
    if (blob && target !== 'native') {
      const direct = await shareImageToApp(target as DirectShareTarget, blob, text);
      if (direct.status === 'shared') {
        if (direct.captionCopied) setShareNote("Caption copied — paste it into your post. (Facebook and Instagram don't let apps fill it in.)");
        return;
      }
      if (direct.status === 'not_installed') setShareNote("That app doesn't seem to be installed — choose another app from the share sheet instead.");
    }
    if (picked.length > 0 && (await shareViaOsSheet(text))) return;
    // No image sharing here — fall back to the same text/link shares as everywhere else.
    if (target === 'native') {
      navigator.clipboard?.writeText(message).catch(() => {});
      alert('Share message copied! (Sharing is not supported on this device/browser.)');
      return;
    }
    if (target === 'whatsapp') window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    else if (target === 'twitter') window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
    else if (target === 'facebook') window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_LANDING_URL)}`, '_blank');
    else if (target === 'linkedin') window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_LANDING_URL)}`, '_blank');
    else {
      navigator.clipboard?.writeText(message).catch(() => {});
      alert('Caption copied! Open Instagram and paste it into your post.');
    }
  };

  const handleShareLinkOnly = async () => {
    if (!active) return;
    const result = await shareText('FamilyLedger', buildShareMessage(active));
    if (result === 'copied') alert('Message and link copied!');
    logGrowthEvent('share_link_only', user?.uid);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[280] flex items-center justify-center p-4" onClick={close}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        >
          <div className="p-4 border-b border-border-subtle flex items-center justify-between shrink-0">
            <h2 className="text-lg font-bold text-primary">Your Weekly Recap</h2>
            <button onClick={close} className="p-2 hover:bg-surface rounded-full shrink-0">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-5">
            {loading && <p className="text-center text-sm text-text-muted py-8">Loading…</p>}
            {!loading && !active && (
              <p className="text-center text-sm text-text-muted italic py-8">
                No recap yet — check back after your first week of activity!
              </p>
            )}

            {active && (
              <>
                <div className="rounded-3xl border-2 border-primary/20 bg-primary/5 p-4 space-y-3">
                  <div className="text-center space-y-1">
                    <p className="text-sm font-black text-primary">Be proud of this. Inspire another family.</p>
                    <p className="text-xs text-text-muted leading-snug">
                      All your pictures are ready and selected below. Untick any you do not want, then share in one tap. Each has your achievements, the app link, a QR code, the Google Play badge, and our Instagram and Facebook pages, and the caption carries the links too.
                    </p>
                  </div>
                  <ShareAppButtons
                    onShare={handleShareApp}
                    onLinkOnly={handleShareLinkOnly}
                    primaryIcon={typeof navigator !== 'undefined' && (navigator as any).share ? 'share' : 'content_copy'}
                    primaryLabel={typeof navigator !== 'undefined' && (navigator as any).share ? (chosen.length > 1 ? `Share ${chosen.length} pictures` : 'Share my recap') : 'Copy share message'}
                    note={shareNote}
                  />
                </div>

                <AppreciationCard summary={active} />

                <div className="space-y-2">
                  <div className="flex items-end justify-between px-1">
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Pick what to share</p>
                    <p className="text-[11px] font-black text-primary">{chosen.length === 0 ? 'None selected' : `${chosen.length} selected`}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {variantsFor(active).map((v) => {
                      const pic = pictures[v.id];
                      const on = chosen.includes(v.id);
                      const failed = failedVariants.has(v.id);
                      return (
                        <div key={v.id} className="space-y-1">
                          <button
                            type="button"
                            onClick={() => pic && toggleChosen(v.id)}
                            aria-pressed={on}
                            aria-label={`${on ? 'Selected' : 'Not selected'}: ${v.title}`}
                            className={`relative block w-full aspect-[4/5] rounded-2xl overflow-hidden transition-all active:scale-[0.98] ${on ? 'ring-4 ring-primary shadow-lg' : 'ring-1 ring-border-subtle opacity-80'}`}
                          >
                            {pic ? (
                              <img src={pic.url} alt={v.title} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full bg-[#0b3a4f] flex items-center justify-center text-white/80 text-[11px] font-bold px-3 text-center">
                                {failed ? 'Could not draw this one' : 'Drawing…'}
                              </div>
                            )}
                            <span className={`absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center shadow-md ${on ? 'bg-primary text-white' : 'bg-white/90 text-text-muted border border-border-subtle'}`}>
                              <span className="material-symbols-outlined text-[20px]">{on ? 'check' : 'add'}</span>
                            </span>
                            {on && <span className="absolute bottom-0 inset-x-0 bg-primary text-white text-[11px] font-black py-1 text-center">Selected to share</span>}
                          </button>
                          <div className="flex items-start justify-between gap-1 px-0.5">
                            <div className="min-w-0">
                              <p className="text-[11px] font-black text-primary leading-tight truncate">{v.title}</p>
                              <p className="text-[10px] text-text-muted leading-tight truncate">{v.blurb}</p>
                            </div>
                            {pic && <button type="button" onClick={() => setZoomed(v.id)} className="shrink-0 text-[10px] font-bold text-primary underline">View</button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {failedVariants.size > 0 && (
                    <button type="button" onClick={() => setPreviewAttempt((n) => n + 1)} className="w-full py-2 rounded-xl bg-primary/5 text-primary text-xs font-black">Try drawing again</button>
                  )}
                </div>

                {zoomed && pictures[zoomed] && (
                  <div className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center p-4" onClick={() => setZoomed(null)}>
                    <img src={pictures[zoomed]!.url} alt="Recap picture" className="max-h-full max-w-full rounded-2xl" />
                    <button type="button" onClick={() => setZoomed(null)} className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/90 flex items-center justify-center" aria-label="Close"><span className="material-symbols-outlined">close</span></button>
                  </div>
                )}

                {(active.goalsTracked !== undefined || active.accountsMonitored !== undefined) && (
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2 px-1">Your Money Tracking</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <SnapshotStat icon="flag" label="Goals tracked" value={active.goalsTracked ?? 0} />
                      <SnapshotStat icon="account_balance" label="Accounts monitored" value={active.accountsMonitored ?? 0} />
                    </div>
                  </div>
                )}

                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider -mb-2 px-1">Your week in numbers</p>
                <div>
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2 px-1">This Week vs. Last Week</p>
                  <PeriodStats current={active.week} previous={active.prevWeek} />
                </div>

                <div>
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2 px-1">This Month vs. Last Month</p>
                  <PeriodStats current={active.month} previous={active.prevMonth} />
                </div>

                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className="w-full py-2.5 rounded-xl text-xs font-bold text-primary bg-primary/5 flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">history</span>
                  {showHistory ? 'Hide past recaps' : `See all past recaps (${summaries.length})`}
                </button>

                {showHistory && (
                  <div className="space-y-1.5">
                    {summaries.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => setSelectedId(s.id)}
                        className={`w-full text-left p-2.5 rounded-xl border ${s.id === active.id ? 'border-primary bg-primary/5' : 'border-border-subtle bg-white'}`}
                      >
                        <p className="text-xs font-bold text-on-surface">{s.periodLabel}</p>
                        <p className="text-[10px] text-text-muted italic line-clamp-1">{s.kudos}</p>
                      </button>
                    ))}
                  </div>
                )}

              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
