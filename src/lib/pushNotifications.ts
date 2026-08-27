import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { User } from 'firebase/auth';
import { navigateTo } from './navigationRef';

let registered = false;
// The most recently FCM-registered token for this device, so removeCurrentDeviceToken (called on
// sign-out) can tell the server exactly which token to pull off the signing-out user's account —
// without this, a device that's used for multiple accounts (family members sharing a phone,
// testing with two accounts, etc.) leaves its token behind on every account it's ever signed into,
// so a LATER push meant for account A can land on the device while it's showing account B's UI
// (whoever's currently signed in), tapping into whatever screen that push points at for an
// account they're not even looking at. See project_recurring_reminder_stale_token memory.
let currentDeviceToken: string | null = null;

// Deep-links a tapped notification to the relevant screen instead of just opening the app to
// wherever it was left. Shared by both the real push tap handler and the local-notification tap
// handler (see pushNotificationReceived below) so foreground-shown notifications route exactly
// like backgrounded ones.
function routeNotificationTap(data: Record<string, string> | undefined) {
  if (!data?.type) return;
  if (data.type === 'group_invite' && data.groupId) {
    navigateTo(`/join/${data.groupId}`);
  } else if (data.type === 'group_activity' && data.groupId) {
    navigateTo(`/groups/${data.groupId}`);
  } else if (data.type === 'expense_activity' && data.groupId) {
    // An expense added/updated/deleted (or income added) — open the expenses list directly
    // rather than the group summary page.
    navigateTo(`/groups/${data.groupId}/expenses`);
  } else if (data.type === 'recurring_activity' && data.groupId) {
    // A recurring expense rule was created/changed/deleted for this group — open Recurring
    // Expenses filtered to that group, rather than the group's analysis summary page.
    navigateTo(`/recurring-expenses?groupId=${data.groupId}`);
  } else if (data.type === 'comment' && data.groupId && data.expenseId) {
    // An expense-level comment — open that expense's detail/comment view directly instead of
    // just the group page. Group-level "discussion" comments have no expenseId, and fall through
    // to the plain group-page branch below.
    navigateTo(`/groups/${data.groupId}/expenses?expenseId=${data.expenseId}`);
  } else if (data.type === 'comment' && data.groupId) {
    navigateTo(`/groups/${data.groupId}`);
  } else if (data.type === 'group_chat' && data.groupId) {
    navigateTo(`/groups/${data.groupId}?chat=1`);
  } else if (data.type === 'weekly_summary') {
    navigateTo('/weekly-summary');
  } else if (data.type === 'feedback_reply' || data.type === 'feedback_resolved') {
    navigateTo('/feedback');
  } else if (data.type === 'admin_feedback') {
    navigateTo('/admin/feedback');
  } else if (data.type === 'poke' && data.groupId) {
    navigateTo(`/add-expense?groupId=${data.groupId}`);
  } else if (data.type === 'dm_chat' && data.otherUid) {
    navigateTo(`/?dm=${data.otherUid}`);
  } else if (data.type === 'friend_request' && data.uid) {
    // Deep-links straight to the accept/decline prompt for THIS request rather than just the
    // Friends screen — Friends.tsx reads the `request` param on every render (not a mount-only
    // effect) and opens the modal for it.
    navigateTo(`/friends?request=${data.uid}`);
  } else if (data.type === 'friend_accepted') {
    navigateTo('/friends');
  } else if (data.type === 'recurring_confirm') {
    navigateTo('/recurring-approvals');
  } else if (data.type === 'expense_reminder') {
    const params = new URLSearchParams();
    if (data.groupId) params.set('groupId', data.groupId);
    if (data.category) params.set('category', data.category);
    if (data.amount) params.set('amount', data.amount);
    if (data.reminderId) params.set('reminderId', data.reminderId);
    navigateTo(`/add-expense${params.toString() ? `?${params.toString()}` : ''}`);
  } else if (data.type === 'settlement_reminder' && data.groupId && data.settleWith) {
    // "Pay now" from a settle-up reminder — pre-fills the whole expense as a payment to
    // whoever sent the reminder (see server.ts's /api/settlement-reminder and AddExpense.tsx's
    // `settleWith` handling).
    const params = new URLSearchParams({ groupId: data.groupId, settleWith: data.settleWith, description: 'Settlement', category: 'misc' });
    if (data.amount) params.set('amount', data.amount);
    navigateTo(`/add-expense?${params.toString()}`);
  } else if (
    data.type === 'todo_reminder' ||
    data.type === 'todo_created' ||
    data.type === 'todo_completed' ||
    data.type === 'birthday_group_reminder'
  ) {
    navigateTo('/todo');
  } else if (data.type === 'glucose_reminder' || data.type === 'glucose_logged') {
    const params = new URLSearchParams();
    if (data.meal) params.set('meal', data.meal);
    if (data.timing) params.set('timing', data.timing);
    navigateTo(`/health/glucose${params.toString() ? `?${params.toString()}` : ''}`);
  } else if (data.type === 'spread_word_reminder' || data.type === 'birthday_wish') {
    navigateTo('/profile');
  } else if (data.type === 'dob_reminder') {
    navigateTo('/profile?promptDob=1');
  } else if (data.type === 'shopping_list' && data.listId) {
    navigateTo(`/shopping-lists/${data.listId}`);
  } else if (data.type === 'shopping_list') {
    navigateTo('/shopping-lists');
  } else if (data.type === 'budget_set' && data.groupId) {
    navigateTo(`/groups/${data.groupId}/manage`);
  } else if ((data.type === 'loan_activity' || data.type === 'loan_reminder' || data.type === 'loan_installment_due') && data.contactId) {
    navigateTo(`/personal-loans/${data.contactId}`);
  } else if (data.type === 'shopkeeper_request') {
    navigateTo('/admin/shopkeeper-requests');
  } else if (data.type === 'shopkeeper_approved') {
    navigateTo('/profile');
  } else if (data.type === 'shopkeeper_rejected') {
    navigateTo('/profile');
  } else if ((data.type === 'ludo_invite' || data.type === 'ludo_poke' || data.type === 'ludo_turn') && data.gameId) {
    navigateTo(`/games/ludo/${data.gameId}`);
  } else if (data.type === 'ludo_chat' && data.gameId) {
    navigateTo(`/games/ludo/${data.gameId}?chat=1`);
  } else if ((data.type === 'rummy_invite' || data.type === 'rummy_poke' || data.type === 'rummy_turn') && data.gameId) {
    navigateTo(`/games/rummy/${data.gameId}`);
  } else if (data.type === 'rummy_chat' && data.gameId) {
    navigateTo(`/games/rummy/${data.gameId}?chat=1`);
  } else if ((data.type === 'business_invite' || data.type === 'business_poke' || data.type === 'business_turn') && data.gameId) {
    navigateTo(`/games/business/${data.gameId}`);
  } else if (data.type === 'business_chat' && data.gameId) {
    navigateTo(`/games/business/${data.gameId}?chat=1`);
  } else if ((data.type === 'sweep_invite' || data.type === 'sweep_poke' || data.type === 'sweep_turn') && data.gameId) {
    navigateTo(`/games/sweep/${data.gameId}`);
  } else if (data.type === 'sweep_chat' && data.gameId) {
    navigateTo(`/games/sweep/${data.gameId}?chat=1`);
  } else if ((data.type === 'sequence_invite' || data.type === 'sequence_poke' || data.type === 'sequence_turn') && data.gameId) {
    navigateTo(`/games/sequence/${data.gameId}`);
  } else if (data.type === 'sequence_chat' && data.gameId) {
    navigateTo(`/games/sequence/${data.gameId}?chat=1`);
  } else if ((data.type === 'chess_invite' || data.type === 'chess_poke' || data.type === 'chess_turn') && data.gameId) {
    navigateTo(`/games/chess/${data.gameId}`);
  } else if (data.type === 'chess_chat' && data.gameId) {
    navigateTo(`/games/chess/${data.gameId}?chat=1`);
  }
}

// Requests permission, registers for FCM, and sends the resulting device token to the
// backend so it can be used to push notifications (reminders + group activity alerts).
// No-ops on web (push notifications here are native-only) and only wires listeners once
// per app session.
export async function initPushNotifications(user: User) {
  if (!Capacitor.isNativePlatform() || registered) return;
  registered = true;

  try {
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') return;

    // Local notifications share the same Android OS permission as push, but Capacitor tracks
    // it separately per-plugin — request it too so LocalNotifications.schedule() below is
    // actually allowed to show anything.
    try {
      let localPerm = await LocalNotifications.checkPermissions();
      if (localPerm.display === 'prompt') {
        localPerm = await LocalNotifications.requestPermissions();
      }
    } catch (err) {
      console.error('LocalNotifications permission request failed:', err);
    }

    PushNotifications.addListener('registration', async (token) => {
      currentDeviceToken = token.value;
      try {
        const idToken = await user.getIdToken();
        await fetch('/api/register-device-token', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
        });
      } catch (err) {
        console.error('Failed to register device token:', err);
      }
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.error('Push registration error:', err);
    });

    // A push whose payload has a `notification` block (every push this app sends does) only
    // auto-displays in the system tray when the app is backgrounded or killed — that's Android/
    // FCM's own behavior, not something this app controls. When the app is in the *foreground*,
    // Android instead delivers it here, silently, and shows nothing unless the app does — so
    // without this listener, any reminder/notification that arrives while FamilyLedger happens
    // to be open never appears at all. Re-display it ourselves as a local notification.
    PushNotifications.addListener('pushNotificationReceived', async (notification) => {
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Math.floor(Math.random() * 2147483647),
              title: notification.title || 'FamilyLedger',
              body: notification.body || '',
              extra: notification.data,
            },
          ],
        });
      } catch (err) {
        console.error('Failed to show foreground local notification:', err);
      }
    });

    // Deep-links a tapped notification to the relevant screen instead of just opening the
    // app to wherever it was left. Capacitor buffers the tap event that launched the app
    // (if any) until this listener is registered, so this also covers a cold start.
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      routeNotificationTap(action.notification.data as Record<string, string> | undefined);
    });

    // Tapping the local notification we showed for a foreground-arrived push should route the
    // same way as tapping a real (backgrounded) push notification.
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      routeNotificationTap(action.notification.extra as Record<string, string> | undefined);
    });

    await PushNotifications.register();
  } catch (err) {
    console.error('initPushNotifications failed:', err);
  }
}

// Call before auth.signOut() so this device's token doesn't keep receiving (and mis-delivering)
// pushes meant for the account that's signing out — see currentDeviceToken's comment above for
// why this matters. Best-effort: if it fails, the token is just left behind (same as before this
// fix existed), never blocks the actual sign-out.
export async function removeCurrentDeviceToken(user: User) {
  if (!currentDeviceToken) return;
  try {
    const idToken = await user.getIdToken();
    await fetch('/api/unregister-device-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: currentDeviceToken }),
    });
  } catch (err) {
    console.error('Failed to unregister device token:', err);
  }
}
