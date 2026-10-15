import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import DraggableCard from './DraggableCard';
import { parseCard, SUIT_SYMBOL, SUIT_RED } from '../lib/rummy';

// Shared pieces of the rummy table (27-Hand and 13-Card Rummy): a readable card face, the card back,
// and the hand area that lays every card out in as many rows as it takes for them to stay readable.

const CARD_ASPECT = 7 / 5; // height / width

// A card face. Rank + suit sit in the top-left corner (the part that stays visible if cards overlap),
// with a big suit mark bottom-right when there's room. `width` is in px.
export function PlayingCard({
  cardId,
  width,
  selected,
  highlight,
  dim,
  faceDown,
  glyph = '♣',
  isJoker,
  isWild,
  onClick,
}: {
  cardId: string;
  width: number;
  selected?: boolean;
  highlight?: boolean;
  dim?: boolean;
  faceDown?: boolean;
  glyph?: string;
  isJoker?: boolean;
  isWild?: boolean;
  onClick?: () => void;
}) {
  const height = Math.round(width * CARD_ASPECT);
  const base = `relative shrink-0 select-none rounded-lg border-2 font-extrabold transition-colors ${onClick ? 'cursor-pointer active:scale-95' : ''} ${dim ? 'opacity-40' : ''}`;

  if (faceDown) {
    return (
      <div
        role={onClick ? 'button' : undefined}
        onClick={onClick}
        style={{ width, height }}
        className={`${base} border-white/60 bg-[#0f4761] text-white flex items-center justify-center shadow-md [background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.14)_0_5px,transparent_5px_10px)]`}
      >
        <span style={{ fontSize: width * 0.4 }} className="leading-none drop-shadow">{glyph}</span>
      </div>
    );
  }

  const { rank, suit } = parseCard(cardId);
  const red = !isJoker && SUIT_RED[suit];
  const state = selected
    ? 'border-amber-400 ring-2 ring-amber-300/80 bg-amber-50 shadow-md'
    : highlight
    ? 'border-warning ring-2 ring-warning/60 bg-white shadow-md'
    : 'border-slate-300 bg-white shadow';
  const color = isJoker ? 'text-warning' : red ? 'text-error' : 'text-slate-900';
  const fs = Math.max(12, Math.round(width * 0.29));

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{ width, height }}
      className={`${base} ${state} ${color}`}
    >
      {isJoker ? (
        <span style={{ fontSize: width * 0.55 }} className="absolute inset-0 flex items-center justify-center leading-none">🃏</span>
      ) : (
        <>
          <span style={{ fontSize: fs, left: Math.round(width * 0.08), top: Math.round(width * 0.04) }} className="absolute leading-none">{rank}</span>
          <span style={{ fontSize: fs, left: Math.round(width * 0.08), top: Math.round(width * 0.04 + fs) }} className="absolute leading-none">{SUIT_SYMBOL[suit]}</span>
          {width >= 54 && (
            <span style={{ fontSize: Math.round(width * 0.52), right: Math.round(width * 0.07), bottom: Math.round(width * 0.04) }} className="absolute leading-none opacity-90">{SUIT_SYMBOL[suit]}</span>
          )}
        </>
      )}
      {isWild && (
        <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-warning text-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[11px] leading-none">auto_awesome</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------------------------

export interface HandGroup {
  idx: number; // index in the caller's group list (drop target id)
  cards: string[];
  valid: boolean;
  label?: string; // e.g. "12 pts"
}

type Item = { kind: 'group'; group: HandGroup } | { kind: 'loose'; card: string };

const itemSize = (it: Item) => (it.kind === 'group' ? it.group.cards.length : 1);

// Packs items into `rows` rows without splitting a group, as evenly as possible.
function planRows(items: Item[], rows: number): Item[][] {
  const total = items.reduce((n, it) => n + itemSize(it), 0);
  const target = Math.ceil(total / rows);
  const out: Item[][] = [[]];
  let count = 0;
  for (const it of items) {
    const size = itemSize(it);
    if (count > 0 && count + size > target && out.length < rows) {
      out.push([]);
      count = 0;
    }
    out[out.length - 1].push(it);
    count += size;
  }
  return out;
}

const GROUP_GAP = 14;

interface Fit {
  rows: Item[][];
  cardW: number;
  pitch: number; // distance from one card's left edge to the next
}

// Chooses 1–3 rows and a card size so the whole hand stays readable inside `w` x `h`: the fewest rows
// that fit without cramping the cards, otherwise the layout that keeps the most of each card visible.
function fitHand(items: Item[], w: number, h: number): Fit {
  const total = items.reduce((n, it) => n + itemSize(it), 0);
  if (total === 0 || w <= 0 || h <= 0) return { rows: [items], cardW: 56, pitch: 58 };
  let best: Fit | null = null;
  let bestScore = -1;
  for (let r = 1; r <= 3; r++) {
    const rows = planRows(items, r);
    const rowH = h / rows.length - 12; // leave room for each row's validity bar
    const cardW = Math.min(72, Math.max(30, rowH / CARD_ASPECT));
    let pitch = cardW + 2;
    for (const row of rows) {
      const cards = row.reduce((n, it) => n + itemSize(it), 0);
      const clusters = row.reduce((n, it, i) => n + (it.kind === 'group' || i === 0 || row[i - 1].kind === 'group' ? 1 : 0), 0);
      const usable = w - 12 - Math.max(0, clusters - 1) * GROUP_GAP;
      if (cards > 1) pitch = Math.min(pitch, (usable - cardW) / (cards - 1));
    }
    pitch = Math.max(14, pitch);
    // What matters is how much of each card you can actually read: the visible strip, and the card size.
    const score = Math.min(pitch, cardW) * 2 + cardW * 0.3 - (rows.length - 1) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = { rows, cardW, pitch };
    }
  }
  return best!;
}

export function HandArea({
  groups,
  loose,
  wildRanks,
  selected,
  highlightCard,
  dragEnabled,
  isDragging,
  draggedFlag,
  onDragState,
  onDrop,
  onCardClick,
  onUngroup,
  onAddSelected,
  selectedCount,
  jokerCheck,
  looseLabelFor,
  chip,
}: {
  groups: HandGroup[];
  loose: string[];
  wildRanks?: string[];
  selected: string[];
  highlightCard?: string | null;
  dragEnabled: boolean;
  isDragging: boolean;
  draggedFlag: React.MutableRefObject<boolean>;
  onDragState: (d: boolean) => void;
  onDrop: (card: string, rect: DOMRect) => void;
  onCardClick?: (card: string) => void;
  onUngroup?: (groupIdx: number) => void;
  onAddSelected?: (groupIdx: number) => void;
  selectedCount: number;
  jokerCheck?: (card: string) => boolean;
  // Caption under each cluster of loose (ungrouped) cards, e.g. their points.
  looseLabelFor?: (cards: string[]) => string;
  // A small action chip floated above one card (e.g. "Discard").
  chip?: { card: string; label: string; onClick: () => void } | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = useMemo<Item[]>(
    () => [...groups.map((g) => ({ kind: 'group' as const, group: g })), ...loose.map((c) => ({ kind: 'loose' as const, card: c }))],
    [groups, loose],
  );
  const fit = useMemo(() => fitHand(items, size.w, size.h), [items, size.w, size.h]);

  const renderCard = (c: string, i: number, first: boolean, key: string) => {
    const wild = !!wildRanks?.includes(parseCard(c).rank);
    return (
      <div key={key} style={{ width: fit.cardW, marginLeft: first ? 0 : fit.pitch - fit.cardW }} className="relative shrink-0">
        {chip && chip.card === c && (
          <button
            onClick={chip.onClick}
            className="absolute left-1/2 -translate-x-1/2 -top-7 z-30 whitespace-nowrap rounded-full bg-error text-white text-[10px] font-extrabold px-2.5 py-1 shadow-lg after:content-[''] after:absolute after:left-1/2 after:-bottom-1 after:-ml-1 after:border-4 after:border-transparent after:border-t-error after:border-b-0"
          >
            {chip.label}
          </button>
        )}
        <DraggableCard enabled={dragEnabled} draggedFlag={draggedFlag} onDragState={onDragState} onDrop={(r) => onDrop(c, r)}>
          <PlayingCard
            cardId={c}
            width={fit.cardW}
            selected={selected.includes(c)}
            highlight={c === highlightCard}
            isWild={wild}
            isJoker={jokerCheck?.(c)}
            onClick={onCardClick ? () => { if (!draggedFlag.current) onCardClick(c); } : undefined}
          />
        </DraggableCard>
      </div>
    );
  };

  return (
    <div
      ref={boxRef}
      data-loose-area=""
      className={`flex-1 min-h-0 flex flex-col justify-around rounded-lg px-1 py-1 transition-colors ${isDragging ? 'border border-dashed border-amber-300 bg-amber-300/10' : 'border border-transparent'}`}
    >
      {fit.rows.map((row, ri) => {
        // Consecutive loose cards form one cluster; each group is its own cluster.
        const clusters: Array<{ group?: HandGroup; cards: string[] }> = [];
        row.forEach((it) => {
          if (it.kind === 'group') clusters.push({ group: it.group, cards: it.group.cards });
          else {
            const last = clusters[clusters.length - 1];
            if (last && !last.group) last.cards.push(it.card);
            else clusters.push({ cards: [it.card] });
          }
        });
        return (
          <div key={ri} className="flex justify-center items-start" style={{ gap: GROUP_GAP }}>
            {clusters.map((cl, ci) => (
              <div key={cl.group ? `g${cl.group.idx}` : `l${ci}`} data-group-idx={cl.group?.idx} className={`relative flex flex-col rounded-md transition-colors ${isDragging && cl.group ? 'bg-amber-300/10 ring-1 ring-amber-300/40' : ''}`}>
                <div className="flex">{cl.cards.map((c, i) => renderCard(c, i, i === 0, `${c}-${ri}-${ci}-${i}`))}</div>
                <div className={`mt-1 h-1 rounded-full ${cl.group ? (cl.group.valid ? 'bg-success' : 'bg-text-muted/40') : 'bg-text-muted/25'}`} />
                {cl.group?.label && (
                  <span className={`text-center text-[9px] font-black leading-none mt-0.5 ${cl.group.valid ? 'text-emerald-400' : 'text-white/60'}`}>{cl.group.label}</span>
                )}
                {!cl.group && looseLabelFor && (
                  <span className="text-center text-[9px] font-black leading-none mt-0.5 text-white/60">{looseLabelFor(cl.cards)}</span>
                )}
                {cl.group && onUngroup && (
                  <button
                    onClick={() => onUngroup(cl.group!.idx)}
                    aria-label="Ungroup"
                    className="absolute -top-2 -right-2 z-20 w-4 h-4 rounded-full bg-white border border-border-subtle shadow flex items-center justify-center text-text-muted"
                  >
                    <span className="material-symbols-outlined text-[11px] leading-none">close</span>
                  </button>
                )}
                {cl.group && onAddSelected && selectedCount > 0 && (
                  <button
                    onClick={() => onAddSelected(cl.group!.idx)}
                    aria-label="Add selected cards here"
                    className="absolute -bottom-2 -right-2 z-20 flex items-center gap-0.5 h-4 min-w-[16px] px-1 rounded-full bg-amber-300 text-[#1a1300] text-[9px] font-black shadow"
                  >
                    <span className="material-symbols-outlined text-[10px] leading-none">add</span>
                    {selectedCount}
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// A small pill-shaped action button for the felt table's button row.
export function TablePill({
  children,
  onClick,
  disabled,
  tone = 'primary',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'light' | 'success' | 'warn';
}) {
  const tones: Record<string, string> = {
    primary: 'bg-amber-300 text-[#1a1300]',
    light: 'bg-white text-slate-900 border border-slate-300',
    success: 'bg-success text-white',
    warn: 'bg-amber-100 text-amber-800 border border-amber-300',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-full text-[10px] font-extrabold whitespace-nowrap flex items-center gap-1 shadow disabled:opacity-40 active:scale-95 transition-all ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
