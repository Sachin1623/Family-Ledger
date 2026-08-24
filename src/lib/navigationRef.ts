// A mutable ref to the router's navigate function, set by <NavigationBridge /> (mounted
// once inside <Router> in App.tsx). Lets non-component code (e.g. the push notification
// tap handler in pushNotifications.ts) navigate without needing React context.
type NavigateFn = (path: string) => void;

let navigateFn: NavigateFn | null = null;
let pendingPath: string | null = null;

export function setNavigateFn(fn: NavigateFn | null) {
  navigateFn = fn;
  if (navigateFn && pendingPath) {
    const path = pendingPath;
    pendingPath = null;
    navigateFn(path);
  }
}

// Navigates immediately if the router is ready; otherwise remembers the path and navigates
// as soon as setNavigateFn is next called (covers a cold-start race where a push notification
// tap fires before the app's Router has mounted).
export function navigateTo(path: string) {
  if (navigateFn) {
    navigateFn(path);
  } else {
    pendingPath = path;
  }
}
