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
  message: string;
  date: string; // YYYY-MM-DD
  time: string; // e.g. "03:45 PM"
  notes: string[]; // anything the user should double-check
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// A line that is just an amount, e.g. "₹202", "Rs. 1,250.50", or a bare "202" when the ₹ was lost.
const MONEY_LINE = /^(₹|Rs\.?|INR|[2-3?])?\s*(\d[\d,]*(?:\.\d{1,2})?)$/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parsePhonePeReceipt(share: SharedReceipt): ParsedReceipt {
  const out: ParsedReceipt = {
    isPhonePe: false, status: 'unknown', direction: 'unknown', amount: '', amountSure: false,
    payee: '', upiId: '', txnId: '', utr: '', paidFrom: '', message: '', date: '', time: '', notes: [],
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

  // Amount: the figure that shows up more than once (header and "Debited from"), preferring the ₹ form.
  type Cand = { value: string; hadSymbol: boolean; line: number; viaMisread: boolean };
  const cands: Cand[] = [];
  lines.forEach((l, i) => {
    const m = l.match(MONEY_LINE);
    if (!m) return;
    const sym = m[1] || '';
    cands.push({ value: m[2].replace(/,/g, ''), hadSymbol: /₹|rs|inr/i.test(sym), line: i, viaMisread: /^[2-3?]$/.test(sym) });
  });
  // A "₹" misread as "2"/"3" glues onto the number ("2202"); that only counts if the stripped number also appears.
  const values = new Set(cands.map((c) => c.value));
  const fixed = cands.map((c) => (c.viaMisread ? c : c));
  const counts = new Map<string, number>();
  fixed.forEach((c) => counts.set(c.value, (counts.get(c.value) || 0) + 1));
  let pick: Cand | undefined = fixed.filter((c) => (counts.get(c.value) || 0) >= 2 && c.hadSymbol)[0] || fixed.filter((c) => (counts.get(c.value) || 0) >= 2)[0];
  if (!pick) {
    // A single reading: take the first figure inside the payee block, else the first ₹ figure.
    pick = fixed.find((c) => paidIdx >= 0 && c.line > paidIdx && (endIdx < 0 || c.line < endIdx)) || fixed.find((c) => c.hadSymbol) || fixed[0];
  }
  if (pick) {
    // If the pick is "2202"-style (₹ read as 2) and the stripped value is also on the receipt, use the stripped one.
    let value = pick.value;
    if (/^[23]\d+$/.test(value) && values.has(value.slice(1))) value = value.slice(1);
    out.amount = value;
    out.amountSure = (counts.get(pick.value) || 0) >= 2 && pick.hadSymbol;
  }

  if (!out.isPhonePe) out.notes.push("This doesn't look like a PhonePe receipt.");
  if (out.status !== 'success') out.notes.push(out.status === 'unknown' ? "Couldn't confirm the payment succeeded." : `Payment status looks ${out.status} — check before saving.`);
  if (out.direction === 'received') out.notes.push('This looks like money you received, not a payment you made.');
  if (!out.amount) out.notes.push("Couldn't read the amount.");
  else if (!out.amountSure) out.notes.push('Please double-check the amount.');
  if (!out.payee) out.notes.push("Couldn't read who was paid.");
  return out;
}
