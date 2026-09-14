// A mutable ref to ProfileSetupWizard's force-open function, set by ProfileSetupWizard.tsx
// (mounted once, globally, in App.tsx). Mirrors calculatorRef.ts's pattern — lets the header's
// "Test: New User Guide" menu item (localhost-testing only) relaunch the whole first-time
// experience on demand, bypassing the normal `hasCompletedProfileSetup === false` gate so it can
// be replayed on an already-onboarded test account.
type TriggerNewUserGuideFn = () => void;

let triggerFn: TriggerNewUserGuideFn | null = null;

export function setTriggerNewUserGuideFn(fn: TriggerNewUserGuideFn | null) {
  triggerFn = fn;
}

export function triggerNewUserGuide() {
  triggerFn?.();
}
