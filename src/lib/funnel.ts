import { getAnalyticsConsent } from './firebase';

// Anonymous sign-in funnel counters, kept on our own server so they work for everyone, whatever they answered on the analytics
// banner. Only an event NAME (and a short error code) is sent: no user id, no device id, no cookie, nothing that identifies a
// person. The server just adds one to that day's counter. It answers "where do installs drop off before they have an account?".
export type FunnelEvent =
  | 'login_screen_view'
  | 'google_tap'
  | 'google_success_new'
  | 'google_success_existing'
  | 'google_cancel'
  | 'google_error'
  | 'email_tap'
  | 'email_login_ok'
  | 'email_login_fail'
  | 'email_signup_ok'
  | 'apple_tap'
  | 'apple_success'
  | 'consent_accept'
  | 'consent_decline'
  | 'group_created';

// True the first time THIS phone/browser reports this event today (IST day), so the server can also keep a "devices" count next to the
// raw count — a reload or a second visit then no longer looks like another person. The memory is a local flag only: no id is sent.
function firstTimeToday(event: FunnelEvent): boolean {
  try {
    const day = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const raw = localStorage.getItem('fl_funnel_seen');
    const saved = raw ? JSON.parse(raw) : null;
    const seen: string[] = saved && saved.day === day && Array.isArray(saved.seen) ? saved.seen : [];
    if (seen.includes(event)) return false;
    localStorage.setItem('fl_funnel_seen', JSON.stringify({ day, seen: [...seen, event] }));
    return true;
  } catch {
    return false; // storage unavailable: count it, but never as a "new device"
  }
}

export function trackFunnel(event: FunnelEvent, detail?: string) {
  // Same switch as the rest of analytics: never on the iPhone app (App Store guideline 5.1.1(ii) asks for consent even for anonymous usage data),
  // and only where analytics is allowed (on by default in the Android app outside Europe, otherwise after the person says yes).
  if (getAnalyticsConsent() !== 'granted') return;
  try {
    void fetch('/api/funnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail: detail ? String(detail).slice(0, 40) : undefined, first: firstTimeToday(event) || undefined }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let counting get in the way of the app */
  }
}
