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
  amountSure: boolean; // seen with a ₹ sign and matching a second amount on the receipt
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
    isPhonePe: false, status: 'unknown', direction: 'unknown', amount: '', amountSure: false,
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
  const endIdx = lines.findIndex((l, i) => i > paidIdx && /transfer\s+details/i.test(l));
  const block = paidIdx >= 0 ? lines.slice(paidIdx + 1, endIdx > paidIdx ? endIdx : paidIdx + 8) : [];

  const nameLines: string[] = [];
  const upiParts: string[] = [];
  for (const l of block) {
    if (MONEY_LINE.test(l)) continue; // the amount shown on the right of the payee row
    if (l.includes('@')) { upiParts.push(l); continue; }
    if (/^[A-Z0-9-]{8,}$/.test(l) && !/\s/.test(l) && upiParts.length === 0 && nameLines.length > 0) { upiParts.push(l); continue; } // first half of a wrapped UPI id
    if (l.length <= 3) continue; // the round avatar's initials
    if (upiParts.length > 0) { upiParts.push(l); continue; } // second half of a wrapped UPI id
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
    const cand = lines.slice(dIdx + 1, dIdx + 4).find((l) => !MONEY_LINE.test(l) && l.length > 2);
    if (cand) out.paidFrom = cand;
  }

  const mIdx = lines.findIndex((l) => /^message$/i.test(l));
  if (mIdx >= 0 && lines[mIdx + 1] && !/transaction\s*id/i.test(lines[mIdx + 1])) out.message = lines[mIdx + 1];

  // Amount: the same figure appears twice on a receipt (beside the payee, and again under "Debited from").
  // The reader often mangles the ₹ sign into a leading digit ("7202" for ₹202), so when one figure is exactly
  // another with one extra digit in front, the shorter one is the real amount.
  type Tok = { value: string; line: number };
  const toks: Tok[] = [];
  lines.forEach((l, i) => {
    const m = l.match(MONEY_LINE);
    if (m) toks.push({ value: m[2].replace(/,/g, ''), line: i });
  });
  const canon = (v: string) => {
    const shorter = toks.find((u) => u.value !== v && v.length === u.value.length + 1 && v.slice(1) === u.value);
    return shorter ? shorter.value : v;
  };
  const resolved = toks.map((t) => ({ ...t, value: canon(t.value) }));
  const counts = new Map<string, number>();
  resolved.forEach((t) => counts.set(t.value, (counts.get(t.value) || 0) + 1));
  const repeated = resolved.find((t) => (counts.get(t.value) || 0) >= 2);
  const inBlock = resolved.find((t) => paidIdx >= 0 && t.line > paidIdx && (endIdx < 0 || t.line < endIdx));
  const pick = repeated || inBlock || resolved[0];
  if (pick) {
    out.amount = pick.value;
    out.amountSure = !!repeated;
  }

  if (!out.isPhonePe) out.notes.push("This doesn't look like a PhonePe receipt.");
  if (out.status !== 'success') out.notes.push(out.status === 'unknown' ? "Couldn't confirm the payment succeeded." : `Payment status looks ${out.status} — check before saving.`);
  if (out.direction === 'received') out.notes.push('This looks like money you received, not a payment you made.');
  if (!out.amount) out.notes.push("Couldn't read the amount.");
  else if (!out.amountSure) out.notes.push('Please double-check the amount.');
  if (!out.payee) out.notes.push("Couldn't read who was paid.");
  return out;
}
