import { addDoc, collection } from 'firebase/firestore';
import { db } from './firebase';

// Lightweight usage tracking for the admin Growth tab — how much the invite and "Spread the
// Word" share flows actually get used, and through which channel. Same fire-and-forget,
// client-writes-its-own-event pattern as `loginEvents` in AuthContext.tsx: never blocks or
// throws into the caller, and a failed write here should never be the reason an invite/share
// action itself fails.
export type GrowthEventType =
  | 'invite_whatsapp'
  | 'invite_sms'
  | 'invite_email'
  | 'invite_inapp'
  | 'share_whatsapp'
  | 'share_facebook'
  | 'share_twitter'
  | 'share_linkedin'
  | 'share_native'
  | 'share_link_only';

export function logGrowthEvent(type: GrowthEventType, uid: string | undefined | null) {
  if (!uid) return;
  addDoc(collection(db, 'growthEvents'), {
    type,
    uid,
    createdAt: new Date().toISOString(),
  }).catch((err) => console.error('growthEvents write failed:', err));
}
