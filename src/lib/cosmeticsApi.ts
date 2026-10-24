import { auth } from './firebase';

// Flame styles and badges (see cosmetics.ts on the server). The server owns the catalogue, the prices and what has been earned; the app only shows it.

export interface FlameOption { id: string; name: string; price: number; hint: string | null; unlocked: boolean; earnedOnly: boolean }
export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'legend';
export interface BadgeOption { id: string; name: string; icon: string; hint: string; tier: BadgeTier; target: number; progress: number; earned: boolean }
export interface CosmeticsState {
  coins: number;
  equipped: { flame: string; badges: string[] };
  maxBadges: number;
  flames: FlameOption[];
  badges: BadgeOption[];
  newlyEarned: string[]; // badges earned since the screen was last opened, for the celebration
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export const fetchCosmetics = () => call<CosmeticsState>('/api/cosmetics');
export const buyFlame = (id: string) => call<{ ok: boolean }>('/api/cosmetics/buy', 'POST', { id });
export const equipStyle = (patch: { flame?: string; badges?: string[] }) => call<{ ok: boolean }>('/api/cosmetics/equip', 'POST', patch);

// How each flame style recolours the streak flame. The flame is drawn in orange; these turn it blue, green, and so on. 'classic' leaves it as drawn.
export const FLAME_FILTERS: Record<string, string> = {
  classic: 'none',
  blue: 'hue-rotate(190deg) saturate(1.5)',
  gold: 'hue-rotate(-12deg) saturate(2) brightness(1.15)',
  green: 'hue-rotate(95deg) saturate(1.4)',
  purple: 'hue-rotate(250deg) saturate(1.5)',
  frost: 'hue-rotate(170deg) saturate(.7) brightness(1.2)',
};
