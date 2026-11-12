// A "first-time" person: an account made in the last few days. Announcement popups (admin broadcasts, "Spread the Word") stay away from
// them so their first sessions are about getting set up, not about messages meant for existing users.
export const FIRST_TIME_DAYS = 3;
export function isFirstTimeAccount(user: { metadata?: { creationTime?: string } } | null | undefined): boolean {
  const created = user?.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : NaN;
  return Number.isFinite(created) && Date.now() - created < FIRST_TIME_DAYS * 86_400_000;
}
