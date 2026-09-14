// A mutable ref to Dashboard.tsx's "force one group tile to its fully-expanded state" function,
// set by Dashboard itself while mounted. Mirrors newUserGuideRef.ts's pattern — lets a tour step
// (src/lib/tours.ts's 'group-explore') expand the just-created group's tile as its own `onEnter`
// side effect, so its action icons/budget bar/recent-spend actually exist in the DOM to spotlight
// next. Safe to call before Dashboard has mounted (e.g. immediately after `navigate('/')`, before
// the new route's component has rendered) — it's just a no-op until Dashboard registers itself,
// and OnboardingTour.tsx's own retry loop calls every step's `onEnter` again on each retry attempt
// until its spotlight target is found, so the expand naturally takes effect once Dashboard mounts.
type ExpandGroupTileFn = (groupId: string) => void;

let expandFn: ExpandGroupTileFn | null = null;

export function setExpandGroupTileFn(fn: ExpandGroupTileFn | null) {
  expandFn = fn;
}

export function expandGroupTile(groupId: string) {
  expandFn?.(groupId);
}
