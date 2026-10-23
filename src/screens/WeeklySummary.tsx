import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { renderRecapCard } from '../lib/recapCardImage';
import { buildRecapView } from '../lib/recapFeatures';
import { installLinksText } from '../lib/cardCanvas';
import { shareOrDownloadFile, shareText } from '../lib/fileShare';
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
  praise?: { loggedDays30: number; streakDays: number; healthDays30: number; weeksActive8: number; topPercent: number | null; members: number };
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


// What financially steady families tend to do, in plain words, with where the idea comes from. These are widely repeated rules of thumb
// from financial planners and consumer-finance research, offered as encouragement, never as a promise of a result.
const COMMUNITY_THOUGHTS: { icon: string; text: string; source: string }[] = [
  { icon: 'savings', text: 'Financial planners commonly suggest keeping 3 to 6 months of living expenses aside as an emergency fund, and keeping it separate from everyday savings.', source: 'Common planner guidance' },
  { icon: 'pie_chart', text: 'The popular 50/30/20 guide splits income into needs, wants and savings. It only works if you know where the money actually goes, and you are finding that out.', source: '50/30/20 rule of thumb (Elizabeth Warren)' },
  { icon: 'visibility', text: 'In a UK study of people who used a budgeting method for three months, about half said it helped them keep track of what they spend, and over a third said they understood their income and spending better.', source: 'Royal London, "Looking after the pennies" (2017)' },
  { icon: 'event_repeat', text: 'Money habits stick when they are small and regular. A quick check-in each week matters more than a long review once a year.', source: 'Habit-building principle widely used by planners' },
  { icon: 'family_restroom', text: 'Families who talk about money openly, with everyone seeing the same numbers, tend to argue less about it. Shared groups give you exactly that.', source: 'Common family-finance advice' },
  { icon: 'flag', text: 'Writing a goal down, with an amount and a date, makes it far easier to act on than a vague wish to save more.', source: 'Goal-setting guidance used by planners' },
  { icon: 'health_and_safety', text: 'Health is a money topic too. Medical costs are one of the biggest surprises in a family budget, and staying on top of check-ups and medicines helps avoid them.', source: 'Common family-finance advice' },
];

function AppreciationCard({ summary }: { summary: SummaryDoc }) {
  const p = summary.praise;
  const w = summary.week;
  const weekNumber = Math.floor(new Date(summary.generatedAt).getTime() / (7 * 86400000));
  const thought = COMMUNITY_THOUGHTS[weekNumber % COMMUNITY_THOUGHTS.length];
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
  if (p && p.streakDays > 0) badges.push({ icon: 'local_fire_department', value: String(p.streakDays), label: p.streakDays === 1 ? 'day watching your spending' : 'days in a row watching your spending' });
  if (p && p.loggedDays30 > 0) badges.push({ icon: 'calendar_month', value: `${p.loggedDays30}/30`, label: 'days you logged expenses' });
  if (p && p.weeksActive8 > 0) badges.push({ icon: 'event_available', value: `${p.weeksActive8}/8`, label: 'recent weeks you stayed on top of it' });
  if (p && p.healthDays30 > 0) badges.push({ icon: 'favorite', value: String(p.healthDays30), label: 'days you looked after family health' });

  const habits = [
    { done: trackedMoney, icon: 'receipt_long', title: 'Knows where the money goes', text: 'You track spending, which is the first step planners ask of every family.' },
    { done: planning, icon: 'flag', title: 'Plans ahead', text: planning ? `You are tracking ${summary.goalsTracked ?? 0} goal${(summary.goalsTracked ?? 0) === 1 ? '' : 's'} and ${summary.accountsMonitored ?? 0} account${(summary.accountsMonitored ?? 0) === 1 ? '' : 's'}.` : 'Set one goal with an amount and a date to join the planners.' },
    { done: health, icon: 'favorite', title: 'Protects the family\'s health', text: health ? 'You are keeping health records, which helps avoid costly surprises.' : 'Add a medicine or health log to cover the other half of family wellbeing.' },
  ];

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
  // The picture that gets shared, drawn on a canvas (see recapCardImage.ts) — also shown here as the
  // preview, so what you see is exactly what goes out.
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const [previewAttempt, setPreviewAttempt] = React.useState(0);

  const [summariesSnap, loading] = useCollection(
    user ? query(collection(db, 'userWeeklySummaries'), where('userId', '==', user.uid), orderBy('generatedAt', 'desc'), limit(20)) : null,
  );
  const summaries: SummaryDoc[] = React.useMemo(
    () => summariesSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as SummaryDoc)) || [],
    [summariesSnap],
  );
  const active = summaries.find((s) => s.id === selectedId) || summaries[0] || null;

  const close = () => navigate('/');

  // What the picture features depends on where THIS person was most engaged this week (health, games,
  // money, planning, chat...) — at least six different features, most-used first.
  const buildRecapBlob = (summary: SummaryDoc) =>
    renderRecapCard({
      periodLabel: summary.periodLabel,
      kudos: summary.kudos,
      view: buildRecapView(summary.week, summary.prevWeek, { goalsTracked: summary.goalsTracked, accountsMonitored: summary.accountsMonitored }),
      praise: summary.praise,
    });

  // Preview of the exact image that will be shared, regenerated whenever the selected recap changes.
  React.useEffect(() => {
    if (!active) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    // Start from "creating…" every time (another recap selected, or a retry), never leaving the previous picture or a blank box up.
    setPreviewUrl(null);
    setPreviewFailed(false);
    buildRecapBlob(active)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      })
      .catch((err) => {
        console.error('Recap preview failed:', err);
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, previewAttempt]);

  // All three buttons below try the SAME best path first — hand the recap picture (plus the full
  // text) to the phone's own share sheet, so whichever app the user picks (WhatsApp — a contact or
  // Status, Facebook, Instagram, anything else registered as a share target) receives the actual
  // image with real numbers baked in. On the installed app this goes through the native share
  // plugin (the WebView's own navigator.share can't reliably carry files); in a browser it uses the
  // Web Share API. They only diverge in their FALLBACK when neither is available.
  const shareViaOsSheet = async (message: string): Promise<boolean> => {
    if (!active) return false;
    const nav = navigator as any;
    if (!Capacitor.isNativePlatform() && !nav.share) return false;
    try {
      const blob = await buildRecapBlob(active);
      await shareOrDownloadFile(blob, 'familyledger-weekly-recap.png', 'image/png', message);
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
    const blob = await buildRecapBlob(active).catch(() => null);
    if (blob && target !== 'native') {
      const direct = await shareImageToApp(target as DirectShareTarget, blob, text);
      if (direct.status === 'shared') {
        if (direct.captionCopied) setShareNote("Caption copied — paste it into your post. (Facebook and Instagram don't let apps fill it in.)");
        return;
      }
      if (direct.status === 'not_installed') setShareNote("That app doesn't seem to be installed — choose another app from the share sheet instead.");
    }
    if (blob && (await shareViaOsSheet(text))) return;
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
                <AppreciationCard summary={active} />

                {previewUrl ? (
                  <motion.img
                    key={previewUrl}
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.35 }}
                    src={previewUrl}
                    alt="Your weekly recap picture"
                    className="w-full rounded-2xl shadow-md"
                  />
                ) : (
                  <RecapPreviewPlaceholder failed={previewFailed} onRetry={() => setPreviewAttempt((n) => n + 1)} />
                )}

                <div className="rounded-3xl border-2 border-primary/20 bg-primary/5 p-4 space-y-3">
                  <div className="text-center space-y-1">
                    <p className="text-sm font-black text-primary">Be proud of this. Inspire another family.</p>
                    <p className="text-xs text-text-muted leading-snug">
                      Share your recap in one tap. The picture already has your achievements, the app link, a QR code, the Google Play badge, and our Instagram and Facebook pages, and the caption carries the links too.
                    </p>
                  </div>
                  <ShareAppButtons
                    onShare={handleShareApp}
                    onLinkOnly={handleShareLinkOnly}
                    primaryIcon={typeof navigator !== 'undefined' && (navigator as any).share ? 'share' : 'content_copy'}
                    primaryLabel={typeof navigator !== 'undefined' && (navigator as any).share ? 'Share my recap' : 'Copy share message'}
                    note={shareNote}
                  />
                </div>

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
