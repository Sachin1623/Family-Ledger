// A few things are remembered on the device to make the next use quicker: the groups shown in the Talk sheet, the group an expense was last
// added to, the streak milestone already celebrated. They belong to ONE account, so when someone else signs in on the same phone (or the
// person signs out) they are cleared. Without this, the next account saw the previous account's last group in the Talk sheet.
const PER_ACCOUNT_KEYS = ['fl_voice_groups', 'fl_last_expense_group', 'fl_streak_milestone_seen'];
const OWNER_KEY = 'fl_device_cache_owner';

export function clearPerAccountDeviceCaches(): void {
  try {
    PER_ACCOUNT_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable: nothing was remembered anyway */
  }
}

// Call whenever an account is signed in: if it is a different account from the one the caches were made for, they are cleared first.
export function resetCachesIfAccountChanged(uid: string): void {
  try {
    const owner = localStorage.getItem(OWNER_KEY);
    if (owner && owner !== uid) PER_ACCOUNT_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(OWNER_KEY, uid);
  } catch {
    /* ignore */
  }
}
