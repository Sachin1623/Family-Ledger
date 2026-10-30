import { useEffect, useState } from 'react';

// Shown instead of the technical error box when a screen could not be downloaded because the connection dropped (weak or no signal).
// It waits quietly, checks the connection every few seconds and reloads on its own the moment the server answers again.
export const isConnectionError = (err: Error | null | undefined) =>
  !!err && /dynamically imported module|importing a module script|loading chunk|loading css chunk|failed to fetch|networkerror|load failed|network request failed/i.test(`${err.name} ${err.message}`);

export default function ConnectionLost() {
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`/manifest.json?ping=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || res.status === 404) { window.location.reload(); return; } // any answer means we are back online
    } catch {
      /* still offline */
    }
    setChecking(false);
  };

  useEffect(() => {
    const id = window.setInterval(() => { void check(); }, 5000);
    const onOnline = () => { void check(); };
    window.addEventListener('online', onOnline);
    return () => { window.clearInterval(id); window.removeEventListener('online', onOnline); };
  }, []);

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <style>{`
        @keyframes flc-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        @keyframes flc-arc { 0%,100% { opacity: .15 } 40%,60% { opacity: 1 } }
        @keyframes flc-orbit { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes flc-dot { 0%,80%,100% { opacity: .25 } 40% { opacity: 1 } }
        .flc-cloud { animation: flc-bob 3.2s ease-in-out infinite; transform-origin: center; }
        .flc-a1 { animation: flc-arc 2.2s ease-in-out infinite; }
        .flc-a2 { animation: flc-arc 2.2s ease-in-out .35s infinite; }
        .flc-a3 { animation: flc-arc 2.2s ease-in-out .7s infinite; }
        .flc-orbit { animation: flc-orbit 6s linear infinite; transform-origin: 110px 112px; }
        .flc-d { animation: flc-dot 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .flc-cloud, .flc-a1, .flc-a2, .flc-a3, .flc-orbit, .flc-d { animation: none !important; } .flc-a1, .flc-a2, .flc-a3 { opacity: .6; } }
      `}</style>
      <div className="max-w-sm w-full bg-white rounded-3xl border border-border-subtle shadow-sm px-6 pt-8 pb-6 text-center">
        <svg viewBox="0 0 220 190" className="w-56 h-48 mx-auto" role="img" aria-label="A cloud waiting for a signal">
          <ellipse cx="110" cy="168" rx="58" ry="7" fill="#0b3b57" opacity=".08" />
          <g className="flc-orbit" opacity=".9">
            <circle cx="110" cy="22" r="4" fill="#22c1a5" />
          </g>
          <g className="flc-cloud">
            <path d="M62 128c-15 0-26-10-26-23 0-12 9-22 21-23 3-17 18-29 36-29 14 0 26 8 32 20 3-1 6-2 10-2 15 0 27 11 27 26 0 14-12 31-28 31H62z" fill="#e8f6f3" stroke="#0f7a8f" strokeWidth="3" strokeLinejoin="round" />
            <circle cx="92" cy="104" r="4" fill="#0b3b57" />
            <circle cx="122" cy="104" r="4" fill="#0b3b57" />
            <path d="M99 117c5 5 14 5 19 0" fill="none" stroke="#0b3b57" strokeWidth="3" strokeLinecap="round" />
            <path className="flc-a1" d="M96 60a20 20 0 0 1 28 0" fill="none" stroke="#0f7a8f" strokeWidth="4" strokeLinecap="round" />
            <path className="flc-a2" d="M86 50a34 34 0 0 1 48 0" fill="none" stroke="#0f7a8f" strokeWidth="4" strokeLinecap="round" />
            <path className="flc-a3" d="M76 40a48 48 0 0 1 68 0" fill="none" stroke="#0f7a8f" strokeWidth="4" strokeLinecap="round" />
          </g>
        </svg>
        <h2 className="text-xl font-black text-primary mt-1">Your signal took a break</h2>
        <p className="text-sm text-text-muted mt-2 leading-relaxed">
          We could not load this screen because the connection dropped. Nothing is lost. We will open it for you the moment you are back online.
        </p>
        <p className="mt-4 text-xs font-bold text-primary inline-flex items-center gap-1.5">
          {checking ? 'Checking the connection' : 'Waiting for a signal'}
          <span className="inline-flex gap-0.5" aria-hidden>
            <i className="flc-d w-1 h-1 rounded-full bg-primary" />
            <i className="flc-d w-1 h-1 rounded-full bg-primary" style={{ animationDelay: '.2s' }} />
            <i className="flc-d w-1 h-1 rounded-full bg-primary" style={{ animationDelay: '.4s' }} />
          </span>
        </p>
        <button type="button" onClick={() => { void check(); }} disabled={checking} className="mt-5 w-full py-3 bg-primary text-white font-bold rounded-2xl active:scale-[0.98] transition-transform disabled:opacity-60">
          Try again now
        </button>
      </div>
    </div>
  );
}
