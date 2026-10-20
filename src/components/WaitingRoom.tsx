import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { clsx } from 'clsx';
import ShareGameButton from './ShareGameButton';
import PresenceDot from './PresenceDot';
import { GameShell, GameHeader } from './GameShell';

export interface WaitingPlayer {
  uid: string;
  displayName: string;
  photoURL?: string;
  isBot?: boolean;
  seatIndex?: number;
  /** Ring colour round the avatar (Ludo colour, team colour…). */
  ringColor?: string;
  /** Small line under the name — "Red", "Team A", "plays automatically"… */
  sub?: string;
}

// The waiting room shared by every game: a big code to pass around, the seats (round table for 4-seat games, a seat list
// for the rest), invite / bot / start / join / delete, and a guest view. Each game keeps its own logic and passes its
// handlers in; nothing here talks to the database.
export default function WaitingRoom({
  title,
  modeLabel,
  backTo,
  headerActions,
  code,
  shareLabel,
  sharePath,
  players,
  maxPlayers,
  minToStart,
  hostUid,
  myUid,
  isPlayer,
  layout = 'list',
  tableLabels,
  note,
  customSeats,
  afterSeats,
  joinDisabled,
  onJoin,
  joinLabel = 'Join game',
  onStart,
  startLabel = 'Start game',
  startBusy,
  startBlocked,
  autoStart,
  onFillBot,
  fillBotLabel = 'Add a bot',
  addingBot,
  invitePicker,
  onDelete,
  deleteLabel = 'Delete',
  error,
}: {
  title: string;
  modeLabel?: string;
  backTo: string;
  headerActions?: React.ReactNode;
  code: string;
  shareLabel: string;
  sharePath: string;
  players: WaitingPlayer[];
  maxPlayers: number;
  minToStart: number;
  hostUid: string;
  myUid?: string;
  isPlayer: boolean;
  layout?: 'table' | 'list';
  /** For the round table: label + subtitle for a seat by its position relative to you (0 = you, 1 = left, 2 = across, 3 = right). */
  tableLabels?: (rel: number) => { label: string; sub?: string };
  note?: string;
  customSeats?: React.ReactNode;
  /** Extra controls shown under the seats (Ludo's colour picker and partner mode). */
  afterSeats?: React.ReactNode;
  joinDisabled?: boolean;
  onJoin?: () => void;
  joinLabel?: string;
  onStart?: () => void;
  startLabel?: string;
  startBusy?: boolean;
  /** A reason the table can't start yet even though it is full (e.g. teams not 2-2). */
  startBlocked?: string;
  /** The game starts by itself once it's full (Chess) — no Start button. */
  autoStart?: boolean;
  onFillBot?: () => void;
  fillBotLabel?: string;
  addingBot?: boolean;
  invitePicker?: React.ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
  error?: string | null;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [copied, setCopied] = useState(false);
  const isHost = !!myUid && hostUid === myUid;

  // Invites this host has sent for this table. An invite document exists only while it is waiting: the person joining
  // (or declining) removes it. So "still there and not seated" = waiting to accept; "was waiting, now gone and not seated" = declined.
  const [sentValue] = useCollection(isHost && myUid ? query(collection(db, 'gameInvites'), where('hostUid', '==', myUid)) : null);
  const seatedUids = useMemo(() => new Set(players.map((p) => p.uid)), [players]);
  const waitingInvites = useMemo(
    () =>
      (sentValue?.docs || [])
        .map((d) => d.data() as any)
        .filter((d) => d.code === code && !seatedUids.has(d.toUid))
        .map((d) => ({ uid: d.toUid as string, name: (d.toName as string) || 'Invited player', photo: (d.toPhoto as string) || '', at: d.createdAt as string })),
    [sentValue, code, seatedUids],
  );
  const everWaiting = useRef(new Map<string, { name: string; photo: string }>());
  const [declined, setDeclined] = useState<{ uid: string; name: string; photo: string }[]>([]);
  useEffect(() => {
    if (!sentValue) return;
    const nowWaiting = new Set(waitingInvites.map((w) => w.uid));
    waitingInvites.forEach((w) => everWaiting.current.set(w.uid, { name: w.name, photo: w.photo }));
    const gone: { uid: string; name: string; photo: string }[] = [];
    everWaiting.current.forEach((v, uid) => {
      if (!nowWaiting.has(uid) && !seatedUids.has(uid)) gone.push({ uid, ...v });
    });
    setDeclined(gone);
  }, [sentValue, waitingInvites, seatedUids]);
  const inviteAvatar = (name: string, photo: string, dim: boolean) => (
    <div className={clsx('w-9 h-9 shrink-0 rounded-full overflow-hidden bg-gradient-to-br from-[#6f86b3] to-[#3a4a75] flex items-center justify-center text-xs font-black text-white', dim && 'opacity-60')}>
      {photo ? <img src={photo} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (name || '?').slice(0, 1).toUpperCase()}
    </div>
  );
  const host = players.find((p) => p.uid === hostUid);
  const open = Math.max(0, maxPlayers - players.length);
  const canStart = players.length >= minToStart && !startBlocked && !startBusy;

  const copy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const avatar = (p: WaitingPlayer, size: number) => (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="w-full h-full rounded-full overflow-hidden bg-gradient-to-br from-[#6f86b3] to-[#3a4a75] flex items-center justify-center font-black text-white" style={{ border: `3px solid ${p.ringColor || (p.uid === hostUid ? '#f5c451' : '#3a4a75')}`, fontSize: size * 0.38 }}>
        {p.isBot ? '🤖' : p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (p.displayName || '?').slice(0, 1).toUpperCase()}
      </div>
      {!p.isBot && <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-3 h-3" />}
    </div>
  );

  // ── Seats ────────────────────────────────────────────────────────────────────────────────────────
  const me = players.find((p) => p.uid === myUid);
  const mySeat = me?.seatIndex ?? 0;
  const POS: Record<number, string> = { 0: 'left-1/2 -translate-x-1/2 bottom-0', 1: 'left-0 top-1/2 -translate-y-1/2', 2: 'left-1/2 -translate-x-1/2 top-0', 3: 'right-0 top-1/2 -translate-y-1/2' };
  const table = (
    <div className="relative h-[290px] my-1">
      <div className="absolute left-1/2 top-1/2 w-[170px] h-[170px] -ml-[85px] -mt-[85px] rounded-full flex flex-col items-center justify-center text-center border-[6px] border-[#2a3b6b] shadow-[inset_0_0_30px_rgba(0,0,0,0.5),0_10px_30px_rgba(0,0,0,0.4)]" style={{ background: 'radial-gradient(circle,#1f6a4a,#0f3a2a)' }}>
        <span className="text-[9px] font-extrabold tracking-[0.12em] text-emerald-200">PLAYERS</span>
        <b className="text-[26px] font-black">{players.length} / {maxPlayers}</b>
        <span className="text-[9px] font-extrabold tracking-[0.12em] text-emerald-200">{open === 0 ? 'TABLE FULL' : `${open} SEAT${open === 1 ? '' : 'S'} OPEN`}</span>
      </div>
      {[0, 1, 2, 3].map((rel) => {
        const seat = (mySeat + rel) % 4;
        const p = players.find((x) => x.seatIndex === seat);
        const lab = tableLabels?.(rel) || { label: rel === 0 ? 'You' : 'Player' };
        return (
          <div key={rel} className={clsx('absolute w-[92px] text-center', POS[rel])}>
            {p ? <div className="mx-auto w-fit">{avatar(p, 58)}</div> : <div className="w-[58px] h-[58px] mx-auto rounded-full border-2 border-dashed border-[#3a4a75] bg-[#0c1230] text-[#5d6c92] text-2xl flex items-center justify-center">＋</div>}
            <p className="text-[10.5px] font-extrabold mt-1 truncate">{p ? (p.uid === myUid ? 'You' : p.displayName) : lab.label}</p>
            <p className="text-[8.5px] font-bold text-white/50">{p ? lab.sub || '' : lab.sub || ''}</p>
            {p?.uid === hostUid && <span className="inline-block text-[8px] font-black px-2 py-px rounded-full bg-amber-300/20 text-amber-300">HOST</span>}
          </div>
        );
      })}
    </div>
  );

  const list = (
    <div className="space-y-2">
      <p className="text-[10px] font-black tracking-[0.14em] text-amber-300 px-1">PLAYERS · {players.length} OF {maxPlayers}</p>
      {players.map((p) => (
        <div key={p.uid} className="flex items-center gap-2.5 rounded-2xl px-3 py-2.5 bg-[#121a2e] border border-[#1f2a47]">
          {avatar(p, 38)}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-extrabold truncate">{p.uid === myUid ? `${p.displayName} (you)` : p.displayName}{p.uid === hostUid && <span className="ml-1.5 text-[10px] font-black text-amber-300">· Host</span>}</p>
            {p.sub && <p className="text-[10px] font-bold text-white/50">{p.sub}</p>}
          </div>
        </div>
      ))}
      {Array.from({ length: open }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-2xl px-3 py-2.5 border-[1.5px] border-dashed border-[#2c3a63]">
          <div className="w-[38px] h-[38px] rounded-full border-2 border-dashed border-[#3a4a75] bg-[#0c1230] text-[#5d6c92] flex items-center justify-center text-xl">＋</div>
          <div className="min-w-0">
            <p className="text-[13px] font-extrabold text-[#5d6c92]">Open seat</p>
            <p className="text-[10px] font-bold text-white/40">{isPlayer ? 'Invite someone or add a bot' : 'Waiting for a player'}</p>
          </div>
        </div>
      ))}
    </div>
  );

  const startText = autoStart
    ? ''
    : players.length < minToStart
    ? minToStart === maxPlayers ? `Need ${minToStart} players to start` : `Need at least ${minToStart} players`
    : startBlocked ? startBlocked : startBusy ? 'Starting…' : `${startLabel}${minToStart !== maxPlayers ? ` · ${players.length} players` : ''}`;

  return (
    <GameShell>
        <GameHeader title={title} subtitle={(modeLabel ? `${modeLabel} · ` : '') + 'Waiting for players'} backTo={backTo} actions={headerActions} />

        <main className="relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-4 space-y-3 max-w-md mx-auto w-full">
          {isPlayer && !isHost && host && (
            <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-3.5 text-center">
              <p className="text-[10px] font-black tracking-[0.14em] text-amber-300">HOSTED BY</p>
              <p className="text-lg font-black mt-0.5">{host.displayName}</p>
              <p className="text-[10.5px] font-bold text-white/50">You've joined · {players.length} of {maxPlayers} seated</p>
            </div>
          )}

          <div className="rounded-3xl bg-[#121a2e] border border-[#1f2a47] p-3.5">
            <p className="text-[10px] font-black tracking-[0.14em] text-amber-300">SHARE THIS CODE</p>
            <div className="flex gap-1.5 my-2.5">
              {code.split('').map((ch, i) => (
                <div key={i} className="flex-1 h-12 rounded-xl bg-[#0c1230] border-[1.5px] border-amber-300 text-amber-300 text-[22px] font-black flex items-center justify-center shadow-[0_0_12px_rgba(245,196,81,0.15)]">{ch}</div>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={copy} className="flex-1 py-2.5 rounded-xl text-[11.5px] font-black bg-[#18213a] border border-[#243052] text-slate-200">{copied ? '✓ Copied' : '⧉ Copy'}</button>
              <ShareGameButton gameLabel={shareLabel} code={code} path={sharePath} className="flex-1 py-2.5 rounded-xl text-[11.5px] font-black bg-[#22c55e] text-[#04140d] flex items-center justify-center gap-1" />
            </div>
          </div>

          {note && <p className="text-[11px] font-bold text-white/60 text-center px-2">{note}</p>}
          {customSeats ? customSeats : layout === 'table' ? table : list}
          {afterSeats}

          {isHost && (waitingInvites.length > 0 || declined.length > 0) && (
            <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-3 space-y-2">
              <p className="text-[10px] font-black tracking-[0.14em] text-amber-300">INVITES SENT</p>
              {waitingInvites.map((w) => (
                <div key={w.uid} className="flex items-center gap-3">
                  {inviteAvatar(w.name, w.photo, false)}
                  <span className="flex-1 min-w-0 truncate text-sm font-bold">{w.name}</span>
                  <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-extrabold text-amber-300">
                    <span className="w-3 h-3 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
                    Waiting to accept
                  </span>
                </div>
              ))}
              {declined.map((w) => (
                <div key={w.uid} className="flex items-center gap-3">
                  {inviteAvatar(w.name, w.photo, true)}
                  <span className="flex-1 min-w-0 truncate text-sm font-bold text-white/60">{w.name}</span>
                  <span className="shrink-0 text-[11px] font-extrabold text-red-300">Declined</span>
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-xs font-bold text-red-300 px-1">{error}</p>}

          {!isPlayer && onJoin && open > 0 && (
            <button onClick={onJoin} disabled={joinDisabled} className="w-full py-3.5 rounded-2xl text-sm font-black text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_5px_0_#b88a1d] active:translate-y-0.5 disabled:opacity-40">{joinLabel}</button>
          )}

          {isPlayer && open > 0 && (invitePicker || (isHost && onFillBot)) && (
            <div className="grid grid-cols-2 gap-2">
              {invitePicker ? <button onClick={() => setShowInvite(true)} className="py-3 rounded-2xl text-[11.5px] font-extrabold bg-[#121a2e] border border-[#1f2a47]">👥 Invite family</button> : <span />}
              {isHost && onFillBot ? <button onClick={onFillBot} disabled={addingBot} className="py-3 rounded-2xl text-[11.5px] font-extrabold bg-[#121a2e] border border-[#1f2a47] disabled:opacity-50">{addingBot ? 'Adding…' : `🤖 ${fillBotLabel}`}</button> : <span />}
            </div>
          )}

          {isPlayer && isHost && onStart && !autoStart && (
            <button onClick={onStart} disabled={!canStart} className={clsx('w-full py-4 rounded-2xl text-[15px] font-black transition-transform', canStart ? 'text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_5px_0_#b88a1d] active:translate-y-0.5' : 'bg-[#1b2543] text-[#5d6c92]')}>
              {canStart ? `▶ ${startText}` : startText}
            </button>
          )}
          {isPlayer && !isHost && (
            <p className="text-center text-[12px] font-bold text-white/55 py-2">{autoStart ? 'The game starts as soon as everyone has joined…' : 'Waiting for the host to start…'}</p>
          )}
          {isPlayer && isHost && autoStart && (
            <p className="text-center text-[12px] font-bold text-white/55 py-2">The game starts as soon as everyone has joined…</p>
          )}

          {isPlayer && isHost && onDelete && (
            <button onClick={onDelete} className="w-full py-2 text-red-300/80 text-[12px] font-extrabold">{deleteLabel}</button>
          )}
        </main>

        {showInvite && invitePicker && (
          <div className="absolute inset-0 z-[40] flex items-end bg-black/60" onClick={() => setShowInvite(false)}>
            <div className="w-full max-h-[78%] overflow-y-auto rounded-t-3xl bg-[#0f1630] border-t border-[#243052] p-3 space-y-2" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
              <div className="w-10 h-1 rounded-full bg-[#2c3a63] mx-auto" />
              <div className="flex items-center justify-between px-1">
                <p className="text-[15px] font-black">Invite to the table</p>
                <span className="text-[11px] font-extrabold text-white/50">{open} seat{open === 1 ? '' : 's'} open</span>
              </div>
              <div className="rounded-2xl bg-white text-on-surface p-2">{React.isValidElement(invitePicker) ? React.cloneElement(invitePicker as React.ReactElement<any>, { onSent: () => setShowInvite(false) }) : invitePicker}</div>
              <button onClick={() => setShowInvite(false)} className="w-full py-3 rounded-2xl text-sm font-extrabold bg-white/10 border border-white/15">Done</button>
            </div>
          </div>
        )}
    </GameShell>
  );
}
