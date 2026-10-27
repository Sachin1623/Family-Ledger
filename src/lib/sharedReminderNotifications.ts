import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

// Shared Reminders were removed from the app. Phones that had some armed still hold their trigger-time notifications, which would keep firing for a
// feature that no longer exists, so GlobalReminderScheduler calls this once to cancel exactly the ids that were armed (kept in localStorage).
const STORAGE_KEY = 'familyledger_shared_reminder_ids';

export async function cancelSharedReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ids: number[] = raw ? JSON.parse(raw) : [];
    if (ids.length > 0) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to cancel shared reminders:', err);
  }
}
