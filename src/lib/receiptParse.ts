// Picks the right reader for a shared receipt (PhonePe or Paytm) and returns one common shape.
import type { SharedReceipt } from './receiptShare';
import { parsePhonePeReceipt, payeeKey, type ParsedReceipt } from './phonepeReceipt';
import { parsePaytmReceipt } from './paytmReceipt';
import { parseGPayReceipt } from './gpayReceipt';

export { payeeKey };
export type { ParsedReceipt };

export function detectReceiptApp(share: SharedReceipt): 'phonepe' | 'paytm' | 'gpay' | 'unknown' {
  const text = [share.ocrText || '', share.text || '', share.subject || '', ...(share.lines || []).map((l) => l.text)].join('\n');
  const from = share.referrer || '';
  if (/phonepe/i.test(from)) return 'phonepe';
  if (/paytm/i.test(from)) return 'paytm';
  if (/paisa|google\.android|com\.google/i.test(from)) return 'gpay';
  // Receipts can mention other apps ("…@axl on PhonePe"), so look for each app's own labels first.
  if (/google\s*transaction\s*id/i.test(text)) return 'gpay';
  if (/phonepe\s*transaction\s*id/i.test(text)) return 'phonepe';
  if (/pay\s?tm/i.test(text) || /UPI\s*Ref\.?\s*No/i.test(text)) return 'paytm';
  if (/phonepe/i.test(text)) return 'phonepe';
  return 'unknown';
}

export function parseReceipt(share: SharedReceipt): ParsedReceipt {
  const app = detectReceiptApp(share);
  if (app === 'paytm') return parsePaytmReceipt(share);
  if (app === 'gpay') return parseGPayReceipt(share);
  const p = parsePhonePeReceipt(share);
  if (app === 'unknown') p.notes = p.notes.filter((n) => !/PhonePe receipt/.test(n));
  if (app === 'unknown') p.notes.unshift("We couldn't tell which app this receipt is from — please check the details.");
  return p;
}
