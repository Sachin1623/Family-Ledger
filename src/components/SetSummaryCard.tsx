import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { GroupSet } from '../lib/groupSets';
import { SetGroup } from './GroupSets';

// The home page, with a set chosen: this month's total for the groups in the set, against last month, split by group.
// Each group is read through a small invisible probe that asks for exactly the same expenses query the group's own card already uses, so the
// Firestore SDK shares one listener between them and the summary costs no extra reads.

export type SummaryGroup = SetGroup & { currency?: string };

const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// income offsets spending, the same convention the group cards use for their month figure
const net = (e: any) => (e.type === 'income' ? -(e.amount || 0) : (e.amount || 0));

function GroupMonthProbe({ groupId, onStats }: { groupId: string; onStats: (id: string, cur: number, prev: number) => void }) {
  const [snap] = useCollection(query(collection(db, 'expenses'), where('groupId', '==', groupId)));
  const { cur, prev } = useMemo(() => {
    const now = new Date();
    const curKey = monthKeyOf(now);
    const prevKey = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    let c = 0;
    let p = 0;
    snap?.docs.forEach((d) => {
      const e: any = d.data();
      const date = typeof e.date === 'string' ? e.date : '';
      if (date.startsWith(curKey)) c += net(e);
      else if (date.startsWith(prevKey)) p += net(e);
    });
    return { cur: c, prev: p };
  }, [snap]);
  useEffect(() => {
    if (snap) onStats(groupId, cur, prev);
  }, [snap, groupId, cur, prev, onStats]);
  return null;
}

const SEGMENT_COLORS = ['#ffd166', '#ffffff', '#7ee0c6', '#ff9aa2', '#b9a7ff', '#9bd1ff'];

export default function SetSummaryCard({
  set,
  groups,
  onEdit,
  onAnalyse,
  onAdd,
}: {
  set: GroupSet;
  groups: SummaryGroup[]; // the active groups of yours that are in this set
  onEdit: () => void;
  onAnalyse: () => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false); // closed by default: one slim line, the full card on a tap
  const [stats, setStats] = useState<Record<string, { cur: number; prev: number }>>({});
  const report = useCallback((id: string, cur: number, prev: number) => {
    setStats((s) => (s[id] && s[id].cur === cur && s[id].prev === prev ? s : { ...s, [id]: { cur, prev } }));
  }, []);

  const now = new Date();
  const monthName = now.toLocaleDateString(undefined, { month: 'long' });
  const prevMonthName = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString(undefined, { month: 'long' });

  const rows = groups.map((g) => ({ g, cur: stats[g.id]?.cur ?? 0, prev: stats[g.id]?.prev ?? 0 }));
  const total = rows.reduce((s, r) => s + r.cur, 0);
  const prevTotal = rows.reduce((s, r) => s + r.prev, 0);
  const positive = rows.filter((r) => r.cur > 0);
  const positiveTotal = positive.reduce((s, r) => s + r.cur, 0);
  const currencies = Array.from(new Set(groups.map((g) => g.currency || 'INR')));
  const symbol = getCurrencySymbol(groups[0]?.currency);
  const money = (n: number) => `${symbol}${Math.round(Math.abs(n)).toLocaleString()}`;
  // a month where income beat spending nets below zero, so the earlier month's figure keeps its minus sign
  const signed = (n: number) => `${n < 0 ? '−' : ''}${money(n)}`;
  // the comparison is always shown, even when last month had nothing: then it says how much more (or less) than zero
  const comparison = (() => {
    const diff = total - prevTotal;
    if (diff === 0) return `Same as ${prevMonthName} (${signed(prevTotal)})`;
    const arrow = diff > 0 ? '▲' : '▼';
    if (prevTotal > 0) return `${arrow} ${Math.abs(Math.round((diff / prevTotal) * 100))}% vs ${prevMonthName} (${signed(prevTotal)})`;
    return `${arrow} ${money(diff)} ${diff > 0 ? 'more' : 'less'} than ${prevMonthName} (${signed(prevTotal)})`;
  })();

  const shortDiff = total - prevTotal;
  const shortCmp = shortDiff === 0 ? '＝' : `${shortDiff > 0 ? '▲' : '▼'} ${prevTotal > 0 ? `${Math.abs(Math.round((shortDiff / prevTotal) * 100))}%` : money(shortDiff)}`;
  const gradient = 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)';
  const probes = groups.map((g) => <Fragment key={g.id}><GroupMonthProbe groupId={g.id} onStats={report} /></Fragment>);

  // closed: one line with the set, this month's total and how it compares; the probes stay mounted so the numbers are always current
  if (!open) {
    return (
      <>
        {probes}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} aria-label={`Open ${set.name} summary`} className="w-full flex items-center gap-2 rounded-2xl px-3 py-2 text-left text-white shadow-sm active:scale-[0.99] transition-transform" style={{ background: gradient }}>
          <span className="text-base leading-none">{set.icon}</span>
          <span className="min-w-0 truncate text-[11px] font-black uppercase tracking-wider text-white/85">{set.name} · {monthName}</span>
          <span className="flex-1" />
          <span className="text-lg font-black leading-none tabular-nums whitespace-nowrap">{symbol}{Math.round(total).toLocaleString()}</span>
          <span className="text-[11px] font-black rounded-full bg-white/15 px-2 py-1 leading-none whitespace-nowrap">{shortCmp}<span className="hidden sm:inline font-bold"> vs {prevMonthName}</span></span>
          <span className="material-symbols-outlined text-[20px] shrink-0 text-white/70">expand_more</span>
        </button>
      </>
    );
  }

  return (
    <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: gradient }}>
      {probes}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-wider text-white/85 truncate">{set.icon} {set.name} · {monthName}</p>
          <p className="text-[28px] font-black leading-tight tabular-nums">{symbol}{Math.round(total).toLocaleString()}</p>
          <p className="text-[12px] text-white/90">
            {comparison} · {groups.length} group{groups.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <button type="button" onClick={onEdit} className="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-black active:scale-95">Edit set</button>
          <button type="button" onClick={() => setOpen(false)} aria-expanded aria-label="Show less" className="rounded-lg bg-white/15 w-7 h-7 flex items-center justify-center active:scale-95"><span className="material-symbols-outlined text-[20px]">expand_less</span></button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="mt-3 rounded-xl bg-white/15 px-3 py-2 text-xs font-bold">None of the groups in this set are active any more. Use Edit set to choose others.</p>
      ) : (
        <>
          {positiveTotal > 0 && (
            <>
              <div className="flex h-2 rounded-full overflow-hidden gap-0.5 mt-3">
                {positive.map((r, i) => <i key={r.g.id} className="block h-full" style={{ width: `${(r.cur / positiveTotal) * 100}%`, background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }} />)}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10.5px] font-bold text-white/95">
                {positive.map((r, i) => (
                  <span key={r.g.id} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }} />{r.g.name} {Math.round((r.cur / positiveTotal) * 100)}%</span>
                ))}
              </div>
            </>
          )}
          {currencies.length > 1 && <p className="mt-2 text-[10.5px] text-amber-100 font-bold">These groups use different currencies, so the total adds the numbers as they are.</p>}
        </>
      )}

      <div className="flex gap-2 mt-3">
        <button type="button" onClick={onAdd} className="flex-1 rounded-xl bg-white text-[#0b3b57] py-2 text-xs font-black active:scale-95">＋ Add expense</button>
        <button type="button" onClick={onAnalyse} className="flex-1 rounded-xl bg-white/20 py-2 text-xs font-black active:scale-95">📊 Analyse this set</button>
      </div>
    </div>
  );
}
