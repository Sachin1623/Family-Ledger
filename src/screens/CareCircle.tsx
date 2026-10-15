import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useFriendships } from '../lib/useFriendships';
import { PersonAvatar, StatusChip, Tone } from '../components/HealthKit';
import type { HealthDelegateInvite, HealthDelegateKind } from '../lib/healthDelegateInvites';

const KIND_LABEL: Record<HealthDelegateKind, string> = { medicine: 'Medicines', glucose: 'Glucose', bp: 'Blood pressure' };
const KIND_PATH: Record<HealthDelegateKind, string> = { medicine: '/health/medicines', glucose: '/health/glucose', bp: '/health/blood-pressure' };

type InviteRow = HealthDelegateInvite & { id: string };

// One place for who can help with your health and whose health you help with. The invites themselves
// (friend-based delegation) are the existing ones — nothing here changes what anyone is allowed to do;
// it just gathers them, with Accept / Decline for pending ones, and links to each tool's own settings to edit.
export default function CareCircle() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { usersByUid } = useFriendships(user?.uid);
  const [busy, setBusy] = useState<string | null>(null);

  const [forMeValue] = useCollection(user ? query(collection(db, 'healthDelegateInvites'), where('friendUid', '==', user.uid)) : null);
  const [fromMeValue] = useCollection(user ? query(collection(db, 'healthDelegateInvites'), where('ownerUid', '==', user.uid)) : null);

  const forMe: InviteRow[] = useMemo(() => (forMeValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [forMeValue]);
  const fromMe: InviteRow[] = useMemo(() => (fromMeValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [fromMeValue]);

  const pending = forMe.filter((i) => i.status === 'pending');
  const lookAfter = useMemo(() => {
    const map = new Map<string, { ownerUid: string; name: string; photo: string; kinds: HealthDelegateKind[] }>();
    forMe.filter((i) => i.status === 'accepted').forEach((i) => {
      const cur = map.get(i.ownerUid) || { ownerUid: i.ownerUid, name: i.ownerName || 'Someone', photo: i.ownerPhoto || '', kinds: [] };
      cur.kinds.push(i.kind);
      map.set(i.ownerUid, cur);
    });
    return [...map.values()];
  }, [forMe]);
  const helpers = useMemo(() => {
    const map = new Map<string, { friendUid: string; items: { kind: HealthDelegateKind; status: InviteRow['status'] }[] }>();
    fromMe.forEach((i) => {
      const cur = map.get(i.friendUid) || { friendUid: i.friendUid, items: [] };
      cur.items.push({ kind: i.kind, status: i.status });
      map.set(i.friendUid, cur);
    });
    return [...map.values()];
  }, [fromMe]);

  const respond = async (id: string, status: 'accepted' | 'declined') => {
    setBusy(id);
    try {
      await updateDoc(doc(db, 'healthDelegateInvites', id), { status, respondedAt: new Date().toISOString() });
    } catch (err) {
      console.error('Failed to respond to care invite:', err);
      alert('Could not save your answer — please try again.');
    } finally {
      setBusy(null);
    }
  };

  const tone = (s: InviteRow['status']): Tone => (s === 'accepted' ? 'ok' : s === 'pending' ? 'warn' : 'mute');
  const statusText = (s: InviteRow['status']) => (s === 'accepted' ? 'Can help' : s === 'pending' ? 'Invite sent' : 'Declined');

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <button onClick={() => navigate('/health')} className="text-xs font-bold text-primary flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Health
        </button>
        <div>
          <h1 className="text-xl font-black text-slate-900">Care circle</h1>
          <p className="text-[12px] font-semibold text-slate-500">Who can help with your health, and whose health you help with.</p>
        </div>

        {pending.length > 0 && (
          <section className="space-y-2">
            {pending.map((inv) => (
              <div key={inv.id} className="rounded-2xl border border-blue-200 bg-blue-50 p-3.5">
                <div className="flex items-center gap-2.5">
                  <PersonAvatar name={inv.ownerName || 'Someone'} photoURL={inv.ownerPhoto} id={inv.ownerUid} size={34} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] font-black text-slate-900">{inv.ownerName || 'Someone'} invited you to help with their {KIND_LABEL[inv.kind].toLowerCase()}</p>
                    <p className="text-[10.5px] font-semibold text-slate-500">You'll be able to log for them and get their reminders.</p>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button disabled={busy === inv.id} onClick={() => respond(inv.id, 'accepted')} className="flex-1 py-2 rounded-xl bg-teal-700 text-white text-xs font-black disabled:opacity-50">Accept</button>
                  <button disabled={busy === inv.id} onClick={() => respond(inv.id, 'declined')} className="flex-1 py-2 rounded-xl bg-white text-slate-700 text-xs font-black border border-slate-200 disabled:opacity-50">Decline</button>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-[10px] font-black tracking-[0.12em] text-slate-500 px-1">PEOPLE WHO HELP ME</h2>
          <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
            {helpers.length === 0 && <p className="p-4 text-xs font-semibold text-slate-500">Nobody yet. Add someone from a tool's settings → Delegates.</p>}
            {helpers.map((h) => {
              const u = usersByUid.get(h.friendUid);
              return (
                <div key={h.friendUid} className="p-3 flex items-center gap-3">
                  <PersonAvatar name={u?.displayName || 'Someone'} photoURL={u?.photoURL} id={h.friendUid} size={34} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] font-black text-slate-900 truncate">{u?.displayName || 'Someone'}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {h.items.map((it) => <StatusChip key={it.kind} tone={tone(it.status)}>{KIND_LABEL[it.kind]} · {statusText(it.status)}</StatusChip>)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['medicine', 'glucose', 'bp'] as HealthDelegateKind[]).map((k) => (
              <button key={k} onClick={() => navigate(`${KIND_PATH[k]}?panel=delegates`)} className="py-2.5 rounded-xl bg-teal-50 text-teal-700 text-[10.5px] font-black">Edit · {KIND_LABEL[k]}</button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-[10px] font-black tracking-[0.12em] text-slate-500 px-1">PEOPLE I LOOK AFTER</h2>
          <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
            {lookAfter.length === 0 && <p className="p-4 text-xs font-semibold text-slate-500">You're not helping anyone yet. When someone invites you and you accept, they appear here.</p>}
            {lookAfter.map((p) => (
              <div key={p.ownerUid} className="p-3 flex items-center gap-3">
                <PersonAvatar name={p.name} photoURL={p.photo} id={p.ownerUid} size={34} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-black text-slate-900 truncate">{p.name}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.kinds.map((k) => (
                      <button key={k} onClick={() => navigate(`${KIND_PATH[k]}?forUid=${p.ownerUid}`)}>
                        <StatusChip tone="teal">{KIND_LABEL[k]} ›</StatusChip>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10.5px] font-semibold text-slate-400 px-1">Baby vaccine caregivers are managed from the baby's own profile.</p>
        </section>
      </main>
    </div>
  );
}
