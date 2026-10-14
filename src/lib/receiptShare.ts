// Share-to-FamilyLedger for payment receipts (Android only for now — see ReceiptSharePlugin.java).
// Another app (PhonePe …) shares a receipt to us; the native side copies it, reads the text on the phone
// (Google ML Kit, no network, nothing uploaded) and hands the result here. The image itself is deleted
// right after reading — only the extracted text is kept, and only in memory.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface SharedLine {
  text: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SharedReceipt {
  action?: string;
  mime: string; // what arrived: image/png, application/pdf, text/plain …
  kind?: 'image' | 'pdf' | 'text' | 'file';
  name?: string; // file name as the sender gave it
  sizeBytes?: number;
  referrer?: string; // which app sent it, when Android tells us
  text?: string; // plain text the sender included (EXTRA_TEXT)
  subject?: string;
  width?: number;
  height?: number;
  pages?: number;
  ocrText?: string;
  lines?: SharedLine[];
  ocrMs?: number;
  error?: string;
}

interface ReceiptSharePlugin {
  getPendingShare(): Promise<SharedReceipt | Record<string, never>>;
  addListener(event: 'receiptShared', cb: (data: SharedReceipt) => void): Promise<PluginListenerHandle>;
}

const ReceiptShare = registerPlugin<ReceiptSharePlugin>('ReceiptShare');

export function receiptShareAvailable(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('ReceiptShare');
}

export function getPendingReceiptShare() {
  return ReceiptShare.getPendingShare();
}

export function onReceiptShared(cb: (data: SharedReceipt) => void) {
  return ReceiptShare.addListener('receiptShared', cb);
}

// The most recent share, held in memory for the Receipt screen to pick up.
let current: SharedReceipt | null = null;
export function setSharedReceipt(r: SharedReceipt | null) {
  current = r;
}
export function getSharedReceipt(): SharedReceipt | null {
  return current;
}
