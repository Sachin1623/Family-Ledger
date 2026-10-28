// Remembers (on this device only) whether someone was signed in the last time the app ran. Firebase restores the session
// asynchronously, so a brand-new install would otherwise sit on a loading screen just to learn there is nobody signed in.
// With no hint the login page can show at once; Firebase still decides in the background and the page moves on if it finds a user.
const KEY = 'fl_auth_hint';

export function hasAuthHint(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

export function setAuthHint(signedIn: boolean) {
  try { if (signedIn) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}
