import { Capacitor } from '@capacitor/core';

// Alarm-related Android permissions are asked for at the moment they are needed, not when the app opens: exact alarms ("Alarms & reminders"),
// the battery exemption and, for medicine alarms, "Display over other apps" (the Snooze / Dismiss card). A screen that is about to rely on
// them calls askAlarmPermissions(); AlarmPermissionsPrompt.tsx (mounted once at the app root) shows what is still missing, with an Enable
// button for each. New users are asked for notifications only until they set up something that rings.
export type AlarmAskKind = 'medicine' | 'reminder';

export interface AlarmAskDetail {
  kind: AlarmAskKind;
  force: boolean; // true right after the person set something up; false = "if it has been a while" (at most once a day)
}

export const ALARM_ASK_EVENT = 'fl-ask-alarm-permissions';

export function askAlarmPermissions(kind: AlarmAskKind, opts: { force?: boolean } = {}): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
  window.dispatchEvent(new CustomEvent<AlarmAskDetail>(ALARM_ASK_EVENT, { detail: { kind, force: !!opts.force } }));
}
