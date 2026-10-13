import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { renderRecapCard } from '../lib/recapCardImage';
import { buildRecapView } from '../lib/recapFeatures';
import { installLinksText } from '../lib/cardCanvas';
import { shareOrDownloadFile } from '../lib/fileShare';
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
}

function buildShareMessage(summary: SummaryDoc): string {
  const w = summary.week;
  const trackingLine = summary.goalsTracked || summary.accountsMonitored
    ? ` I'm also tracking ${summary.goalsTracked ?? 0} savings goal${(summary.goalsTracked ?? 0) === 1 ? '' : 's'} across ${summary.accountsMonitored ?? 0} account${(summary.accountsMonitored ?? 0) === 1 ? '' : 's'}.`
    : '';
  return `🙌 This week FamilyLedger helped me stay connected — I played ${w.gamesPlayed} game${w.gamesPlayed === 1 ? '' : 's'} with ${w.coPlayers} family member${w.coPlayers === 1 ? '' : 's'}/friend${w.coPlayers === 1 ? '' : 's'}, tracked ${w.expensesTracked} expense${w.expensesTracked === 1 ? '' : 's'} across ${w.groupsEngaged} group${w.groupsEngaged === 1 ? '' : 's'}, and chatted with ${w.chatPeople} ${w.chatPeople === 1 ? 'person' : 'people'} — all in one app!${trackingLine}\n\n✅ Split bills equally, by %, or exact amounts\n🔄 Never forget a recurring bill\n🎲 Play Ludo, Rummy, Chess & more together\n📊 Budgets, smart reminders & to-do/shopping lists\n\nTry it with your family 👇\n${installLinksText()}`;
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


export default function WeeklySummary() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  // The picture that gets shared, drawn on a canvas (see recapCardImage.ts) — also shown here as the
  // preview, so what you see is exactly what goes out.
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

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
    });

  // Preview of the exact image that will be shared, regenerated whenever the selected recap changes.
  React.useEffect(() => {
    if (!active) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    buildRecapBlob(active)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      })
      .catch((err) => console.error('Recap preview failed:', err));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

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

  const handleShareStatus = async () => {
    if (!active) return;
    const message = buildShareMessage(active);
    if (await shareViaOsSheet(message)) return;
    navigator.clipboard?.writeText(message).catch(() => {});
    alert('Share message copied! Paste it into WhatsApp yourself — the share sheet isn\'t supported on this device/browser.');
  };

  const handleSendWhatsApp = async () => {
    if (!active) return;
    const message = buildShareMessage(active);
    if (await shareViaOsSheet(message)) return;
    // wa.me can't carry an image via URL params at all — text-only fallback, same as before.
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleShareFacebook = async () => {
    if (!active) return;
    const message = buildShareMessage(active);
    if (await shareViaOsSheet(message)) return;
    // Facebook's own sharer.php ONLY ever accepts a bare URL from an external caller (a real,
    // unfixable platform restriction) and has no way to receive custom text OR an image from us —
    // this only runs if the OS share sheet itself isn't available above.
    navigator.clipboard?.writeText(message).catch(() => {});
    alert('Copied your recap! In the Facebook box that opens: 1) Paste (your message + link), 2) Tap the photo icon and attach a screenshot yourself — Facebook doesn\'t let us pre-fill either one automatically.');
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_LANDING_URL)}`, '_blank');
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
                {previewUrl ? (
                  <img src={previewUrl} alt="Your weekly recap picture" className="w-full rounded-2xl shadow-md" />
                ) : (
                  <div className="w-full aspect-[4/5] rounded-2xl bg-surface animate-pulse" />
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

                <div className="border-t border-border-subtle pt-4 space-y-2.5">
                  <p className="text-xs text-text-muted text-center leading-snug">
                    Enjoying FamilyLedger? Share how it's helping you stay connected with family & friends — one tap:
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={handleShareStatus} className="py-2.5 rounded-xl bg-[#25D366]/10 text-[#25D366] text-[11px] font-bold flex flex-col items-center gap-1">
                      <span className="material-symbols-outlined text-[18px]">ios_share</span>
                      WhatsApp Status
                    </button>
                    <button onClick={handleSendWhatsApp} className="py-2.5 rounded-xl bg-[#25D366]/10 text-[#25D366] text-[11px] font-bold flex flex-col items-center gap-1">
                      <span className="material-symbols-outlined text-[18px]">send</span>
                      Send to WhatsApp
                    </button>
                    <button onClick={handleShareFacebook} className="py-2.5 rounded-xl bg-[#1877F2]/10 text-[#1877F2] text-[11px] font-bold flex flex-col items-center gap-1">
                      <span className="material-symbols-outlined text-[18px]">thumb_up</span>
                      Facebook
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
