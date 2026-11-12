import React from 'react';
import { motion } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { inviteJoinLink } from '../lib/referral';
import { logGrowthEvent } from '../lib/growthEvents';

// Shown right after an expense is saved that includes someone with only a name in the group (no account yet). That is the moment an
// invite makes sense to the sender: "Ravi has a share of this, send him the link." One tap opens WhatsApp with the message ready,
// carrying the tagged join link so a registration from it is counted and the sender is thanked.
export interface SplitNudge { groupId: string; groupName?: string; names: string[]; description: string; shareText: string }

const COOLDOWN_MS = 3 * 86_400_000;
const cooldownKey = (groupId: string, name: string) => `fl_split_nudge_${groupId}_${name.toLowerCase()}`;

export function nudgeIsDue(groupId: string, name: string): boolean {
  try {
    const at = Number(localStorage.getItem(cooldownKey(groupId, name)) || 0);
    return !at || Date.now() - at > COOLDOWN_MS;
  } catch { return true; }
}

function markNudged(n: SplitNudge) {
  try { n.names.forEach((name) => localStorage.setItem(cooldownKey(n.groupId, name), String(Date.now()))); } catch { /* the nudge may show again sooner */ }
}

export default function InviteSplitNudge({ nudge, onDismiss }: { nudge: SplitNudge; onDismiss: () => void }) {
  const { user } = useAuth();
  const who = nudge.names.length === 1 ? nudge.names[0] : `${nudge.names.slice(0, -1).join(', ')} and ${nudge.names[nudge.names.length - 1]}`;

  const close = () => { markNudged(nudge); onDismiss(); };

  const sendWhatsApp = () => {
    const link = inviteJoinLink(nudge.groupId, user?.uid, 'wa');
    const text = `Hi! I added "${nudge.description}" on FamilyLedger${nudge.shareText ? ` (${nudge.shareText})` : ''}. Join the group to see it and settle up: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    logGrowthEvent('invite_whatsapp', user?.uid);
    close();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={close} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl space-y-5">
        <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-3xl">💬</div>
        <div className="text-center space-y-2">
          <h3 className="text-xl font-bold text-primary">Tell {who} about it?</h3>
          <p className="text-sm text-text-secondary leading-relaxed">
            {who} {nudge.names.length === 1 ? "isn't" : "aren't"} on FamilyLedger yet. Send the link and they can see this expense and settle up in the app.
          </p>
        </div>
        <button type="button" onClick={sendWhatsApp} className="w-full py-3.5 bg-[#25D366] text-white font-bold rounded-2xl flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm">
          <span className="material-symbols-outlined text-[20px]">send</span>
          Send on WhatsApp
        </button>
        <button type="button" onClick={close} className="w-full text-center text-xs font-bold text-text-muted hover:text-primary">Maybe later</button>
      </motion.div>
    </div>
  );
}
