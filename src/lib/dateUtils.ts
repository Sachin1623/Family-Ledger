// Parses a date-only "YYYY-MM-DD" string as LOCAL midnight, not UTC midnight. Per the ES spec,
// the single-arg `new Date(dateOnlyString)` constructor parses date-only ISO strings as UTC —
// which then displays as the PREVIOUS calendar day for any negative-UTC-offset user once run
// through local `.toLocaleDateString()`/getters (and can misfire near local midnight even for
// positive-offset users). The 3-arg Date constructor is always local-time, so build it that way.
export function parseLocalDate(dateOnlyString: string): Date {
  const [year, month, day] = dateOnlyString.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Any Date as a local "YYYY-MM-DD" string. NOT `date.toISOString().split('T')[0]`, which gives
// the UTC calendar day — wrong for any non-UTC user, and specifically wrong right after local
// midnight for positive-UTC-offset zones (e.g. IST), where it still shows the previous day.
export function toLocalDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today's date as a local "YYYY-MM-DD" string — see toLocalDateString above.
export function todayLocalDateString(): string {
  return toLocalDateString(new Date());
}

// Current "YYYY-MM" month key in local time — same reasoning as todayLocalDateString.
export function currentLocalMonthKey(): string {
  return todayLocalDateString().slice(0, 7);
}

// "Just now" / "5m ago" / "2h ago" / "3d ago" / a plain date past a week — the bucket logic
// presence.ts's lastSeenLabel already used, factored out here so anything showing a relative
// timestamp (friend-request "last sent", chat presence, ...) shares one implementation. Returns
// plain English fragments, not translated — matches this app's existing convention of wrapping a
// small English time fragment inside a translated outer sentence via a `{{time}}` placeholder
// (see 'chat.lastSeen': 'Last seen {{time}}' and 'friends.sentTime': 'Sent {{time}}').
export function formatRelativeTimeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
