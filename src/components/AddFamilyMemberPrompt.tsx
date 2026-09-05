import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { buildGroupInviteWhatsAppUrl } from '../lib/inviteApi';

// Three moments this shows: right after ANY group is created (every one, not just the user's
// first — per explicit request, since every group needs its own people invited into it), right
// after the user logs their first-ever expense (one-shot, gated by a real user-doc flag so it
// can't re-fire on a fresh install/reinstall — see markInvitePromptSeen below), and the
// every-10-days "still solo?" nudge for a group that's picked up no one after the first two (see
// server.ts's /api/cron/send-daily-reminders invite-family check). The WhatsApp link itself
// reuses the SAME /join/{groupId} mechanism ManageGroup.tsx's own invite tab already uses — this
// doesn't invent a second invite system, just surfaces the existing one at these three moments
// with a single tap instead of requiring the user to find their way to Manage Group > Invite
// first. 'group_created' and 'recurring_reminder' both fire every time their own trigger condition
// is met again (a new group; the server's 10-day+still-solo gate) — only 'first_expense' has a
// permanent "don't show again" flag, since by definition it can only ever be true once.
export type AddFamilyMemberTrigger = 'group_created' | 'first_expense' | 'recurring_reminder';

const COPY: Record<AddFamilyMemberTrigger, { emoji: string; title: string; body: string }> = {
  group_created: {
    emoji: '👨‍👩‍👧‍👦',
    title: 'Invite your group',
    body: "You've created the group — invite the people you'll actually be splitting expenses with, so it starts filling in for everyone right away.",
  },
  first_expense: {
    emoji: '🎉',
    title: 'Nice, first expense logged!',
    body: "Splitting only works once your family's actually in the group — send them a quick invite and future expenses split automatically.",
  },
  recurring_reminder: {
    emoji: '💌',
    title: "Still flying solo?",
    body: "Your group's still just you — invite your family or friends whenever you're ready, so splitting actually works both ways.",
  },
};

// Persisted so the ONE genuinely one-shot prompt (first_expense) can never re-fire, across
// devices/reinstalls — a plain localStorage flag would reset on a new device and defeat the
// point. 'group_created'/'recurring_reminder' have no entry here on purpose (see the type's own
// doc comment above) — both are meant to fire again on their own trigger condition.
const FIELD_BY_TRIGGER: Partial<Record<AddFamilyMemberTrigger, string>> = {
  first_expense: 'hasSeenFirstExpenseInvitePrompt',
};

export async function markInvitePromptSeen(uid: string, trigger: AddFamilyMemberTrigger) {
  const field = FIELD_BY_TRIGGER[trigger];
  if (!field) return; // 'recurring_reminder' — nothing to persist, see its doc comment above
  await updateDoc(doc(db, 'users', uid), { [field]: true }).catch((err) =>
    console.error(`Failed to mark ${trigger} invite prompt seen:`, err),
  );
}

export default function AddFamilyMemberPrompt({
  trigger,
  groupId,
  groupName,
  onDismiss,
}: {
  trigger: AddFamilyMemberTrigger;
  groupId: string;
  groupName?: string;
  onDismiss: () => void;
}) {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const copy = COPY[trigger];

  const close = () => {
    if (user) markInvitePromptSeen(user.uid, trigger);
    onDismiss();
  };

  const handleInvite = () => {
    setSending(true);
    window.open(buildGroupInviteWhatsAppUrl(groupId, groupName), '_blank');
    // No way to detect whether the user actually completed the WhatsApp share from here (same
    // platform limitation as every other wa.me-based invite in this app) — closing right away
    // assumes they will, matching how ManageGroup's own WhatsApp invite button behaves.
    close();
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl space-y-5"
        >
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-3xl">
            {copy.emoji}
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-xl font-bold text-primary">{copy.title}</h3>
            <p className="text-sm text-text-secondary leading-relaxed">{copy.body}</p>
          </div>
          <button
            type="button"
            onClick={handleInvite}
            disabled={sending}
            className="w-full py-3.5 bg-[#25D366] text-white font-bold rounded-2xl flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>call</span>
            Invite via WhatsApp
          </button>
          <button type="button" onClick={close} className="w-full text-center text-xs font-bold text-text-muted hover:text-primary">
            Maybe later
          </button>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
