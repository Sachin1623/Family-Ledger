// Picks the right reader for a shared receipt (PhonePe or Paytm) and returns one common shape.
import type { SharedReceipt } from './receiptShare';
import { parsePhonePeReceipt, payeeKey, type ParsedReceipt } from './phonepeReceipt';
import { parsePaytmReceipt } from './paytmReceipt';

export { payeeKey };
export type { ParsedReceipt };

export function detectReceiptApp(share: SharedReceipt): 'phonepe' | 'paytm' | 'unknown' {
  const text = [share.ocrText || '', share.text || '', share.subject || '', ...(share.lines || []).map((l) => l.text)].join('\n');
  const from = share.referrer || '';
  if (/phonepe/i.test(from)) return 'phonepe';
  if (/paytm/i.test(from)) return 'paytm';
  if (/phonepe/i.test(text)) return 'phonepe';
  if (/pay\s?tm/i.test(text) || /UPI\s*Ref\.?\s*No/i.test(text)) return 'paytm';
  return 'unknown';
}

export function parseReceipt(share: SharedReceipt): ParsedReceipt {
  const app = detectReceiptApp(share);
  if (app === 'paytm') return parsePaytmReceipt(share);
  const p = parsePhonePeReceipt(share);
  if (app === 'unknown') p.notes.unshift("We couldn't tell which app this receipt is from — please check the details.");
  return p;
}
