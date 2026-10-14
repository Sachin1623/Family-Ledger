// Share-to-FamilyLedger for payment receipts — Android (ReceiptSharePlugin.java) and iOS (ReceiptSharePlugin.swift).
// Another app (PhonePe …) shares a receipt to us; the native side copies it, reads the text on the phone
// (Google ML Kit, no network, nothing uploaded) and hands the result here. The image itself is deleted
// right after reading. A small compressed copy is passed along so it can be attached to the expense — but
// only if the user keeps the "attach" switch on and then saves the expense.
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
  imageData?: string; // small compressed copy (data:image/jpeg;base64,…) to attach to the expense
  imageError?: string;
  imageChars?: number;
  pluginVersion?: number; // 3+ = can pass the receipt picture along; missing = an older build
  lines?: SharedLine[];
  ocrMs?: number;
  error?: string;
}

interface ReceiptSharePlugin {
  getPendingShare(): Promise<SharedReceipt | Record<string, never>>;
  // iOS: a file handed to the app ("Copy to FamilyLedger") is read here; Android receives the share by itself.
  processFile(opts: { url: string }): Promise<SharedReceipt>;
  addListener(event: 'receiptShared', cb: (data: SharedReceipt) => void): Promise<PluginListenerHandle>;
}

const ReceiptShare = registerPlugin<ReceiptSharePlugin>('ReceiptShare');

export function receiptShareAvailable(): boolean {
  const p = Capacitor.getPlatform();
  return (p === 'android' || p === 'ios') && Capacitor.isPluginAvailable('ReceiptShare');
}

export function processReceiptFile(url: string) {
  return ReceiptShare.processFile({ url });
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
