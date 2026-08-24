// Mutable refs bridging pointsApi.ts's claimPoints (a plain async function, not a component,
// called from event handlers all over the app) to the two visual reactions an award triggers: a
// toast (via NotificationContext, registered by PointsToastBridge) and a flying-coins animation
// toward the Header's points pill (registered by HeaderPointsPill). Mirrors feedPanelRef.ts's
// pattern for the same reason — none of this can be React context, since the trigger site isn't
// a component.
type AddNotificationFn = (n: { type: 'info' | 'success' | 'warning' | 'error'; title: string; message: string; icon?: string }) => void;
type FlyListenerFn = (xp: number, coins: number, targetRect: DOMRect | null) => void;

let addFn: AddNotificationFn | null = null;
let hudTargetGetter: (() => DOMRect | null) | null = null;
let flyListener: FlyListenerFn | null = null;

export function setPointsToastFn(fn: AddNotificationFn | null) {
  addFn = fn;
}

// Registered by HeaderPointsPill with a function that reads its own DOM node's current
// getBoundingClientRect() — read fresh on every award rather than cached, so the flight target
// stays correct across layout shifts (window resize, orientation change, keyboard opening).
export function setPointsHudTarget(getter: (() => DOMRect | null) | null) {
  hudTargetGetter = getter;
}

export function setPointsFlyListener(fn: FlyListenerFn | null) {
  flyListener = fn;
}

export function showPointsAward(xp: number, coins: number): void {
  if (!xp && !coins) return;
  addFn?.({
    type: 'success',
    title: `+${xp} XP`,
    message: coins ? `+${coins} coins` : 'Nice work!',
    icon: 'stars',
  });
  flyListener?.(xp, coins, hudTargetGetter ? hudTargetGetter() : null);
}
