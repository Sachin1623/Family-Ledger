import { logGrowthEvent } from './growthEvents';

// Shared between Profile.tsx's "Spread the Word" card (which also tries an OS-share-sheet image
// attempt first, via its own shareViaOsSheetWithBanner — that part stays Profile-only, since it
// needs an off-screen <ShareBanner> mounted to capture) and SpreadWordPrompt.tsx's global popup
// (text-only, no banner capture, so it can mount cheaply at the app root on every screen).
// Pulling this out avoids a second hand-copy of the carefully-tuned message text and per-platform
// share URLs drifting out of sync between the two.
export function buildShareMessages() {
  const shareUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
  const webShareUrl = `${window.location.origin}/share`;
  // WhatsApp/native have no length limit and WhatsApp renders *bold*/dividers as real
  // formatting, so this "banner" version leans into that — a bold title line, a divider, and
  // one bold-label line per feature (Splitwise-style expense splitting, budgets that work even
  // without splitting, goals, chat/friends, and games as a closing bonus). Twitter/X gets a
  // separate, short version below — its 280-char compose box would just force a manual trim of
  // the long version anyway, and a mistimed trim can cut the link off entirely.
  const message = `*💰 FamilyLedger*\n_Split bills. Track budgets. Stay sane._\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nTired of chasing "who owes who"? I've been using this with my family and it's actually fixed it.\n\n✅ *Split expenses* — equally, by %, or exact amounts\n📊 *Real budgets* — set one per category (rent, food, bills...); splitting is optional, so it also works if you just want to track family spending\n🔄 *Recurring bills* — rent, wifi, subscriptions log themselves every month\n🎯 *Goals* — set savings targets, link real accounts, see when you'll hit them\n💬 *Group chat & friends* — no separate thread just for money talk\n🎮 *Bonus* — a few games built in too\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n👉 Try it — free on Android:\n${shareUrl}`;
  const shortMessage = `💰 Tired of chasing who-owes-who? FamilyLedger splits bills, tracks budgets & recurring expenses — free on Android. Give it a try 👇\n${shareUrl}`;
  return { shareUrl, webShareUrl, message, shortMessage };
}

export type ShareTarget = 'native' | 'whatsapp' | 'facebook' | 'twitter' | 'linkedin';

// Plain per-platform share (no image-banner attempt) — logs the growth event, then opens the
// platform's own share intent, falling back to clipboard copy when there's no share API at all.
export function shareAppPlain(target: ShareTarget, uid: string | undefined | null) {
  const { webShareUrl, message, shortMessage } = buildShareMessages();
  logGrowthEvent(`share_${target}`, uid);

  if (target === 'whatsapp') {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    return;
  }
  if (target === 'facebook') {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(webShareUrl)}`, '_blank');
    return;
  }
  if (target === 'twitter') {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shortMessage)}`, '_blank');
    return;
  }
  if (target === 'linkedin') {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(webShareUrl)}`, '_blank');
    return;
  }
  // "native" with no share API at all (very old browser) — copy to clipboard as a last resort.
  navigator.clipboard?.writeText(message).catch(() => {});
  alert('Share message copied! (Sharing is not supported on this device/browser.)');
}
