// Imperative launch for OnboardingTour.tsx, bypassing its normal `?tour=<id>`-matches-current-
// route mechanism entirely — used by the new-user onboarding chain (and the header's "Guides"
// menu) to start a tour at the exact moment the right screen is already mounted, with no route
// round-trip needed. The existing `?tour=` deep link (About.tsx's tour tiles) is untouched and
// still works exactly as before; this is a second, independent way in.
//
// `ctx` is stashed here for a tour's own step-level `onEnter` callbacks to read via
// getTourContext() — tours.ts is static data with no access to something like "which group was
// just created," so a caller passes that once at launch time instead (e.g.
// startTour('group-explore', { groupId })).
type StartTourFn = (id: string) => void;

let startFn: StartTourFn | null = null;
let context: Record<string, any> = {};

export function setStartTourFn(fn: StartTourFn | null) {
  startFn = fn;
}

export function startTour(id: string, ctx: Record<string, any> = {}) {
  context = ctx;
  startFn?.(id);
}

export function getTourContext(): Record<string, any> {
  return context;
}
