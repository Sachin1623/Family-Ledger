// Number formatting for the admin screens, in the Indian style: 12,345 below a lakh, then "2.35 L" (lakh) and "1.2 Cr" (crore),
// so a big figure reads at a glance instead of as a long run of digits. Use `inNum` for counts and amounts, `inExact` where the exact
// figure matters (it only changes the digit grouping to 1,23,456).
export function inNum(n: number, maxFrac = 0): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (a >= 10000000) return `${sign}${trim(a / 10000000)} Cr`;
  if (a >= 100000) return `${sign}${trim(a / 100000)} L`;
  return n.toLocaleString('en-IN', { maximumFractionDigits: maxFrac });
}
export const inExact = (n: number, maxFrac = 0) => n.toLocaleString('en-IN', { maximumFractionDigits: maxFrac });
