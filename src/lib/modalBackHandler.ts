// A stack of "close this modal" callbacks, so ANY back gesture — Android/gesture hardware back
// (Capacitor's 'backButton' event, see App.tsx) AND a plain browser/web back (button, mobile
// browser back gesture, Alt+Left, whatever pops the History API) — closes whatever floating modal
// is currently open instead of leaving the page it's covering. Neither of those two back paths
// otherwise has any idea a modal (not a route) is on screen: Capacitor's handler falls through to
// route-based navigation (getParentPath), and a modal never pushed a history entry of its own, so
// a real browser back just pops straight past the current route entirely — which is exactly what
// this app's Goals "Accounts" tab hit (a route-less internal tab, one level further removed than
// a normal route from whatever the browser's previous history entry actually was).
//
// Any modal that wants "back closes me, not the page behind me" pushes its own close handler when
// it opens (via pushModalBackHandler) and pops it when it closes (via popModalBackHandler) — a
// stack, not a single ref, so a modal opened from inside another modal unwinds back-presses one
// layer at a time, in the right order.
type BackHandler = () => void;
const stack: BackHandler[] = [];

// Web/browser back support: opening a modal pushes a dummy history entry (same URL — this never
// changes what page/tab is showing) so the *next* browser back pops that entry first instead of
// navigating the underlying page away. The popstate listener below then closes the modal instead
// of letting the browser actually leave, and removes the handler from `stack` itself, synchronously,
// BEFORE calling it — that's what lets popModalBackHandler tell "closed by a real back" (already
// gone from the stack, nothing left to do) apart from "closed some other way" (X/Cancel/Save/the
// native Capacitor path below), where it still needs to consume the pushed entry itself.
export function pushModalBackHandler(handler: BackHandler) {
  stack.push(handler);
  try {
    window.history.pushState({ modalBackGuard: true }, '', window.location.href);
  } catch {
    // pushState can throw in some embedded/sandboxed webviews — the modal still works, it just
    // won't intercept a browser back press in that environment.
  }
}

export function popModalBackHandler(handler: BackHandler) {
  const idx = stack.lastIndexOf(handler);
  if (idx === -1) return; // already removed by the popstate listener — its own browser-level back
  // already consumed the entry pushed above, nothing left to clean up.
  stack.splice(idx, 1);
  // Closed via something other than a real back navigation — the dummy entry from pushModalBackHandler
  // is still sitting in browser history unconsumed. Pop it now so the *next* real back press goes
  // straight to the actual previous page instead of silently eating a press on this leftover entry.
  try {
    window.history.back();
  } catch {
    // ignore
  }
}

// Called by App.tsx's Capacitor backButton listener before it does its own route-based navigation.
// Returns true if a modal was open and handled (closed) the press — the caller should stop there.
// Deliberately does NOT remove the handler from `stack` itself (unlike the popstate listener) — a
// hardware back press is a discrete OS event, not a browser history pop, so the modal's own
// resulting close still runs through its normal effect cleanup -> popModalBackHandler(), which is
// what actually removes it and consumes the pushed history entry.
export function consumeModalBackHandler(): boolean {
  if (stack.length === 0) return false;
  const top = stack[stack.length - 1];
  top();
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (stack.length === 0) return;
    const top = stack.pop()!;
    top();
  });
}
