// Reads a Google Pay payment receipt out of the text the phone recognised in the shared image.
// Google Pay's layout: the payee on top ("To Practo", or just "SonyLIV" for a bill), the amount, an optional note
// pill, "Completed", the date ("29 May 2026, 10:34 pm"), the bank that paid ("HDFC Bank 9153"), a sentence
// repeating the amount ("Payment of ₹699 completed"), then "UPI transaction ID", "To: <full name>" with a masked UPI
// id, "From: <you>", and the "Google transaction ID".
import { suggestCategory, type ParsedReceipt } from './phonepeReceipt';
import type { SharedLine, SharedReceipt } from './receiptShare';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const MONEY_LINE = /^(₹|Rs\.?|INR|[^\d\s.,])?\s*(\d{1,8}(?:,\d{2,3})*(?:\.\d{1,2})?)$/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const cents = (v: string) => Math.round(parseFloat(v) * 100);
const variants = (v: string) => (v.length > 1 && '723'.includes(v[0]) && /^\d/.test(v.slice(1)) ? [v, v.slice(1)] : [v]);

export function parseGPayReceipt(share: SharedReceipt): ParsedReceipt {
  const out: ParsedReceipt = {
    app: 'gpay', isPhonePe: false, status: 'unknown', direction: 'unknown', amount: '', amountSure: false, alternatives: [],
    payee: '', upiId: '', txnId: '', utr: '', paidFrom: '', kind: 'payment', billType: '', reference: '', categoryHint: '',
    payeeIsPerson: false, message: '', date: '', time: '', notes: [],
  };

  const lines: string[] = (share.lines && share.lines.length > 0
    ? [...share.lines].sort((a: SharedLine, b: SharedLine) => a.top - b.top || a.left - b.left).map((l) => norm(l.text))
    : (share.ocrText || share.text || '').split(/\r?\n/).map(norm)
  ).filter(Boolean);
  const all = lines.join('\n');

  if (/\bcompleted\b/i.test(all)) out.status = 'success';
  else if (/fail|declin|unsuccessful/i.test(all)) out.status = 'failed';
  else if (/pending|processing/i.test(all)) out.status = 'pending';
  out.direction = /^(from\s+\S|received)/im.test(lines.slice(0, 3).join('\n')) ? 'received' : 'paid';

  // Date + time: "29 May 2026, 10:34 pm"
  const dm = all.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4}),?\s+(\d{1,2}:\d{2})\s*([ap]m)/i);
  if (dm) {
    const mm = MONTHS[dm[2].slice(0, 3).toLowerCase()];
    if (mm) out.date = `${dm[3]}-${mm}-${dm[1].padStart(2, '0')}`;
    out.time = `${dm[4]} ${dm[5].toUpperCase()}`;
  }

  // Where the big amount is, and who it went to (header "To Practo", or a bare name above the amount for bills)
  const amountLineIdx = lines.findIndex((l) => MONEY_LINE.test(l));
  const headerTo = lines.slice(0, Math.max(amountLineIdx, 0)).map((l) => l.match(/^to\s+(?!:)(.+)$/i)).find(Boolean);
  const detailTo = lines.map((l, i) => ({ m: l.match(/^to\s*:\s*(.+)$/i), i })).find((x) => x.m);
  if (headerTo) out.payee = headerTo[1];
  else if (amountLineIdx > 0 && !/^g\s?pay$/i.test(lines[amountLineIdx - 1])) out.payee = lines[amountLineIdx - 1]; // bills: just the biller's name
  else if (detailTo) out.payee = detailTo.m![1];

  // The payee's UPI id is on the line after the detailed "To:" — masked with dots, and ending "on PhonePe" etc.
  // for a person's own id (a shop's id has no such suffix).
  if (detailTo) {
    const idLine = lines.slice(detailTo.i + 1, detailTo.i + 3).find((l) => l.includes('@'));
    if (idLine) {
      out.upiId = (idLine.match(/\S*@\S+/) || [''])[0];
      out.payeeIsPerson = /\bon\s+(phonepe|google pay|paytm|bhim|amazon pay|cred|whatsapp)\b/i.test(idLine);
    }
  }

  // Paid from: the bank line ("HDFC Bank 9153"), else the "From:" line
  const bank = lines.find((l) => /^[A-Za-z][A-Za-z ]*bank\s+\d{3,4}$/i.test(l));
  if (bank) out.paidFrom = bank;
  else {
    const f = lines.findIndex((l) => /^from\s*:?$/i.test(l));
    if (f >= 0 && lines[f + 1]) out.paidFrom = lines[f + 1];
  }

  // Transaction id: "UPI transaction ID" and its value (same line or the next)
  const tIdx = lines.findIndex((l) => /upi\s*transaction\s*id/i.test(l));
  if (tIdx >= 0) {
    const same = lines[tIdx].match(/(\d{8,})/);
    const next = lines[tIdx + 1]?.match(/^(\d{8,})$/);
    out.txnId = same ? same[1] : next ? next[1] : '';
    out.utr = out.txnId;
  }

  // A bill: the biller's details (due date, mobile / consumer number, plan …) instead of a "To:" block
  if (/bharat connect|bill payment|due date|consumer|mobile number/i.test(all)) {
    out.kind = 'bill';
    out.billType = 'Bill payment';
    const mIdx = lines.findIndex((l) => /^(mobile|consumer|customer|account)\s*(number|no\.?|id)$/i.test(l));
    if (mIdx >= 0) {
      const ref = lines.slice(mIdx + 1, mIdx + 8).find((l) => /^\d{6,14}$/.test(l));
      if (ref) out.reference = ref;
    }
    out.payeeIsPerson = false;
  }

  // The user's own note, shown as a pill between the amount and "Completed" (ignoring the app's own tags)
  const doneIdx = lines.findIndex((l) => /^completed$/i.test(l));
  if (amountLineIdx >= 0 && doneIdx > amountLineIdx) {
    const note = lines.slice(amountLineIdx + 1, doneIdx).filter((l) => !/^(upi\s*intent|pay again|completed)$/i.test(l) && !MONEY_LINE.test(l));
    if (note.length > 0) out.message = note.join(' ');
  }

  // Amount: the big figure, confirmed by the sentence that repeats it ("Payment of ₹699 completed", "₹1,499.00 paid").
  const heads = lines
    .slice(0, doneIdx > 0 ? doneIdx : lines.length)
    .map((l) => l.match(MONEY_LINE))
    .filter(Boolean)
    .map((m) => m![2].replace(/,/g, ''));
  const echoes: string[] = [];
  for (const l of lines) {
    const a = l.match(/payment of\s*\S?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*completed/i);
    const b = l.match(/(\d[\d,]*\.\d{2})\s*paid/i);
    if (a) echoes.push(a[1].replace(/,/g, ''));
    if (b) echoes.push(b[1].replace(/,/g, ''));
  }
  const head = heads[0];
  if (head) {
    let chosen = head;
    let sure = false;
    for (const e of echoes) {
      const hit = variants(head).find((h) => variants(e).some((x) => cents(x) === cents(h)));
      if (hit) { chosen = hit; sure = true; break; }
    }
    // The echo exists but nothing lines up (a mangled ₹ on the header): trust the echo's shortest reading
    if (!sure && echoes.length > 0) {
      const e = variants(echoes[0]).sort((a, b) => a.length - b.length)[0];
      if (variants(head).some((h) => h.endsWith(e) || e.endsWith(h))) { chosen = e; sure = false; }
    }
    out.amount = chosen;
    out.amountSure = sure;
  } else if (echoes.length > 0) {
    out.amount = echoes[0];
    out.amountSure = false;
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
