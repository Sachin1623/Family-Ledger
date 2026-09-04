// Field-level encryption for financial amounts — AES-256-GCM via WebCrypto, scoped PER DOCUMENT
// (a specific goal, a specific account) rather than per-group or per-friendship. The server hands
// out a scope's decryption key only to someone already authorized to read that document — the
// exact same checks Firestore rules already enforce (isGoalViewer(), existing().userId ===
// caller, etc.) — so a Firestore console view, a raw DB export, or a misconfigured rule that
// exposes a doc to the wrong signed-in user all yield ciphertext, never a plaintext number.
//
// Threat model this deliberately does NOT cover: this app's own backend, which legitimately needs
// to read amounts for things like composing a push notification body, and which holds the master
// secret every scope key is derived from (see server.ts's /api/crypto/key). Encrypting against
// the backend itself would mean the backend could never compute anything over the data at all —
// out of scope here; see the comment atop that endpoint for the fuller reasoning.
//
// Coverage note: this currently protects Goals (target/current amounts, ledger entries) and
// Financial Accounts (balances, monthly snapshots) — the collections built for those features.
// The older, much larger `expenses`/`groups`/`groupBudgets` collections (and everything that
// reads them — Dashboard, Analysis Summary, Settlements, Recurring Expenses, Personal Loans) are
// NOT yet covered; that's a separate, larger follow-up phase, not silently skipped.

import { auth } from './firebase';

export type EncryptionScopeType = 'user' | 'goal' | 'account';

const keyCache = new Map<string, Promise<CryptoKey>>();
const ENC_PREFIX = 'enc:v1:';

async function fetchScopeKeyBase64(scopeType: EncryptionScopeType, scopeId: string): Promise<string> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch('/api/crypto/key', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopeType, scopeId }),
  });
  if (!res.ok) throw new Error('Failed to fetch encryption key.');
  const data = await res.json();
  return data.key as string;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function getScopeKey(scopeType: EncryptionScopeType, scopeId: string): Promise<CryptoKey> {
  const cacheKey = `${scopeType}:${scopeId}`;
  let cached = keyCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const base64 = await fetchScopeKeyBase64(scopeType, scopeId);
      return crypto.subtle.importKey('raw', base64ToBytes(base64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();
    keyCache.set(cacheKey, cached);
    cached.catch(() => keyCache.delete(cacheKey)); // don't poison the cache with a failed fetch
  }
  return cached;
}

// Drop a scope's cached key — call on sign-out so a shared device doesn't keep the next user able
// to silently decrypt the previous user's data via a stale in-memory key.
export function clearFieldCryptoCache() {
  keyCache.clear();
}

export async function encryptAmount(scopeType: EncryptionScopeType, scopeId: string, valueMinor: number): Promise<string> {
  const key = await getScopeKey(scopeType, scopeId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(String(Math.round(valueMinor)));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

// Accepts either a ciphertext string (decrypts) OR a plain number (passes through unchanged) —
// documents written before this feature existed are still plain numbers in Firestore, and stay
// readable rather than breaking or silently vanishing.
export async function decryptAmount(scopeType: EncryptionScopeType, scopeId: string, value: string | number | undefined | null): Promise<number> {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return Number(value) || 0;
  const [ivB64, ctB64] = value.slice(ENC_PREFIX.length).split(':');
  const key = await getScopeKey(scopeType, scopeId);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return Number(new TextDecoder().decode(plainBuf)) || 0;
}

export function isEncryptedAmount(value: string | number | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

// Same AES-256-GCM/scope-key mechanism as encryptAmount/decryptAmount above, for an arbitrary
// string instead of a minor-units number — added for FinancialAccount.accountNumber, which is
// sensitive PII on the same level as a balance but isn't itself a numeric amount (may carry
// leading zeros, letters, IFSC-style prefixes, etc., none of which survive `Number(...)`).
export async function encryptText(scopeType: EncryptionScopeType, scopeId: string, text: string): Promise<string> {
  const key = await getScopeKey(scopeType, scopeId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

// Accepts either ciphertext (decrypts) OR a plain string (passes through unchanged) — same
// backwards-compatibility rule as decryptAmount, for documents/fields written before encryption
// existed. Missing/null passes through as ''.
export async function decryptText(scopeType: EncryptionScopeType, scopeId: string, value: string | undefined | null): Promise<string> {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (!value.startsWith(ENC_PREFIX)) return value;
  const [ivB64, ctB64] = value.slice(ENC_PREFIX.length).split(':');
  const key = await getScopeKey(scopeType, scopeId);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return new TextDecoder().decode(plainBuf);
}
