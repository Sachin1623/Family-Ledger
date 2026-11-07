import { auth } from './firebase';

// Tells the server what happened to a broadcast on this phone (it was shown, closed, or something in it was tapped), so the admin dashboard can
// show how well a broadcast worked. Fire-and-forget: it never blocks or fails anything the person is doing.
export type BroadcastTarget = 'instagram' | 'facebook' | 'play' | 'feedback' | 'other';
export type BroadcastVia = 'link' | 'button' | 'image';

export function targetOf(url: string): BroadcastTarget {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com')) return 'facebook';
  if (url.includes('play.google.com')) return 'play';
  if (url.includes('familyledger.thirteenapps.com') && url.includes('/feedback')) return 'feedback';
  return 'other';
}

export async function trackBroadcast(id: string, event: 'view' | 'close' | 'click' | 'replay', extra: { target?: BroadcastTarget; via?: BroadcastVia } = {}): Promise<void> {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    await fetch('/api/broadcast/track', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, event, ...extra }),
      keepalive: true,
    });
  } catch {
    /* a missed count is not worth any trouble */
  }
}
