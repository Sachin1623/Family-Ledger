import { useEffect } from 'react';
import { cancelSharedReminders } from '../lib/sharedReminderNotifications';

// Shared Reminders no longer exist. This runs once per app start and cancels any of their notifications still armed on this phone (see
// sharedReminderNotifications.ts); after that it finds nothing to do. It can be deleted once old app installs have all opened the app.
export default function GlobalReminderScheduler() {
  useEffect(() => {
    cancelSharedReminders();
  }, []);
  return null;
}
