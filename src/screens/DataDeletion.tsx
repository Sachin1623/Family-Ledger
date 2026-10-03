import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function DataDeletion() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen bg-surface font-sans">
      <main className="flex-1 p-6 space-y-8 max-w-3xl mx-auto w-full pb-20 prose prose-slate">
        <header className="space-y-4 pt-4">
          <h1 className="text-3xl font-black tracking-tight text-primary">Data Deletion</h1>
          <p className="text-text-secondary">
            At FamilyLedger, we respect your privacy and provide a straightforward way to delete your account and all associated data.
          </p>
        </header>

        <section className="space-y-4 bg-white p-6 rounded-2xl border border-border-subtle shadow-sm">
          <h3 className="text-xl font-bold text-primary">How to Request Account Deletion</h3>
          <p className="text-text-secondary">
            Log in to the app, go to your <strong>Profile</strong>, and select <strong>Delete Account</strong> at the bottom of the page. You'll be offered two ways to delete it — or you can email <strong>system@thirteenapps.com</strong> with the subject "Data Deletion Request" from the address on your account, and we'll process a permanent deletion for you.
          </p>

          <div className="space-y-6 mt-4">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-bold">1</div>
              <div>
                <p className="font-bold text-primary">Pause for 30 days (recommended)</p>
                <p className="text-sm text-text-secondary">Your account is signed out everywhere and hidden right away. If you log back in with the same details within 30 days, you get everything back exactly as it was. If you take no action for 30 days, it's then permanently deleted automatically. You can also choose to finish the deletion early at any point during those 30 days, from the same in-app prompt.</p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-bold">2</div>
              <div>
                <p className="font-bold text-primary">Delete everything now</p>
                <p className="text-sm text-text-secondary">Immediate and permanent, no 30-day window. Your data is erased on our next cleanup pass (typically within a day).</p>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xl font-bold text-primary">What data will be deleted?</h3>
          <p className="text-text-secondary">Once a deletion completes (either immediately, or 30 days after a pause), the following is permanently removed:</p>
          <ul className="list-disc pl-5 text-text-secondary space-y-2">
            <li><strong>Personal Identity:</strong> Your name, email address, and profile picture.</li>
            <li><strong>Financial Records:</strong> Every goal, financial account, and loan ledger you own privately (not shared with a group or friend), including their full history.</li>
            <li><strong>Health Tracking:</strong> Your blood pressure, glucose, and medicine records, including any medical incidents/illnesses and baby vaccination profiles you created — even ones you'd shared read-only access to.</li>
            <li><strong>Game History:</strong> Your personal gamification points, badges, and leaderboard entries.</li>
            <li><strong>Usage History:</strong> Activity, login, and interaction logs.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-xl font-bold text-primary">Data Retention Policy</h3>
          <p className="text-text-secondary font-medium">Is any data kept?</p>
          <p className="text-text-secondary">
            If you choose the 30-day pause, nothing is deleted until the 30 days actually elapse (or you choose to finish it early) — this is the whole point of the pause, so you can get everything back if you change your mind. Once a deletion completes, we may still retain copies in our secure database backups for a short additional period for disaster recovery purposes, after which they are fully purged.
          </p>
          <p className="text-text-secondary italic text-sm">
            Note: Expenses, goals, and accounts you've shared with a group or specific friends, multiplayer game history, shared reminders, and direct messages stay in place for the other people involved (so their own records/balances/history stay intact), but your name on them is replaced with a generic "Deleted User" label and your photo is removed.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="text-xl font-bold text-primary">Partial Data Deletion</h3>
          <p className="text-text-secondary">
            You do not need to delete your entire account to remove specific data. You can manually delete individual expenses or leave specific groups directly within the app interface at any time.
          </p>
        </section>

        <div className="pt-8 border-t border-border-subtle text-center">
          <p className="text-sm text-text-muted">Developed by Sachin Rajput</p>
        </div>
      </main>
    </div>
  );
}
