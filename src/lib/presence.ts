// Shared "is this user online right now" logic — originally built for Dashboard's Group Members
// list, reused here for showing presence in multiplayer game waiting rooms/tables. Reads a
// `users/{uid}` doc's `appForegroundAt`/`lastActiveAt` fields (see AuthContext's writeForeground
// heartbeat, which refreshes `appForegroundAt` every 25s while the app is foregrounded and clears
// it to null on backgrounding).
import { formatRelativeTimeAgo } from './dateUtils';

const ONLINE_WINDOW_MS = 90_000;

export function isPresenceOnline(presence: any): boolean {
  if (!presence?.appForegroundAt) return false;
  return Date.now() - new Date(presence.appForegroundAt).getTime() < ONLINE_WINDOW_MS;
}

export function lastSeenLabel(presence: any): string {
  const iso = presence?.lastActiveAt || presence?.appForegroundAt;
  if (!iso) return 'Never active';
  return formatRelativeTimeAgo(iso);
}
