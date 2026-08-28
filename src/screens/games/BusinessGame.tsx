import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import {
  BOARD,
  BOARD_SIZE,
  STARTING_CASH,
  SALARY,
  JAIL_BAIL,
  INCOME_TAX,
  JAIL_INDEX,
  MAX_JAIL_TURNS,
  UNMORTGAGE_INTEREST,
  COLOR_GROUPS_LIGHT,
  squareAt,
  isOwnable,
  movePlayer,
  nearestSquareOfType,
  propertyRent,
  railwayRent,
  utilityRent,
  RENT_HOUSE_MULTIPLIERS,
  RENT_HOTEL_MULTIPLIER,
  ownsFullGroup,
  canBuildOnGroup,
  canBuildOnProperty,
  ownedRailwayCount,
  ownsBothUtilities,
  CHANCE_CARDS,
  COMMUNITY_CHEST_CARDS,
  type BusinessGame as BusinessGameDoc,
  type BusinessPlayer,
  type PropertySquare,
  type RailwaySquare,
  type UtilitySquare,
  type CardEffect,
} from '../../lib/business';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import { BUSINESS_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { useGameTurnPresence, notifyGameTurnClient } from '../../lib/gameTurnPresence';
import DiceFace from '../../components/DiceFace';

// Board geometry: 32-cell outer ring of a 9x9 grid (corners at indices 0/8/16/24) — verified with
// a standalone script (adjacency + corner-position checks) before being written here, same
// discipline used for Ludo's PATH52. index0 = GO at the bottom-right corner, moving counter-
// clockwise (left along the bottom, up the left side, right along the top, down the right side).
const SQUARE_COORDS: [number, number][] = (() => {
  const path: [number, number][] = [];
  for (let col = 8; col >= 0; col--) path.push([8, col]);
  for (let row = 7; row >= 0; row--) path.push([row, 0]);
  for (let col = 1; col <= 8; col++) path.push([0, col]);
  for (let row = 1; row <= 7; row++) path.push([row, 8]);
  return path;
})();

function formatMoney(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}


// A hand-drawn pawn silhouette (base disc, tapered body, neck, round head) rather than a photo
// asset — no image-processing tools available to extract/recolor the reference photo, so this is
// a from-scratch SVG approximation of the same classic-pawn shape, in whatever color is passed.
const PawnToken: React.FC<{ color: string; size?: number }> = ({ color, size = 16 }) => {
  const gradId = `pawnGrad-${color.replace('#', '')}`;
  const shadeId = `pawnShade-${color.replace('#', '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 140" className="shrink-0 drop-shadow-lg" style={{ overflow: 'visible' }}>
      <defs>
        {/* Off-center highlight + a darker rim toward the bottom-right — reads as a lit sphere
            rather than a flat tint, without needing a separate white backing shape behind it. */}
        <radialGradient id={gradId} cx="32%" cy="24%" r="90%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="22%" stopColor={color} stopOpacity="1" />
          <stop offset="78%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.4" />
        </radialGradient>
        <linearGradient id={shadeId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="50" cy="129" rx="30" ry="8" fill="#000000" opacity="0.25" />
      <ellipse cx="50" cy="121" rx="29" ry="11" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <path d="M 33 116 C 30 94, 37 68, 42 54 L 58 54 C 63 68, 70 94, 67 116 Z" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <ellipse cx="50" cy="54" rx="15" ry="6" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <circle cx="50" cy="29" r="23" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      {/* Glossy specular highlight on the head, and a soft sheen down the body. */}
      <ellipse cx="42" cy="20" rx="8" ry="6" fill="#ffffff" opacity="0.75" />
      <path d="M 36 60 C 34 80, 38 100, 42 114 L 47 114 C 44 98, 41 78, 42 58 Z" fill={`url(#${shadeId})`} />
    </svg>
  );
};

// DiceFace itself now lives in src/components/DiceFace.tsx (shared with Ludo, the isometric-cube
// design) — the roll trigger here is the separate "Roll" button below, matching Ludo's pattern
// (tinted to whoever's turn it is), not a click on the dice themselves.

const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-0">
    <span className="text-xs text-text-muted">{label}</span>
    <span className="text-sm font-bold text-on-surface">{value}</span>
  </div>
);

// One icon per non-property square type — utilities are split by name since both share the same
// square type. No icon for 'property' (its own color fill + name already carries the meaning).
function squareIcon(square: (typeof BOARD)[number]): string | null {
  switch (square.type) {
    case 'go':
      return 'flag';
    case 'jail':
      return 'lock';
    case 'free_parking':
      return 'local_parking';
    case 'go_to_jail':
      return 'gavel';
    case 'tax':
      return 'receipt_long';
    case 'chance':
      return 'help';
    case 'community':
      return 'inventory_2';
    case 'railway':
      return 'train';
    case 'utility':
      return square.name.startsWith('Elec') ? 'bolt' : 'water_drop';
    default:
      return null;
  }
}

const PLAYER_COLORS = ['#DC2626', '#2563EB', '#16A34A', '#F59E0B', '#7C3AED', '#DB2777'];

export default function BusinessGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap, loading] = useDocument(gameId ? doc(db, 'businessGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as BusinessGameDoc) : null;
  const voice = useGameVoice('businessGames', gameId, game?.players || []);

  // "It's your turn" presence — Business is client-authoritative, so (unlike the server-mediated
  // games) the actual notify call has to happen client-side too, right after whichever updateDoc
  // hands the turn to the next player — see handleEndTurn and handleDeclareBankruptcy below.
  useGameTurnPresence('business', gameId);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'business', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('businessGames', gameId);
  // A tapped "new chat message" push/in-app banner deep-links here as `?chat=1` (see
  // /api/chat/send's bannerTo + InviteBanner.tsx) — auto-opens the chat panel instead of just
  // landing on the game screen, same pattern as Dashboard.tsx's `?dm=` for direct messages.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showChat, setShowChat] = useState(false);
  // Reacts to searchParams itself, not a mount-only effect — if this screen's already mounted
  // (this same game already open) when the notification is tapped, React Router reuses the
  // instance instead of remounting it, so a mount-only effect would never see the new `chat=1`.
  useEffect(() => {
    if (searchParams.get('chat') === '1') {
      setShowChat(true);
      const next = new URLSearchParams(searchParams);
      next.delete('chat');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Local-only turn-flow state — none of this is hidden information, it just doesn't need to be
  // in Firestore until the underlying action actually commits (buying, paying, building, etc. are
  // all real writes the instant they happen; this only tracks "what prompt is currently showing").
  const [rolling, setRolling] = useState(false);
  const [debt, setDebt] = useState<{ amount: number; toUid: string | 'bank'; reason: string } | null>(null);
  const [showBuild, setShowBuild] = useState(false);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [bidAmount, setBidAmount] = useState('');
  const [showTrade, setShowTrade] = useState(false);
  const [tradeTarget, setTradeTarget] = useState<string | null>(null);
  const [tradeOfferProps, setTradeOfferProps] = useState<number[]>([]);
  const [tradeOfferCash, setTradeOfferCash] = useState('');
  const [tradeRequestProps, setTradeRequestProps] = useState<number[]>([]);
  const [tradeRequestCash, setTradeRequestCash] = useState('');

  const playerColor = (uid: string, players: BusinessPlayer[]) => PLAYER_COLORS[players.findIndex((p) => p.uid === uid) % PLAYER_COLORS.length] || '#6B7280';

  // Tokens hop one tile at a time instead of jumping straight to the new position — purely a
  // client-side visual layer on top of the authoritative Firestore position (which still updates
  // instantly; the game logic doesn't wait on this). A single die roll (2-12) always walks
  // tile-by-tile; anything bigger (Jail teleports, "advance to nearest X" cards) snaps instead,
  // since animating a long walk for what's meant to be an instant teleport would read as wrong.
  const [displayPositions, setDisplayPositions] = useState<Record<string, number>>({});
  const lastPositionsRef = useRef<Record<string, number>>({});
  const animatingRef = useRef<Set<string>>(new Set());
  const positionsKey = game?.players?.map((p) => `${p.uid}:${p.position}`).join(',') ?? '';
  useEffect(() => {
    if (!game) return;
    game.players.forEach((p) => {
      const last = lastPositionsRef.current[p.uid];
      if (last === undefined) {
        lastPositionsRef.current[p.uid] = p.position;
        setDisplayPositions((d) => ({ ...d, [p.uid]: p.position }));
        return;
      }
      if (last === p.position || animatingRef.current.has(p.uid)) return;
      const forward = (p.position - last + BOARD_SIZE) % BOARD_SIZE;
      lastPositionsRef.current[p.uid] = p.position;
      if (forward === 0 || forward > 12) {
        setDisplayPositions((d) => ({ ...d, [p.uid]: p.position }));
        return;
      }
      animatingRef.current.add(p.uid);
      let step = last;
      const tick = () => {
        step = (step + 1) % BOARD_SIZE;
        setDisplayPositions((d) => ({ ...d, [p.uid]: step }));
        if (step !== p.position) {
          setTimeout(tick, 220);
        } else {
          animatingRef.current.delete(p.uid);
        }
      };
      setTimeout(tick, 220);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsKey]);

  if (loading) return <div className="p-8 text-center text-text-muted">Loading…</div>;
  if (!game || !user) return <div className="p-8 text-center text-text-muted">Game not found.</div>;

  const myIndex = game.players.findIndex((p) => p.uid === user.uid);
  const me = myIndex >= 0 ? game.players[myIndex] : null;
  const isPlayer = !!me;
  const isMyTurn = game.status === 'active' && game.players[game.currentTurnSeatIndex]?.uid === user.uid && !me?.bankrupt;

  const gameRef = () => doc(db, 'businessGames', gameId!);

  const handleJoinGame = async () => {
    if (!user || isPlayer || game.players.length >= 6) return;
    setError(null);
    try {
      const newPlayer: BusinessPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: game.players.length,
        cash: STARTING_CASH,
        position: 0,
        inJail: false,
        jailTurns: 0,
        getOutOfJailCards: 0,
        bankrupt: false,
        doublesStreak: 0,
      };
      await updateDoc(gameRef(), {
        players: [...game.players, newPlayer],
        playerUids: [...game.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join Business game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  // Mirrors Ludo's End Game — any active player can force the match to finish early for
  // everyone (no winner declared), a direct client write since Business's Firestore rules
  // already let any player already in the game update it at any time.
  const handleEndGame = async () => {
    if (!isPlayer) return;
    if (!window.confirm("End this game now for everyone? This can't be undone.")) return;
    await updateDoc(gameRef(), {
      status: 'finished',
      winnerUid: null,
      endedBy: user?.uid || null,
      endedByName: me?.displayName || null,
      finishedAt: new Date().toISOString(),
    });
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/business/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('business invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleCopyCode = () => navigator.clipboard?.writeText(game.code).catch(() => {});

  const handleStart = async () => {
    if (!user || game.hostUid !== user.uid || game.players.length < 2) return;
    setBusy(true);
    try {
      await updateDoc(gameRef(), {
        status: 'active',
        startedAt: new Date().toISOString(),
        currentTurnSeatIndex: 0,
        turnPhase: 'roll',
      });
    } finally {
      setBusy(false);
    }
  };

  // ---- Core turn engine (client-trusted, mirrors Ludo's applyMove-then-write pattern) ----

  const players = game.players;
  const properties = game.properties;

  const applyPlayerPatch = (uid: string, patch: Partial<BusinessPlayer>, basePlayers = players) =>
    basePlayers.map((p) => (p.uid === uid ? { ...p, ...patch } : p));

  // Transfers cash between a player and either another player or the bank; if the payer can't
  // cover it, opens the local "raise cash" flow instead of silently failing. Always takes the
  // CALLER's own copy of `players` (basePlayers) rather than defaulting to the component's stale
  // `players` closure — resolveLanding calls this right after already moving the mover to their
  // new position in a still-in-flight write, and building the final update off the OLD `players`
  // array would silently revert that position change back to where they started.
  const tryPay = (payerUid: string, amount: number, toUid: string | 'bank', reason: string, basePlayers: BusinessPlayer[], after: (newPlayers: BusinessPlayer[]) => Promise<void> | void) => {
    const payer = basePlayers.find((p) => p.uid === payerUid)!;
    if (payer.cash < amount) {
      setDebt({ amount, toUid, reason });
      return;
    }
    let next = applyPlayerPatch(payerUid, { cash: payer.cash - amount }, basePlayers);
    if (toUid !== 'bank') {
      const recipient = next.find((p) => p.uid === toUid)!;
      next = applyPlayerPatch(toUid, { cash: recipient.cash + amount }, next);
    }
    void after(next);
  };

  const resolveLanding = async (position: number, seatIndex: number, diceSum: number, currentPlayers: BusinessPlayer[]) => {
    const square = squareAt(position);
    const mover = currentPlayers[seatIndex];

    if (square.type === 'go_to_jail') {
      const jailed = applyPlayerPatch(mover.uid, { position: JAIL_INDEX, inJail: true, jailTurns: 0, doublesStreak: 0 }, currentPlayers);
      await updateDoc(gameRef(), { players: jailed, turnPhase: 'action', lastAction: { text: `${mover.displayName} was sent to Jail.`, at: new Date().toISOString() } });
      return;
    }

    if (square.type === 'free_parking') {
      if (game.houseRules.freeParkingJackpot && game.freeParkingPot > 0) {
        const paid = applyPlayerPatch(mover.uid, { cash: mover.cash + game.freeParkingPot }, currentPlayers);
        await updateDoc(gameRef(), { players: paid, freeParkingPot: 0, turnPhase: 'action', lastAction: { text: `${mover.displayName} collected the ${formatMoney(game.freeParkingPot)} Free Parking pot!`, at: new Date().toISOString() } });
      } else {
        await updateDoc(gameRef(), { players: currentPlayers, turnPhase: 'action' });
      }
      return;
    }

    if (square.type === 'tax') {
      const toFreeParking = game.houseRules.freeParkingJackpot;
      tryPay(mover.uid, INCOME_TAX, 'bank', 'Income Tax', currentPlayers, async (next) => {
        await updateDoc(gameRef(), {
          players: next,
          turnPhase: 'action',
          ...(toFreeParking ? { freeParkingPot: game.freeParkingPot + INCOME_TAX } : {}),
          lastAction: { text: `${mover.displayName} paid ${formatMoney(INCOME_TAX)} Income Tax.`, at: new Date().toISOString() },
        });
      });
      return;
    }

    if (square.type === 'chance' || square.type === 'community') {
      const isChance = square.type === 'chance';
      const deck = isChance ? game.chanceDeck : game.communityDeck;
      const [cardIndex, ...rest] = deck.length > 0 ? deck : Array.from({ length: (isChance ? CHANCE_CARDS : COMMUNITY_CHEST_CARDS).length }, (_, i) => i);
      await updateDoc(gameRef(), {
        players: currentPlayers,
        [isChance ? 'chanceDeck' : 'communityDeck']: rest,
        pendingCard: { deck: isChance ? 'chance' : 'community', cardIndex },
        turnPhase: 'action',
      });
      // The card's effect is applied when the player dismisses the reveal (handleAcknowledgeCard),
      // so a bank-loses-money card can't be silently skipped by navigating away mid-reveal.
      return;
    }

    if (isOwnable(square)) {
      const state = properties[square.index];
      if (!state.ownerUid) {
        await updateDoc(gameRef(), { players: currentPlayers, turnPhase: 'action', lastAction: { text: `${mover.displayName} landed on ${square.name} (unowned).`, at: new Date().toISOString() } });
        return;
      }
      if (state.ownerUid === mover.uid || state.mortgaged) {
        await updateDoc(gameRef(), { players: currentPlayers, turnPhase: 'action' });
        return;
      }
      let rent = 0;
      if (square.type === 'property') {
        rent = propertyRent(square, state.houses, state.hotel, ownsFullGroup(square.group, state.ownerUid, properties), game.houseRules.doubleRentFullSet);
      } else if (square.type === 'railway') {
        rent = railwayRent(ownedRailwayCount(state.ownerUid, properties));
      } else {
        rent = utilityRent(diceSum, ownsBothUtilities(state.ownerUid, properties));
      }
      const ownerName = currentPlayers.find((p) => p.uid === state.ownerUid)?.displayName || 'the owner';
      tryPay(mover.uid, rent, state.ownerUid, `Rent for ${square.name}`, currentPlayers, async (next) => {
        await updateDoc(gameRef(), { players: next, turnPhase: 'action', lastAction: { text: `${mover.displayName} paid ${formatMoney(rent)} rent to ${ownerName} for ${square.name}.`, at: new Date().toISOString() } });
      });
      return;
    }

    // GO / Jail (just visiting) — nothing further to resolve.
    await updateDoc(gameRef(), { players: currentPlayers, turnPhase: 'action' });
  };

  const handleRoll = async () => {
    if (!isMyTurn || rolling || busy || game.turnPhase !== 'roll') return;
    setRolling(true);
    setError(null);
    try {
      const d1 = 1 + Math.floor(Math.random() * 6);
      const d2 = 1 + Math.floor(Math.random() * 6);
      const isDoubles = d1 === d2;
      await new Promise((r) => setTimeout(r, 350));

      let working = players;
      const seatIndex = game.currentTurnSeatIndex;
      const mover = working[seatIndex];
      const nextStreak = isDoubles ? mover.doublesStreak + 1 : 0;

      if (game.houseRules.doublesExtraTurn && nextStreak >= 3) {
        working = applyPlayerPatch(mover.uid, { position: JAIL_INDEX, inJail: true, jailTurns: 0, doublesStreak: 0 }, working);
        await updateDoc(gameRef(), { players: working, lastRoll: [d1, d2], turnPhase: 'action', lastAction: { text: `${mover.displayName} rolled doubles 3 times in a row — straight to Jail!`, at: new Date().toISOString() } });
        return;
      }

      const { newPosition, passedGo } = movePlayer(mover.position, d1 + d2);
      let cash = mover.cash;
      if (passedGo) {
        const exact = newPosition === 0;
        cash += exact && game.houseRules.doubleSalaryOnExactGo ? SALARY * 2 : SALARY;
      }
      working = applyPlayerPatch(mover.uid, { position: newPosition, cash, doublesStreak: nextStreak }, working);
      await updateDoc(gameRef(), { players: working, lastRoll: [d1, d2] });
      await resolveLanding(newPosition, seatIndex, d1 + d2, working);
    } finally {
      setRolling(false);
    }
  };

  // Jail: three ways out, per the rules — pay bail, use a card, or roll for doubles (3 failed
  // attempts forces the bail payment and ends the turn without moving).
  const handleJailAction = async (mode: 'pay' | 'card' | 'roll') => {
    if (!isMyTurn || rolling || game.turnPhase !== 'roll' || !me?.inJail) return;
    setRolling(true);
    setError(null);
    try {
      const seatIndex = game.currentTurnSeatIndex;
      const mover = players[seatIndex];

      if (mode === 'pay') {
        if (mover.cash < JAIL_BAIL) { setDebt({ amount: JAIL_BAIL, toUid: 'bank', reason: 'Jail bail' }); return; }
        const freed = applyPlayerPatch(mover.uid, { cash: mover.cash - JAIL_BAIL, inJail: false, jailTurns: 0 });
        await updateDoc(gameRef(), { players: freed });
        return;
      }
      if (mode === 'card') {
        if (mover.getOutOfJailCards <= 0) return;
        const freed = applyPlayerPatch(mover.uid, { getOutOfJailCards: mover.getOutOfJailCards - 1, inJail: false, jailTurns: 0 });
        await updateDoc(gameRef(), { players: freed });
        return;
      }
      // mode === 'roll'
      const d1 = 1 + Math.floor(Math.random() * 6);
      const d2 = 1 + Math.floor(Math.random() * 6);
      await new Promise((r) => setTimeout(r, 350));
      if (d1 === d2) {
        const { newPosition, passedGo } = movePlayer(mover.position, d1 + d2);
        let cash = mover.cash + (passedGo ? SALARY : 0);
        const freed = applyPlayerPatch(mover.uid, { position: newPosition, cash, inJail: false, jailTurns: 0, doublesStreak: 0 });
        await updateDoc(gameRef(), { players: freed, lastRoll: [d1, d2] });
        await resolveLanding(newPosition, seatIndex, d1 + d2, freed);
      } else {
        const turns = mover.jailTurns + 1;
        if (turns >= MAX_JAIL_TURNS) {
          if (mover.cash < JAIL_BAIL) { setDebt({ amount: JAIL_BAIL, toUid: 'bank', reason: 'Jail bail (3 failed attempts)' }); return; }
          const freed = applyPlayerPatch(mover.uid, { cash: mover.cash - JAIL_BAIL, inJail: false, jailTurns: 0 });
          await updateDoc(gameRef(), { players: freed, lastRoll: [d1, d2], turnPhase: 'action', lastAction: { text: `${mover.displayName} paid bail after 3 failed attempts.`, at: new Date().toISOString() } });
        } else {
          const stayed = applyPlayerPatch(mover.uid, { jailTurns: turns });
          await updateDoc(gameRef(), { players: stayed, lastRoll: [d1, d2], turnPhase: 'action', lastAction: { text: `${mover.displayName} failed to roll doubles (attempt ${turns}/${MAX_JAIL_TURNS}).`, at: new Date().toISOString() } });
        }
      }
    } finally {
      setRolling(false);
    }
  };

  const handleAcknowledgeCard = async () => {
    if (!game.pendingCard || !me || !isMyTurn) return;
    const isChance = game.pendingCard.deck === 'chance';
    const card = (isChance ? CHANCE_CARDS : COMMUNITY_CHEST_CARDS)[game.pendingCard.cardIndex];
    const effect: CardEffect = card.effect;
    const seatIndex = game.currentTurnSeatIndex;
    const mover = players[seatIndex];

    const finish = async (next: BusinessPlayer[], extraPatch: Record<string, unknown> = {}) => {
      await updateDoc(gameRef(), { players: next, pendingCard: null, ...extraPatch });
    };

    switch (effect.kind) {
      case 'receive': {
        await finish(applyPlayerPatch(mover.uid, { cash: mover.cash + effect.amount }));
        return;
      }
      case 'pay': {
        tryPay(mover.uid, effect.amount, 'bank', card.text, players, (next) => finish(next));
        return;
      }
      case 'payEachPlayer': {
        const total = effect.amount * (players.length - 1);
        if (mover.cash < total) { setDebt({ amount: total, toUid: 'bank', reason: card.text }); return; }
        let next = applyPlayerPatch(mover.uid, { cash: mover.cash - total });
        for (const p of players) {
          if (p.uid === mover.uid) continue;
          next = applyPlayerPatch(p.uid, { cash: p.cash + effect.amount }, next);
        }
        await finish(next);
        return;
      }
      case 'collectFromEachPlayer': {
        let next = players;
        let total = 0;
        for (const p of players) {
          if (p.uid === mover.uid) continue;
          const pay = Math.min(p.cash, effect.amount);
          total += pay;
          next = applyPlayerPatch(p.uid, { cash: p.cash - pay }, next);
        }
        next = applyPlayerPatch(mover.uid, { cash: mover.cash + total }, next);
        await finish(next);
        return;
      }
      case 'getOutOfJailCard': {
        await finish(applyPlayerPatch(mover.uid, { getOutOfJailCards: mover.getOutOfJailCards + 1 }));
        return;
      }
      case 'goToJail': {
        await finish(applyPlayerPatch(mover.uid, { position: JAIL_INDEX, inJail: true, jailTurns: 0 }));
        return;
      }
      case 'repairs': {
        let houses = 0, hotels = 0;
        properties.forEach((s) => { if (s.ownerUid === mover.uid) { if (s.hotel) hotels += 1; else houses += s.houses; } });
        const amount = houses * effect.perHouse + hotels * effect.perHotel;
        if (amount === 0) { await finish(players); return; }
        tryPay(mover.uid, amount, 'bank', card.text, players, (next) => finish(next));
        return;
      }
      case 'moveTo': {
        const { newPosition, passedGo } = movePlayer(mover.position, effect.position - mover.position >= 0 ? effect.position - mover.position : BOARD_SIZE + effect.position - mover.position);
        const cash = mover.cash + (passedGo ? SALARY : 0);
        const moved = applyPlayerPatch(mover.uid, { position: effect.position, cash });
        await updateDoc(gameRef(), { players: moved, pendingCard: null });
        await resolveLanding(effect.position, seatIndex, 0, moved);
        return;
      }
      case 'moveRelative': {
        const { newPosition, passedGo } = movePlayer(mover.position, effect.steps);
        const cash = mover.cash + (passedGo ? SALARY : 0);
        const moved = applyPlayerPatch(mover.uid, { position: newPosition, cash });
        await updateDoc(gameRef(), { players: moved, pendingCard: null });
        await resolveLanding(newPosition, seatIndex, 0, moved);
        return;
      }
      case 'moveToNearestRailway':
      case 'moveToNearestUtility': {
        const target = nearestSquareOfType(mover.position, effect.kind === 'moveToNearestRailway' ? 'railway' : 'utility');
        const passedGo = target <= mover.position;
        const cash = mover.cash + (passedGo ? SALARY : 0);
        const moved = applyPlayerPatch(mover.uid, { position: target, cash });
        await updateDoc(gameRef(), { players: moved, pendingCard: null });
        await resolveLanding(target, seatIndex, 0, moved);
        return;
      }
    }
  };

  const handleBuyProperty = async () => {
    if (!me || !isMyTurn) return;
    const square = squareAt(me.position);
    if (!isOwnable(square)) return;
    if (me.cash < square.price) { setError("You don't have enough cash to buy this."); return; }
    setBusy(true);
    try {
      const newPlayers = applyPlayerPatch(me.uid, { cash: me.cash - square.price });
      const newProperties = properties.map((s, i) => (i === square.index ? { ...s, ownerUid: me.uid } : s));
      await updateDoc(gameRef(), { players: newPlayers, properties: newProperties, lastAction: { text: `${me.displayName} bought ${square.name} for ${formatMoney(square.price)}.`, at: new Date().toISOString() } });
    } finally {
      setBusy(false);
    }
  };

  // --- Auction — declining to buy outright opens this to every player, not just the mover ---
  const handleStartAuction = async () => {
    if (!me || !isMyTurn) return;
    const square = squareAt(me.position);
    if (!isOwnable(square) || properties[square.index].ownerUid) return;
    setBusy(true);
    try {
      await updateDoc(gameRef(), {
        auction: { propertyIndex: square.index, currentBid: 0, currentBidderUid: null, passedUids: [] },
        lastAction: { text: `${me.displayName} put ${square.name} up for auction.`, at: new Date().toISOString() },
      });
    } finally {
      setBusy(false);
    }
  };

  const resolveAuctionIfDone = async (auction: NonNullable<BusinessGameDoc['auction']>, passedUids: string[]) => {
    const remaining = players.filter((p) => !p.bankrupt && !passedUids.includes(p.uid));
    if (remaining.length > 1) {
      await updateDoc(gameRef(), { auction: { ...auction, passedUids } });
      return;
    }
    const winner = remaining.length === 1 && auction.currentBidderUid === remaining[0].uid ? remaining[0] : null;
    if (winner && auction.currentBid > 0) {
      const newProperties = properties.map((s, i) => (i === auction.propertyIndex ? { ...s, ownerUid: winner.uid } : s));
      const newPlayers = applyPlayerPatch(winner.uid, { cash: winner.cash - auction.currentBid });
      await updateDoc(gameRef(), {
        properties: newProperties,
        players: newPlayers,
        auction: null,
        lastAction: { text: `${winner.displayName} won the auction for ${BOARD[auction.propertyIndex].name} at ${formatMoney(auction.currentBid)}.`, at: new Date().toISOString() },
      });
    } else {
      await updateDoc(gameRef(), {
        auction: null,
        lastAction: { text: `No bids on ${BOARD[auction.propertyIndex].name} — it stays unowned.`, at: new Date().toISOString() },
      });
    }
  };

  const handleBid = async () => {
    if (!me || !game.auction) return;
    const amount = Math.round(Number(bidAmount));
    if (!Number.isFinite(amount) || amount <= game.auction.currentBid || amount > me.cash) return;
    setBusy(true);
    try {
      await updateDoc(gameRef(), {
        auction: { ...game.auction, currentBid: amount, currentBidderUid: me.uid, passedUids: game.auction.passedUids.filter((u) => u !== me.uid) },
      });
      setBidAmount('');
    } finally {
      setBusy(false);
    }
  };

  const handlePassAuction = async () => {
    if (!me || !game.auction) return;
    setBusy(true);
    try {
      await resolveAuctionIfDone(game.auction, [...game.auction.passedUids, me.uid]);
    } finally {
      setBusy(false);
    }
  };

  // --- Trading — either side proposes to any other player at any time, not gated to your turn ---
  const handleProposeTrade = async () => {
    if (!me || !tradeTarget) return;
    const offerCash = Math.round(Number(tradeOfferCash)) || 0;
    const requestCash = Math.round(Number(tradeRequestCash)) || 0;
    if (offerCash > me.cash) { setError("You don't have that much cash to offer."); return; }
    if (tradeOfferProps.length === 0 && tradeRequestProps.length === 0 && offerCash === 0 && requestCash === 0) {
      setError('Add at least one property or cash amount to the trade.');
      return;
    }
    setBusy(true);
    try {
      const trade = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromUid: me.uid,
        toUid: tradeTarget,
        offerProperties: tradeOfferProps,
        offerCash,
        requestProperties: tradeRequestProps,
        requestCash,
      };
      await updateDoc(gameRef(), { pendingTrade: trade });
      setShowTrade(false);
      setTradeTarget(null);
      setTradeOfferProps([]);
      setTradeOfferCash('');
      setTradeRequestProps([]);
      setTradeRequestCash('');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelTrade = async () => {
    setBusy(true);
    await updateDoc(gameRef(), { pendingTrade: null }).catch(() => {});
    setBusy(false);
  };

  const handleRespondTrade = async (accept: boolean) => {
    if (!game.pendingTrade) return;
    const trade = game.pendingTrade;
    if (!accept) {
      await updateDoc(gameRef(), { pendingTrade: null }).catch(() => {});
      return;
    }
    const fromPlayer = players.find((p) => p.uid === trade.fromUid);
    const toPlayer = players.find((p) => p.uid === trade.toUid);
    if (!fromPlayer || !toPlayer || fromPlayer.cash < trade.offerCash || toPlayer.cash < trade.requestCash) {
      setError('One side no longer has enough cash for this trade.');
      await updateDoc(gameRef(), { pendingTrade: null }).catch(() => {});
      return;
    }
    setBusy(true);
    try {
      let newPlayers = applyPlayerPatch(trade.fromUid, { cash: fromPlayer.cash - trade.offerCash + trade.requestCash });
      newPlayers = applyPlayerPatch(trade.toUid, { cash: toPlayer.cash - trade.requestCash + trade.offerCash }, newPlayers);
      const newProperties = properties.map((s, i) => {
        if (trade.offerProperties.includes(i)) return { ...s, ownerUid: trade.toUid };
        if (trade.requestProperties.includes(i)) return { ...s, ownerUid: trade.fromUid };
        return s;
      });
      await updateDoc(gameRef(), {
        players: newPlayers,
        properties: newProperties,
        pendingTrade: null,
        lastAction: { text: `${fromPlayer.displayName} and ${toPlayer.displayName} completed a trade.`, at: new Date().toISOString() },
      });
    } finally {
      setBusy(false);
    }
  };

  const handleEndTurn = async () => {
    if (!isMyTurn || game.turnPhase !== 'action' || debt || game.auction || game.pendingTrade) return;
    setBusy(true);
    try {
      const seatIndex = game.currentTurnSeatIndex;
      const mover = players[seatIndex];
      // Extra turn on doubles (unless it sent them to jail, which already reset doublesStreak to 0
      // and left them mid-jail — landing on go_to_jail via a card also resets the streak, so this
      // check is simply "did they roll doubles and are they still free").
      if (game.houseRules.doublesExtraTurn && mover.doublesStreak > 0 && !mover.inJail) {
        await updateDoc(gameRef(), { turnPhase: 'roll' });
        return;
      }
      let nextSeat = (seatIndex + 1) % players.length;
      let loops = 0;
      while (players[nextSeat]?.bankrupt && loops < players.length) {
        nextSeat = (nextSeat + 1) % players.length;
        loops += 1;
      }
      const stillIn = players.filter((p) => !p.bankrupt);
      if (stillIn.length <= 1) {
        await updateDoc(gameRef(), { status: 'finished', winnerUid: stillIn[0]?.uid || null, finishedAt: new Date().toISOString() });
        return;
      }
      await updateDoc(gameRef(), { currentTurnSeatIndex: nextSeat, turnPhase: 'roll', players: applyPlayerPatch(mover.uid, { doublesStreak: 0 }) });
      const nextPlayer = players[nextSeat];
      if (nextPlayer) {
        notifyGameTurnClient(user, {
          gameType: 'business',
          gameId: gameId!,
          nextPlayerUid: nextPlayer.uid,
          opponentNames: players.filter((p) => p.uid !== nextPlayer.uid).map((p) => p.displayName).filter(Boolean).join(', ') || null,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  // --- Building ---
  const handleBuild = async (square: PropertySquare) => {
    if (!me || !isMyTurn) return;
    const { canBuild, isHotel } = canBuildOnProperty(square, properties);
    if (!canBuild || !canBuildOnGroup(square.group, me.uid, properties)) return;
    if (me.cash < square.houseCost) { setError("You don't have enough cash to build here."); return; }
    setBusy(true);
    try {
      const state = properties[square.index];
      const newProperties = properties.map((s, i) =>
        i === square.index ? { ...s, houses: isHotel ? 0 : state.houses + 1, hotel: isHotel } : s,
      );
      const newPlayers = applyPlayerPatch(me.uid, { cash: me.cash - square.houseCost });
      await updateDoc(gameRef(), { players: newPlayers, properties: newProperties, lastAction: { text: `${me.displayName} built ${isHotel ? 'a hotel' : 'a house'} on ${square.name}.`, at: new Date().toISOString() } });
    } finally {
      setBusy(false);
    }
  };

  const handleSellHouse = async (square: PropertySquare) => {
    if (!me) return;
    const state = properties[square.index];
    if (state.ownerUid !== me.uid || (!state.hotel && state.houses === 0)) return;
    setBusy(true);
    try {
      const refund = Math.round(square.houseCost / 2);
      const newProperties = properties.map((s, i) =>
        i === square.index ? { ...s, hotel: false, houses: state.hotel ? 4 : state.houses - 1 } : s,
      );
      const newPlayers = applyPlayerPatch(me.uid, { cash: me.cash + refund });
      await updateDoc(gameRef(), { players: newPlayers, properties: newProperties });
    } finally {
      setBusy(false);
    }
  };

  // --- Mortgage ---
  const handleMortgage = async (index: number) => {
    if (!me) return;
    const square = BOARD[index];
    if (!isOwnable(square)) return;
    const state = properties[index];
    if (state.ownerUid !== me.uid || state.mortgaged || state.houses > 0 || state.hotel) return;
    setBusy(true);
    try {
      const newProperties = properties.map((s, i) => (i === index ? { ...s, mortgaged: true } : s));
      const newPlayers = applyPlayerPatch(me.uid, { cash: me.cash + square.mortgageValue });
      await updateDoc(gameRef(), { players: newPlayers, properties: newProperties });
    } finally {
      setBusy(false);
    }
  };

  const handleUnmortgage = async (index: number) => {
    if (!me) return;
    const square = BOARD[index];
    if (!isOwnable(square)) return;
    const state = properties[index];
    if (state.ownerUid !== me.uid || !state.mortgaged) return;
    const cost = Math.round(square.mortgageValue * (1 + UNMORTGAGE_INTEREST));
    if (me.cash < cost) { setError("You don't have enough cash to unmortgage this."); return; }
    setBusy(true);
    try {
      const newProperties = properties.map((s, i) => (i === index ? { ...s, mortgaged: false } : s));
      const newPlayers = applyPlayerPatch(me.uid, { cash: me.cash - cost });
      await updateDoc(gameRef(), { players: newPlayers, properties: newProperties });
    } finally {
      setBusy(false);
    }
  };

  // --- Raise-cash / bankruptcy flow ---
  const handleDebtSellHouse = async (index: number) => {
    const square = BOARD[index] as PropertySquare;
    await handleSellHouse(square);
  };
  const handleDebtMortgage = async (index: number) => handleMortgage(index);

  const handlePayDebt = async () => {
    if (!me || !debt || me.cash < debt.amount) return;
    setBusy(true);
    try {
      let next = applyPlayerPatch(me.uid, { cash: me.cash - debt.amount });
      if (debt.toUid !== 'bank') {
        const recipient = next.find((p) => p.uid === debt.toUid)!;
        next = applyPlayerPatch(debt.toUid, { cash: recipient.cash + debt.amount }, next);
      }
      await updateDoc(gameRef(), { players: next, turnPhase: 'action', lastAction: { text: `${me.displayName} settled up (${debt.reason}).`, at: new Date().toISOString() } });
      setDebt(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDeclareBankruptcy = async () => {
    if (!me || !debt) return;
    if (!window.confirm('Declare bankruptcy? You will be out of the game and your properties will be surrendered.')) return;
    setBusy(true);
    try {
      const toBank = debt.toUid === 'bank';
      const newProperties = properties.map((s) =>
        s.ownerUid === me.uid ? { ownerUid: toBank ? null : debt.toUid, houses: toBank ? 0 : s.houses, hotel: toBank ? false : s.hotel, mortgaged: toBank ? false : s.mortgaged } : s,
      );
      const bankruptPlayers = applyPlayerPatch(me.uid, { cash: 0, bankrupt: true });
      const stillIn = bankruptPlayers.filter((p) => !p.bankrupt);
      const patch: Record<string, unknown> = { players: bankruptPlayers, properties: newProperties, lastAction: { text: `${me.displayName} went bankrupt.`, at: new Date().toISOString() } };
      if (stillIn.length <= 1) {
        patch.status = 'finished';
        patch.winnerUid = stillIn[0]?.uid || null;
        patch.finishedAt = new Date().toISOString();
      } else if (isMyTurn) {
        let nextSeat = (game.currentTurnSeatIndex + 1) % bankruptPlayers.length;
        let loops = 0;
        while (bankruptPlayers[nextSeat]?.bankrupt && loops < bankruptPlayers.length) {
          nextSeat = (nextSeat + 1) % bankruptPlayers.length;
          loops += 1;
        }
        patch.currentTurnSeatIndex = nextSeat;
        patch.turnPhase = 'roll';
      }
      await updateDoc(gameRef(), patch);
      if (patch.currentTurnSeatIndex != null) {
        const nextPlayer = bankruptPlayers[patch.currentTurnSeatIndex as number];
        if (nextPlayer) {
          notifyGameTurnClient(user, {
            gameType: 'business',
            gameId: gameId!,
            nextPlayerUid: nextPlayer.uid,
            opponentNames: bankruptPlayers.filter((p) => p.uid !== nextPlayer.uid && !p.bankrupt).map((p) => p.displayName).filter(Boolean).join(', ') || null,
          });
        }
      }
      setDebt(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGame = async () => {
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/business/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete.');
      navigate('/games/business');
    } catch (err: any) {
      setError(err.message || 'Failed to delete game.');
    }
  };

  const handlePlayAgain = async () => {
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/business/rematch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to start rematch.');
      if (json.gameId) navigate(`/games/business/${json.gameId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start rematch.');
    }
  };

  // ---- Waiting room ----
  if (game.status === 'waiting') {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <button onClick={() => navigate('/games/business')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
          <h1 className="font-black text-primary">Business</h1>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
          {showHelp && <GameHelpModal content={BUSINESS_HELP} onClose={() => setShowHelp(false)} />}
          {showChat && user && (
            <ChatPanel
              collectionName="businessGames"
              gameId={gameId!}
              messages={chatMessages}
              loading={chatLoading}
              myUid={user.uid}
              myDisplayName={profile?.displayName || user.displayName || 'Player'}
              myPhotoURL={profile?.photoURL || user.photoURL || ''}
              otherUids={game.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
              onClose={() => setShowChat(false)}
            />
          )}
        </header>
        <main className="flex-1 p-4 max-w-xl mx-auto w-full space-y-5 pb-24">
          <div className="bg-white rounded-2xl border border-border-subtle p-5 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Share code</p>
              <p className="text-2xl font-black text-primary tracking-widest">{game.code}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={handleCopyCode} className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">content_copy</span> Copy
              </button>
              <ShareGameButton
                gameLabel="Business"
                code={game.code}
                path={`/games/business/${gameId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {game.players.map((p) => (
              <div key={p.uid} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">
                  {p.displayName?.slice(0, 1) || '?'}
                </div>
                <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                {p.uid === game.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, 2 - game.players.length) }).map((_, i) => (
              <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                <p className="text-sm text-text-muted italic">Waiting for player…</p>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-1">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">House Rules</p>
            <p className="text-xs text-text-muted">
              {[
                game.houseRules.freeParkingJackpot && 'Free Parking Jackpot',
                game.houseRules.doubleRentFullSet && 'Double Rent on Full Set',
                game.houseRules.doubleSalaryOnExactGo && 'Double Salary on Exact GO',
                game.houseRules.doublesExtraTurn && 'Bonus for Rolling Doubles',
              ].filter(Boolean).join(' · ') || 'None enabled'}
            </p>
          </div>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {!isPlayer && game.players.length < 6 && (
            <button onClick={handleJoinGame} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Join Game
            </button>
          )}

          {isPlayer && (
            <button
              onClick={() => setShowInvite((v) => !v)}
              className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">group_add</span>
              Invite Group Members
            </button>
          )}

          {showInvite && <InvitePicker groupIds={groupIds} alreadyIn={game.players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />}

          {isPlayer && user.uid === game.hostUid ? (
            <button onClick={handleStart} disabled={busy || game.players.length < 2} className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">
              {game.players.length < 2 ? 'Need at least 2 players' : busy ? 'Starting…' : 'Start Game'}
            </button>
          ) : isPlayer ? (
            <p className="text-center text-sm text-text-muted italic">Waiting for the host to start the game…</p>
          ) : null}

          {isPlayer && user.uid === game.hostUid && (
            <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">
              Delete Game
            </button>
          )}
        </main>
      </div>
    );
  }

  // ---- Finished ----
  if (game.status === 'finished') {
    const winner = game.players.find((p) => p.uid === game.winnerUid);
    const finalStandings = [...game.players].sort((a, b) => b.cash - a.cash);
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          {winner && <Fireworks />}
          <span className="relative text-4xl">{winner ? '🏆' : '🏁'}</span>
          <div className="relative flex items-center justify-center gap-2 mt-1">
            <h1 className="text-lg font-black text-primary">
              {winner ? `${winner.displayName} wins!` : `Game ended early${game.endedByName ? ` by ${game.endedByName}` : ''}.`}
            </h1>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
        </div>

        {/* Final standings — the match's actual result, not just a text banner. */}
        <main className="flex-1 overflow-y-auto p-4 space-y-2 pb-28">
          {finalStandings.map((p, idx) => (
            <div
              key={p.uid}
              className={clsx('bg-white rounded-2xl border p-3 flex items-center gap-3', p.uid === game.winnerUid ? 'border-warning' : 'border-border-subtle')}
            >
              <span className="w-6 text-center text-sm font-black text-text-muted">{idx + 1}</span>
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                {p.photoURL ? (
                  <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  p.displayName?.slice(0, 1) || '?'
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">
                  {p.uid === game.winnerUid ? '🏆 ' : ''}{p.displayName}{p.bankrupt ? ' (bankrupt)' : ''}
                </p>
              </div>
              <span className="text-sm font-black text-primary shrink-0">₹{p.cash.toLocaleString()}</span>
            </div>
          ))}
        </main>

        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-border-subtle p-3 flex items-center gap-2 z-20">
          {isPlayer && (
            <button
              onClick={() => (game.rematchGameId ? navigate(`/games/business/${game.rematchGameId}`) : handlePlayAgain())}
              className="flex-1 py-3 bg-success text-white font-bold rounded-2xl text-sm"
            >
              {game.rematchGameId ? 'Join Rematch' : 'Play Again'}
            </button>
          )}
          <button onClick={() => navigate('/games/business')} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl text-sm">
            Back to Lobby
          </button>
          {user.uid === game.hostUid && (
            <button onClick={handleDeleteGame} className="p-3 text-error/70" aria-label="Delete game">
              <span className="material-symbols-outlined text-[20px] block">delete</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Active game ----
  const currentSquare = squareAt(me?.position ?? 0);
  const canBuy = isMyTurn && game.turnPhase === 'action' && isOwnable(currentSquare) && !properties[currentSquare.index].ownerUid && !game.pendingCard && !game.auction && !game.pendingTrade;
  const myProperties = properties
    .map((s, i) => ({ state: s, square: BOARD[i] }))
    .filter((e) => e.state.ownerUid === me?.uid && isOwnable(e.square));
  const canRollNow = isMyTurn && !debt && !game.pendingCard && !me?.inJail && game.turnPhase === 'roll' && !game.auction && !game.pendingTrade;
  // Drawn from `game.pendingCard` (synced to every client via Firestore) rather than local state,
  // so the card text is visible to ALL players at the table, not just whoever drew it — only the
  // "Continue" button below is restricted to the drawer (isMyTurn), since only they can apply it.
  const pendingCardInfo = game.pendingCard
    ? { deck: game.pendingCard.deck, text: (game.pendingCard.deck === 'chance' ? CHANCE_CARDS : COMMUNITY_CHEST_CARDS)[game.pendingCard.cardIndex].text }
    : null;
  // Rolling doubles grants another roll, so the action panel shouldn't offer to "End Turn" (which
  // reads as passing to the next player) — it should say the player rolls again instead.
  const mustRollAgain = isMyTurn && game.houseRules.doublesExtraTurn && !!me && me.doublesStreak > 0 && !me.inJail;

  // Rent info shown in the center panel for whoever's turn it currently is — only the destination
  // square (their authoritative Firestore position), and only once the token's visual animation has
  // actually arrived there, not for every tile it hops through on the way.
  const turnPlayer = players[game.currentTurnSeatIndex];
  const turnPlayerArrived = !!turnPlayer && (displayPositions[turnPlayer.uid] ?? turnPlayer.position) === turnPlayer.position;
  const turnSquare = turnPlayer ? squareAt(turnPlayer.position) : null;
  const turnSquareState = turnSquare && isOwnable(turnSquare) ? properties[turnSquare.index] : null;
  let turnSquareRentLabel: string | null = null;
  if (turnSquare && turnPlayerArrived && turnSquareState?.ownerUid && !turnSquareState.mortgaged && turnSquareState.ownerUid !== turnPlayer?.uid) {
    if (turnSquare.type === 'property') {
      const rent = propertyRent(turnSquare, turnSquareState.houses, turnSquareState.hotel, ownsFullGroup(turnSquare.group, turnSquareState.ownerUid, properties), game.houseRules.doubleRentFullSet);
      turnSquareRentLabel = `${turnSquare.name} rent: ${formatMoney(rent)}`;
    } else if (turnSquare.type === 'railway') {
      turnSquareRentLabel = `${turnSquare.name} rent: ${formatMoney(railwayRent(ownedRailwayCount(turnSquareState.ownerUid, properties)))}`;
    } else if (turnSquare.type === 'utility') {
      turnSquareRentLabel = `${turnSquare.name} rent: dice × ${ownsBothUtilities(turnSquareState.ownerUid, properties) ? 10 : 4}`;
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      <header className="p-2 flex items-center gap-2 bg-white border-b border-border-subtle">
        <button onClick={() => navigate('/games/business')} className="text-text-muted">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
        </button>
        <h1 className="font-black text-primary text-xs">Business</h1>
        <ReactionButton onSend={handleSendReaction} />
        <div className="flex items-center gap-1.5 ml-auto">
          {isPlayer && game.status === 'active' && (
            <button onClick={handleEndGame} className="p-2 text-error shrink-0" aria-label="Leave game">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
          )}
          <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
          <VoiceChatButton voice={voice} />
          <HelpButton onClick={() => setShowHelp(true)} />
        </div>
      </header>
      {showHelp && <GameHelpModal content={BUSINESS_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="businessGames"
          gameId={gameId!}
          messages={chatMessages}
          loading={chatLoading}
          myUid={user.uid}
          myDisplayName={profile?.displayName || user.displayName || 'Player'}
          myPhotoURL={profile?.photoURL || user.photoURL || ''}
          otherUids={game.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
          onClose={() => setShowChat(false)}
        />
      )}

      <main className="flex-1 p-2 max-w-xl mx-auto w-full space-y-2 pb-24">
        {/* Players status strip */}
        <div className="bg-white rounded-xl border border-border-subtle p-2 flex items-center gap-1.5 overflow-x-auto">
          {players.map((p, i) => (
            <div
              key={p.uid}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border shrink-0 ${
                i === game.currentTurnSeatIndex ? 'border-primary bg-primary/5' : 'border-border-subtle'
              } ${p.bankrupt ? 'opacity-30' : ''}`}
            >
              <PawnToken color={playerColor(p.uid, players)} size={16} />
              <PresenceDot uid={p.uid} className="w-1.5 h-1.5" />
              <span className="text-[10px] font-bold text-on-surface whitespace-nowrap">{p.uid === user.uid ? 'You' : p.displayName}</span>
              <span className="text-[10px] text-text-muted whitespace-nowrap">{p.bankrupt ? 'out' : formatMoney(p.cash)}</span>
              {p.inJail && <span className="material-symbols-outlined text-[12px] text-warning">lock</span>}
            </div>
          ))}
        </div>

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        {/* Turn indicator — plain text, not a heavy colored block, so it doesn't visually compete
            with the Roll Dice button below for "which of these do I tap" attention. */}
        <div className="flex items-center gap-1.5 px-1">
          {isMyTurn && !me?.bankrupt && <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />}
          <p className="text-xs font-bold text-text-muted">
            {me?.bankrupt
              ? 'You are out of the game.'
              : isMyTurn
              ? me?.inJail
                ? 'Your turn — you are in Jail'
                : game.turnPhase === 'roll'
                ? mustRollAgain
                  ? 'Doubles! Roll again'
                  : 'Your turn to roll'
                : mustRollAgain
                ? 'Doubles! Finish up, then roll again'
                : 'Your turn — buy/build/mortgage, then End Turn'
              : `${players[game.currentTurnSeatIndex]?.displayName || '…'}'s turn`}
          </p>
        </div>

        {/* Board */}
        <div className="bg-white rounded-xl border border-border-subtle p-1.5 shadow-sm">
          <div className="grid gap-0 relative" style={{ gridTemplateColumns: 'repeat(9, 1fr)', gridTemplateRows: 'repeat(9, 1fr)', aspectRatio: '1 / 1' }}>
            {/* Center panel — tap the dice to roll (no separate button), current-square rent,
                last action, and the pot, using the space better than a mostly-empty middle. */}
            <div style={{ gridRow: '2 / 9', gridColumn: '2 / 9' }} className="relative flex flex-col items-center justify-center gap-2 bg-surface rounded-lg p-2">
              {isMyTurn && game.turnPhase === 'action' && !canBuy && !debt && !game.pendingCard && !game.auction && !game.pendingTrade && (
                <button
                  onClick={handleEndTurn}
                  disabled={busy}
                  className="absolute top-1.5 right-1.5 px-2.5 py-1 rounded-full text-[10px] font-black text-white uppercase tracking-wide animate-pulse disabled:opacity-50"
                  style={{
                    background: '#0a0a0a',
                    boxShadow: '0 0 0 2px rgba(0,0,0,0.15), 0 0 10px 3px rgba(0,0,0,0.65), 0 0 20px 6px rgba(0,0,0,0.35)',
                  }}
                >
                  {mustRollAgain ? 'Roll Again' : 'End Turn'}
                </button>
              )}
              {isMyTurn && game.turnPhase === 'action' && !canBuy && !debt && !game.pendingCard && !game.auction && !game.pendingTrade && (
                <button
                  onClick={() => setShowBuild((v) => !v)}
                  className="absolute bottom-1.5 left-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide bg-white border border-border-subtle text-primary shadow-sm"
                >
                  {showBuild ? 'Hide' : 'Manage'}
                </button>
              )}
              {!game.pendingTrade && !game.auction && !canBuy && me && !me.bankrupt && !showTrade && (
                <button
                  onClick={() => setShowTrade(true)}
                  className="absolute bottom-1.5 right-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide bg-white border border-border-subtle text-primary shadow-sm"
                >
                  Trade
                </button>
              )}

              {/* Buy/auction decision — pinned to the same bottom-right corner as the Trade
                  button above (mutually exclusive with it, never both visible at once) instead
                  of a full-width card pushed below the board. */}
              {canBuy && !debt && (
                <div className="absolute bottom-1.5 right-1.5 w-[68%] max-w-[230px] bg-white rounded-xl border border-border-subtle p-2 shadow-lg space-y-1.5 z-20">
                  <p className="text-[11px] font-bold text-on-surface leading-tight">
                    Buy {currentSquare.name} for {formatMoney((currentSquare as PropertySquare | RailwaySquare | UtilitySquare).price)}?
                  </p>
                  <div className="flex gap-1.5">
                    <button onClick={handleBuyProperty} disabled={busy} className="flex-1 py-1.5 bg-primary text-white font-bold rounded-lg text-[11px] disabled:opacity-50">
                      Buy
                    </button>
                    <button onClick={handleStartAuction} disabled={busy} className="px-2.5 py-1.5 bg-surface border border-border-subtle rounded-lg text-[11px] font-bold">
                      Auction
                    </button>
                  </div>
                </div>
              )}

              {game.auction && (() => {
                const auction = game.auction;
                const auctionSquare = BOARD[auction.propertyIndex];
                const bidder = auction.currentBidderUid ? players.find((p) => p.uid === auction.currentBidderUid) : null;
                const iPassed = !!me && auction.passedUids.includes(me.uid);
                const canAct = !!me && !me.bankrupt && !iPassed && auction.currentBidderUid !== me.uid;
                const minBid = auction.currentBid + 1;
                return (
                  <div className="absolute bottom-1.5 right-1.5 w-[75%] max-w-[260px] bg-white rounded-xl border-2 border-primary p-2 shadow-lg space-y-1.5 z-20">
                    <p className="text-[11px] font-bold text-primary leading-tight">Auction: {auctionSquare.name}</p>
                    <p className="text-[10px] text-text-muted">
                      Bid: <span className="font-bold text-on-surface">{formatMoney(auction.currentBid)}</span>
                      {bidder && <> by {bidder.displayName}</>}
                    </p>
                    {canAct ? (
                      <div className="flex gap-1">
                        <input
                          type="number"
                          value={bidAmount}
                          onChange={(e) => setBidAmount(e.target.value)}
                          placeholder={`${minBid}+`}
                          min={minBid}
                          className="w-0 flex-1 bg-surface p-1.5 rounded-lg border border-border-subtle text-[11px] outline-none"
                        />
                        <button onClick={handleBid} disabled={busy || !bidAmount} className="px-2 py-1.5 bg-primary text-white font-bold rounded-lg text-[10px] disabled:opacity-50">
                          Bid
                        </button>
                        <button onClick={handlePassAuction} disabled={busy} className="px-2 py-1.5 bg-surface border border-border-subtle rounded-lg text-[10px] font-bold">
                          Pass
                        </button>
                      </div>
                    ) : (
                      <p className="text-[10px] italic text-text-muted">{iPassed ? "You've passed." : "You're the top bidder."}</p>
                    )}
                  </div>
                );
              })()}

              {/* Card reveal — shown to EVERY player at the table (driven off `game.pendingCard`,
                  synced via Firestore), not just whoever drew it, since the whole point of a
                  Chance/Community Chest draw is that it's public. Only the drawer gets the
                  "Continue" button; everyone else just reads the outcome and waits. */}
              {pendingCardInfo && (
                <div className="w-[92%] max-w-[240px] bg-primary/10 border border-primary/30 rounded-xl p-2.5 space-y-1.5 text-center z-20">
                  <p className="text-[10px] font-bold text-primary uppercase tracking-wider">
                    {pendingCardInfo.deck === 'chance' ? 'Chance' : 'Community Chest'}
                  </p>
                  <p className="text-xs font-bold text-on-surface leading-snug">{pendingCardInfo.text}</p>
                  {isMyTurn ? (
                    <button onClick={handleAcknowledgeCard} className="w-full py-1.5 bg-primary text-white font-bold rounded-lg text-xs">
                      Continue
                    </button>
                  ) : (
                    <p className="text-[10px] italic text-text-muted">Waiting for {turnPlayer?.displayName}…</p>
                  )}
                </div>
              )}

              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-3">
                  <DiceFace value={game.lastRoll?.[0] ?? null} spinning={rolling} size={44} />
                  <DiceFace value={game.lastRoll?.[1] ?? null} spinning={rolling} size={44} />
                </div>
                {/* Matches Ludo's pattern: the dice stay neutral, this button carries whoever's
                    turn it is and is the actual roll trigger, not tapping the dice themselves. */}
                <button
                  type="button"
                  onClick={canRollNow ? handleRoll : undefined}
                  disabled={!canRollNow}
                  className={`w-24 py-1.5 rounded-lg text-[10px] font-black text-white uppercase tracking-wide transition-all shadow-sm ${canRollNow ? 'active:scale-95 cursor-pointer animate-pulse' : 'opacity-50 cursor-default'}`}
                  style={{ backgroundColor: turnPlayer ? playerColor(turnPlayer.uid, players) : '#9CA3AF' }}
                >
                  {rolling ? '…' : 'Roll'}
                </button>
              </div>

              {turnSquareRentLabel && (
                <div className="flex items-center gap-1 bg-primary/10 text-primary px-2.5 py-1 rounded-full">
                  <span className="material-symbols-outlined text-[13px]">payments</span>
                  <span className="text-[11px] font-bold">{turnSquareRentLabel}</span>
                </div>
              )}

              {game.lastAction && (
                <p className="text-sm font-bold text-on-surface text-center px-3 py-1.5 bg-white rounded-xl shadow-sm max-w-[90%] border border-border-subtle">
                  {game.lastAction.text}
                </p>
              )}

              {game.houseRules.freeParkingJackpot && (
                <div className="flex items-center gap-1 bg-warning/10 text-warning px-2.5 py-1 rounded-full">
                  <span className="material-symbols-outlined text-[14px]">local_parking</span>
                  <span className="text-[11px] font-bold">{formatMoney(game.freeParkingPot)}</span>
                </div>
              )}
            </div>

            {BOARD.map((square, idx) => {
              const [row, col] = SQUARE_COORDS[idx];
              const state = properties[idx];
              const tileBg = square.type === 'property' ? COLOR_GROUPS_LIGHT[square.group] : undefined;
              const icon = squareIcon(square);
              const isCardSquare = square.type === 'chance' || square.type === 'community';
              const ownerColor = state?.ownerUid ? playerColor(state.ownerUid, players) : undefined;
              return (
                <div
                  key={idx}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailIndex(idx)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailIndex(idx); } }}
                  style={{
                    gridRow: row + 1,
                    gridColumn: col + 1,
                    backgroundColor: tileBg,
                    ...(ownerColor ? { borderColor: ownerColor, borderWidth: 2 } : {}),
                  }}
                  className="border border-border-subtle flex flex-col items-center justify-center gap-0.5 p-0.5 relative overflow-hidden cursor-pointer"
                >
                  {icon && (
                    <span
                      className="material-symbols-outlined text-on-surface/70 leading-none"
                      style={{ fontSize: isCardSquare ? '16px' : '9px' }}
                    >
                      {icon}
                    </span>
                  )}
                  <p className={`font-bold text-center leading-tight text-on-surface line-clamp-2 ${isCardSquare ? 'text-[5px]' : 'text-[6.5px]'}`}>
                    {square.name}
                  </p>
                  {isOwnable(square) && (
                    <p className="text-[5px] text-text-muted leading-none">
                      {state?.mortgaged ? 'Mortgaged' : formatMoney(square.price)}
                    </p>
                  )}
                  {state && (state.houses > 0 || state.hotel) && (
                    <span className="absolute top-0.5 right-0.5 flex items-center gap-0.5 bg-white/90 rounded px-0.5">
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: '7px' }}>
                        {state.hotel ? 'hotel' : 'home'}
                      </span>
                      {!state.hotel && <span className="text-[5px] font-black text-primary">{state.houses}</span>}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Token overlay — absolutely positioned on top of the grid (not inside individual
                tile cells) so each token is one continuous DOM element that CSS can smoothly
                slide between tiles, instead of unmounting/remounting into a new cell every hop. */}
            {players.filter((p) => !p.bankrupt).map((p, i, arr) => {
              const pos = displayPositions[p.uid] ?? p.position;
              const [row, col] = SQUARE_COORDS[pos];
              const sharing = arr.filter((o) => (displayPositions[o.uid] ?? o.position) === pos);
              const shareIdx = sharing.findIndex((o) => o.uid === p.uid);
              const offsetX = sharing.length > 1 ? (shareIdx % 2) * 11 - 5.5 : 0;
              const offsetY = sharing.length > 1 ? Math.floor(shareIdx / 2) * 11 - 5.5 : 0;
              return (
                <div
                  key={p.uid}
                  className="absolute pointer-events-none transition-[left,top] duration-[220ms] ease-in-out"
                  style={{
                    left: `calc(${((col + 0.5) / 9) * 100}% + ${offsetX}px)`,
                    top: `calc(${((row + 0.5) / 9) * 100}% + ${offsetY}px)`,
                    transform: 'translate(-50%, -50%)',
                    zIndex: 10,
                  }}
                >
                  <PawnToken color={playerColor(p.uid, players)} size={18} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Debt / raise-cash panel — blocks everything else until resolved */}
        {debt && me && (
          <div className="bg-error/5 border border-error/40 rounded-xl p-3 space-y-2">
            <p className="text-sm font-bold text-error">
              You owe {formatMoney(debt.amount)} ({debt.reason}) but only have {formatMoney(me.cash)}.
            </p>
            <p className="text-[11px] text-text-muted">Sell houses or mortgage properties to raise the difference, then pay.</p>
            <div className="space-y-1">
              {myProperties.map(({ state, square }) => (
                <div key={square.index} className="flex items-center justify-between bg-white rounded-lg p-2 border border-border-subtle">
                  <span className="text-xs font-bold">{square.name}</span>
                  <div className="flex gap-1">
                    {square.type === 'property' && (state.houses > 0 || state.hotel) && (
                      <button onClick={() => handleDebtSellHouse(square.index)} className="text-[10px] font-bold px-2 py-1 bg-warning/10 text-warning rounded-lg">
                        Sell {state.hotel ? 'Hotel' : 'House'}
                      </button>
                    )}
                    {!state.mortgaged && state.houses === 0 && !state.hotel && (
                      <button onClick={() => handleDebtMortgage(square.index)} className="text-[10px] font-bold px-2 py-1 bg-primary/10 text-primary rounded-lg">
                        Mortgage (+{formatMoney((square as PropertySquare | RailwaySquare | UtilitySquare).mortgageValue)})
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {myProperties.length === 0 && <p className="text-[11px] text-text-muted italic">No properties left to raise cash from.</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={handlePayDebt} disabled={me.cash < debt.amount || busy} className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-40">
                Pay {formatMoney(debt.amount)}
              </button>
              <button onClick={handleDeclareBankruptcy} disabled={busy} className="px-3 py-2 bg-error text-white font-bold rounded-lg text-xs">
                Declare Bankruptcy
              </button>
            </div>
          </div>
        )}

        {/* Jail actions */}
        {isMyTurn && !debt && !game.pendingCard && me?.inJail && game.turnPhase === 'roll' && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => handleJailAction('pay')} disabled={rolling} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-50">
              Pay {formatMoney(JAIL_BAIL)} Bail
            </button>
            {me.getOutOfJailCards > 0 && (
              <button onClick={() => handleJailAction('card')} disabled={rolling} className="px-3 py-1.5 bg-white border border-border-subtle rounded-lg text-xs font-bold disabled:opacity-50">
                Use Get Out of Jail Card ({me.getOutOfJailCards})
              </button>
            )}
            <button onClick={() => handleJailAction('roll')} disabled={rolling} className="px-3 py-1.5 bg-white border border-border-subtle rounded-lg text-xs font-bold disabled:opacity-50">
              {rolling ? 'Rolling…' : `Roll for Doubles (${me.jailTurns}/${MAX_JAIL_TURNS})`}
            </button>
          </div>
        )}

        {/* Rolling now happens by tapping the dice in the center panel above — no separate
            button, and the buy/auction decision is now pinned to that same panel's
            bottom-right corner rather than a card down here. */}

        {/* Pending trade — proposer sees Cancel, the other side sees Accept/Reject, everyone else sees a status line */}
        {game.pendingTrade && (() => {
          const trade = game.pendingTrade;
          const fromP = players.find((p) => p.uid === trade.fromUid);
          const toP = players.find((p) => p.uid === trade.toUid);
          const describe = (props: number[], cash: number) => {
            const parts = props.map((i) => BOARD[i].name);
            if (cash > 0) parts.push(formatMoney(cash));
            return parts.length ? parts.join(', ') : 'nothing';
          };
          return (
            <div className="bg-white rounded-xl border-2 border-primary p-3 space-y-2">
              <p className="text-sm font-bold text-primary">Trade Offer</p>
              <p className="text-xs text-on-surface">
                <span className="font-bold">{fromP?.displayName}</span> offers {describe(trade.offerProperties, trade.offerCash)}
                {' '}for <span className="font-bold">{toP?.displayName}</span>'s {describe(trade.requestProperties, trade.requestCash)}
              </p>
              {me?.uid === trade.toUid && (
                <div className="flex gap-2">
                  <button onClick={() => handleRespondTrade(true)} disabled={busy} className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-50">
                    Accept
                  </button>
                  <button onClick={() => handleRespondTrade(false)} disabled={busy} className="flex-1 py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold">
                    Reject
                  </button>
                </div>
              )}
              {me?.uid === trade.fromUid && (
                <button onClick={handleCancelTrade} disabled={busy} className="w-full py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold">
                  Cancel Offer
                </button>
              )}
            </div>
          );
        })()}

        {/* Trade builder */}
        {!game.pendingTrade && me && !me.bankrupt && showTrade && (() => {
          const others = players.filter((p) => p.uid !== me.uid && !p.bankrupt);
          const targetProperties = tradeTarget
            ? properties.map((s, i) => ({ state: s, square: BOARD[i] })).filter((e) => e.state.ownerUid === tradeTarget && isOwnable(e.square))
            : [];
          const toggleIn = (list: number[], idx: number) => (list.includes(idx) ? list.filter((i) => i !== idx) : [...list, idx]);
          const closeTradeBuilder = () => {
            setShowTrade(false);
            setTradeTarget(null);
            setTradeOfferProps([]);
            setTradeOfferCash('');
            setTradeRequestProps([]);
            setTradeRequestCash('');
          };
          return (
            <div className="bg-white rounded-xl border border-border-subtle p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-on-surface">Propose a Trade</p>
                <button onClick={closeTradeBuilder} className="text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {others.map((p) => (
                  <button
                    key={p.uid}
                    onClick={() => { setTradeTarget(p.uid); setTradeOfferProps([]); setTradeRequestProps([]); }}
                    className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${tradeTarget === p.uid ? 'bg-primary text-white border-primary' : 'bg-white border-border-subtle'}`}
                  >
                    {p.displayName}
                  </button>
                ))}
              </div>
              {tradeTarget && (
                <>
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">You Give</p>
                    <div className="flex flex-wrap gap-1">
                      {myProperties.map(({ square }) => (
                        <button
                          key={square.index}
                          onClick={() => setTradeOfferProps((l) => toggleIn(l, square.index))}
                          className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${tradeOfferProps.includes(square.index) ? 'bg-primary/10 border-primary text-primary' : 'bg-white border-border-subtle'}`}
                        >
                          {square.name}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={tradeOfferCash}
                      onChange={(e) => setTradeOfferCash(e.target.value)}
                      placeholder="Cash to add"
                      className="mt-1.5 w-full bg-surface p-2 rounded-lg border border-border-subtle text-xs outline-none"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">You Get</p>
                    <div className="flex flex-wrap gap-1">
                      {targetProperties.map(({ square }) => (
                        <button
                          key={square.index}
                          onClick={() => setTradeRequestProps((l) => toggleIn(l, square.index))}
                          className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${tradeRequestProps.includes(square.index) ? 'bg-primary/10 border-primary text-primary' : 'bg-white border-border-subtle'}`}
                        >
                          {square.name}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={tradeRequestCash}
                      onChange={(e) => setTradeRequestCash(e.target.value)}
                      placeholder="Cash to request"
                      className="mt-1.5 w-full bg-surface p-2 rounded-lg border border-border-subtle text-xs outline-none"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleProposeTrade} disabled={busy} className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-50">
                      Send Offer
                    </button>
                    <button onClick={closeTradeBuilder} className="px-4 py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold">
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* Manage Properties is triggered from the corner button pinned to the dice area above,
            not a button down here — this just renders the expanded list once toggled on. */}
        {isMyTurn && game.turnPhase === 'action' && !canBuy && !debt && !game.pendingCard && !game.auction && !game.pendingTrade && showBuild && (
              <div className="space-y-1">
                {myProperties.length === 0 && <p className="text-xs text-text-muted italic px-1">You don't own any properties yet.</p>}
                {myProperties.map(({ state, square }) => {
                  const isProp = square.type === 'property';
                  const build = isProp ? canBuildOnProperty(square, properties) : { canBuild: false, isHotel: false };
                  const canBuildHere = isProp && build.canBuild && canBuildOnGroup((square as PropertySquare).group, me!.uid, properties);
                  return (
                    <div key={square.index} className="bg-white rounded-lg border border-border-subtle p-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-bold truncate">{square.name}</p>
                        <p className="text-[10px] text-text-muted">
                          {state.mortgaged ? 'Mortgaged' : isProp ? `${state.hotel ? 'Hotel' : `${state.houses} house(s)`}` : 'Owned'}
                        </p>
                      </div>
                      <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                        {isProp && canBuildHere && (
                          <button onClick={() => handleBuild(square as PropertySquare)} disabled={busy} className="text-[10px] font-bold px-2 py-1 bg-success/10 text-success rounded-lg">
                            Build {build.isHotel ? 'Hotel' : 'House'} ({formatMoney((square as PropertySquare).houseCost)})
                          </button>
                        )}
                        {isProp && (state.houses > 0 || state.hotel) && (
                          <button onClick={() => handleSellHouse(square as PropertySquare)} disabled={busy} className="text-[10px] font-bold px-2 py-1 bg-warning/10 text-warning rounded-lg">
                            Sell {state.hotel ? 'Hotel' : 'House'}
                          </button>
                        )}
                        {!state.mortgaged && state.houses === 0 && !state.hotel && (
                          <button onClick={() => handleMortgage(square.index)} disabled={busy} className="text-[10px] font-bold px-2 py-1 bg-primary/10 text-primary rounded-lg">
                            Mortgage (+{formatMoney((square as PropertySquare | RailwaySquare | UtilitySquare).mortgageValue)})
                          </button>
                        )}
                        {state.mortgaged && (
                          <button onClick={() => handleUnmortgage(square.index)} disabled={busy} className="text-[10px] font-bold px-2 py-1 bg-primary/10 text-primary rounded-lg">
                            Unmortgage ({formatMoney(Math.round((square as PropertySquare | RailwaySquare | UtilitySquare).mortgageValue * (1 + UNMORTGAGE_INTEREST)))})
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
        )}
      </main>

      {/* Property detail sheet — tap any tile to see its full rates/rent/build/mortgage info,
          same as flipping over a physical property card. */}
      {detailIndex != null && (() => {
        const detailSquare = BOARD[detailIndex];
        const detailState = properties[detailIndex];
        const ownerName = detailState?.ownerUid ? players.find((p) => p.uid === detailState.ownerUid)?.displayName : null;
        const isMine = !!me && detailState?.ownerUid === me.uid;
        const canManageNow = isMyTurn && game.turnPhase === 'action' && !canBuy && !debt && !game.pendingCard && !game.auction && !game.pendingTrade;
        const isProp = detailSquare.type === 'property';
        const build = isProp ? canBuildOnProperty(detailSquare as PropertySquare, properties) : { canBuild: false, isHotel: false };
        const canBuildHere = isMine && isProp && build.canBuild && canBuildOnGroup((detailSquare as PropertySquare).group, me!.uid, properties);
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetailIndex(null)}>
            <div className="bg-white rounded-2xl w-full max-w-xl p-4 space-y-2 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-black text-primary">{detailSquare.name}</h2>
                <button onClick={() => setDetailIndex(null)} className="text-text-muted">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {ownerName && (
                <p className="text-xs font-bold text-primary">
                  Owned by {ownerName}{detailState?.mortgaged ? ' — mortgaged' : ''}
                  {detailState && (detailState.houses > 0 || detailState.hotel) ? ` — ${detailState.hotel ? 'hotel' : `${detailState.houses} house(s)`}` : ''}
                </p>
              )}

              {detailSquare.type === 'property' && (
                <div>
                  <DetailRow label="Price" value={formatMoney(detailSquare.price)} />
                  <DetailRow label="Rent" value={formatMoney(detailSquare.baseRent)} />
                  <DetailRow label="Rent (owns full color set)" value={formatMoney(detailSquare.baseRent * 2)} />
                  <DetailRow label="Rent with 1 house" value={formatMoney(detailSquare.baseRent * RENT_HOUSE_MULTIPLIERS[1])} />
                  <DetailRow label="Rent with 2 houses" value={formatMoney(detailSquare.baseRent * RENT_HOUSE_MULTIPLIERS[2])} />
                  <DetailRow label="Rent with 3 houses" value={formatMoney(detailSquare.baseRent * RENT_HOUSE_MULTIPLIERS[3])} />
                  <DetailRow label="Rent with 4 houses" value={formatMoney(detailSquare.baseRent * RENT_HOUSE_MULTIPLIERS[4])} />
                  <DetailRow label="Rent with hotel" value={formatMoney(detailSquare.baseRent * RENT_HOTEL_MULTIPLIER)} />
                  <DetailRow label="House / hotel cost" value={formatMoney(detailSquare.houseCost)} />
                  <DetailRow label="Mortgage value" value={formatMoney(detailSquare.mortgageValue)} />
                  <DetailRow label="Release (unmortgage) cost" value={formatMoney(Math.round(detailSquare.mortgageValue * (1 + UNMORTGAGE_INTEREST)))} />
                </div>
              )}

              {detailSquare.type === 'railway' && (
                <div>
                  <DetailRow label="Price" value={formatMoney(detailSquare.price)} />
                  <DetailRow label="Rent (1 owned)" value={formatMoney(railwayRent(1))} />
                  <DetailRow label="Rent (2 owned)" value={formatMoney(railwayRent(2))} />
                  <DetailRow label="Rent (3 owned)" value={formatMoney(railwayRent(3))} />
                  <DetailRow label="Rent (4 owned)" value={formatMoney(railwayRent(4))} />
                  <DetailRow label="Mortgage value" value={formatMoney(detailSquare.mortgageValue)} />
                  <DetailRow label="Release (unmortgage) cost" value={formatMoney(Math.round(detailSquare.mortgageValue * (1 + UNMORTGAGE_INTEREST)))} />
                </div>
              )}

              {detailSquare.type === 'utility' && (
                <div>
                  <DetailRow label="Price" value={formatMoney(detailSquare.price)} />
                  <p className="text-xs text-text-muted py-1">Rent = dice roll × 4 (× 10 if you own both utilities)</p>
                  <DetailRow label="Mortgage value" value={formatMoney(detailSquare.mortgageValue)} />
                  <DetailRow label="Release (unmortgage) cost" value={formatMoney(Math.round(detailSquare.mortgageValue * (1 + UNMORTGAGE_INTEREST)))} />
                </div>
              )}

              {detailSquare.type === 'tax' && <DetailRow label="Amount" value={formatMoney(INCOME_TAX)} />}
              {detailSquare.type === 'go' && (
                <p className="text-sm text-text-muted">
                  Pass GO and collect {formatMoney(SALARY)} salary — double if you land exactly on it and that house rule is on.
                </p>
              )}
              {detailSquare.type === 'jail' && <p className="text-sm text-text-muted">Just visiting — no penalty unless you're sent here.</p>}
              {detailSquare.type === 'free_parking' && (
                <p className="text-sm text-text-muted">
                  No penalty.{game.houseRules.freeParkingJackpot ? ` Collects the accumulated pot (currently ${formatMoney(game.freeParkingPot)}).` : ''}
                </p>
              )}
              {detailSquare.type === 'go_to_jail' && <p className="text-sm text-text-muted">Go directly to Jail — do not collect salary.</p>}
              {(detailSquare.type === 'chance' || detailSquare.type === 'community') && (
                <p className="text-sm text-text-muted">Draw a card and follow its instructions.</p>
              )}

              {isMine && isOwnable(detailSquare) && (
                <div className="pt-2 mt-2 border-t border-border-subtle space-y-1.5">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Manage</p>
                  {!canManageNow && <p className="text-xs text-text-muted italic">Available on your turn, after rolling.</p>}
                  {canManageNow && (
                    <div className="flex flex-wrap gap-1.5">
                      {canBuildHere && (
                        <button
                          onClick={() => handleBuild(detailSquare as PropertySquare)}
                          disabled={busy}
                          className="text-xs font-bold px-3 py-1.5 bg-success/10 text-success rounded-lg disabled:opacity-50"
                        >
                          Build {build.isHotel ? 'Hotel' : 'House'} ({formatMoney((detailSquare as PropertySquare).houseCost)})
                        </button>
                      )}
                      {isProp && detailState && (detailState.houses > 0 || detailState.hotel) && (
                        <button
                          onClick={() => handleSellHouse(detailSquare as PropertySquare)}
                          disabled={busy}
                          className="text-xs font-bold px-3 py-1.5 bg-warning/10 text-warning rounded-lg disabled:opacity-50"
                        >
                          Sell {detailState.hotel ? 'Hotel' : 'House'}
                        </button>
                      )}
                      {detailState && !detailState.mortgaged && detailState.houses === 0 && !detailState.hotel && (
                        <button
                          onClick={() => handleMortgage(detailIndex)}
                          disabled={busy}
                          className="text-xs font-bold px-3 py-1.5 bg-primary/10 text-primary rounded-lg disabled:opacity-50"
                        >
                          Mortgage (+{formatMoney((detailSquare as PropertySquare | RailwaySquare | UtilitySquare).mortgageValue)})
                        </button>
                      )}
                      {detailState?.mortgaged && (
                        <button
                          onClick={() => handleUnmortgage(detailIndex)}
                          disabled={busy}
                          className="text-xs font-bold px-3 py-1.5 bg-primary/10 text-primary rounded-lg disabled:opacity-50"
                        >
                          Unmortgage ({formatMoney(Math.round((detailSquare as PropertySquare | RailwaySquare | UtilitySquare).mortgageValue * (1 + UNMORTGAGE_INTEREST)))})
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
