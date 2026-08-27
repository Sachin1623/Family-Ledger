import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
// html2canvas-pro, not plain html2canvas — see HealthGlucose.tsx's PDF export for why (the
// original throws on Tailwind v4's color-mix()/oklab()-based opacity modifiers, which this
// recap tile's own classes use).
import html2canvas from 'html2canvas-pro';
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
  kudos: string;
}

function buildShareMessage(summary: SummaryDoc): string {
  const w = summary.week;
  return `🙌 This week FamilyLedger helped me stay connected — I played ${w.gamesPlayed} game${w.gamesPlayed === 1 ? '' : 's'} with ${w.coPlayers} family member${w.coPlayers === 1 ? '' : 's'}/friend${w.coPlayers === 1 ? '' : 's'}, tracked ${w.expensesTracked} expense${w.expensesTracked === 1 ? '' : 's'} across ${w.groupsEngaged} group${w.groupsEngaged === 1 ? '' : 's'}, and chatted with ${w.chatPeople} ${w.chatPeople === 1 ? 'person' : 'people'} — all in one app!\n\n✅ Split bills equally, by %, or exact amounts\n🔄 Never forget a recurring bill\n🎲 Play Ludo, Rummy, Chess & more together\n📊 Budgets, smart reminders & to-do/shopping lists\n\nTry it with your family 👇\n${SHARE_LANDING_URL}`;
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

function PeriodStats({ current, previous }: { current: SummaryBucket; previous: SummaryBucket }) {
  return (
    <div className="space-y-1.5">
      <StatRow icon="sports_esports" label={`Games played · with ${current.coPlayers} ${current.coPlayers === 1 ? 'person' : 'people'}`} current={current.gamesPlayed} previous={previous.gamesPlayed} />
      <StatRow icon="groups" label="Family groups engaged in" current={current.groupsEngaged} previous={previous.groupsEngaged} />
      <StatRow icon="receipt_long" label="Total expenses tracked" current={current.expensesTracked} previous={previous.expensesTracked} />
      <StatRow icon="edit_note" label="Expense lines you added" current={current.expenseLinesAdded} previous={previous.expenseLinesAdded} />
      <StatRow icon="chat" label="Groups/games you chatted in" current={current.chatGroups} previous={previous.chatGroups} />
      <StatRow icon="diversity_3" label="People you connected with via chat" current={current.chatPeople} previous={previous.chatPeople} />
    </div>
  );
}

// The actual "recap tile" that gets captured as an image for one-click sharing (see
// captureRecapImage below) — a compact, self-contained branded card with the real numbers baked
// directly into the pixels. This is what makes the shared image itself carry the personalized
// stats regardless of platform: WhatsApp/Facebook's own caption-text handling is unreliable (see
// the share handlers' comments), but an attached image always shows exactly what's rendered here.
const RecapTile = React.forwardRef<HTMLDivElement, { summary: SummaryDoc }>(({ summary }, ref) => {
  const w = summary.week;
  const tiles: Array<{ icon: string; value: number; label: string }> = [
    { icon: 'sports_esports', value: w.gamesPlayed, label: `Games played${w.coPlayers ? ` · with ${w.coPlayers}` : ''}` },
    { icon: 'groups', value: w.groupsEngaged, label: 'Groups engaged in' },
    { icon: 'receipt_long', value: w.expensesTracked, label: 'Expenses tracked' },
    { icon: 'diversity_3', value: w.chatPeople, label: 'People chatted with' },
  ];
  return (
    <div ref={ref} className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #003044, #0f4761)' }}>
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="w-9 h-9 rounded-xl bg-white/15 p-1.5" />
          <div>
            <p className="text-sm font-black text-white leading-none">FamilyLedger</p>
            <p className="text-[10px] text-white/70 uppercase tracking-wider font-bold mt-1">{summary.periodLabel}</p>
          </div>
        </div>
        <p className="text-sm font-bold text-white leading-snug">{summary.kudos}</p>
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="bg-white/10 rounded-xl p-2.5">
              <div className="flex items-center gap-1 text-white/70">
                <span className="material-symbols-outlined text-[13px]">{t.icon}</span>
              </div>
              <p className="text-xl font-black text-white leading-none mt-1">{t.value}</p>
              <p className="text-[9px] text-white/70 font-bold mt-0.5 leading-tight">{t.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
RecapTile.displayName = 'RecapTile';

export default function WeeklySummary() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const recapTileRef = React.useRef<HTMLDivElement>(null);

  const [summariesSnap, loading] = useCollection(
    user ? query(collection(db, 'userWeeklySummaries'), where('userId', '==', user.uid), orderBy('generatedAt', 'desc'), limit(20)) : null,
  );
  const summaries: SummaryDoc[] = React.useMemo(
    () => summariesSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as SummaryDoc)) || [],
    [summariesSnap],
  );
  const active = summaries.find((s) => s.id === selectedId) || summaries[0] || null;

  const close = () => navigate('/');

  // Renders the visible RecapTile (real stats baked into the pixels) to a PNG File — the one-click
  // "attach a screenshot of the tile" mechanism. Returns null on any failure (e.g. an ad-blocker or
  // unusual WebView blocking canvas export) so callers can fall back to a text-only share instead
  // of hard-failing the whole action.
  const captureRecapImage = async (): Promise<File | null> => {
    if (!recapTileRef.current) return null;
    try {
      const canvas = await html2canvas(recapTileRef.current, { backgroundColor: null, scale: 2, useCORS: true });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
      if (!blob) return null;
      return new File([blob], 'familyledger-weekly-recap.png', { type: 'image/png' });
    } catch (err) {
      console.error('Failed to capture recap tile image:', err);
      return null;
    }
  };

  // All three buttons below try the SAME best path first — hand the real recap-tile screenshot
  // (plus the full text) to the OS share sheet via the Web Share API, so whichever app the user
  // picks (WhatsApp — either a contact or Status, Facebook, Instagram, anything else registered as
  // a share target) receives the actual image with real numbers baked in, not just a generic
  // banner or bare link. They only diverge in their FALLBACK when file-sharing isn't supported on
  // the device/browser — that's a genuine platform capability gap, not something fixable client-side.
  const shareViaOsSheet = async (message: string): Promise<boolean> => {
    const nav = navigator as any;
    if (!nav.share) return false;
    const image = await captureRecapImage();
    if (image && nav.canShare?.({ files: [image] })) {
      try {
        await nav.share({ title: 'FamilyLedger', text: message, files: [image] });
        return true;
      } catch (err) {
        if ((err as any)?.name === 'AbortError') return true; // user cancelled — don't fall through to a second share path
        console.error('Image share failed, falling back:', err);
      }
    }
    return false;
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
                <RecapTile ref={recapTileRef} summary={active} />

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
