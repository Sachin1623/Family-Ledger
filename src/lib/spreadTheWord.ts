import { logGrowthEvent } from './growthEvents';
import { isIosApp } from './platform';

// Shared between Profile.tsx's "Spread the Word" card (which also tries an OS-share-sheet image
// attempt first, via its own shareViaOsSheetWithBanner — that part stays Profile-only, since it
// needs an off-screen <ShareBanner> mounted to capture) and SpreadWordPrompt.tsx's global popup
// (text-only, no banner capture, so it can mount cheaply at the app root on every screen).
// Pulling this out avoids a second hand-copy of the carefully-tuned message text and per-platform
// share URLs drifting out of sync between the two.
// The poster the person picked decides the wording: each theme has its own long message (WhatsApp /
// native — bold title, divider, one line per feature, matching that poster's tiles) and a short one
// for X. Facebook/LinkedIn can't carry caption text at all, so they only get the link.
export type SpreadTheme = 'all' | 'money' | 'health' | 'family' | 'games';

interface ThemeCopy {
  title: string;      // "💰 FamilyLedger"
  tagline: string;
  intro: string;
  features: string[]; // one "emoji *Bold* — detail" line each
  short: string;
}

const THEME_COPY: Record<SpreadTheme, ThemeCopy> = {
  all: {
    title: '✨ FamilyLedger',
    tagline: 'One app for the whole family.',
    intro: 'Money, health, chats and games — all in one place, and my family actually uses it.',
    features: [
      '💸 *Split bills* — equally, by %, or exact amounts',
      '📊 *Budgets & goals* — track spending, hit targets',
      '🩺 *Health records* — BP, sugar, medicines, vaccines',
      '⏰ *Smart reminders* — bills, doses and to-dos',
      '💬 *Group chat* — everyone on the same page',
      '🎮 *Family games* — Rummy, Ludo, Chess & more',
    ],
    short: '✨ One app for the whole family — split bills, track health, chat and play games together. Free on Android 👇',
  },
  money: {
    title: '💰 FamilyLedger',
    tagline: 'Split bills. Track budgets. Stay sane.',
    intro: `Tired of chasing "who owes who"? I've been using this with my family and it's actually fixed it.`,
    features: [
      '💸 *Split expenses* — equally, by %, or exact amounts',
      '📊 *Real budgets* — by category; splitting is optional, so it also works for just tracking family spending',
      '🔄 *Recurring bills* — rent, wifi, subscriptions log themselves every month',
      '🎯 *Savings goals* — link real accounts and see when you will hit them',
      '🤝 *Personal loans* — keep IOUs with a clear trail',
      '🔔 *Expense reminders* — never forget to log a spend',
    ],
    short: '💰 Tired of chasing who-owes-who? FamilyLedger splits bills, tracks budgets & recurring expenses — free on Android. Give it a try 👇',
  },
  health: {
    title: '🩺 FamilyLedger',
    tagline: "Your family's health, sorted.",
    intro: "Keeping track of the family's health used to be chaos. This made it simple — and everyone can see what they need to.",
    features: [
      '❤️ *BP & glucose* — log readings with colour-coded trends',
      '💊 *Medicine reminders* — alarm-style, never miss a dose',
      '💉 *Baby vaccinations* — schedule and due-date reminders',
      '👨‍👩‍👧 *Caregiver sharing* — let family keep an eye, safely',
      '📄 *Doctor-ready reports* — share clean PDF summaries',
    ],
    short: "🩺 Your family's health, sorted — BP & glucose logs, medicine reminders, baby vaccination schedules and caregiver sharing. Free on Android 👇",
  },
  family: {
    title: '🏠 FamilyLedger',
    tagline: 'Run the home together.',
    intro: 'One shared space for the whole household — less nagging, more getting things done.',
    features: [
      '💬 *Group chat* — no separate thread for money talk',
      '🛒 *Shopping lists* — shared, tick off as you go',
      '✅ *To-dos & habits* — plan, repeat and track together',
      '⏰ *Shared reminders* — everyone gets the nudge',
      '👥 *Family groups* — one ledger everyone can see',
      "📰 *Activity feed* — see what everyone's up to",
    ],
    short: '🏠 Run the home together — group chat, shared shopping lists, to-dos, reminders and a family ledger in one app. Free on Android 👇',
  },
  games: {
    title: '🎮 FamilyLedger',
    tagline: 'Game night, sorted.',
    intro: 'Classic games with the family, anywhere — and no real-money wagering.',
    features: [
      '🃏 *Rummy* — 13-card and 27-hand variants',
      '♠️ *Spade Pledge* — bid, play, outsmart the table',
      '🎴 *Sweep & Sequence* — team card-game classics',
      '🎲 *Ludo* — race your tokens home',
      '🏠 *Business* — buy, trade and bankrupt friends',
      '♟️ *Chess & Word games* — quick duels and word races',
    ],
    short: '🎮 Game night, sorted! Rummy, Spade Pledge, Ludo, Business, Chess & more with family — free on Android 👇',
  },
};

export function buildShareMessages(theme: SpreadTheme = 'money') {
  // iPhone app: no Google Play / Android wording or link (see isIosApp), the website link instead.
  const ios = isIosApp();
  const shareUrl = ios ? 'https://familyledger.thirteenapps.com' : 'https://play.google.com/store/apps/details?id=com.familyledger.app';
  const webShareUrl = `${window.location.origin}/share`;
  const c = THEME_COPY[theme] || THEME_COPY.money;
  const platformWording = (t: string) => (ios ? t.replace(/free on Android/gi, 'free to try') : t);
  // WhatsApp/native have no length limit and WhatsApp renders *bold*/dividers as real formatting, so
  // the long version leans into that. Twitter/X gets the short one — its 280-char compose box would
  // just force a manual trim of the long version, and a mistimed trim can cut the link off entirely.
  const divider = '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬';
  const message = platformWording(`*${c.title}*\n_${c.tagline}_\n${divider}\n\n${c.intro}\n\n${c.features.join('\n')}\n\n${divider}\n👉 Try it — free on Android:\n${shareUrl}`);
  const shortMessage = platformWording(`${c.short}\n${shareUrl}`);
  return { shareUrl, webShareUrl, message, shortMessage };
}

export type ShareTarget = 'native' | 'whatsapp' | 'facebook' | 'instagram' | 'twitter' | 'linkedin';

// Plain per-platform share (no image-banner attempt) — logs the growth event, then opens the
// platform's own share intent, falling back to clipboard copy when there's no share API at all.
export function shareAppPlain(target: ShareTarget, uid: string | undefined | null, theme: SpreadTheme = 'money') {
  const { webShareUrl, message, shortMessage } = buildShareMessages(theme);
  logGrowthEvent(`share_${target}`, uid);

  if (target === 'whatsapp') {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    return;
  }
  if (target === 'facebook') {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(webShareUrl)}`, '_blank');
    return;
  }
  if (target === 'instagram') {
    // Instagram has no web share link at all — copy the text so it can be pasted into a post.
    navigator.clipboard?.writeText(message).catch(() => {});
    alert('Caption copied! Open Instagram and paste it into your post.');
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
