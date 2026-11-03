// Who sent a join link, and how. A WhatsApp or SMS invite is just a link, so the sender and channel travel inside it
// (?ref=<sender uid>&via=wa|sms). When the link is opened it is remembered on the phone; the first time a brand-new
// account signs in, the server is told so it can record where that person came from (see /api/referral/claim).
export type InviteVia = 'wa' | 'sms';

const KEY = 'fl_referral';

export function inviteJoinLink(groupId: string, senderUid: string | undefined | null, via: InviteVia): string {
  const base = `${window.location.origin}/join/${groupId}`;
  return senderUid ? `${base}?ref=${encodeURIComponent(senderUid)}&via=${via}` : base;
}

// Call with any location's query string (the page the app opened on, or a deep link handed to the app).
export function rememberReferral(search: string) {
  try {
    const p = new URLSearchParams(search);
    const ref = p.get('ref');
    const via = p.get('via');
    if (!ref || !/^[A-Za-z0-9]{10,64}$/.test(ref) || (via !== 'wa' && via !== 'sms')) return;
    localStorage.setItem(KEY, JSON.stringify({ ref, via, at: Date.now() }));
  } catch { /* storage unavailable: the invite just goes untracked */ }
}

export function pendingReferral(): { ref: string; via: InviteVia } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const x = JSON.parse(raw);
    if (!x?.ref || (x.via !== 'wa' && x.via !== 'sms') || Date.now() - Number(x.at) > 14 * 86_400_000) return null;
    return { ref: x.ref, via: x.via };
  } catch { return null; }
}

export function clearReferral() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
