import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';

export default function Contact() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen bg-surface font-sans">
      <main className="flex-1 p-6 space-y-8 max-w-2xl mx-auto w-full pb-20">
        <header className="text-center space-y-4 py-8">
          <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary">
            <span className="material-symbols-outlined text-4xl">contact_support</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-primary">Contact Us</h1>
          <p className="text-text-muted">We're here to assist you with any questions about FamilyLedger.</p>
        </header>

        <div className="grid gap-6">
          <motion.a 
            href="mailto:system@thirteenapps.com"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-4 p-6 bg-white rounded-3xl border border-border-subtle shadow-sm hover:shadow-md transition-all group"
          >
            <div className="w-12 h-12 rounded-2xl bg-surface flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
              <span className="material-symbols-outlined">mail</span>
            </div>
            <div>
              <p className="font-bold text-primary">Email Support</p>
              <p className="text-sm text-text-muted">system@thirteenapps.com</p>
            </div>
            <span className="material-symbols-outlined ml-auto text-text-muted group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </motion.a>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex items-center gap-4 p-6 bg-white rounded-3xl border border-border-subtle shadow-sm opacity-50"
          >
            <div className="w-12 h-12 rounded-2xl bg-surface flex items-center justify-center text-text-muted">
              <span className="material-symbols-outlined">chat</span>
            </div>
            <div>
              <p className="font-bold text-text-muted">Live Chat</p>
              <p className="text-sm text-text-muted">Coming soon to active members.</p>
            </div>
          </motion.div>
        </div>

        <section className="space-y-4 pt-12">
          <h3 className="text-sm font-bold text-text-muted uppercase tracking-widest pl-2">Common Questions</h3>
          <div className="space-y-3">
            {[
              { q: "Is FamilyLedger free?", a: "Yes, the basic group sharing and expense tracking features are completely free for families and small groups." },
              { q: "Can I use it offline?", a: "The app requires an internet connection to sync data in real-time with other members, but it caches your data for quick viewing offline." },
              { q: "How do I join a group?", a: "You need an invite link from the group owner or an existing member. Just click the link and you'll be added instantly." }
            ].map((faq, i) => (
              <div key={i} className="bg-white p-5 rounded-2xl border border-border-subtle">
                <p className="font-bold text-primary text-sm mb-1">{faq.q}</p>
                <p className="text-sm text-text-muted leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
