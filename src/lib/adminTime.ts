// Every date and time on the admin screens is shown in Indian time (IST) so the numbers read the same wherever the admin is, matching the
// server's IST day buckets. 'device' is the one manual switch (Admin home > Times shown in), kept in this browser only.
const KEY = 'fl_admin_tz';
export const IST = 'Asia/Kolkata';

export function getAdminTz(): string | undefined {
  try {
    return localStorage.getItem(KEY) === 'device' ? undefined : IST;
  } catch {
    return IST;
  }
}
export function setAdminTzMode(mode: 'ist' | 'device') {
  try { localStorage.setItem(KEY, mode); } catch { /* storage blocked: stays IST */ }
}
export const adminTzLabel = () => (getAdminTz() ? 'IST' : 'your device time');

const asDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));
export const fmtDateTime = (v: string | number | Date) => asDate(v).toLocaleString(undefined, { timeZone: getAdminTz() });
export const fmtDate = (v: string | number | Date) => asDate(v).toLocaleDateString(undefined, { timeZone: getAdminTz() });
export const fmtTime = (v: string | number | Date) => asDate(v).toLocaleTimeString(undefined, { timeZone: getAdminTz() });
// today's date parts in the admin timezone (for "days left in the month" style maths)
export function adminNowParts() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: getAdminTz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  return { year: p[0], month: p[1], day: p[2] };
}

// datetime-local inputs (broadcast scheduling) hold a wall-clock time with no zone: read it as IST (or the device's zone when switched).
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: getAdminTz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return parts.replace(' ', 'T');
}
export function localInputToIso(v: string): string {
  return (getAdminTz() ? new Date(`${v}:00+05:30`) : new Date(v)).toISOString();
}
