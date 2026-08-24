import React, { useEffect, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { TOUR_BY_ID } from '../lib/tours';

// Mounted once, globally, in App.tsx (not per-screen) so it survives navigation and can run any
// tour from the registry in src/lib/tours.ts, not just the original single onboarding sequence.
// A tour is launched by navigating to its `route` with `?tour=<id>` appended (see About.tsx's
// feature tiles) — this component reacts to that query param plus the current route, rather than
// being told directly, so it activates correctly whether it was already mounted or the navigation
// that carries `?tour=` is what mounts the target screen in the first place.
function findStepElement(selector: string): HTMLElement | null {
  return document.querySelector(`[data-tour="${selector}"]`);
}

export default function OnboardingTour() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTourId, setActiveTourId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, forceRerender] = useState(0);

  const activeTour = activeTourId ? TOUR_BY_ID[activeTourId] : null;

  // Decides whether a tour should be running at all. Two ways in: (1) an explicit `?tour=<id>`
  // whose target route matches where we currently are — set by About.tsx's tiles navigating
  // straight to `${tour.route}?tour=${tour.id}` — or (2) the 'dashboard' tour auto-launching for a
  // genuinely brand-new account (`hasSeenOnboarding === false`, set explicitly at signup in
  // AuthContext.tsx) that hasn't finished it yet, landing on '/' with no explicit tour requested.
  // Re-runs on every route/param change so navigating from one tour's screen to another's (or a
  // fresh `?tour=` deep link on an already-mounted screen) picks it up correctly.
  useEffect(() => {
    if (!user || !profile) return;
    const requested = searchParams.get('tour');
    if (requested) {
      const tour = TOUR_BY_ID[requested];
      if (tour && tour.route === location.pathname) {
        if (activeTourId !== requested) {
          setStepIndex(0);
          setActiveTourId(requested);
        }
        return;
      }
    }
    if (!requested && !activeTourId && location.pathname === '/' && profile.hasSeenOnboarding === false) {
      setStepIndex(0);
      setActiveTourId('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, profile, searchParams, location.pathname]);

  // Re-measures the current step's target on every step change and on resize/scroll, retrying
  // briefly if the element isn't mounted yet (e.g. group cards still loading from Firestore).
  useEffect(() => {
    if (!activeTour) return;
    let cancelled = false;
    let attempts = 0;

    const measure = () => {
      if (cancelled) return;
      const step = activeTour.steps[stepIndex];
      const el = step ? findStepElement(step.selector) : null;
      if (el) {
        setRect(el.getBoundingClientRect());
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else if (attempts < 10) {
        attempts += 1;
        setTimeout(measure, 200);
      } else {
        // Gave up finding this step's target (e.g. a feature that isn't populated yet) — skip to
        // the next one.
        setRect(null);
        setStepIndex((i) => (i + 1 < activeTour.steps.length ? i + 1 : -1));
      }
    };

    measure();
    const onViewportChange = () => forceRerender((n) => n + 1);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [activeTour, stepIndex]);

  useEffect(() => {
    if (stepIndex === -1) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  const finish = () => {
    const finishedDashboard = activeTourId === 'dashboard';
    setActiveTourId(null);
    if (finishedDashboard && user) {
      setDoc(doc(db, 'users', user.uid), { hasSeenOnboarding: true }, { merge: true }).catch((err) =>
        console.error('Failed to save onboarding completion:', err),
      );
    }
    if (searchParams.get('tour')) {
      const next = new URLSearchParams(searchParams);
      next.delete('tour');
      setSearchParams(next, { replace: true });
    }
  };

  if (!activeTour) return null;

  const step = activeTour.steps[stepIndex];
  if (!step) return null;

  const pad = 8;
  const spotlightStyle: React.CSSProperties = rect
    ? {
        position: 'fixed',
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        borderRadius: 16,
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
        border: '2px solid white',
        transition: 'top 0.2s, left 0.2s, width 0.2s, height 0.2s',
        pointerEvents: 'none',
        zIndex: 251,
      }
    : { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 251 };

  // Tooltip sits below the target by default, flipping above it if there isn't room.
  const tooltipTop = rect
    ? rect.bottom + pad * 2 + 160 > window.innerHeight
      ? Math.max(16, rect.top - pad * 2 - 180)
      : rect.bottom + pad * 2
    : window.innerHeight / 2 - 90;
  const tooltipLeft = rect ? Math.min(Math.max(16, rect.left), window.innerWidth - 320) : Math.max(16, window.innerWidth / 2 - 160);

  return (
    <div className="fixed inset-0 z-[250]">
      <div style={spotlightStyle} onClick={finish} />
      <div
        className="fixed bg-white rounded-2xl shadow-2xl p-5 w-[300px] space-y-3 z-[252]"
        style={{ top: tooltipTop, left: tooltipLeft }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
            Step {stepIndex + 1} of {activeTour.steps.length}
          </span>
          <button onClick={finish} className="text-[11px] font-bold text-text-muted hover:text-primary">
            Skip tour
          </button>
        </div>
        <h3 className="text-base font-black text-primary">{step.title}</h3>
        <p className="text-sm text-text-muted leading-relaxed">{step.description}</p>
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
            className="text-xs font-bold text-primary disabled:opacity-30"
          >
            Back
          </button>
          <button
            onClick={() => setStepIndex((i) => (i + 1 < activeTour.steps.length ? i + 1 : -1))}
            className="px-4 py-2 bg-primary text-white rounded-xl font-bold text-xs active:scale-95 transition-transform"
          >
            {stepIndex + 1 === activeTour.steps.length ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
