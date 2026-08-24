// Shopkeeper mode: shared helpers for sale confirmation / promo messaging. No WhatsApp Business
// API connector on purpose — wa.me deep links (tap-to-send, free, no approval process) are
// enough for a small shopkeeper, same trade-off already made for Personal Loans' reminders.
import { auth, db } from './firebase';
import { addDoc, collection } from 'firebase/firestore';

const PLAY_STORE_LINK = 'https://play.google.com/store/apps/details?id=com.familyledger.app';

export type ShopActivityType =
  | 'sale_created' | 'sale_updated' | 'cost_set' | 'customer_created'
  | 'credit_payment' | 'category_added' | 'staff_added' | 'staff_removed';

// Fire-and-forget log entry for the Shopkeeper-mode activity feed (`shops/{shopId}/activities`)
// — a separate feed from the household Activity Feed, scoped to just this shop's own actions.
export function logShopActivity(shopId: string, type: ShopActivityType, description: string, actorName?: string) {
  const currentUser = auth.currentUser;
  if (!currentUser) return;
  addDoc(collection(db, 'shops', shopId, 'activities'), {
    userId: currentUser.uid,
    userName: actorName || currentUser.displayName || 'Someone',
    type,
    description,
    createdAt: new Date().toISOString(),
  }).catch((err) => console.error('shop activity log failed:', err));
}

// Some walk-in customers don't want to share a name or phone number — rather than block the sale,
// generate a short, friendly stand-in identifier so the sale/credit ledger still has someone to
// point at. Not checked for uniqueness against the shop's existing customers: a shop's customer
// list is small enough (dozens to low hundreds) that a 4-digit random suffix collision is very
// unlikely, and even a collision here is harmless — worst case two anonymous customers share a
// label, same as two real customers coincidentally sharing a name would.
export function generateCustomerCode(): string {
  return `C-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Item/promo photos are stored as base64 data URIs directly in Firestore documents (no Storage
// bucket in this app), so keeping these small matters a lot more than for a one-off profile photo
// — a shop can accumulate thousands of these across sales. Deliberately compressed harder than
// the 700px/0.7 used elsewhere in the app (~15-30KB typical output vs ~80-150KB before).
export function resizeShopImage(file: File, maxSize = 420, quality = 0.4): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onerror = reject;
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) { height *= maxSize / width; width = maxSize; }
        } else if (height > maxSize) {
          width *= maxSize / height; height = maxSize;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
    };
  });
}

export function buildSaleMessage(params: {
  shopName: string;
  sellerName: string;
  itemName: string;
  quantity?: number;
  price: number;
  currencySymbol: string;
}): string {
  const { shopName, sellerName, itemName, quantity, price, currencySymbol } = params;
  const itemLine = quantity && quantity > 1 ? `${itemName} × ${quantity}` : itemName;
  return `🛍️ ${shopName}\nSold by: ${sellerName}\nItem: ${itemLine}\nPrice: ${currencySymbol}${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\nThanks for shopping with us!\n\nGet FamilyLedger: ${PLAY_STORE_LINK}`;
}

export function buildPromoMessage(params: { shopName: string; itemName: string; message: string }): string {
  return `🛍️ ${params.shopName}\n\nNew arrival: ${params.itemName}\n${params.message}\n\nGet FamilyLedger: ${PLAY_STORE_LINK}`;
}

// wa.me can't attach an image via URL params — only the Web Share API's `files` support can
// hand an actual image to WhatsApp (or whichever app the user picks) via the OS share sheet.
// Falls back to a text-only wa.me link (optionally addressed to a specific phone number) when
// there's no photo, or the platform/browser doesn't support file sharing.
export async function shareViaWhatsApp(params: { message: string; phone?: string; imageDataUri?: string }) {
  const { message, phone, imageDataUri } = params;
  if (imageDataUri) {
    try {
      const nav = navigator as any;
      const res = await fetch(imageDataUri);
      const blob = await res.blob();
      const file = new File([blob], 'item.jpg', { type: blob.type || 'image/jpeg' });
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ text: message, files: [file] });
        return;
      }
    } catch (err) {
      if ((err as any)?.name === 'AbortError') return; // user cancelled the share sheet
      console.error('Image share failed, falling back to text-only WhatsApp link:', err);
    }
  }
  const digits = (phone || '').replace(/[^\d]/g, '');
  const url = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}
