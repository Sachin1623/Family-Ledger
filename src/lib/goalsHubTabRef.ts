// A mutable ref to GoalsHub.tsx's tab-switch function, set by GoalsHub itself while mounted.
// Mirrors newUserGuideRef.ts's pattern — lets a tour step (src/lib/tours.ts's 'goals-explore')
// switch GoalsHub's active tab as its own `onEnter` side effect, so the next step's spotlight
// target actually exists in the DOM.
type SetGoalsHubTabFn = (tab: string) => void;

let setTabFn: SetGoalsHubTabFn | null = null;

export function setGoalsHubTabFn(fn: SetGoalsHubTabFn | null) {
  setTabFn = fn;
}

export function setGoalsHubTab(tab: string) {
  setTabFn?.(tab);
}
