import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FavoriteButton } from './FavoriteButton';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';
import { CALC_KEY_ROWS, pressCalcKey } from '../lib/calculatorLogic';

// The Finance page: what you're owed / owe at the top, the next policy renewal and your expense reminders as cards,
// a working calculator right on the page, and the bigger financial calculators below. Everything shown is read from
// small lists the Finance tools already use (own loan contacts, own policies, own reminders).
export default function FinanceHome() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const today = todayLocalDateString();

  const [myContactsValue] = useCollection(user ? query(collection(db, 'loanContacts'), where('ownerId', '==', user.uid)) : null);
  const [theirContactsValue] = useCollection(user ? query(collection(db, 'loanContacts'), where('linkedUserId', '==', user.uid)) : null);
  const [policiesValue] = useCollection(user ? query(collection(db, 'policies'), where('userId', '==', user.uid)) : null);
  const [remindersValue] = useCollection(user ? query(collection(db, 'expenseReminders'), where('userId', '==', user.uid)) : null);

  // Balances from MY side: a contact I own stores it as-is (positive = they owe me); a contact where I'm the linked
  // person stores the owner's side, so mine is the negation. Bucketed per currency, never blended.
  const loans = useMemo(() => {
    const owed: Record<string, number> = {};
    const owe: Record<string, number> = {};
    let open = 0;
    const add = (docs: any[] | undefined, isOwner: boolean) =>
      (docs || []).forEach((d) => {
        const c = d.data() as any;
        const bal = isOwner ? c.balance : -c.balance;
        if (!bal || Math.abs(bal) <= 0.01) return;
        open += 1;
        const cur = c.currency || 'INR';
        if (bal > 0) owed[cur] = (owed[cur] || 0) + bal;
        else owe[cur] = (owe[cur] || 0) - bal;
      });
    add(myContactsValue?.docs, true);
    add(theirContactsValue?.docs, false);
    return { owed, owe, open };
  }, [myContactsValue, theirContactsValue]);

  const fmt = (m: Record<string, number>) =>
    Object.entries(m).length === 0
      ? `${getCurrencySymbol(profile?.currency)}0`
      : Object.entries(m).map(([cur, amt]) => `${getCurrencySymbol(cur)}${formatAmountCompact(amt, undefined, profile?.numberSystem)}`).join(' + ');

  const nextRenewal = useMemo(() => {
    const policies = (policiesValue?.docs || []).map((d) => d.data() as any).filter((p) => p.status !== 'archived');
    const dated = policies.filter((p) => p.renewalDate).map((p) => p.renewalDate as string).sort();
    const upcoming = dated.find((d) => d >= today);
    const overdue = dated.filter((d) => d < today).length;
    const days = upcoming ? Math.round((new Date(upcoming + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000) : null;
    return { count: policies.length, days, overdue };
  }, [policiesValue, today]);

  const activeReminders = (remindersValue?.docs || []).filter((d) => (d.data() as any).active !== false).length;

  // Calculator
  const [expression, setExpression] = useState('');
  const [justEvaluated, setJustEvaluated] = useState(false);
  const press = (key: string) => {
    const next = pressCalcKey(expression, justEvaluated, key);
    setExpression(next.expression);
    setJustEvaluated(next.justEvaluated);
  };

  const owedText = Object.keys(loans.owed).length > 0 ? `You're owed ${fmt(loans.owed)}` : loans.open > 0 ? 'Nobody owes you' : 'No open loans';
  const policyTag = nextRenewal.overdue > 0
    ? { text: `${nextRenewal.overdue} renewal${nextRenewal.overdue === 1 ? '' : 's'} overdue`, cls: 'bg-red-50 text-red-700' }
    : nextRenewal.days !== null
    ? { text: nextRenewal.days === 0 ? 'Renews today' : `Renews in ${nextRenewal.days} day${nextRenewal.days === 1 ? '' : 's'}`, cls: nextRenewal.days <= 30 ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700' }
    : { text: nextRenewal.count > 0 ? `${nextRenewal.count} polic${nextRenewal.count === 1 ? 'y' : 'ies'}` : 'Add your first', cls: 'bg-slate-100 text-slate-600' };

  const card = (to: string, icon: string, bg: string, title: string, sub: string, tag: { text: string; cls: string } | null, favKey: string) => (
    <div role="button" tabIndex={0} onClick={() => navigate(to)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(to); }} className="flex items-center gap-3 rounded-3xl bg-white border border-slate-200 p-3.5 shadow-sm cursor-pointer active:scale-[0.99] transition-transform">
      <div className={clsx('w-11 h-11 rounded-2xl flex items-center justify-center text-xl shrink-0', bg)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-black text-slate-900">{title}</p>
        <p className="text-[10.5px] font-semibold text-slate-500">{sub}</p>
      </div>
      {tag && <span className={clsx('text-[9px] font-extrabold px-2.5 py-1 rounded-full whitespace-nowrap', tag.cls)}>{tag.text}</span>}
      <FavoriteButton itemKey={favKey} />
    </div>
  );

  return (
    <div className="space-y-3">
      <div role="button" tabIndex={0} onClick={() => navigate('/personal-loans')} onKeyDown={(e) => { if (e.key === 'Enter') navigate('/personal-loans'); }} className="relative overflow-hidden rounded-3xl p-4 pr-24 text-white shadow-md cursor-pointer active:scale-[0.99] transition-transform" style={{ background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' }}>
        <p className="text-[15px] font-black">Personal loans</p>
        <p className="text-[10.5px] font-bold text-white/85">Money lent and borrowed</p>
        <p className="text-[24px] font-black leading-tight mt-2">{owedText}</p>
        <p className="text-[11px] font-bold text-white/85 mt-0.5">{Object.keys(loans.owe).length > 0 ? `You owe ${fmt(loans.owe)} · ` : ''}{loans.open} open loan{loans.open === 1 ? '' : 's'}</p>
        <span className="absolute right-3 bottom-1 text-[52px] leading-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.35)]">🤝</span>
        <span className="absolute right-2 top-2"><FavoriteButton itemKey="personal-loans" className="!text-white/80" /></span>
      </div>

      {card('/policies', '🛡️', 'bg-blue-50', t('tools.policyVault'), 'Insurance & renewals', policyTag, 'policy-vault')}
      {card('/expense-reminders', '🔔', 'bg-amber-50', t('tools.expenseReminders'), 'Get nudged to log irregular spends', activeReminders > 0 ? { text: `${activeReminders} active`, cls: 'bg-teal-50 text-teal-700' } : null, 'expense-reminders')}

      <div className="rounded-3xl bg-white border border-slate-200 p-3 shadow-sm">
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-[10px] font-black tracking-[0.12em] text-slate-500">CALCULATOR</p>
          <FavoriteButton itemKey="calculator" />
        </div>
        <div className="bg-slate-900 text-white rounded-2xl px-4 py-3 text-right min-h-[56px] flex items-end justify-end">
          <span className="text-[26px] font-black tracking-tight break-all leading-tight">{expression || '0'}</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 mt-2">
          {CALC_KEY_ROWS.flat().map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              className={clsx(
                'py-2.5 rounded-xl text-[15px] font-extrabold active:scale-95 transition-transform',
                key === '0' && 'col-span-2',
                key === '=' && 'bg-blue-800 text-white',
                key === 'C' && 'bg-red-50 text-red-600',
                key === '⌫' && 'bg-slate-100 text-slate-500',
                ['+', '-', '×', '÷', '%'].includes(key) && 'bg-teal-50 text-teal-700',
                /^[0-9.]$/.test(key) && 'bg-slate-100 text-slate-800',
              )}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      {card('/financial-calculators', '🏦', 'bg-emerald-50', t('tools.financialCalculators'), 'Loans, FD/RD, SIP, SWP, NPS & more', null, 'financial-calculators')}
    </div>
  );
}
