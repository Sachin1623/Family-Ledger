import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { GameHelpModal, HelpButton } from './GameHelpModal';

// Shared pieces of every game lobby (Chess, Ludo, Rummy, 27-Hand Rummy, Business, Sweep, Sequence, Spade Pledge,
// Scramble race): the dark page with a game banner, a six-box code field, "your games" cards that say whose move it
// is, and the full-screen "new game" options sheet. Each lobby keeps its own game logic and just passes it in.

export function GameLobbyShell({
  title,
  emoji,
  tagline,
  gradient = ['#2b3f7a', '#162250'],
  stats,
  ranksPath,
  help,
  error,
  children,
}: {
  title: string;
  emoji: string;
  tagline: string;
  gradient?: [string, string];
  stats?: { label: string; value: string | number }[];
  ranksPath?: string;
  help?: { content: any };
  error?: string | null;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [showHelp, setShowHelp] = React.useState(false);
  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1d2b57_0%,#0c1230_55%,#070a18_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />
        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate('/tools?category=games')} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="flex-1" />
          {help && <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />}
          {ranksPath && (
            <button onClick={() => navigate(ranksPath)} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center text-sm" aria-label="Ranks">🏅</button>
          )}
        </header>
        {showHelp && help && <GameHelpModal content={help.content} onClose={() => setShowHelp(false)} />}

        <main className="relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-8 space-y-3 max-w-md mx-auto w-full">
          <div className="relative overflow-hidden rounded-[1.25rem] p-4 border border-white/15" style={{ background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }}>
            <span className="absolute -right-1 -top-2 text-[88px] leading-none opacity-90 drop-shadow-[0_6px_14px_rgba(0,0,0,0.5)] select-none">{emoji}</span>
            <h1 className="relative text-[22px] font-black">{title}</h1>
            <p className="relative text-[11px] font-semibold text-white/75 mt-0.5 max-w-[11.5rem] leading-snug">{tagline}</p>
            {stats && stats.length > 0 && (
              <div className="relative flex gap-1.5 mt-3">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl bg-black/30 px-2.5 py-1.5">
                    <p className="text-[8px] font-extrabold tracking-[0.1em] text-white/55">{s.label.toUpperCase()}</p>
                    <p className="text-[15px] font-black leading-tight">{s.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <p className="text-xs font-bold text-red-300 px-1">{error}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

export function GoldButton({ onClick, disabled, children, className }: { onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx('w-full py-3.5 rounded-2xl text-sm font-black text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_5px_0_#b88a1d] active:translate-y-[3px] active:shadow-[0_2px_0_#b88a1d] disabled:opacity-50', className)}
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[10px] font-black tracking-[0.14em] text-amber-300 px-1">{String(children).toUpperCase()}</h2>;
}

export function CodeJoin({ value, onChange, onJoin, joining }: { value: string; onChange: (v: string) => void; onJoin: () => void; joining: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-3.5 space-y-2.5">
      <SectionLabel>Join with a code</SectionLabel>
      <div className="relative" onClick={() => ref.current?.focus()}>
        <div className="flex gap-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={clsx('flex-1 h-10 rounded-[10px] bg-[#0c1230] border-[1.5px] flex items-center justify-center text-base font-black', value[i] ? 'border-amber-300 text-amber-300' : 'border-[#2c3a63] text-white/30')}>
              {value[i] || '·'}
            </div>
          ))}
        </div>
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter') onJoin(); }}
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={6}
          aria-label="Game code"
          className="absolute inset-0 w-full h-full opacity-0"
        />
      </div>
      <button onClick={onJoin} disabled={joining || !value.trim()} className="w-full py-2.5 rounded-xl text-xs font-black text-slate-200 bg-[#18213a] border border-[#243052] disabled:opacity-40">
        {joining ? 'Joining…' : 'Join game'}
      </button>
    </div>
  );
}

export type Chip = { text: string; tone: 'gold' | 'green' | 'grey' };

/** "Your move" / "Their move" / "Waiting" for a game doc. Falls back to a plain "In progress" when the game keeps its turn elsewhere. */
export function turnChipFor(g: any, uid: string | undefined, kind: 'chess' | 'seat' | 'none'): Chip {
  if (g.status === 'waiting') return { text: 'WAITING', tone: 'grey' };
  if (!uid) return { text: 'IN PROGRESS', tone: 'grey' };
  if (kind === 'chess') {
    const me = (g.players || []).find((p: any) => p.uid === uid);
    const turn = String(g.fen || '').split(' ')[1];
    if (me && turn) return me.color === turn ? { text: 'YOUR MOVE', tone: 'gold' } : { text: 'THEIR MOVE', tone: 'green' };
  }
  if (kind === 'seat' && typeof g.currentTurnSeatIndex === 'number') {
    const me = (g.players || []).find((p: any) => p.uid === uid);
    if (me && typeof me.seatIndex === 'number') return me.seatIndex === g.currentTurnSeatIndex ? { text: 'YOUR MOVE', tone: 'gold' } : { text: 'THEIR MOVE', tone: 'green' };
  }
  return { text: 'IN PROGRESS', tone: 'green' };
}

export function LobbyGameCard({
  players,
  title,
  subtitle,
  chip,
  onClick,
  actions,
}: {
  key?: React.Key;
  players: { uid: string; photoURL?: string; displayName?: string; isBot?: boolean; color?: string }[];
  title: string;
  subtitle: string;
  chip: Chip;
  onClick: () => void;
  actions?: React.ReactNode;
}) {
  const mine = chip.tone === 'gold';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      className={clsx('flex items-center gap-2.5 rounded-2xl px-3 py-2.5 border cursor-pointer active:scale-[0.99] transition-transform', mine ? 'border-amber-300 bg-[#1d1a14] shadow-[0_0_14px_rgba(245,196,81,0.25)]' : 'border-[#1f2a47] bg-[#121a2e]')}
    >
      <div className="flex shrink-0">
        {players.slice(0, 4).map((p, i) => (
          <div key={p.uid} className="w-[30px] h-[30px] rounded-full border-2 border-[#121a2e] bg-gradient-to-br from-[#6f86b3] to-[#3a4a75] flex items-center justify-center text-[11px] font-black overflow-hidden" style={{ marginLeft: i === 0 ? 0 : -8, ...(p.color ? { background: p.color } : null) }}>
            {p.isBot ? '🤖' : p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (p.displayName || '?').slice(0, 1).toUpperCase()}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-extrabold truncate">{title}</p>
        <p className="text-[9px] font-bold text-white/50 truncate">{subtitle}</p>
      </div>
      <span className={clsx('shrink-0 text-[8.5px] font-black tracking-[0.06em] px-2 py-1 rounded-lg', chip.tone === 'gold' ? 'bg-amber-300 text-[#1a1300]' : chip.tone === 'green' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-slate-300')}>{chip.text}</span>
      {actions}
    </div>
  );
}

export function IconAction({ icon, label, onClick, disabled, tone = 'red' }: { icon: string; label: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; tone?: 'red' | 'blue' }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label} className={clsx('p-1.5 disabled:opacity-40 shrink-0', tone === 'red' ? 'text-red-300' : 'text-sky-300')}>
      <span className="material-symbols-outlined text-[18px] block">{icon}</span>
    </button>
  );
}

/** Full-screen "new game" options: big selectable cards / switches in children, the create button pinned at the bottom. */
export function NewGameSheet({
  open,
  onClose,
  title,
  subtitle,
  createLabel,
  creating,
  onCreate,
  error,
  children,
}: {
  error?: string | null;
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  createLabel: string;
  creating: boolean;
  onCreate: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[170] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1d2b57_0%,#0c1230_55%,#070a18_100%)]">
      <header className="shrink-0 flex items-center gap-2 px-3 pt-2">
        <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <div className="leading-tight">
          <h1 className="text-[15px] font-black">{title}</h1>
          <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">{subtitle.toUpperCase()}</span>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-4 space-y-3 max-w-md mx-auto w-full">{children}{error && <p className="text-xs font-bold text-red-300 px-1">{error}</p>}</div>
      <div className="shrink-0 px-3 pb-3 max-w-md mx-auto w-full">
        <GoldButton onClick={onCreate} disabled={creating}>{creating ? 'Creating…' : createLabel}</GoldButton>
      </div>
    </div>
  );
}

/** A dark options card with a gold heading — wrap one group of choices (format, players, rules…). */
export function OptionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-3.5 space-y-2.5">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

/** Row of selectable pills (player count, word length, timers…). */
export function PillPicker<T extends string | number>({ options, value, onChange, format }: { options: readonly T[]; value: T; onChange: (v: T) => void; format?: (v: T) => string }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map((o) => (
        <button key={String(o)} onClick={() => onChange(o)} className={clsx('flex-1 min-w-[3rem] py-2 rounded-xl text-xs font-black border-[1.5px]', value === o ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] border-transparent' : 'bg-[#0c1230] border-[#2c3a63] text-white/55')}>
          {format ? format(o) : o}
        </button>
      ))}
    </div>
  );
}

/** Big selectable cards (e.g. Partnership / Free-for-all). */
export function CardPicker<T extends string>({ options, value, onChange }: { options: { id: T; emoji: string; label: string; sub: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={clsx('rounded-2xl p-3 text-center border-2 transition-all', value === o.id ? 'border-amber-300 bg-[#2a1d05] shadow-[0_0_14px_rgba(245,196,81,0.25)]' : 'border-[#2c3a63] bg-[#0c1230]')}>
          <div className="text-2xl">{o.emoji}</div>
          <p className="text-xs font-black mt-1">{o.label}</p>
          <p className="text-[9px] font-bold text-white/50 mt-0.5 leading-tight">{o.sub}</p>
        </button>
      ))}
    </div>
  );
}

export function SwitchRow({ label, hint, checked, onChange }: { key?: React.Key; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="w-full flex items-center justify-between py-2 text-left" role="switch" aria-checked={checked}>
      <span className="pr-3"><span className="block text-[11px] font-bold">{label}</span>{hint && <span className="block text-[9px] font-semibold text-white/45 leading-tight">{hint}</span>}</span>
      <span className={clsx('relative w-[34px] h-5 rounded-full transition-colors', checked ? 'bg-emerald-400' : 'bg-[#2c3a63]')}>
        <span className={clsx('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

/** The three numbers on the lobby banner, worked out from the games already listed (no extra reads). */
export function lobbyStats(games: any[], uid: string | undefined, kind: 'chess' | 'seat' | 'none') {
  const chips = games.map((g) => turnChipFor(g, uid, kind).text);
  const n = (t: string) => chips.filter((c) => c === t).length;
  const yourMove = n('YOUR MOVE');
  const base = [
    { label: 'Open games', value: games.length },
    { label: 'Waiting', value: n('WAITING') },
  ];
  return kind === 'none' ? base : [...base, { label: 'Your move', value: yourMove }];
}
