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

export function trackFunnel(event: FunnelEvent, detail?: string) {
  try {
    void fetch('/api/funnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail: detail ? String(detail).slice(0, 40) : undefined }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let counting get in the way of the app */
  }
}
