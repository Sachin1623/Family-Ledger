// Reads a Paytm payment receipt out of the text the phone recognised in the shared image.
// Paytm's layout: a blue card with the status ("Paid Successfully", "Money Sent Successfully", "Order
// Successful"), the amount, and the amount IN WORDS ("Rupees Six Hundred Ninety Nine Only"); below it
// "To: <payee>" / "For: Bill Payment for <biller> <number>", "From: <you>", "UPI Ref No", and the date.
// The words line is used to double-check the digits — it can't be mangled the way the ₹ sign is.
import { suggestCategory, type ParsedReceipt } from './phonepeReceipt';
import type { SharedLine, SharedReceipt } from './receiptShare';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function wordsToNumber(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w in UNITS) { current += UNITS[w]; seen = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; }
    else if (w === 'lakh' || w === 'lac' || w === 'lakhs') { total += (current || 1) * 100000; current = 0; seen = true; }
    else if (w === 'crore' || w === 'crores') { total += (current || 1) * 10000000; current = 0; seen = true; }
    else if (w === 'and' || w === '') continue;
    else return null; // an unknown word — the line was misread, don't trust it
  }
  return seen ? total + current : null;
}

/** "Rupees Two Thousand One Hundred Forty and Thirty Two Paise Only" -> 214032 (in paise), or null. */
export function amountInWordsToPaise(text: string): number | null {
  const clean = text.toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^rupees?\b/.test(clean)) return null;
  const body = clean.replace(/^rupees?\s*/, '').replace(/\s*only$/, '');
  const paiseAt = body.search(/\bpaise\b|\bpaisa\b/);
  let rupeeWords: string[];
  let paise = 0;
  if (paiseAt >= 0) {
    const before = body.slice(0, paiseAt).trim().split(' ');
    const andIdx = before.lastIndexOf('and');
    rupeeWords = andIdx >= 0 ? before.slice(0, andIdx) : [];
    const p = wordsToNumber(andIdx >= 0 ? before.slice(andIdx + 1) : before);
    if (p === null) return null;
    paise = p;
  } else {
    rupeeWords = body.split(' ');
  }
  const r = rupeeWords.length > 0 ? wordsToNumber(rupeeWords) : 0;
  if (r === null) return null;
  return r * 100 + paise;
}

const MONEY_LINE = /^(₹|Rs\.?|INR|[^\d\s.,])?\s*(\d{1,8}(?:,\d{2,3})*(?:\.\d{1,2})?)$/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parsePaytmReceipt(share: SharedReceipt): ParsedReceipt {
  const out: ParsedReceipt = {
    app: 'paytm', isPhonePe: false, status: 'unknown', direction: 'unknown', amount: '', amountSure: false, alternatives: [],
    payee: '', upiId: '', txnId: '', utr: '', paidFrom: '', kind: 'payment', billType: '', reference: '', categoryHint: '',
    payeeIsPerson: false, message: '', date: '', time: '', notes: [],
  };

  const lines: string[] = (share.lines && share.lines.length > 0
    ? [...share.lines].sort((a: SharedLine, b: SharedLine) => a.top - b.top || a.left - b.left).map((l) => norm(l.text))
    : (share.ocrText || share.text || '').split(/\r?\n/).map(norm)
  ).filter(Boolean);
  const all = lines.join('\n');

  if (/successful/i.test(all)) out.status = 'success';
  else if (/fail|declin|unsuccessful/i.test(all)) out.status = 'failed';
  else if (/pending|processing/i.test(all)) out.status = 'pending';
  out.direction = /received/i.test(all.split('\n').slice(0, 4).join(' ')) ? 'received' : 'paid';

  // Date + time: "08:20 AM, 13 Jul 2026"
  const dm = all.match(/(\d{1,2}:\d{2}\s*[AP]M),?\s+(?:on\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (dm) {
    const mm = MONTHS[dm[3].slice(0, 3).toLowerCase()];
    if (mm) out.date = `${dm[4]}-${mm}-${dm[2].padStart(2, '0')}`;
    out.time = dm[1].toUpperCase().replace(/\s+/g, ' ');
  }

  // Payee: "To: REZONI"  or  "For: Bill Payment for BSES Rajdhani 103176449" (may wrap onto the next line)
  const toIdx = lines.findIndex((l) => /^(to|for)\s*:/i.test(l));
  if (toIdx >= 0) {
    const first = lines[toIdx].replace(/^(to|for)\s*:\s*/i, '');
    const isFor = /^for/i.test(lines[toIdx]);
    const parts = [first];
    for (const l of lines.slice(toIdx + 1, toIdx + 4)) {
      if (/^upi\s*id/i.test(l) || /^from\s*:/i.test(l)) break;
      parts.push(l);
    }
    const text = norm(parts.join(' '));
    const bill = text.match(/^bill\s+payment\s+for\s+(.+?)\s+(\d{5,})$/i) || (isFor ? text.match(/^(?:bill\s+payment\s+for\s+)?(.+?)\s+(\d{5,})$/i) : null);
    if (isFor && /bill/i.test(text)) {
      out.kind = 'bill';
      out.billType = 'Bill payment';
      out.payee = bill ? bill[1] : text.replace(/^bill\s+payment\s+for\s+/i, '');
      out.reference = bill ? bill[2] : '';
    } else {
      out.payee = text;
    }
    // The payee's UPI id is the first "UPI ID:" line after To/For (the next one belongs to the payer).
    const u = lines.slice(toIdx + 1, toIdx + 5).map((l) => l.match(/^upi\s*id\s*:\s*(\S+)/i)).find(Boolean);
    if (u) out.upiId = u[1];
  }
  // A masked UPI id ("******8929@pthdfc") is a person's number: this was money sent to someone, not a shop.
  out.payeeIsPerson = out.kind !== 'bill' && (out.upiId.includes('*') || /money\s+sent/i.test(all));

  // Paid from: "HDFC Bank - 9153" under "From:"
  const fIdx = lines.findIndex((l) => /^from\s*:/i.test(l));
  if (fIdx >= 0) {
    const bank = lines.slice(fIdx + 1, fIdx + 5).find((l) => /bank|wallet|card/i.test(l) && !/^upi/i.test(l));
    if (bank) out.paidFrom = bank;
  }

  const ref = all.match(/UPI\s*Ref\.?\s*No\.?\s*:?\s*(\d{8,})/i);
  if (ref) { out.txnId = ref[1]; out.utr = ref[1]; }
  const order = all.match(/Order\s*ID\s*:?\s*(\d+)/i);
  if (order && !out.reference) out.reference = order[1];
  const note = all.match(/^payment[+\s]for[+\s](\S.*)$/im);
  if (note) out.message = note[0].replace(/\+/g, ' ');

  // Amount: the digits beside the check mark, confirmed by the amount in words.
  const wordsIdx = lines.findIndex((l) => /^rupees?\b/i.test(l));
  let wordsPaise: number | null = null;
  if (wordsIdx >= 0) {
    for (let n = 1; n <= 3 && wordsIdx + n <= lines.length; n++) {
      const candidate = lines.slice(wordsIdx, wordsIdx + n).join(' ');
      const v = amountInWordsToPaise(candidate);
      if (v !== null && /only$/i.test(candidate.trim())) { wordsPaise = v; break; }
    }
  }
  const headEnd = toIdx >= 0 ? toIdx : lines.length;
  const toks = lines.slice(0, headEnd).map((l) => l.match(MONEY_LINE)).filter(Boolean).map((m) => m![2].replace(/,/g, ''));
  const variants = (v: string) => (v.length > 1 && '723'.includes(v[0]) && /^\d/.test(v.slice(1)) ? [v, v.slice(1)] : [v]);
  if (toks.length > 0) {
    let chosen: string | null = null;
    if (wordsPaise !== null) {
      for (const t of toks) {
        const hit = variants(t).find((v) => Math.round(parseFloat(v) * 100) === wordsPaise);
        if (hit) { chosen = hit; break; }
      }
      if (!chosen) chosen = (wordsPaise % 100 === 0 ? String(wordsPaise / 100) : (wordsPaise / 100).toFixed(2)); // trust the words over mangled digits
      out.amountSure = true;
    } else {
      chosen = toks[0];
      out.amountSure = false;
    }
    out.amount = chosen;
  } else if (wordsPaise !== null) {
    out.amount = wordsPaise % 100 === 0 ? String(wordsPaise / 100) : (wordsPaise / 100).toFixed(2);
    out.amountSure = true;
  }

  out.isPhonePe = false;
  out.categoryHint = suggestCategory(out);
  if (out.status !== 'success') out.notes.push(out.status === 'unknown' ? "Couldn't confirm the payment succeeded." : `Payment status looks ${out.status} — check before saving.`);
  if (out.direction === 'received') out.notes.push('This looks like money you received, not a payment you made.');
  if (!out.amount) out.notes.push("Couldn't read the amount.");
  else if (!out.amountSure) out.notes.push('Please double-check the amount.');
  if (!out.payee) out.notes.push("Couldn't read who was paid.");
  if (out.payeeIsPerson) out.notes.push(`This looks like money sent to a person${out.payee ? ` (${out.payee})` : ''} — add it as an expense only if it was a purchase.`);
  return out;
}
