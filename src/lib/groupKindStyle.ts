import type { CSSProperties } from 'react';

// Each kind of group has its own colour wherever it appears (Create Group, the Dashboard card, the Payments screen), so a
// person can tell a monthly group, an event and a payments group apart at a glance.
export type GroupKind = 'regular' | 'event' | 'payments';

export const KIND_STYLE: Record<GroupKind, {
  label: string;      // the short badge text
  acc: string;        // the main accent
  light: string;      // the accent on a dark background
  tint: string;       // a very light wash of it
  dark: string;       // the accent as text on a light background
  onAcc: string;      // text on top of the accent
  hero: string;       // the dark header colour on Create Group
  headerWash: string; // the Dashboard card's header background
}> = {
  regular: { label: 'Monthly', acc: '#12b89a', light: '#5fe0c4', tint: '#effcf8', dark: '#0b6b5a', onAcc: '#04251f', hero: '#06222f', headerWash: 'linear-gradient(90deg, rgba(74,222,128,.15), rgba(59,130,246,.15))' },
  event: { label: 'Event', acc: '#f59e0b', light: '#fcd34d', tint: '#fff7e6', dark: '#b45309', onAcc: '#2b1700', hero: '#2a1a08', headerWash: 'linear-gradient(90deg, rgba(245,158,11,.20), rgba(251,113,133,.12))' },
  payments: { label: 'Payments', acc: '#6366f1', light: '#a5b4fc', tint: '#eef0ff', dark: '#4338ca', onAcc: '#ffffff', hero: '#14163f', headerWash: 'linear-gradient(90deg, rgba(99,102,241,.20), rgba(129,140,248,.10))' },
};

export const kindOf = (group: any): GroupKind => (group?.groupType === 'event' || group?.groupType === 'payments' ? group.groupType : 'regular');

// CSS variables a screen sets once so everything inside can colour itself with var(--acc), var(--acc-tint) and so on
export const kindVars = (kind: GroupKind): CSSProperties => {
  const k = KIND_STYLE[kind];
  return {
    '--acc': k.acc, '--acc-light': k.light, '--acc-tint': k.tint, '--acc-dark': k.dark, '--on-acc': k.onAcc, '--hero': k.hero,
  } as CSSProperties;
};
