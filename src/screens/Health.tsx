import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

// Only one tracker today — structured as a list (rather than routing /health straight to Glucose)
// so future trackers (blood pressure, weight, ...) slot in as additional rows without a reroute.
const HEALTH_TRACKERS = [
  { to: '/health/glucose', icon: '🩸', titleKey: 'health.glucoseTracker', descKey: 'health.glucoseTrackerDesc' },
];

export default function Health() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('health.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('health.subtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden">
          {HEALTH_TRACKERS.map((tracker) => (
            <div
              key={tracker.to}
              onClick={() => navigate(tracker.to)}
              className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center shrink-0">
                  <span className="text-xl">{tracker.icon}</span>
                </div>
                <div>
                  <p className="font-bold text-primary text-sm">{t(tracker.titleKey)}</p>
                  <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t(tracker.descKey)}</p>
                </div>
              </div>
              <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
