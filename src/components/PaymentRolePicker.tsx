import React from 'react';
import { clsx } from 'clsx';

// In a Payments group a person can be marked as the one who pays, the one who receives, or both. It is a label and a default,
// never a restriction: it pre-fills "who you pay" and tells everyone how the group is meant to work, but anyone can still add
// or view entries (a refund, a part-payment in cash and similar real-life cases run in the other direction).
export type PaymentRole = 'payer' | 'receiver' | 'both';
export const PAYMENT_ROLE_LABEL: Record<PaymentRole, string> = { payer: 'Payer', receiver: 'Receiver', both: 'Payer & receiver' };

export const isPaymentRole = (v: any): v is PaymentRole => v === 'payer' || v === 'receiver' || v === 'both';
// can this person be the one who gets paid / the one who pays
export const canReceive = (role: any) => role === 'receiver' || role === 'both';
export const canPay = (role: any) => role === 'payer' || role === 'both';

const TONE: Record<PaymentRole, string> = {
  payer: 'bg-[#eef0ff] text-[#4338ca]',
  receiver: 'bg-success/10 text-success',
  both: 'bg-amber-100 text-amber-800',
};

// A small chip that reads as a tag, and becomes a chooser when the person may change it
export default function PaymentRolePicker({
  value, onChange, editable, className,
}: {
  value?: string;
  onChange?: (role: PaymentRole | '') => void;
  editable: boolean;
  className?: string;
}) {
  const role = isPaymentRole(value) ? value : '';
  if (!editable) {
    return role ? <span className={clsx('text-[10px] font-black uppercase tracking-wider rounded-full px-2.5 py-1', TONE[role], className)}>{PAYMENT_ROLE_LABEL[role]}</span> : null;
  }
  return (
    <select
      aria-label="Payment role"
      value={role}
      onChange={(e) => onChange?.(e.target.value as PaymentRole | '')}
      onClick={(e) => e.stopPropagation()}
      className={clsx('text-[10px] font-black uppercase tracking-wider rounded-full px-2.5 py-1 border-0 outline-none cursor-pointer appearance-none text-center', role ? TONE[role] : 'bg-surface text-text-muted border border-border-subtle', className)}
    >
      <option value="">Set role</option>
      <option value="payer">Payer</option>
      <option value="receiver">Receiver</option>
      <option value="both">Payer &amp; receiver</option>
    </select>
  );
}
