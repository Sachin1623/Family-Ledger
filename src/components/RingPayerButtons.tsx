import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ringPayerNow } from '../lib/paymentReminders';
import MemberAvatar from './MemberAvatar';

// "Ring [name]" for each payer other than me. After a ring the button counts down the minute the server makes everyone wait, so a
// second tap never ends in an error, and the line underneath says plainly where it went. The countdown outlives the screen (it is kept
// here, not in the component), so closing and reopening the sheet does not reset it.
const COOLDOWN_MS = 60_000;
const lastRung = new Map<string, number>();

export default function RingPayerButtons({ groupId, payers, labelFor, accent = '#4338ca', onAccent = '#ffffff' }: {
  groupId: string;
  payers: { userId: string; name: string; photo?: string }[];
  labelFor: (uid: string) => string; // what the payment is for, shown in their notification
  accent?: string;
  onAccent?: string;
}) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const cooling = payers.some((p) => now - (lastRung.get(`${groupId}_${p.userId}`) || 0) < COOLDOWN_MS);

  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooling]);

  const ring = async (p: { userId: string; name: string }) => {
    setBusy(true);
    setMsg(null);
    const result = await ringPayerNow(groupId, p.userId, labelFor(p.userId), p.name);
    if (result.ok || result.cooldown) lastRung.set(`${groupId}_${p.userId}`, Date.now());
    setNow(Date.now());
    setMsg({ ok: result.ok, text: result.message });
    setBusy(false);
  };

  if (payers.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {payers.map((p) => {
          const left = Math.ceil((COOLDOWN_MS - (now - (lastRung.get(`${groupId}_${p.userId}`) || 0))) / 1000);
          const wait = left > 0 && left <= 60;
          return (
            <button key={p.userId} type="button" disabled={busy || wait} onClick={() => ring(p)}
              style={{ background: accent, color: onAccent }}
              className={clsx('flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-xs font-black active:scale-95 disabled:opacity-60')}>
              <MemberAvatar name={p.name} photo={p.photo} size={20} />
              <span className="material-symbols-outlined text-[16px]">{wait ? 'check_circle' : 'notifications_active'}</span>
              {wait ? `Rung · again in 0:${String(left).padStart(2, '0')}` : `Ring ${p.name}`}
            </button>
          );
        })}
      </div>
      {msg && <p className={clsx('text-xs font-bold', msg.ok ? 'text-success' : 'text-error')} role="status">{msg.text}</p>}
    </div>
  );
}
