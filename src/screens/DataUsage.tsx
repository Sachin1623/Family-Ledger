import React from 'react';
import { Link } from 'react-router-dom';

interface DataRow {
  data: string;
  why: string;
  sharedWith: string;
}

interface DataCategory {
  icon: string;
  title: string;
  rows: DataRow[];
}

const CATEGORIES: DataCategory[] = [
  {
    icon: 'person',
    title: 'Account',
    rows: [
      {
        data: 'Name, email address, profile picture',
        why: 'Identify you in the app and let others recognize you in shared groups/games',
        sharedWith: 'Members of your groups, other players in your games',
      },
    ],
  },
  {
    icon: 'groups',
    title: 'Groups & Expenses',
    rows: [
      {
        data: 'Group names, expense/income entries, amounts, categories, dates, budgets',
        why: 'Track and split shared costs, show spending analysis',
        sharedWith: 'Members of that specific group',
      },
      {
        data: 'Group chat messages',
        why: 'Let group members discuss expenses and coordinate',
        sharedWith: 'Members of that specific group',
      },
    ],
  },
  {
    icon: 'handshake',
    title: 'Personal Loans',
    rows: [
      {
        data: 'Amounts, dates, descriptions, repayment history you enter',
        why: 'Keep a running record of money given to or taken from someone',
        sharedWith: 'Only the other party, and only if you link the record to their account',
      },
    ],
  },
  {
    icon: 'storefront',
    title: 'Shopkeeper Mode',
    rows: [
      {
        data: 'Customer names/contacts, sale items, prices, cost, credit ("udhaar") balances',
        why: 'Run a lightweight point-of-sale and customer ledger',
        sharedWith: "The shop's owner and staff",
      },
    ],
  },
  {
    icon: 'stadium',
    title: 'Games (Ludo, Rummy, Business, Sweep, Sudoku)',
    rows: [
      {
        data: 'Board/turn state — token positions, dice rolls, scores, property ownership, deal progress',
        why: 'Run the live multiplayer game and keep everyone\'s screen in sync',
        sharedWith: 'Other players currently in that specific game',
      },
      {
        data: 'Card hands (27-Hand Rummy, Sweep)',
        why: 'Deal and play the game correctly',
        sharedWith: 'Nobody — not even other players in the same game can read your hand; only revealed cards (played/on the table) are ever shared',
      },
      {
        data: 'Win/loss record, head-to-head stats',
        why: 'Power the Ranks/leaderboard screens',
        sharedWith: 'Other players you\'ve played against, when they view head-to-head stats',
      },
      {
        data: 'Quick-reaction emoji (👍❤️😂 etc.)',
        why: 'Show a brief animated reaction to other players',
        sharedWith: 'Other players currently in that game — not stored as a permanent log, only the most recent one is kept and it\'s overwritten by the next',
      },
      {
        data: 'Game chat messages',
        why: 'Let players in a game talk to each other',
        sharedWith: 'Other players currently in that specific game',
      },
    ],
  },
  {
    icon: 'military_tech',
    title: 'Gamification (Points, Levels & Badges)',
    rows: [
      {
        data: 'XP, level, streaks, and badges earned from app activity',
        why: 'Track your progress and power the My Progress screen and public profile',
        sharedWith: 'Any signed-in FamilyLedger user who views your public profile page',
      },
      {
        data: 'Coins (a separate spendable in-app balance)',
        why: 'A reward currency, kept separate from XP, for future cosmetic features',
        sharedWith: 'Only your friends and members of your groups, on leaderboards — never shown on your public profile',
      },
      {
        data: 'Points activity log (what earned you XP/coins and when)',
        why: 'Let you review your own recent activity in My Progress',
        sharedWith: 'Nobody — private to your account',
      },
    ],
  },
  {
    icon: 'shield',
    title: 'Chat Moderation (game & group chat)',
    rows: [
      {
        data: 'Reported messages — the message text, who sent it, who reported it',
        why: 'Let our team review reports of abusive messages and take action',
        sharedWith: 'Only FamilyLedger admins',
      },
      {
        data: 'Your block/mute list',
        why: 'Hide messages from people you\'ve chosen to block or mute',
        sharedWith: 'Nobody — this is private to your account, and the person you blocked/muted is never notified',
      },
    ],
  },
  {
    icon: 'fingerprint',
    title: 'App Lock',
    rows: [
      {
        data: 'Fingerprint / PIN',
        why: 'Let you lock the app locally',
        sharedWith:
          'Nobody — biometrics never leave your device (handled by your OS); a PIN is stored as a one-way hash on-device only, never synced or sent to us',
      },
    ],
  },
  {
    icon: 'notifications',
    title: 'Notifications',
    rows: [
      {
        data: 'Push notification token, notification preferences',
        why: 'Deliver alerts you\'ve opted into (group activity, reminders, turn notifications, announcements)',
        sharedWith: 'Nobody — used only by our servers to deliver your notifications',
      },
    ],
  },
  {
    icon: 'query_stats',
    title: 'Usage & Diagnostics',
    rows: [
      {
        data: 'Activity logs, app version, rough usage patterns',
        why: 'Improve the app, power the Activity Feed, detect and fix bugs',
        sharedWith: 'Nobody outside FamilyLedger',
      },
    ],
  },
];

export default function DataUsage() {
  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-6 space-y-8 max-w-3xl mx-auto w-full pb-20">
        <header className="space-y-3 pt-4">
          <h1 className="text-3xl font-black tracking-tight text-primary">What Data We Collect &amp; How It's Used</h1>
          <p className="text-sm text-text-muted">
            A plain-language breakdown of every kind of data FamilyLedger collects, why, and who can see it —
            feature by feature. For the full legal terms, see our{' '}
            <Link to="/privacy" className="text-primary font-bold underline">Privacy Policy</Link>.
          </p>
        </header>

        <section className="space-y-4">
          {CATEGORIES.map((cat) => (
            <div key={cat.title} className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 p-4 border-b border-border-subtle bg-primary/5">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[20px]">{cat.icon}</span>
                </div>
                <h2 className="font-bold text-primary">{cat.title}</h2>
              </div>
              <div className="divide-y divide-border-subtle">
                {cat.rows.map((row, i) => (
                  <div key={i} className="p-4 space-y-2">
                    <p className="text-sm font-bold text-on-surface">{row.data}</p>
                    <div className="grid sm:grid-cols-2 gap-2 text-xs text-text-muted">
                      <p><span className="font-bold text-primary/80">Why: </span>{row.why}</p>
                      <p><span className="font-bold text-primary/80">Shared with: </span>{row.sharedWith}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="bg-primary/5 p-6 rounded-2xl border border-primary/10 space-y-2 text-center">
          <p className="text-sm text-primary/80">
            We never sell your personal data. Questions? Reach us at{' '}
          </p>
          <p className="font-bold text-primary">system@thirteenapps.com</p>
        </section>
      </main>
    </div>
  );
}
