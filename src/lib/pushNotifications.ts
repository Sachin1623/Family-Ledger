import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { User } from 'firebase/auth';
import { navigateTo } from './navigationRef';
import { requestAlarmTakeoverPermission } from './alarmClock';
import { registerMedicineActionTypes, snoozeMedicineReminder } from './medicineReminders';

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
  } else if (data.type === 'bp_reminder' || data.type === 'bp_logged') {
    navigateTo('/health/blood-pressure');
  } else if (data.type === 'medicine_reminder' || data.type === 'medicine_logged' || data.type === 'medicine_missed') {
    navigateTo('/health/medicines');
  } else if (data.type === 'shared_reminder') {
    // The scheduled-trigger local notification always carries a reminderId (opens that specific
    // reminder's card directly); the "someone shared a reminder with you" group-activity push
    // fired at creation time doesn't thread one through /api/notify-group-activity, so it just
    // opens the hub list instead — a reasonable fallback rather than adding a param for a single
    // notification type.
    navigateTo(data.reminderId ? `/reminders?open=${data.reminderId}` : '/reminders');
  } else if (data.type === 'spread_word_reminder') {
    // Straight to the Spread the Word card (see Profile.tsx's `share` param handling) — one tap
    // gets there, scrolled to and highlighted, with the actual share button right there for the
    // very next tap, rather than making the user hunt for the section themselves.
    navigateTo('/profile?share=1');
  } else if (data.type === 'birthday_wish') {
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

// Only asked once ever (per device) — declining shouldn't mean getting nagged with a Settings
// redirect on every single app open. If the user later wants it, the reminder screens themselves
// (Medicines, Blood Pressure, Reminders hub, etc.) can surface the same "why are my reminders
// late" explanation and call this again; for now this is the one proactive ask.
const EXACT_ALARM_ASKED_KEY = 'familyledger_exact_alarm_asked';

// See the SCHEDULE_EXACT_ALARM comment in AndroidManifest.xml for the full root cause. This is
// Android-only (iOS has no equivalent concept — local notifications there fire exactly as
// scheduled) and only relevant from Android 12 (API 31) up; `checkExactNotificationSetting`
// itself already reports 'granted' on older OS versions, so no separate version check is needed
// here. `changeExactNotificationSetting()` sends the user to a real system Settings screen — a
// bigger interruption than an in-app permission dialog — so it's gated behind a plain confirm
// explaining why, rather than firing silently.
async function requestExactAlarmPermission() {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    if (localStorage.getItem(EXACT_ALARM_ASKED_KEY)) return;
    const status = await LocalNotifications.checkExactNotificationSetting();
    if (status.exact_alarm === 'granted') {
      localStorage.setItem(EXACT_ALARM_ASKED_KEY, '1');
      return;
    }
    localStorage.setItem(EXACT_ALARM_ASKED_KEY, '1');
    const proceed = window.confirm(
      'To make sure medicine and other reminders arrive exactly on time (not just "sometime soon"), FamilyLedger needs the "Alarms & reminders" permission. Open Settings to allow it now?'
    );
    if (proceed) await LocalNotifications.changeExactNotificationSetting();
  } catch (err) {
    console.error('Failed to check/request exact alarm permission:', err);
  }
}

// Requests permission, registers for FCM, and sends the resulting device token to the
// backend so it can be used to push notifications (reminders + group activity alerts).
// No-ops on web (push notifications here are native-only) and only wires listeners once
// per app session.
//
// Uses @capacitor-firebase/messaging, not @capacitor/push-notifications — the latter registers
// directly with each platform's native push service, which on iOS means the token it hands back
// is a RAW APNS DEVICE TOKEN, not an FCM token. server.ts's sendPush sends through Firebase Admin
// SDK (admin.messaging().sendEachForMulticast), which only accepts genuine FCM tokens — Android
// was fine (Android's native push IS FCM, so its token already was one), but every push to an iOS
// device was silently rejected as an "invalid" token and pruned as stale, meaning NO push
// notification of any kind (chat, reminders, group activity, everything) ever reached an iPhone.
// @capacitor-firebase/messaging's iOS side exchanges the APNs token for a real FCM token via
// Firebase's own backend (see AppDelegate.swift's forwarding of didRegisterForRemoteNotifications-
// WithDeviceToken) — this is the actual fix, not just a workaround. Still requires an APNs Auth
// Key uploaded to Firebase Console (Project Settings > Cloud Messaging > Apple app configuration)
// for Firebase's backend to reach Apple's push servers at all — no code change substitutes for
// that manual step.
export async function initPushNotifications(user: User) {
  if (!Capacitor.isNativePlatform() || registered) return;
  registered = true;

  try {
    // Local notifications (medicine/BP/glucose/shared/todo reminders) are a distinct OS permission
    // from push, and a distinct FEATURE conceptually — a user who declines "push notifications"
    // (server-triggered: group activity, chat, etc.) very reasonably still expects their on-device
    // medicine alarm to work. Request/check it independent of the push permission outcome below,
    // so declining push can never silently take every local reminder down with it.
    try {
      let localPerm = await LocalNotifications.checkPermissions();
      if (localPerm.display === 'prompt') {
        localPerm = await LocalNotifications.requestPermissions();
      }
    } catch (err) {
      console.error('LocalNotifications permission request failed:', err);
    }

    // Getting *shown* a notification (above) is separate from getting it *on time*. Every
    // scheduled reminder in this app (medicine, BP, glucose, shared reminders, todos) asks
    // AlarmManager for an exact alarm; on Android 12+ that silently downgrades to an inexact one
    // — deliverable whenever Doze next wakes the app, sometimes much later than the set time —
    // unless the user has separately granted "Alarms & reminders" for this app. Nudge for it once.
    requestExactAlarmPermission();

    // Same idea, separate Android permission — medicine reminders' alarm-clock-style takeover
    // (see alarmClock.ts) additionally needs "Full screen notifications" to actually take over the
    // screen rather than just post a normal notification.
    requestAlarmTakeoverPermission();

    // iOS-only (no-ops on Android, where medicine reminders bypass this plugin entirely) — lets
    // the scheduled reminder show Dismiss/Snooze buttons directly on the lock-screen notification.
    registerMedicineActionTypes();

    let permStatus = await FirebaseMessaging.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await FirebaseMessaging.requestPermissions();
    }
    if (permStatus.receive !== 'granted') return;

    const registerToken = async (token: string) => {
      currentDeviceToken = token;
      try {
        const idToken = await user.getIdToken();
        await fetch('/api/register-device-token', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, platform: Capacitor.getPlatform() }),
        });
      } catch (err) {
        console.error('Failed to register device token:', err);
      }
    };

    // Fires on later token refreshes (the OS/Firebase can rotate the token at any time); the
    // initial token below is fetched directly since this plugin has no separate one-time
    // "registration" event the way @capacitor/push-notifications did.
    FirebaseMessaging.addListener('tokenReceived', (event) => {
      registerToken(event.token);
    });

    try {
      const { token } = await FirebaseMessaging.getToken();
      await registerToken(token);
    } catch (err) {
      console.error('Failed to get FCM token:', err);
    }

    // A push whose payload has a `notification` block (every push this app sends does) only
    // auto-displays in the system tray when the app is backgrounded or killed — that's each
    // platform's own native behavior, not something this app controls. When the app is in the
    // *foreground*, Android instead delivers it here, silently, and shows nothing unless the app
    // does — so without this, any reminder/notification that arrives while FamilyLedger happens to
    // be open never appears at all. iOS handles this natively instead (see capacitor.config.ts's
    // FirebaseMessaging.presentationOptions), so re-displaying it here too would double it up.
    FirebaseMessaging.addListener('notificationReceived', async (event) => {
      if (Capacitor.getPlatform() !== 'android') return;
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Math.floor(Math.random() * 2147483647),
              title: event.notification.title || 'FamilyLedger',
              body: event.notification.body || '',
              extra: event.notification.data,
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
    FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
      routeNotificationTap(event.notification.data as Record<string, string> | undefined);
    });

    // Tapping the local notification we showed for a foreground-arrived push should route the
    // same way as tapping a real (backgrounded) push notification. A medicine reminder's own
    // "Snooze 10 min" action (iOS only — see medicineReminders.ts's registerMedicineActionTypes;
    // Android's medicine reminders don't go through this plugin at all) is handled here instead of
    // navigating anywhere, since snoozing isn't a request to open the app.
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const extra = action.notification.extra as Record<string, any> | undefined;
      if (extra?.type === 'medicine_reminder' && action.actionId === 'snooze') {
        snoozeMedicineReminder(action.notification.id, action.notification.title || 'Medicine reminder', action.notification.body || '');
        return;
      }
      routeNotificationTap(extra as Record<string, string> | undefined);
    });
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
