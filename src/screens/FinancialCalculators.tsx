import React, { useState } from 'react';
import { clsx } from 'clsx';
import {
  simpleInterest,
  compoundInterest,
  calculateEmi,
  loanAmortizationSchedule,
  fdMaturity,
  rdMaturity,
  sipFutureValue,
  swpSimulation,
  npsProjection,
  requiredSimpleRate,
  requiredCompoundRate,
} from '../lib/financialMath';
import { useLanguage } from '../context/LanguageContext';

const money = (n: number) =>
  '₹' + (isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

function NumField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{label}</label>
      <div className="flex items-center bg-surface rounded-xl border border-border-subtle px-3">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 h-11 bg-transparent outline-none text-sm font-bold text-on-surface min-w-0"
        />
        {suffix && <span className="text-xs font-bold text-text-muted shrink-0 pl-2">{suffix}</span>}
      </div>
    </div>
  );
}

function ResultRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={clsx('flex items-center justify-between py-2', emphasis && 'border-t border-border-subtle mt-1 pt-3')}>
      <span className={clsx('text-xs', emphasis ? 'font-bold text-primary' : 'text-text-muted')}>{label}</span>
      <span className={clsx('font-bold', emphasis ? 'text-lg text-primary' : 'text-sm text-on-surface')}>{value}</span>
    </div>
  );
}

const n = (s: string) => parseFloat(s) || 0;

function LoanBasicCalc() {
  const { t } = useLanguage();
  const [principal, setPrincipal] = useState('1000000');
  const [rate, setRate] = useState('9');
  const [years, setYears] = useState('20');
  const { emi, totalPayment, totalInterest } = calculateEmi(n(principal), n(rate), n(years) * 12);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.loanAmount')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.monthlyEmi')} value={money(emi)} emphasis />
        <ResultRow label={t('fincalc.totalInterest')} value={money(totalInterest)} />
        <ResultRow label={t('fincalc.totalPayment')} value={money(totalPayment)} />
      </div>
    </div>
  );
}

function LoanAdvancedCalc() {
  const { t } = useLanguage();
  const [principal, setPrincipal] = useState('1000000');
  const [rate, setRate] = useState('9');
  const [years, setYears] = useState('20');
  const months = n(years) * 12;
  const { emi, totalPayment, totalInterest } = calculateEmi(n(principal), n(rate), months);
  const schedule = loanAmortizationSchedule(n(principal), n(rate), months);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.loanAmount')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.monthlyEmi')} value={money(emi)} emphasis />
        <ResultRow label={t('fincalc.totalInterest')} value={money(totalInterest)} />
        <ResultRow label={t('fincalc.totalPayment')} value={money(totalPayment)} />
      </div>
      <div className="space-y-1">
        <h3 className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('fincalc.yearlyBreakdown')}</h3>
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface text-text-muted">
                <th className="text-left font-bold px-3 py-2">{t('fincalc.year')}</th>
                <th className="text-right font-bold px-3 py-2">{t('fincalc.principal')}</th>
                <th className="text-right font-bold px-3 py-2">{t('fincalc.interest')}</th>
                <th className="text-right font-bold px-3 py-2">{t('fincalc.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((row) => (
                <tr key={row.year} className="border-t border-border-subtle">
                  <td className="px-3 py-2 font-bold text-primary">{row.year}</td>
                  <td className="px-3 py-2 text-right">{money(row.principalPaid)}</td>
                  <td className="px-3 py-2 text-right">{money(row.interestPaid)}</td>
                  <td className="px-3 py-2 text-right">{money(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FDCalc() {
  const { t } = useLanguage();
  const [principal, setPrincipal] = useState('100000');
  const [rate, setRate] = useState('7');
  const [years, setYears] = useState('5');
  const [compounding, setCompounding] = useState('4');
  const { interest, total } = fdMaturity(n(principal), n(rate), n(years), n(compounding));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.depositAmount')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('fincalc.compounding')}</label>
          <select
            value={compounding}
            onChange={(e) => setCompounding(e.target.value)}
            className="w-full h-11 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold outline-none"
          >
            <option value="1">{t('fincalc.yearlyOpt')}</option>
            <option value="2">{t('fincalc.halfYearlyOpt')}</option>
            <option value="4">{t('fincalc.quarterlyOpt')}</option>
            <option value="12">{t('fincalc.monthlyOpt')}</option>
          </select>
        </div>
      </div>
      <div>
        <ResultRow label={t('fincalc.maturityValue')} value={money(total)} emphasis />
        <ResultRow label={t('fincalc.interestEarned')} value={money(interest)} />
      </div>
    </div>
  );
}

function RDCalc() {
  const { t } = useLanguage();
  const [monthly, setMonthly] = useState('5000');
  const [rate, setRate] = useState('6.5');
  const [years, setYears] = useState('5');
  const { maturity, totalDeposited, interest } = rdMaturity(n(monthly), n(rate), n(years) * 12);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.monthlyDeposit')} value={monthly} onChange={setMonthly} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.maturityValue')} value={money(maturity)} emphasis />
        <ResultRow label={t('fincalc.totalDeposited')} value={money(totalDeposited)} />
        <ResultRow label={t('fincalc.interestEarned')} value={money(interest)} />
      </div>
      <p className="text-[10px] text-text-muted px-1">{t('fincalc.rdApprox')}</p>
    </div>
  );
}

function InterestRateCalc() {
  const { t } = useLanguage();
  const [type, setType] = useState<'simple' | 'compound'>('simple');
  const [principal, setPrincipal] = useState('100000');
  const [maturity, setMaturity] = useState('150000');
  const [years, setYears] = useState('5');
  const rate =
    type === 'simple'
      ? requiredSimpleRate(n(principal), n(maturity), n(years))
      : requiredCompoundRate(n(principal), n(maturity), n(years));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(['simple', 'compound'] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setType(opt)}
            className={clsx(
              'h-10 rounded-xl text-xs font-bold border',
              type === opt ? 'bg-primary text-white border-primary' : 'bg-white border-border-subtle text-on-surface',
            )}
          >
            {opt === 'simple' ? t('fincalc.simpleInterest') : t('fincalc.compoundInterest')}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.principal')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.targetMaturity')} value={maturity} onChange={setMaturity} suffix="₹" />
      </div>
      <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.requiredRate')} value={rate !== null ? `${rate.toFixed(2)}%` : '—'} emphasis />
      </div>
    </div>
  );
}

function SIPCalc() {
  const { t } = useLanguage();
  const [monthly, setMonthly] = useState('10000');
  const [rate, setRate] = useState('12');
  const [years, setYears] = useState('15');
  const { futureValue, invested, gains } = sipFutureValue(n(monthly), n(rate), n(years) * 12);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.monthlyInvestment')} value={monthly} onChange={setMonthly} suffix="₹" />
        <NumField label={t('fincalc.expectedReturn')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <NumField label={t('fincalc.duration')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.futureValue')} value={money(futureValue)} emphasis />
        <ResultRow label={t('fincalc.investedAmount')} value={money(invested)} />
        <ResultRow label={t('fincalc.wealthGained')} value={money(gains)} />
      </div>
    </div>
  );
}

function SWPCalc() {
  const { t } = useLanguage();
  const [corpus, setCorpus] = useState('2000000');
  const [withdrawal, setWithdrawal] = useState('15000');
  const [rate, setRate] = useState('8');
  const { monthsLasted, yearly, finalBalance, depleted } = swpSimulation(n(corpus), n(withdrawal), n(rate));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.startingCorpus')} value={corpus} onChange={setCorpus} suffix="₹" />
        <NumField label={t('fincalc.monthlyWithdrawal')} value={withdrawal} onChange={setWithdrawal} suffix="₹" />
      </div>
      <NumField label={t('fincalc.expectedReturn')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      <div>
        <ResultRow
          label={depleted ? t('fincalc.corpusLasts') : t('fincalc.corpusAfter50')}
          value={depleted && monthsLasted ? `${Math.floor(monthsLasted / 12)}y ${monthsLasted % 12}m` : money(finalBalance)}
          emphasis
        />
        {!depleted && <ResultRow label={t('fincalc.status')} value={t('fincalc.sustainable')} />}
      </div>
      {yearly.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('fincalc.balanceByYear')}</h3>
          <div className="overflow-x-auto rounded-xl border border-border-subtle max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {yearly.map((row) => (
                  <tr key={row.year} className="border-t border-border-subtle first:border-t-0">
                    <td className="px-3 py-1.5 font-bold text-primary">{t('fincalc.yearN', { n: row.year })}</td>
                    <td className="px-3 py-1.5 text-right">{money(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function NPSCalc() {
  const { t } = useLanguage();
  const [currentAge, setCurrentAge] = useState('30');
  const [retirementAge, setRetirementAge] = useState('60');
  const [monthly, setMonthly] = useState('5000');
  const [rate, setRate] = useState('10');
  const [annuityPercent, setAnnuityPercent] = useState('40');
  const [annuityRate, setAnnuityRate] = useState('6');
  const { corpus, invested, lumpSum, annuityCorpus, monthlyPension } = npsProjection(
    n(currentAge),
    n(retirementAge),
    n(monthly),
    n(rate),
    n(annuityPercent),
    n(annuityRate),
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.currentAge')} value={currentAge} onChange={setCurrentAge} suffix={t('fincalc.yrsSuffix')} />
        <NumField label={t('fincalc.retirementAge')} value={retirementAge} onChange={setRetirementAge} suffix={t('fincalc.yrsSuffix')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.monthlyContribution')} value={monthly} onChange={setMonthly} suffix="₹" />
        <NumField label={t('fincalc.expectedReturn')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.annuityPortion')} value={annuityPercent} onChange={setAnnuityPercent} suffix="%" />
        <NumField label={t('fincalc.annuityRate')} value={annuityRate} onChange={setAnnuityRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <div>
        <ResultRow label={t('fincalc.totalCorpusAtRetirement')} value={money(corpus)} emphasis />
        <ResultRow label={t('fincalc.investedAmount')} value={money(invested)} />
        <ResultRow label={t('fincalc.lumpSumWithdrawal')} value={money(lumpSum)} />
        <ResultRow label={t('fincalc.annuityCorpus')} value={money(annuityCorpus)} />
        <ResultRow label={t('fincalc.estimatedMonthlyPension')} value={money(monthlyPension)} />
      </div>
    </div>
  );
}

function CompoundInterestCalc() {
  const { t } = useLanguage();
  const [principal, setPrincipal] = useState('100000');
  const [rate, setRate] = useState('8');
  const [years, setYears] = useState('10');
  const [compounding, setCompounding] = useState('1');
  const { interest, total } = compoundInterest(n(principal), n(rate), n(years), n(compounding));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.principal')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('fincalc.compounding')}</label>
          <select
            value={compounding}
            onChange={(e) => setCompounding(e.target.value)}
            className="w-full h-11 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold outline-none"
          >
            <option value="1">{t('fincalc.yearlyOpt')}</option>
            <option value="2">{t('fincalc.halfYearlyOpt')}</option>
            <option value="4">{t('fincalc.quarterlyOpt')}</option>
            <option value="12">{t('fincalc.monthlyOpt')}</option>
          </select>
        </div>
      </div>
      <div>
        <ResultRow label={t('fincalc.maturityValue')} value={money(total)} emphasis />
        <ResultRow label={t('fincalc.interestEarned')} value={money(interest)} />
      </div>
    </div>
  );
}

function SimpleInterestCalc() {
  const { t } = useLanguage();
  const [principal, setPrincipal] = useState('100000');
  const [rate, setRate] = useState('8');
  const [years, setYears] = useState('10');
  const { interest, total } = simpleInterest(n(principal), n(rate), n(years));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumField label={t('fincalc.principal')} value={principal} onChange={setPrincipal} suffix="₹" />
        <NumField label={t('fincalc.interestRate')} value={rate} onChange={setRate} suffix={t('fincalc.paSuffix')} />
      </div>
      <NumField label={t('fincalc.tenure')} value={years} onChange={setYears} suffix={t('fincalc.yearsSuffix')} />
      <div>
        <ResultRow label={t('fincalc.totalValue')} value={money(total)} emphasis />
        <ResultRow label={t('fincalc.interestEarned')} value={money(interest)} />
      </div>
    </div>
  );
}

type CalcId = 'loan-basic' | 'loan-advanced' | 'fd' | 'rd' | 'interest-rate' | 'sip' | 'swp' | 'nps' | 'compound' | 'simple';

const BANK_CALCS: { id: CalcId; labelKey: string; icon: string }[] = [
  { id: 'loan-basic', labelKey: 'fincalc.loanBasic', icon: 'request_quote' },
  { id: 'loan-advanced', labelKey: 'fincalc.loanAdvanced', icon: 'account_balance' },
  { id: 'fd', labelKey: 'fincalc.fixedDeposit', icon: 'savings' },
  { id: 'rd', labelKey: 'fincalc.recurringDeposit', icon: 'event_repeat' },
  { id: 'interest-rate', labelKey: 'fincalc.interestRate', icon: 'percent' },
];

const INVESTMENT_CALCS: { id: CalcId; labelKey: string; icon: string }[] = [
  { id: 'sip', labelKey: 'fincalc.sip', icon: 'trending_up' },
  { id: 'swp', labelKey: 'fincalc.swp', icon: 'trending_down' },
  { id: 'nps', labelKey: 'fincalc.nps', icon: 'elderly' },
  { id: 'compound', labelKey: 'fincalc.compoundInterest', icon: 'functions' },
  { id: 'simple', labelKey: 'fincalc.simpleInterest', icon: 'calculate' },
];

export default function FinancialCalculators() {
  const { t } = useLanguage();
  const [activeCalc, setActiveCalc] = useState<CalcId>('loan-basic');

  const renderChips = (calcs: typeof BANK_CALCS) => (
    <div className="flex flex-wrap gap-2">
      {calcs.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => setActiveCalc(c.id)}
          className={clsx(
            'px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition-all',
            activeCalc === c.id
              ? 'bg-primary text-white border-primary'
              : 'bg-white border-border-subtle text-on-surface hover:bg-surface-container',
          )}
        >
          <span className="material-symbols-outlined text-[16px]">{c.icon}</span>
          {t(c.labelKey)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.financialCalculators')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('fincalc.subtitle')}</p>
        </div>

        <div className="space-y-2" data-tour="fincalc-chips">
          <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">{t('fincalc.bank')}</h2>
          {renderChips(BANK_CALCS)}
        </div>

        <div className="space-y-2">
          <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">{t('fincalc.investment')}</h2>
          {renderChips(INVESTMENT_CALCS)}
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle p-5 shadow-sm" data-tour="fincalc-result">
          {activeCalc === 'loan-basic' && <LoanBasicCalc />}
          {activeCalc === 'loan-advanced' && <LoanAdvancedCalc />}
          {activeCalc === 'fd' && <FDCalc />}
          {activeCalc === 'rd' && <RDCalc />}
          {activeCalc === 'interest-rate' && <InterestRateCalc />}
          {activeCalc === 'sip' && <SIPCalc />}
          {activeCalc === 'swp' && <SWPCalc />}
          {activeCalc === 'nps' && <NPSCalc />}
          {activeCalc === 'compound' && <CompoundInterestCalc />}
          {activeCalc === 'simple' && <SimpleInterestCalc />}
        </div>
      </main>
    </div>
  );
}
