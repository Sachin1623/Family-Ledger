import { auth } from './firebase';

// Tells the server a payment in a Payments group was created, edited, or given a receipt, so the people's tracked copies stay in
// line and the receiver is notified (see /api/group-payment-updated in server.ts). The payment itself is already saved; this is
// best effort and never blocks the screen.
export async function notifyPaymentChange(paymentId: string, event: 'created' | 'edited' | 'receipt', oldAmount?: number): Promise<void> {
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
