import { useEffect, useState } from 'react';
import { auth } from './firebase';

// This app's first (and, as of this writing, only) real currency-conversion capability — every
// amount everywhere else in the app displays in whatever single currency it's already denominated
// in, with no cross-currency math at all. Rates come from a small server.ts proxy (GET /api/fx-
// rates) backed by Frankfurter (api.frankfurter.dev, ECB-sourced, no key, no rate limit), which
// itself caches in Firestore for ~12h — this module ALSO caches in memory per session on top of
// that, so switching between screens that both want e.g. INR rates doesn't refetch every time.
export interface FxRates {
  base: string;
  date: string;
  rates: Record<string, number>; // units of each currency per 1 unit of `base`
}

const memoryCache = new Map<string, { rates: FxRates; fetchedAt: number }>();
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — well under the server's own ~12h cache window, just avoids a network round-trip per screen visit

export async function fetchFxRates(base: string): Promise<FxRates | null> {
  const code = base.toUpperCase();
  const cached = memoryCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < MEMORY_CACHE_TTL_MS) return cached.rates;

  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return cached?.rates || null;
    const res = await fetch(`/api/fx-rates?base=${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return cached?.rates || null;
    const rates: FxRates = await res.json();
    memoryCache.set(code, { rates, fetchedAt: Date.now() });
    return rates;
  } catch (err) {
    console.error('Failed to fetch FX rates:', err);
    return cached?.rates || null;
  }
}

// Converts `amount` (in `fromCurrency`) into `rates.base`. Returns null — never a silently wrong
// number — when `fromCurrency` isn't one the rate source tracks (e.g. AED/SAR aren't ECB-tracked,
// so they're unconvertible against ANY base here); callers must handle that by excluding/flagging
// the amount rather than guessing a 1:1 rate.
export function convertAmount(amount: number, fromCurrency: string, rates: FxRates): number | null {
  const code = fromCurrency.toUpperCase();
  if (code === rates.base) return amount;
  const rate = rates.rates[code];
  if (!rate) return null;
  return amount / rate;
}

export interface ConversionResult {
  convertedMajor: number;
  unconvertedCurrencies: string[]; // currency codes present in `buckets` that couldn't be converted (rate unavailable, or rates not loaded yet)
}

// Sums a set of same-purpose amounts that are each denominated in their OWN currency (e.g. one
// bucket per group's currency) into a single figure in `targetCurrency` — the direct fix for the
// "add raw numbers across different currencies and slap one symbol on top" bug this module exists
// to prevent (see Settlements.tsx / PersonalLoans.tsx / GoalsHub.tsx for where that bug lived).
export function convertBucketsToCurrency(
  buckets: Record<string, number>,
  targetCurrency: string,
  rates: FxRates | null,
): ConversionResult {
  let convertedMajor = 0;
  const unconvertedCurrencies: string[] = [];
  for (const [code, amount] of Object.entries(buckets)) {
    if (code.toUpperCase() === targetCurrency.toUpperCase()) {
      convertedMajor += amount;
      continue;
    }
    if (!rates) {
      unconvertedCurrencies.push(code);
      continue;
    }
    const converted = convertAmount(amount, code, rates);
    if (converted === null) unconvertedCurrencies.push(code);
    else convertedMajor += converted;
  }
  return { convertedMajor, unconvertedCurrencies };
}

// Small hook wrapper for the common case (a screen just wants "today's rates for currency X,
// refetched if X changes"). Returns null while loading or if `currency` is falsy.
export function useFxRates(currency: string | null | undefined): FxRates | null {
  const [rates, setRates] = useState<FxRates | null>(null);
  useEffect(() => {
    if (!currency) { setRates(null); return; }
    let cancelled = false;
    fetchFxRates(currency).then((r) => { if (!cancelled) setRates(r); });
    return () => { cancelled = true; };
  }, [currency]);
  return rates;
}
