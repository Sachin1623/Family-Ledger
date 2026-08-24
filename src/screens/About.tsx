import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { initializeStatsIfEmpty } from '../services/statsService';
import { getAppVersion } from '../lib/appVersion';
import { useAuth } from '../context/AuthContext';
import { TOURS } from '../lib/tours';

export default function About() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [appVersion, setAppVersion] = useState<{ versionName: string; build: string } | null>(null);

  // Tapping a tile takes you straight into that feature with its tour running — OnboardingTour.tsx
  // (mounted globally in App.tsx) picks up the `?tour=` param the instant the target route mounts.
  // A logged-out visitor is sent to log in first (ProtectedRoute's normal behavior for every
  // route below); they'd need to tap the tile again afterward since the tour param doesn't
  // survive that redirect — an acceptable gap for a feature aimed at existing users.
  const launchTour = (tourId: string, route: string) => {
    if (!user) { navigate('/login'); return; }
    navigate(`${route}?tour=${tourId}`);
  };

  useEffect(() => {
    // Ensure stats are initialized if empty
    initializeStatsIfEmpty();

    const unsub = onSnapshot(doc(db, 'stats', 'global'), (snap) => {
      if (snap.exists()) {
        setStats(snap.data());
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    getAppVersion().then(setAppVersion);
  }, []);

  const formatAmount = (val: number) => {
    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
    return val.toLocaleString();
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-6 space-y-12 max-w-2xl mx-auto w-full pb-20">
        {/* Hero Section */}
        <div className="text-center space-y-4 pt-4">
          <div className="space-y-2">
            <h2 className="text-3xl font-extrabold text-primary tracking-tight">
              FamilyLedger{appVersion ? ` v${appVersion.versionName}` : ''}
            </h2>
            <p className="text-text-muted font-medium italic">Family finances, simplified.</p>
          </div>
        </div>

        {/* Global Stats Tile */}
        <section className="space-y-6">
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest pl-2">Platform Scale</h3>
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-primary p-8 rounded-[2rem] shadow-xl shadow-primary/20 text-white relative overflow-hidden"
          >
            {/* Background Decorations */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-10 -mt-10 blur-2xl" />
            <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/10 rounded-full -ml-8 -mb-8 blur-xl" />
            
            <div className="relative z-10 grid grid-cols-2 gap-8">
              <div className="space-y-1">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-tighter">Total Active Users</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black tracking-tighter">{stats?.totalUsers ?? 0}</span>
                  <span className="text-xs font-bold text-white/40">Registered</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-tighter">Family Groups</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black tracking-tighter">{stats?.totalGroups ?? 0}</span>
                  <span className="text-xs font-bold text-white/40">Created</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-tighter">Spend Lines</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black tracking-tighter">{stats?.totalExpenses ?? 0}</span>
                  <span className="text-xs font-bold text-white/40">Logged</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-tighter">Value Tracked</p>
                <div className="flex items-baseline gap-1">
                   <span className="text-[10px] font-black text-white/40 leading-none">₹</span>
                  <span className="text-3xl font-black tracking-tighter">{formatAmount(stats?.totalAmount || 0)}</span>
                </div>
              </div>
            </div>
            
            <div className="mt-8 pt-6 border-t border-white/10 flex items-center justify-between">
               <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                 <p className="text-[9px] font-bold text-white/50 uppercase tracking-widest">Live Network Stats</p>
               </div>
               <p className="text-[9px] italic text-white/30">Verified & Secure</p>
            </div>
          </motion.div>
        </section>

        {/* Feature Grid — one tile per feature, tap any for a guided tour */}
        <section className="space-y-6">
          <div className="pl-2">
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">Every Feature</h3>
            <p className="text-xs text-text-muted mt-0.5">Tap a tile for a guided tour of that feature.</p>
          </div>
          <div className="grid grid-cols-1 gap-4">
            {TOURS.map((tour, idx) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                key={tour.id}
                role="button"
                tabIndex={0}
                onClick={() => launchTour(tour.id, tour.route)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launchTour(tour.id, tour.route); } }}
                className="bg-white p-5 rounded-2xl border border-border-subtle shadow-sm flex gap-4 items-start cursor-pointer hover:border-primary/30 hover:shadow-md active:scale-[0.99] transition-all"
              >
                <div className="w-12 h-12 rounded-xl bg-surface flex items-center justify-center shrink-0 border border-border-subtle">
                  <span className="material-symbols-outlined text-primary">{tour.icon}</span>
                </div>
                <div className="space-y-1 flex-1">
                  <h4 className="font-bold text-primary">{tour.label}</h4>
                  <p className="text-sm text-text-muted leading-relaxed">{tour.blurb}</p>
                </div>
                <span className="material-symbols-outlined text-text-muted shrink-0 mt-2">chevron_right</span>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Mission */}
        <section className="bg-primary/5 p-8 rounded-3xl border border-primary/10 space-y-4 text-center">
          <h3 className="text-xl font-bold text-primary">Our Mission</h3>
          <p className="text-primary/70 leading-relaxed italic">
            "To remove the complexity of family finances and shared household bills, so you can focus on building your home together."
          </p>
        </section>

        {/* Footer info */}
        <div className="text-center space-y-4 pt-8">
          <p className="text-xs text-text-muted">
            Designed for secure, collaborative fintech experiences.
          </p>
          <div className="flex justify-center flex-wrap gap-6 text-sm font-bold text-primary">
            <Link to="/privacy" className="hover:underline">Privacy</Link>
            <Link to="/data-usage" className="hover:underline">Data Usage</Link>
            <Link to="/terms" className="hover:underline">Terms</Link>
            <Link to="/contact" className="hover:underline">Contact</Link>
            <Link to="/delete-account" className="hover:underline">Data Deletion</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
