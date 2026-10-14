// Reads a PhonePe payment receipt out of the text the phone recognised in the shared image.
// Works from labels (anchor text such as "Paid to", "Debited from", "Transaction ID"), never from pixel
// positions — a different screen size or font scale must not break it. Everything returned is a
// best guess that the user reviews and edits before anything is saved.
import type { SharedLine, SharedReceipt } from './receiptShare';

export interface ParsedReceipt {
  isPhonePe: boolean;
  status: 'success' | 'failed' | 'pending' | 'unknown';
  direction: 'paid' | 'received' | 'unknown';
  amount: string; // digits with optional decimals, no symbol or commas
  amountSure: boolean; // matches what was debited, and no other reading fits as well
  alternatives: string[]; // when two readings both fit (e.g. 90 vs 790), both are offered to the user
  payee: string;
  upiId: string;
  txnId: string;
  utr: string; // bank reference, shown for payments from a bank account
  paidFrom: string;
  kind: 'payment' | 'bill'; // a normal "Paid to" payment, or a bill / recharge payment
  billType: string; // e.g. "Mobile bill" (bills only)
  reference: string; // the number the bill was for (mobile number, consumer number …)
  categoryHint: string; // an expense category id when the payee makes it obvious, else ''
  message: string;
  date: string; // YYYY-MM-DD
  time: string; // e.g. "03:45 PM"
  notes: string[]; // anything the user should double-check
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// A line that is just an amount: "₹202", "Rs. 1,250.50", or a bare "202". The phone's text reader often mangles
// the ₹ sign — dropping it, or reading it as a stray letter or digit ("F683.87", "7683.87") — so ANY single
// leading character is tolerated. At most 8 digits before the decimals keeps long ids (transaction ids, UTRs)
// from being mistaken for amounts.
const MONEY_LINE = /^(₹|Rs\.?|INR|[^\d\s.,])?\s*(\d{1,8}(?:,\d{2,3})*(?:\.\d{1,2})?)$/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parsePhonePeReceipt(share: SharedReceipt): ParsedReceipt {
  const out: ParsedReceipt = {
    isPhonePe: false, status: 'unknown', direction: 'unknown', amount: '', amountSure: false, alternatives: [],
    payee: '', upiId: '', txnId: '', utr: '', paidFrom: '', kind: 'payment', billType: '', reference: '', categoryHint: '', message: '', date: '', time: '', notes: [],
  };

  // Reading order: top to bottom, left to right within a row.
  const lines: string[] = (share.lines && share.lines.length > 0
    ? [...share.lines].sort((a: SharedLine, b: SharedLine) => a.top - b.top || a.left - b.left).map((l) => norm(l.text))
    : (share.ocrText || share.text || '').split(/\r?\n/).map(norm)
  ).filter(Boolean);
  const all = lines.join('\n');

  out.isPhonePe = /phonepe/i.test(all) || /phonepe/i.test(share.referrer || '');

  if (/transaction\s+successful|payment\s+successful/i.test(all)) out.status = 'success';
  else if (/fail|declined|unsuccessful/i.test(all)) out.status = 'failed';
  else if (/pending|processing/i.test(all)) out.status = 'pending';

  if (/\bpaid\s+to\b/i.test(all)) out.direction = 'paid';
  else if (/received\s+from|credited\s+to/i.test(all)) out.direction = 'received';

  // Date + time: "03:45 PM on 14 Oct 2026"
  const dm = all.match(/(\d{1,2}:\d{2}\s*[AP]M)\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (dm) {
    const mm = MONTHS[dm[3].slice(0, 3).toLowerCase()];
    if (mm) out.date = `${dm[4]}-${mm}-${dm[2].padStart(2, '0')}`;
    out.time = dm[1].toUpperCase().replace(/\s+/g, ' ');
  }

  // Everything between "Paid to" and "Transfer Details" is the payee block: name, UPI id, amount.
  const paidIdx = lines.findIndex((l) => /^paid\s+to$/i.test(l));
  const endIdx = lines.findIndex((l, i) => i > paidIdx && /(transfer|payment|bill)\s+details|transaction\s*id|^debited\s+from$/i.test(l));
  const block = paidIdx >= 0 ? lines.slice(paidIdx + 1, endIdx > paidIdx ? endIdx : paidIdx + 8) : [];

  const nameLines: string[] = [];
  const upiParts: string[] = [];
  for (const l of block) {
    if (MONEY_LINE.test(l)) continue; // the amount shown on the right of the payee row
    if (l.includes('@')) { upiParts.push(l); continue; }
    if (/^[A-Z0-9-]{8,}$/.test(l) && !/\s/.test(l) && upiParts.length === 0 && nameLines.length > 0) { upiParts.push(l); continue; } // first half of a wrapped UPI id
    if (l.length <= 3) continue; // the round avatar's initials
    if (upiParts.length > 0) { if (!upiParts.join('').includes('@')) upiParts.push(l); continue; } // second half of a wrapped UPI id (never anything after a complete one)
    nameLines.push(l);
  }
  out.payee = nameLines.join(' ');
  out.upiId = upiParts.join('').replace(/\s+/g, '');

  // Bill / recharge payments have no "Paid to": the heading reads e.g. "Mobile bill paid", followed by the
  // biller's name ("Vi Postpaid") and the number the bill was for.
  if (!out.payee) {
    const hIdx = lines.findIndex((l) => /(bill\s+paid|recharge)/i.test(l) && !/successful|details/i.test(l));
    if (hIdx >= 0) {
      out.kind = 'bill';
      out.billType = lines[hIdx].replace(/\s*paid$/i, '').trim();
      if (out.direction === 'unknown') out.direction = 'paid';
      for (const l of lines.slice(hIdx + 1, hIdx + 6)) {
        if (/details$|^bill (number|date)$/i.test(l)) break;
        if (MONEY_LINE.test(l) && !/\d{8,}/.test(l)) continue;
        if (/^\d{6,14}$/.test(l)) { out.reference = l; continue; }
        if (!out.payee && l.length > 3) out.payee = l;
      }
    }
  }

  // A category suggestion when the payee makes it obvious (the user can always change it).
  const CATEGORY_HINTS: Array<[RegExp, string]> = [
    [/blinkit|blink commerce|zepto|instamart|bigbasket|dmart|grofers|jiomart|reliance (fresh|smart)/i, 'groceries'],
    [/swiggy|zomato|domino|mcdonald|kfc|starbucks|pizza|cafe|restaurant/i, 'food'],
    [/uber|ola\b|rapido|irctc|redbus|metro|fastag|petrol|fuel|indian oil|bharat petroleum|hp pay/i, 'travel'],
    [/amazon|flipkart|myntra|ajio|meesho|nykaa/i, 'shopping'],
    [/apollo|pharm|medplus|netmeds|1mg|hospital|clinic|diagnostic/i, 'health'],
    [/florist|flower|archies|ferns n petals|fnp|gift/i, 'gifts'],
    [/netflix|hotstar|spotify|prime video|bookmyshow|pvr|inox|sony ?liv|zee5/i, 'ent'],
    [/airtel|jio|vodafone|\bvi\b|bsnl|electricity|bescom|tata power|adani|water|gas|broadband|dth|tata play|recharge/i, 'bills'],
  ];
  if (out.kind === 'bill') out.categoryHint = 'bills';
  else {
    const hit = CATEGORY_HINTS.find(([re]) => re.test(out.payee) || re.test(out.upiId));
    if (hit) out.categoryHint = hit[1];
  }

  // Transaction id: the line after the label (or the long T-number anywhere).
  const tIdx = lines.findIndex((l) => /transaction\s*id|utr|ref(erence)?\s*no/i.test(l));
  if (tIdx >= 0) {
    const same = lines[tIdx].match(/[A-Z]?\d{10,}[A-Z0-9]*/);
    const next = lines[tIdx + 1]?.match(/^[A-Z0-9]{10,}$/i);
    out.txnId = same ? same[0] : next ? next[0] : '';
  }
  if (!out.txnId) {
    const t = all.match(/\bT\d{15,}\b/);
    if (t) out.txnId = t[0];
  }

  const um = all.match(/UTR[:\s]*([0-9]{10,})/i);
  if (um) out.utr = um[1];

  // Debited from: the account / wallet that paid
  const dIdx = lines.findIndex((l) => /^debited\s+from$/i.test(l));
  if (dIdx >= 0) {
    const sources: string[] = [];
    for (const l of lines.slice(dIdx + 1, dIdx + 8)) {
      if (/^(utr|powered by|upi|unified)/i.test(l) || /bank$/i.test(l) && sources.length > 0) break;
      if (MONEY_LINE.test(l) || l.length <= 2) continue;
      sources.push(l);
      if (sources.length === 3) break;
    }
    out.paidFrom = sources.join(' + ');
  }

  const mIdx = lines.findIndex((l) => /^message$/i.test(l));
  if (mIdx >= 0 && lines[mIdx + 1] && !/transaction\s*id/i.test(lines[mIdx + 1])) out.message = lines[mIdx + 1];

  // Amount: the figure shown beside the payee must equal what was debited — from one source, or several added
  // together (a payment can be split between the wallet and a bank). The phone's text reader often mangles the ₹ sign
  // into a leading digit ("790" for ₹90, "733.02" for ₹33.02), so every figure is tried both as read and with its first
  // character dropped, and the reading where header = sum of debits wins.
  type Tok = { value: string; line: number };
  const toks: Tok[] = [];
  lines.forEach((l, i) => {
    const m = l.match(MONEY_LINE);
    if (m) toks.push({ value: m[2].replace(/,/g, ''), line: i });
  });
  const cents = (v: string) => Math.round(parseFloat(v) * 100);
  // Only a leading 7, 2 or 3 can be a ₹ sign read as a digit; any other first digit is a real part of the amount.
  const stripped = (v: string) => (v.length > 1 && '723'.includes(v[0]) && /^\d/.test(v.slice(1)) ? v.slice(1) : v);
  const headerTok = toks.find((t) => dIdx < 0 || t.line < dIdx);
  const debitToks = dIdx >= 0 ? toks.filter((t) => t.line > dIdx) : [];
  let resolved = false;
  if (headerTok && debitToks.length > 0 && debitToks.length <= 3) {
    const group = [headerTok, ...debitToks];
    // try the fewest "dropped first character" readings first
    const masks = Array.from({ length: 1 << group.length }, (_, i) => i).sort((x, y) => x.toString(2).replace(/0/g, '').length - y.toString(2).replace(/0/g, '').length);
    const fits: string[] = [];
    for (const mask of masks) {
      const vals = group.map((t, i) => (mask & (1 << i) ? stripped(t.value) : t.value));
      if (vals.some((v) => /^0\d/.test(v))) continue; // "02" is a chopped "202", not a real amount
      const sum = vals.slice(1).reduce((acc, v) => acc + cents(v), 0);
      if (cents(vals[0]) === sum && sum > 0 && !fits.includes(vals[0])) fits.push(vals[0]);
    }
    if (fits.length > 0) {
      // Usually exactly one reading fits. If several do (the same stray digit sits in front of both the total
      // and a debit — 790 = 733.02 + 56.98 and 90 = 33.02 + 56.98), start with the smallest and offer all.
      fits.sort((a, b) => cents(a) - cents(b));
      out.amount = fits[0];
      out.amountSure = fits.length === 1;
      if (fits.length > 1) out.alternatives = fits;
      resolved = true;
    }
  }
  if (!resolved) {
    // No consistent reading: fall back to the figure that repeats, else the first one near the payee.
    const canon = (v: string) => {
      const shorter = toks.find((u) => u.value !== v && v.length === u.value.length + 1 && v.slice(1) === u.value);
      return shorter ? shorter.value : v;
    };
    const rt = toks.map((t) => ({ ...t, value: canon(t.value) }));
    const counts = new Map<string, number>();
    rt.forEach((t) => counts.set(t.value, (counts.get(t.value) || 0) + 1));
    const repeated = rt.find((t) => (counts.get(t.value) || 0) >= 2);
    const inBlock = rt.find((t) => paidIdx >= 0 && t.line > paidIdx && (endIdx < 0 || t.line < endIdx));
    const pick = repeated || inBlock || rt[0];
    if (pick) {
      out.amount = pick.value;
      out.amountSure = !!repeated;
    }
  }

  if (!out.isPhonePe) out.notes.push("This doesn't look like a PhonePe receipt.");
  if (out.status !== 'success') out.notes.push(out.status === 'unknown' ? "Couldn't confirm the payment succeeded." : `Payment status looks ${out.status} — check before saving.`);
  if (out.direction === 'received') out.notes.push('This looks like money you received, not a payment you made.');
  if (!out.amount) out.notes.push("Couldn't read the amount.");
  else if (out.alternatives.length > 1) out.notes.push(`The amount could be ${out.alternatives.map((a) => '₹' + a).join(' or ')} — tap the right one.`);
  else if (!out.amountSure) out.notes.push('Please double-check the amount.');
  if (!out.payee) out.notes.push("Couldn't read who was paid.");
  return out;
}

// A stable key for "who was paid", used to remember what the user calls this payee (and its category).
// The UPI id is the real identity of a payee; bills use the biller + the number the bill was for.
export function payeeKey(p: ParsedReceipt): string {
  const raw = p.upiId.includes('@')
    ? p.upiId
    : p.kind === 'bill' && p.payee
    ? `bill:${p.payee}:${p.reference}`
    : p.payee
    ? `name:${p.payee}`
    : '';
  return raw.toLowerCase().replace(/[^a-z0-9@._:-]+/g, '_').slice(0, 120);
}
