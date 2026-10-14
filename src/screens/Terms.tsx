import React from 'react';
import { useNavigate, Link } from 'react-router-dom';

export default function Terms() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen bg-surface font-sans">
      <main className="flex-1 p-6 space-y-8 max-w-3xl mx-auto w-full pb-20 prose prose-slate">
        <header className="space-y-4 pt-4">
          <h1 className="text-3xl font-black tracking-tight text-primary">Terms of Service</h1>
          <p className="text-sm text-text-muted italic">Last Updated: October 14, 2026</p>
          <p>
            Welcome to FamilyLedger. By using our application, you agree to these terms. Please read them carefully.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">1. Acceptable Use</h2>
          <p>
            You agree to use FamilyLedger only for lawful purposes and in a way that does not infringe the rights of, restrict or inhibit anyone else's use and enjoyment of the service. Prohibited behavior includes harassing or causing distress or inconvenience to any person, or posting abusive, threatening, or otherwise objectionable content in any chat. Where in-app chat is available (such as during a multiplayer game), you can report an abusive message for our review and block that sender so you no longer see their messages. We may remove content and suspend or terminate accounts that violate this policy — see Section 9 (Termination).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">2. User Accounts</h2>
          <p>
            To use certain features of the app, you must register for an account using a Google account, Sign in with Apple, or an email address and password. Email and password accounts must be verified with a one-time code before use. You are responsible for maintaining the confidentiality of your account information and for all activities that occur under your account. You may delete your account at any time from within the app — see our <Link to="/delete-account" className="text-primary font-bold underline">Data Deletion</Link> page for details.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">3. Shared Content</h2>
          <p>
            FamilyLedger allows you to create groups and share expense, income, and budget data with other users. You retain ownership of the data you enter, but by sharing it within a group, you grant other members of that group the right to view and interact with that data as intended by the app's features.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">4. Personal Loans</h2>
          <p>
            The Personal Loans feature is an informal record-keeping tool for tracking money given to or taken from friends and family. It is not a legal debt instrument, does not constitute a contract between FamilyLedger and any party, and we do not mediate, guarantee, or enforce repayment of any amount recorded. Disputes about the accuracy or repayment of a loan are solely between the parties involved. Any WhatsApp or other messages you send about a loan are sent through your own device and accounts, at your sole direction.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">5. Shopkeeper Mode</h2>
          <p>
            Shopkeeper mode is an optional business record-keeping tool, granted after admin review, that lets you track customers, sales, and credit ("udhaar") balances, and add staff to your shop. You are solely responsible for the accuracy of your business records and for complying with any tax, invoicing, or other legal obligations that apply to your business — FamilyLedger does not provide accounting, tax, or legal advice, and Shopkeeper mode is not a substitute for compliant bookkeeping software where required by law. Promotional emails and WhatsApp messages sent to your customers are sent using your own account credentials or device, at your direction, and you are responsible for complying with applicable messaging and marketing laws.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">6. App Lock</h2>
          <p>
            App Lock (fingerprint or PIN) is an optional, device-local convenience feature to help prevent casual access to the app on a shared or unlocked device. It is not a substitute for securing your device or account, and FamilyLedger cannot recover a forgotten PIN or restore access if your device's biometric hardware becomes unavailable — you may need to reinstall or reset the app on that device.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">7. Announcements</h2>
          <p>
            We may from time to time send in-app broadcast messages to communicate important updates, changes, or announcements to some or all users. These are informational and separate from any group, loan, or shop notifications generated by your own activity.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">8. Games, Points &amp; Leaderboards</h2>
          <p>
            The games in FamilyLedger are for entertainment among friends and family. They are not gambling: you never stake or win real money, and nothing in the app can be bought or won for cash. Points, XP, coins, badges, levels and rankings are virtual, have no monetary value, cannot be exchanged or transferred, and may be adjusted, reset or removed by us (for example to fix a bug or an unfair result). You agree to play fairly: no cheating, exploiting bugs, using automation or scripts, or using several accounts to inflate scores or rankings. Some leaderboards show your display name, picture and scores to other users, and we may send you notifications about changes in your ranking — you can turn notifications off at any time.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">9. Chat and Voice Chat</h2>
          <p>
            You are responsible for what you say in text or voice chat. Do not record, copy or share other people's voice or messages without their consent, and do not use chat for harassment, hate, threats, spam or anything unlawful. We may remove content, limit chat features, or suspend accounts that break these rules, including after another user reports a message.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">10. Receipt Sharing</h2>
          <p>
            You can share a payment receipt to FamilyLedger to pre-fill an expense. This is a convenience: the amount, payee, date and other details are read automatically and <strong>may be wrong or incomplete</strong>. You must check every detail before saving, and you remain responsible for the entries you save. Use it only for payments you actually made and receipts you have not altered. FamilyLedger is not affiliated with, endorsed by, or connected to PhonePe, Google Pay, Paytm, any bank, or any payment provider — those names and logos belong to their owners. We do not access your payment accounts or those apps' data; we only read the receipt you choose to share.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">11. Sharing Outside the App</h2>
          <p>
            You can share pictures such as game wins, posters and summaries to other apps. These are created on your device and may include your display name and statistics. What you post, and where, is your own choice and responsibility, and the other app's terms apply once you share.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">12. Limitation of Liability</h2>
          <p>
            FamilyLedger is provided "as is" without any warranties of any kind. We do not guarantee that the app will always be safe, secure, or error-free, or that it will function without disruptions, delays, or imperfections.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">13. Termination</h2>
          <p>
            We reserve the right to terminate or suspend your account and access to the service at our sole discretion, without notice, for conduct that we believe violates these Terms or is harmful to other users of the service, us, or third parties, or for any other reason.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-primary">14. Changes to Terms</h2>
          <p>
            We may modify these terms at any time. If we make changes, we will notify you by revising the date at the top of this policy. Your continued use of the service after such changes indicates your acceptance of the new Terms.
          </p>
        </section>

        <section className="space-y-3 pt-8 border-t border-border-subtle">
          <h2 className="text-lg font-bold text-primary">Contact Information</h2>
          <p>If you have any questions about these Terms, please contact us at:</p>
          <p className="font-bold text-primary">system@thirteenapps.com</p>
        </section>
      </main>
    </div>
  );
}
