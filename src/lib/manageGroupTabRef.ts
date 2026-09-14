// A mutable ref to ManageGroup.tsx's tab-switch function, set by ManageGroup itself while mounted.
// Mirrors newUserGuideRef.ts's pattern — lets a tour step (src/lib/tours.ts's 'group-explore')
// switch ManageGroup's active tab as its own `onEnter` side effect, so the next step's spotlight
// target actually exists in the DOM.
type SetManageGroupTabFn = (tab: string) => void;

let setTabFn: SetManageGroupTabFn | null = null;

export function setManageGroupTabFn(fn: SetManageGroupTabFn | null) {
  setTabFn = fn;
}

export function setManageGroupTab(tab: string) {
  setTabFn?.(tab);
}
