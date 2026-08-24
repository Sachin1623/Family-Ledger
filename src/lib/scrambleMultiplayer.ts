// Types + small pure helpers for multiplayer Scramble. All actual gameplay (starting a match,
// submitting answers, hints, scoring, match-end) is server-authoritative — see server.ts's
// `/api/scramble/*` endpoints — this file only covers what the lobby/game screens need to render
// and to create/join the still-open lobby directly (the one client-writable path Firestore rules
// allow; see firestore.rules' scrambleGames match block).
export interface ScramblePlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
}

export interface ScramblePlayerProgress {
  roundIndex: number;
  score: number;
  solvedCount: number;
  wrongGuesses: number;
  hintsUsedThisRound: number;
  hintsUsedTotal: number;
  finished: boolean;
  finishedAt: string | null;
  // Round indices this player gave up on with Pass — still solvable later for bonus points via
  // /api/scramble/submit-passed (see ScrambleMultiplayerGame.tsx's "Passed Words" panel) as long
  // as the match clock hasn't run out, even after this player's own sequential run is `finished`.
  passedRounds?: number[];
}

export type ScramblePerWordTimer = '15s' | '30s' | '45s';
export type ScrambleMatchTimer = '3min' | '5min' | '10min';

export interface ScrambleMultiplayerGameDoc {
  hostUid: string;
  code: string;
  status: 'waiting' | 'active' | 'finished';
  wordLength: number;
  totalWords: number;
  timerMode: ScramblePerWordTimer;
  matchTimerMode: ScrambleMatchTimer;
  players: ScramblePlayer[];
  playerUids: string[];
  roundTiles?: string[]; // each entry is one round's shuffled letters JOINED into a string — Firestore rejects nested arrays (string[][]), so split('') client-side to get individual tiles
  progress?: Record<string, ScramblePlayerProgress>;
  roundCompletions?: Record<string, { uid: string; hinted: boolean }[]>;
  createdAt: string;
  startedAt?: string | null;
  matchEndsAt?: string | null;
  finishedAt?: string | null;
  winnerUid?: string | null;
  dictionaryVersion?: string;
  rematchGameId?: string | null;
  // The full target-word sequence, copied onto the public doc from the admin-only `secret`
  // subcollection the moment the match finishes (see server.ts's revealScrambleWordsIfFinished) —
  // safe to expose now since hints/cheating no longer matter once nobody can submit any more.
  // Absent while the match is still `active`.
  revealedWords?: string[];
}

export const TOTAL_WORDS_OPTIONS = [5, 10, 15] as const;
export const PER_WORD_TIMER_OPTIONS: ScramblePerWordTimer[] = ['15s', '30s', '45s'];
export const PER_WORD_TIMER_SECONDS: Record<ScramblePerWordTimer, number> = { '15s': 15, '30s': 30, '45s': 45 };
export const PER_WORD_TIMER_LABEL: Record<ScramblePerWordTimer, string> = { '15s': '15 sec', '30s': '30 sec', '45s': '45 sec' };
export const MATCH_TIMER_OPTIONS: ScrambleMatchTimer[] = ['3min', '5min', '10min'];
export const MATCH_TIMER_SECONDS: Record<ScrambleMatchTimer, number> = { '3min': 180, '5min': 300, '10min': 600 };
export const MATCH_TIMER_LABEL: Record<ScrambleMatchTimer, string> = { '3min': '3 min', '5min': '5 min', '10min': '10 min' };

export const SPEED_TIER_BONUS = [5, 3, 2, 1];
export const MULTIPLAYER_BASE_POINTS = 10;
export const MULTIPLAYER_HINT_PENALTY = 3;
export const MULTIPLAYER_MAX_HINTS = 5;
export const MULTIPLAYER_PASS_PENALTY = 5;
export const MULTIPLAYER_SHUFFLE_PENALTY = 1;

export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export function matchSecondsRemaining(matchEndsAt: string | null | undefined): number {
  if (!matchEndsAt) return 0;
  return Math.max(0, Math.round((new Date(matchEndsAt).getTime() - Date.now()) / 1000));
}
