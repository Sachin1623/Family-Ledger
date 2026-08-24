// Lightweight timezone -> country approximation. There's no permissions-friendly way to get
// a user's real country without a paid geo-IP service, so this infers it from the device's
// IANA timezone (Intl.DateTimeFormat) — good enough for admin-panel "where are our users"
// analytics, not meant to be precise.
const TIMEZONE_COUNTRY: Record<string, string> = {
  'Asia/Kolkata': 'India',
  'Asia/Calcutta': 'India',
  'America/New_York': 'United States',
  'America/Chicago': 'United States',
  'America/Denver': 'United States',
  'America/Los_Angeles': 'United States',
  'America/Anchorage': 'United States',
  'Pacific/Honolulu': 'United States',
  'America/Toronto': 'Canada',
  'America/Vancouver': 'Canada',
  'America/Edmonton': 'Canada',
  'America/Winnipeg': 'Canada',
  'Europe/London': 'United Kingdom',
  'Australia/Sydney': 'Australia',
  'Australia/Melbourne': 'Australia',
  'Australia/Brisbane': 'Australia',
  'Australia/Perth': 'Australia',
  'Asia/Dubai': 'United Arab Emirates',
  'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Tokyo': 'Japan',
  'Asia/Shanghai': 'China',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Madrid': 'Spain',
  'Europe/Rome': 'Italy',
  'Europe/Amsterdam': 'Netherlands',
  'Europe/Dublin': 'Ireland',
  'Asia/Singapore': 'Singapore',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Karachi': 'Pakistan',
  'Asia/Dhaka': 'Bangladesh',
  'Asia/Kathmandu': 'Nepal',
  'Asia/Colombo': 'Sri Lanka',
};

export function getApproxCountry(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TIMEZONE_COUNTRY[tz]) return TIMEZONE_COUNTRY[tz];
    // Fall back to a readable region label from the timezone itself, e.g.
    // "Asia/Almaty" -> "Asia (Almaty)", rather than an opaque "Unknown".
    const parts = tz.split('/');
    if (parts.length >= 2) {
      return `${parts[0]} (${parts[parts.length - 1].replace(/_/g, ' ')})`;
    }
    return tz || 'Unknown';
  } catch {
    return 'Unknown';
  }
}
