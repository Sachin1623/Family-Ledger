import React, { useEffect, useState } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { TOUR_BY_ID } from '../lib/tours';
import { setStartTourFn, getTourContext } from '../lib/tourRef';
import AccountsExplainerModal from './AccountsExplainerModal';

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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTourId, setActiveTourId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [showAccountsGoalsOffer, setShowAccountsGoalsOffer] = useState(false);
  const [showAccountsExplainer, setShowAccountsExplainer] = useState(false);

  const activeTour = activeTourId ? TOUR_BY_ID[activeTourId] : null;

  // Registers the imperative launch surface (src/lib/tourRef.ts) — lets the new-user onboarding
  // chain and the header's "Guides" menu start any tour by id without a `?tour=` route round-trip.
  useEffect(() => {
    setStartTourFn((id: string) => {
      setStepIndex(0);
      setActiveTourId(id);
    });
    return () => setStartTourFn(null);
  }, []);

  // Decides whether a tour should be running at all. Two ways in: (1) an explicit `?tour=<id>`
  // whose target route matches where we currently are — set by About.tsx's tiles navigating
  // straight to `${tour.route}?tour=${tour.id}` — or (2) the 'dashboard' tour auto-launching for a
  // genuinely brand-new account (`hasSeenOnboarding === false`, set explicitly at signup in
  // AuthContext.tsx) that hasn't finished it yet, landing on '/' with no explicit tour requested.
  // The auto-launch path also waits on `hasCompletedProfileSetup` (ProfileSetupWizard.tsx's own
  // gate) so a brand-new account sees the name/currency/DOB/create-group wizard first, THEN this
  // spotlight tour once that's dismissed — never both full-screen overlays at once. An explicit
  // `?tour=` deep link (e.g. from About.tsx) is unaffected by that check, since it's a deliberate
  // request, not the auto-launch. Re-runs on every route/param change so navigating from one
  // tour's screen to another's (or a fresh `?tour=` deep link on an already-mounted screen) picks
  // it up correctly.
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
    if (
      !requested && !activeTourId && location.pathname === '/' &&
      profile.hasSeenOnboarding === false && profile.hasCompletedProfileSetup !== false
    ) {
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
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // Tracks whichever real DOM element currently has the glow class, so it can be cleared the
    // instant the step changes (or the tour ends) — never left glowing on a stale target.
    let glowedEl: HTMLElement | null = null;
    // `rect` is a snapshot of the PREVIOUS step's target position and stays that way in state
    // until this step's own target is actually found — without clearing it here, a step whose
    // target takes a moment to appear (still retrying, e.g. right after a route hop or a
    // conditionally-rendered section like a budget card that doesn't exist for this particular
    // group) visibly spotlights the WRONG, stale element for however long the retry takes, even
    // though its own glow class was already correctly removed. Clearing it up front means the
    // overlay just dims the whole screen with no cutout while genuinely searching, instead of
    // lying about where the real target is.
    setRect(null);

    // scrollIntoView's "smooth" behavior is an animation, not instant — a rect taken in the same
    // tick it's called reflects where the element was BEFORE scrolling, not where it ends up. That
    // mismatch is exactly what made the spotlight land in the wrong place on any step whose target
    // wasn't already on-screen (every step this session added that lives further down a page, or
    // behind a tab/route switch the step's own onEnter just triggered). Measuring again once the
    // scroll has had time to finish — and on every resize/scroll event from then on, not just once
    // — keeps the spotlight glued to the real element instead of a stale snapshot.
    const remeasure = (el: HTMLElement) => {
      if (cancelled) return;
      setRect(el.getBoundingClientRect());
    };

    const measure = () => {
      if (cancelled) return;
      const step = activeTour.steps[stepIndex];
      // Both are safe to call repeatedly — a navigate() to the already-current path is a no-op,
      // and onEnter() (a ref-trigger dispatch — see dashboardTileRef.ts's own comment) is a no-op
      // until the target screen has actually mounted and registered itself. Calling them on every
      // retry attempt (not just once) is what lets a single step hop routes AND prime a tab/tile
      // before its target exists to find.
      if (step?.route && step.route !== window.location.pathname) navigate(step.route);
      step?.onEnter?.();
      const resolvedSelector = step ? (typeof step.selector === 'function' ? step.selector(getTourContext()) : step.selector) : null;
      const el = resolvedSelector ? findStepElement(resolvedSelector) : null;
      if (el) {
        if (glowedEl !== el) {
          glowedEl?.classList.remove('fl-tour-glow');
          el.classList.add('fl-tour-glow');
          glowedEl = el;
        }
        remeasure(el); // immediate feedback...
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // ...then again once the smooth scroll (and any layout/animation it interrupted, e.g. a
        // tab switch's own fade-in) has actually settled. 400ms comfortably covers this app's
        // scroll/transition durations without being long enough to feel laggy.
        settleTimer = setTimeout(() => remeasure(el), 400);
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
    // Re-measures the ACTUAL current element's position on resize/scroll, rather than just forcing
    // a re-render off a stale rect (which is all this used to do — a re-render alone recomputes
    // the overlay's style from the same unchanged `rect` state, so it never actually moved).
    const onViewportChange = () => { if (glowedEl) remeasure(glowedEl); };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      glowedEl?.classList.remove('fl-tour-glow');
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTour, stepIndex]);

  useEffect(() => {
    if (stepIndex === -1) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  const finish = () => {
    const finishedDashboard = activeTourId === 'dashboard';
    // Part of the new-user onboarding chain (see tours.ts's 'group-explore' entry) — finishing
    // this specific tour is the "end of the group phase" milestone, so instead of just closing it
    // offers the next phase (Accounts/Goals) rather than silently ending.
    const finishedGroupExplore = activeTourId === 'group-explore';
    setActiveTourId(null);
    if (finishedDashboard && user) {
      setDoc(doc(db, 'users', user.uid), { hasSeenOnboarding: true }, { merge: true }).catch((err) =>
        console.error('Failed to save onboarding completion:', err),
      );
    }
    if (finishedGroupExplore) {
      setShowAccountsGoalsOffer(true);
      // The plain 'dashboard' tour's own auto-launch effect (above) re-evaluates on every render
      // and would otherwise fire immediately here — same route ('/'), same still-`false`
      // hasSeenOnboarding for a brand-new account — stealing focus before this offer ever gets
      // shown, and covering strictly less ground than 'group-explore' (which the user just
      // finished) already did. Marking onboarding seen here, not just when the older tour itself
      // runs, is what stops that collision.
      if (user) {
        setDoc(doc(db, 'users', user.uid), { hasSeenOnboarding: true }, { merge: true }).catch((err) =>
          console.error('Failed to save onboarding completion:', err),
        );
      }
    }
    if (searchParams.get('tour')) {
      const next = new URLSearchParams(searchParams);
      next.delete('tour');
      setSearchParams(next, { replace: true });
    }
  };

  const step = activeTour?.steps[stepIndex];

  if (!activeTour || !step) {
    // No spotlight tour running — still need to render the post-'group-explore' offer/explainer
    // modals below, since `finish()` clears activeTourId before either of those becomes relevant.
    return (
      <>
        {showAccountsGoalsOffer && (
          <div className="fixed inset-0 bg-black/40 z-[253] flex items-center justify-center p-4" onClick={() => setShowAccountsGoalsOffer(false)}>
            <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-2xl">savings</span>
                <h3 className="text-base font-black text-primary">Track your savings & goals too?</h3>
              </div>
              <p className="text-sm text-on-surface leading-relaxed">
                FamilyLedger can also track your real bank/investment accounts and what you're saving toward — separate from group expenses. Want a quick walkthrough setting one of each up?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAccountsGoalsOffer(false)}
                  className="flex-1 py-3 border border-border-subtle text-text-muted font-bold rounded-xl"
                >
                  Not now
                </button>
                <button
                  onClick={() => { setShowAccountsGoalsOffer(false); setShowAccountsExplainer(true); }}
                  className="flex-1 py-3 bg-primary text-white font-bold rounded-xl"
                >
                  Yes, show me
                </button>
              </div>
            </div>
          </div>
        )}
        {showAccountsExplainer && (
          <AccountsExplainerModal
            onClose={() => { setShowAccountsExplainer(false); navigate('/goals/accounts?openAdd=1&guide=1&onboarding=1'); }}
          />
        )}
      </>
    );
  }

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
