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
          <p className="text-text-secondary">To permanently delete your account and data, you can choose one of the following methods:</p>
          
          <div className="space-y-6 mt-4">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-bold">1</div>
              <div>
                <p className="font-bold text-primary">In-App Setting</p>
                <p className="text-sm text-text-secondary">Log in to the app, go to your <strong>Profile</strong>, and select <strong>Delete Account</strong> at the bottom of the page.</p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-bold">2</div>
              <div>
                <p className="font-bold text-primary">Email Request</p>
                <p className="text-sm text-text-secondary">Send an email to <strong>system@thirteenapps.com</strong> with the subject "Data Deletion Request" using the email address associated with your account.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xl font-bold text-primary">What data will be deleted?</h3>
          <p className="text-text-secondary">Upon processing your request, the following information will be permanently removed from our production servers:</p>
          <ul className="list-disc pl-5 text-text-secondary space-y-2">
            <li><strong>Personal Identity:</strong> Your name, email address, and profile picture.</li>
            <li><strong>Financial Records:</strong> All expenses, ledger entries, and group participation history created by you.</li>
            <li><strong>Goals &amp; Financial Accounts:</strong> Every savings goal and financial account you own, including their full history (contribution ledger / balance log).</li>
            <li><strong>Health Tracking:</strong> Your blood pressure, glucose, and medicine records, including any medical incidents/illnesses you created.</li>
            <li><strong>Shared Reminders:</strong> Every reminder you created, and your own response/completion status on reminders others created.</li>
            <li><strong>Usage History:</strong> Activity logs and interaction data.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-xl font-bold text-primary">Data Retention Policy</h3>
          <p className="text-text-secondary font-medium">Is any data kept?</p>
          <p className="text-text-secondary">
            When you delete your account, your data is immediately marked for deletion and is no longer accessible. 
            However, we may retain copies in our secure database backups for up to <strong>30 days</strong> for disaster recovery purposes, after which they are fully purged. 
          </p>
          <p className="text-text-secondary italic text-sm">
            Note: Expenses you have shared with a group will be shown as "Deleted User" to maintain the integrity of other members' ledger balances, but your personal identifiers will be removed.
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
