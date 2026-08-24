// Pure calculation functions for the Financial Calculators screen. No I/O, no React — kept
// separate so each formula can be reasoned about (and unit-tested) on its own.

export function simpleInterest(principal: number, ratePercent: number, years: number) {
  const interest = (principal * ratePercent * years) / 100;
  return { interest, total: principal + interest };
}

export function compoundInterest(principal: number, ratePercent: number, years: number, compoundsPerYear: number) {
  const r = ratePercent / 100;
  const amount = principal * Math.pow(1 + r / compoundsPerYear, compoundsPerYear * years);
  return { interest: amount - principal, total: amount };
}

// Standard reducing-balance EMI: EMI = P × r × (1+r)^n / ((1+r)^n − 1), r = monthly rate.
export function calculateEmi(principal: number, annualRatePercent: number, months: number) {
  const r = annualRatePercent / 12 / 100;
  if (months <= 0 || principal <= 0) return { emi: 0, totalPayment: 0, totalInterest: 0 };
  if (r === 0) {
    const emi = principal / months;
    return { emi, totalPayment: principal, totalInterest: 0 };
  }
  const factor = Math.pow(1 + r, months);
  const emi = (principal * r * factor) / (factor - 1);
  const totalPayment = emi * months;
  return { emi, totalPayment, totalInterest: totalPayment - principal };
}

export interface AmortizationYear {
  year: number;
  principalPaid: number;
  interestPaid: number;
  balance: number;
}

// Year-by-year principal/interest split for a reducing-balance loan — the "advanced" view on
// top of the basic EMI-only output.
export function loanAmortizationSchedule(principal: number, annualRatePercent: number, months: number): AmortizationYear[] {
  const r = annualRatePercent / 12 / 100;
  const { emi } = calculateEmi(principal, annualRatePercent, months);
  let balance = principal;
  const yearly: AmortizationYear[] = [];
  let yearPrincipal = 0;
  let yearInterest = 0;
  for (let m = 1; m <= months; m++) {
    const interestPortion = balance * r;
    const principalPortion = Math.min(emi - interestPortion, balance);
    balance = Math.max(0, balance - principalPortion);
    yearPrincipal += principalPortion;
    yearInterest += interestPortion;
    if (m % 12 === 0 || m === months) {
      yearly.push({ year: Math.ceil(m / 12), principalPaid: yearPrincipal, interestPaid: yearInterest, balance });
      yearPrincipal = 0;
      yearInterest = 0;
    }
  }
  return yearly;
}

// Fixed deposit maturity — compound interest framed for typical bank FD terms (default
// quarterly compounding).
export function fdMaturity(principal: number, ratePercent: number, years: number, compoundsPerYear = 4) {
  return compoundInterest(principal, ratePercent, years, compoundsPerYear);
}

// Recurring deposit maturity — each monthly deposit compounds monthly for its own remaining
// term. This is a transparent month-wise model; real bank RDs sometimes use a quarterly-
// compounding convention that yields a slightly different figure, so this is an approximation.
export function rdMaturity(monthlyDeposit: number, ratePercent: number, months: number) {
  const monthlyRate = ratePercent / 100 / 12;
  let maturity = 0;
  for (let m = 1; m <= months; m++) {
    maturity += monthlyDeposit * Math.pow(1 + monthlyRate, months - m + 1);
  }
  const totalDeposited = monthlyDeposit * months;
  return { maturity, totalDeposited, interest: maturity - totalDeposited };
}

// SIP future value: FV = P × [(1+r)^n − 1] / r × (1+r), monthly investment compounding monthly.
export function sipFutureValue(monthlyInvestment: number, annualRatePercent: number, months: number) {
  const r = annualRatePercent / 100 / 12;
  const futureValue =
    r === 0 ? monthlyInvestment * months : monthlyInvestment * ((Math.pow(1 + r, months) - 1) / r) * (1 + r);
  const invested = monthlyInvestment * months;
  return { futureValue, invested, gains: futureValue - invested };
}

export interface SwpYear {
  year: number;
  balance: number;
}

// SWP: starting corpus grows at the expected rate each month, then the withdrawal is taken.
// Simulated month by month (capped at maxMonths = 50 years) until depleted or the cap is hit.
export function swpSimulation(corpus: number, monthlyWithdrawal: number, annualRatePercent: number, maxMonths = 600) {
  const r = annualRatePercent / 100 / 12;
  let balance = corpus;
  let months = 0;
  const yearly: SwpYear[] = [];
  while (balance > 0 && months < maxMonths) {
    balance = balance * (1 + r) - monthlyWithdrawal;
    months++;
    if (months % 12 === 0) yearly.push({ year: months / 12, balance: Math.max(0, balance) });
  }
  return { monthsLasted: balance <= 0 ? months : null, yearly, finalBalance: Math.max(0, balance), depleted: balance <= 0 };
}

// NPS: accumulate via SIP-style monthly contributions to retirement, then split the corpus into
// a lump-sum portion and an annuity portion (default 60/40, the common NPS withdrawal rule),
// estimating a monthly pension from the annuity portion at an assumed annuity rate.
export function npsProjection(
  currentAge: number,
  retirementAge: number,
  monthlyContribution: number,
  expectedReturnPercent: number,
  annuityPercent: number,
  annuityRatePercent: number,
) {
  const months = Math.max(0, Math.round((retirementAge - currentAge) * 12));
  const { futureValue, invested } = sipFutureValue(monthlyContribution, expectedReturnPercent, months);
  const annuityCorpus = futureValue * (annuityPercent / 100);
  const lumpSum = futureValue - annuityCorpus;
  const monthlyPension = (annuityCorpus * (annuityRatePercent / 100)) / 12;
  return { corpus: futureValue, invested, lumpSum, annuityCorpus, monthlyPension };
}

// Reverse calculators: given principal, a target maturity amount, and the term, find the rate
// that would be needed to get there.
export function requiredSimpleRate(principal: number, maturityAmount: number, years: number): number | null {
  if (principal <= 0 || years <= 0) return null;
  return ((maturityAmount - principal) * 100) / (principal * years);
}

export function requiredCompoundRate(
  principal: number,
  maturityAmount: number,
  years: number,
  compoundsPerYear = 1,
): number | null {
  if (principal <= 0 || years <= 0 || maturityAmount <= 0) return null;
  const ratio = Math.pow(maturityAmount / principal, 1 / (compoundsPerYear * years));
  return (ratio - 1) * compoundsPerYear * 100;
}
