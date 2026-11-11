import { auth } from './firebase';

// Tells the server a payment in a Payments group was created, edited, given a receipt, or (for a security deposit) settled, so the people's
// tracked copies stay in line and the other people in the payment are notified (see /api/group-payment-updated in server.ts). The payment
// itself is already saved; this is best effort and never blocks the screen.
export async function notifyPaymentChange(paymentId: string, event: 'created' | 'edited' | 'receipt' | 'deposit_settled', oldAmount?: number): Promise<void> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    await fetch('/api/group-payment-updated', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId, event, ...(oldAmount !== undefined ? { oldAmount } : {}) }),
    });
  } catch (err) {
    console.error('Could not update the payment copies:', err);
  }
}

// "Nudge for the receipt": asks the payer (by push and in their feed) to add the receipt to a payment that has none. The server allows one
// nudge per payment every 6 hours; `nudgedAt` comes back so the screen can say when.
export async function nudgeForReceipt(paymentId: string): Promise<{ ok: boolean; error?: string; nudgedAt?: string }> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return { ok: false, error: 'Please sign in again.' };
    const res = await fetch('/api/group-payment/receipt-nudge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, nudgedAt: data.nudgedAt };
    return { ok: false, error: data.error || 'Could not send the reminder.', nudgedAt: data.nudgedAt };
  } catch (err) {
    console.error('Could not send the receipt reminder:', err);
    return { ok: false, error: 'Could not send the reminder. Check your connection.' };
  }
}
