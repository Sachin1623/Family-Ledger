import React from 'react';
import { useNavigate, Link } from 'react-router-dom';

export default function PrivacyPolicy() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-6 space-y-8 max-w-3xl mx-auto w-full pb-20 prose prose-slate">
        <header className="space-y-4 pt-4">
          <h1 className="text-3xl font-black tracking-tight text-primary">Privacy Policy</h1>
          <p className="text-sm text-text-muted italic">Last Updated: September 3, 2026</p>
          <p>
            FamilyLedger ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our mobile application and services.
          </p>
          <p className="not-prose">
            <Link to="/data-usage" className="inline-flex items-center gap-1 text-sm font-bold text-primary bg-primary/5 px-4 py-2 rounded-xl hover:bg-primary/10">
              <span className="material-symbols-outlined text-[18px]">query_stats</span>
              See a plain-language, feature-by-feature breakdown of what data we collect
            </Link>
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">1. Information We Collect</h2>
          <div className="space-y-2">
            <h3 className="font-semibold text-primary">A. Personal Information</h3>
            <p>
              When you register for an account, we may collect your name, email address, and profile picture. This information is used to identify you within the app and to communicate with you about your account. If you sign up with email and password, we verify your email address using a one-time code before your account is fully activated.
            </p>
            <h3 className="font-semibold text-primary">B. Financial and Group Data</h3>
            <p>
              We collect information you enter into the app, such as group names, expense amounts, income entries, budgets, descriptions, categories, and dates. This data is shared with the members of the groups you participate in.
            </p>
            <h3 className="font-semibold text-primary">C. Personal Loans Data</h3>
            <p>
              If you use the Personal Loans feature to track money given to or taken from another person, we store the amounts, dates, descriptions, and repayment history you enter. If you link the record to another FamilyLedger user, that person can see the shared loan history and balance. Reminders and messages you choose to send about a loan (for example, via WhatsApp) are composed on your device and sent through your own messaging apps — we do not read or store the content of those external messages.
            </p>
            <h3 className="font-semibold text-primary">D. Shopkeeper Mode Data</h3>
            <p>
              If your account is approved for Shopkeeper mode, we store the business, customer, and sales information you and your staff enter — such as customer names and contact details, sale items, prices, cost, and credit ("udhaar") balances. This data is shared with the shop's owner and any staff added to that shop. Promotional messages you send to customers are delivered through your own email or WhatsApp, at your direction.
            </p>
            <h3 className="font-semibold text-primary">E. App Lock (Biometric / PIN)</h3>
            <p>
              If you enable App Lock, your chosen method (fingerprint or a 4-digit PIN) is stored only on your device. Biometric authentication is handled entirely by your device's operating system — we never receive, transmit, or store your fingerprint or any other biometric data. If you choose a PIN, only a one-way cryptographic hash of it is stored locally on your device; we never see or store the PIN itself, and it does not sync across devices.
            </p>
            <h3 className="font-semibold text-primary">F. Usage Data</h3>
            <p>
              We may collect information about how you interact with our app, including activity logs, to improve our service and provide features like the Activity Feed.
            </p>
            <h3 className="font-semibold text-primary">F.1 Analytics</h3>
            <p>
              We use Google Analytics (Firebase Analytics) to understand how the app is used and to find and fix problems — things like which screens are opened and how often, not the content of your expenses or messages. This only runs if you've opted in via the consent prompt shown the first time you use the app; declining it doesn't limit any feature. You can find your current choice, and change it, from Settings.
            </p>
            <h3 className="font-semibold text-primary">G. Games Data</h3>
            <p>
              If you play a multiplayer game (Ludo, 27-Hand Rummy, Business, Sweep, or Sudoku), we store the live game state needed to run it — token positions, dice rolls, scores, property ownership, deal progress, and your win/loss record — which is visible to the other players in that specific game. For card games with hidden information (27-Hand Rummy, Sweep), your card hand is stored so the game can be dealt and played correctly, but it is never readable by other players — only cards you actually play or that are otherwise revealed by the rules become visible to them. Quick-reaction emoji are shown briefly to other players in the game and are not kept as a permanent history.
            </p>
            <h3 className="font-semibold text-primary">H. Game &amp; Group Chat</h3>
            <p>
              Messages you send in a game's chat or a group's discussion thread are stored and shown to the other players in that game or members of that group. If you report a message as abusive, we store the message text, who sent it, and who reported it, so our team can review it. If you block or mute another player, that preference is private to your account — it is never shared with, or shown to, the person you blocked or muted.
            </p>
            <h3 className="font-semibold text-primary">I. Gamification, Points &amp; Public Profile Data</h3>
            <p>
              We track experience points (XP), a level, spendable coins, streaks, and badges earned from your activity in the app — such as logging expenses, completing to-dos and habits, setting budgets, and playing games. Your level, XP, streaks, and badges are shown on a public profile page that any other signed-in FamilyLedger user can view; your coin balance and the detailed log of exactly what earned you points are never shown on that public profile. Friends and members of your groups can additionally see your coin balance on friends- and group-scoped leaderboards, which compare your progress only against people you already share expenses or games with — we do not publish a global ranking of every FamilyLedger user.
            </p>
            <p>
              You control exactly what appears on your own public profile from Profile → Public Profile: level/XP, streaks, and badges are shown by default (matching how this page has always worked); per-game win/loss stats, your rank among your own friends, your active habits and their streaks, and your birthday (month and day only — we never show the year) are off by default and only appear if you turn them on yourself.
            </p>
            <h3 className="font-semibold text-primary">J. Goals &amp; Savings Data</h3>
            <p>
              If you use the Goals feature, we store the target amount, current progress, target date, and notes you enter for each savings goal, along with the running history of contributions ("ledger") behind it. These amounts are encrypted before being stored (see Section 3). A goal stays private to you unless you explicitly turn on sharing for it — you can share an individual goal with a specific group and/or specific friends, in which case those people can see its name, progress, and target, and can add manual contributions ("boosts") to it; they can never see or touch the linked accounts funding it.
            </p>
            <h3 className="font-semibold text-primary">K. Financial Accounts Data</h3>
            <p>
              If you use the Accounts feature to track a real bank, investment, or broker account's balance, we store the balance, account type, account number (if you choose to add one), nominee name(s) and their allocation percentage, interest rate and compounding schedule, and any recurring contribution ("SIP") amount/schedule you set up. Balances and account numbers are encrypted before being stored (see Section 3). Financial Accounts are strictly personal — unlike Goals, an account and everything in it (including its balance, account number, and nominees) is never shared with anyone else through the app, including your own groups or friends; only you, signed in as yourself, can see it. The one exception is if you use the "Share Account Details" action yourself — that composes a summary (which fields it includes is your choice, shown to you before sending) and hands it to your device's own share sheet or clipboard, the same way a Personal Loans reminder is sent (see Section 1.C); we do not see or store where you send it.
            </p>
            <h3 className="font-semibold text-primary">L. Health Tracking Data</h3>
            <p>
              If you use Blood Pressure, Glucose, or Medicine tracking, we store the readings, dose logs, and (for medicines) the illness/incident grouping and schedule you enter. This data stays private to you by default. You can choose to share it with a specific group and/or specific friends (visible to them the same way a shared goal is), and/or grant a delegate (e.g. a family caregiver) permission to log entries on your behalf — a delegate you've added can add and view entries for you, exactly as if they were you, until you remove that permission.
            </p>
            <h3 className="font-semibold text-primary">M. Shared Reminders Data</h3>
            <p>
              If you create a Shared Reminder, we store its text, schedule, and (if you enable it) who has acknowledged or completed it. A reminder is visible to whichever group and/or specific friends you choose to share it with when you create it.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">2. How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>To provide and maintain our service</li>
            <li>To manage your account and group memberships</li>
            <li>To facilitate expense sharing, income tracking, budgets, and ledger balance calculations</li>
            <li>To operate the Personal Loans and Shopkeeper mode features you choose to use</li>
            <li>To notify you about changes to our service, group activities, loan reminders, or account-wide announcements from our team</li>
            <li>To provide customer support</li>
            <li>To detect, prevent, and address technical issues</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">3. Data Storage and Sync</h2>
          <p>
            FamilyLedger uses industry-standard cloud services (Firebase) to store and synchronize your data in real-time across your devices and with group, loan, or shop members as applicable. Your data is stored securely and access is restricted according to our security rules. App Lock settings are the one exception — they are stored only on your local device, never in the cloud.
          </p>
          <p>
            Goal amounts and Financial Account balances/account numbers (Sections 1.J–K) get an extra layer on top of that: they're individually encrypted before being written to our database, using a key scoped to that specific goal or account. Even someone with direct database access sees only unreadable ciphertext, not the real number — only you, authenticated as yourself (or someone you've explicitly shared that specific goal with, for that goal only), can ever have it decrypted.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">4. Data Sharing and Disclosure</h2>
          <p>
            We do not sell your personal data. Your information is only shared:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>With other members of groups you have joined</li>
            <li>With the other players currently in a game you're playing, or the group whose chat you're posting in</li>
            <li>With the other party to a Personal Loans record you have linked to their account</li>
            <li>With the owner and staff of a shop you belong to, if you use Shopkeeper mode</li>
            <li>With any other signed-in FamilyLedger user who views your public profile — your level, XP, streaks, and badges only, never your coin balance or points activity log</li>
            <li>With your friends and members of your groups, on leaderboards that additionally show your coin balance</li>
            <li>With a group and/or specific friends you choose to share a savings goal, health reading, or reminder with — off by default, only shared if you explicitly turn sharing on for that item</li>
            <li>With a delegate/caregiver you've granted permission to log health data on your behalf, and vice versa if someone has granted that permission to you</li>
            <li>With our team, if you or someone else reports a chat message for review</li>
            <li>With service providers who assist us in operating the app</li>
            <li>If required by law or to protect our rights</li>
          </ul>
          <p>
            Financial Accounts (Section 1.K) are the one exception to all of the above — an account's balance, account number, and nominees are never shared with anyone through the app, including your own groups or friends, unless you yourself use its "Share Account Details" action to hand a summary to your device's own share sheet or clipboard.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">5. Your Data Rights</h2>
          <p>
            You have the right to access, update, or delete your personal information directly within the app. If you wish to delete your entire account and all associated data, you may do so in the settings or by contacting us.
          </p>
          <p>
            You can download a copy of your personal data at any time from Profile → Download My Data, in a portable (JSON) format — no need to contact us first.
          </p>
          <p>
            If you are located in the European Economic Area, the United Kingdom, or another jurisdiction with similar data protection laws, you additionally have the right to: request that we restrict how we process your data; object to certain processing; and withdraw consent at any time for anything we process on the basis of consent (such as the analytics described in Section 1.F.1), without affecting the lawfulness of processing carried out before that withdrawal — you can change your analytics choice at any time from Profile → Privacy. To exercise any of these rights beyond what's available directly in the app, contact us at the email in Section 11. You also have the right to lodge a complaint with your local data protection supervisory authority at any time.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">6. Legal Basis for Processing (EEA/UK Users)</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Performance of a contract:</strong> account data, financial/group data, and the other features described in Section 1 are processed because they're necessary to actually provide the app to you — without them, the core service (tracking and splitting shared expenses) can't function.</li>
            <li><strong>Consent:</strong> analytics (Section 3) only run if you've actively opted in via the in-app consent prompt; you can decline it or change your mind at any time, and the app works identically either way.</li>
            <li><strong>Legitimate interests:</strong> security, fraud/abuse prevention, and diagnosing technical problems, balanced against your right to privacy.</li>
            <li><strong>Legal obligation:</strong> where we're required to disclose information by law (see Section 4).</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">7. Data Retention</h2>
          <p>
            We keep your data for as long as your account is active, since group/loan/game history stays meaningful to the other members you share it with for as long as you're all using the app. When you delete your account (see our <Link to="/delete-account" className="text-primary font-bold underline">Data Deletion</Link> page for the full details), your personal identifiers are removed; data you shared with others (like a split expense) may be retained in an anonymized form so their own balances stay accurate. Backups are retained for up to 30 days after deletion before being fully purged.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">8. International Data Transfers</h2>
          <p>
            We use Google Firebase/Google Cloud to store and process data, which may transfer or store information outside your own country, including in the United States. Where this involves a transfer out of the EEA, UK, or Switzerland, it's covered by Google Cloud's own data processing terms, which incorporate the EU Standard Contractual Clauses and equivalent safeguards for exactly this purpose.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">9. Security</h2>
          <p>
            The security of your data is important to us, but remember that no method of transmission over the Internet or method of electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your personal information, we cannot guarantee its absolute security.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">10. Children's Privacy</h2>
          <p>
            Our service is not directed at children and is not intended for use by anyone under 16. We do not knowingly collect personal information from anyone under 16 — if you believe a child has provided us with personal information, please contact us and we'll delete it. (Some countries set this age lower, down to 13; where that applies to you, that lower age governs instead.)
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">11. Contact Us</h2>
          <p>
            If you have any questions about this Privacy Policy, or want to exercise any of the rights described above, please contact us at:
          </p>
          <p className="font-bold text-primary">system@thirteenapps.com</p>
        </section>
      </main>
    </div>
  );
}
