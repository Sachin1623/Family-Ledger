import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { collection, query, where, orderBy, doc, runTransaction, updateDoc } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { logShopActivity, shareViaWhatsApp } from '../../lib/shop';

function timeAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ShopCustomerDetail() {
  const { customerId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { shopId } = useShopMode();

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const [editingContact, setEditingContact] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [savingContact, setSavingContact] = useState(false);

  const [customerDoc] = useDocument(shopId && customerId ? doc(db, 'shops', shopId, 'customers', customerId) : null);
  const customer = customerDoc?.data() as any;

  const [shopDocValue] = useDocument(shopId ? doc(db, 'shops', shopId) : null);
  const shop = shopDocValue?.data() as any;

  const startEditContact = () => {
    setEditName(customer.name || '');
    setEditPhone(customer.phone || '');
    setEditEmail(customer.email || '');
    setEditingContact(true);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId || !customerId) return;
    setSavingContact(true);
    try {
      await updateDoc(doc(db, 'shops', shopId, 'customers', customerId), {
        name: editName.trim() || customer.name,
        phone: editPhone.trim() || null,
        email: editEmail.trim() || null,
        updatedAt: new Date().toISOString(),
      });
      setEditingContact(false);
    } catch (err) {
      console.error('Failed to update customer contact info:', err);
      alert('Failed to save.');
    } finally {
      setSavingContact(false);
    }
  };

  const handleAddToWhatsAppGroup = () => {
    if (!shop?.whatsappGroupName) return;
    const message = shop.whatsappGroupLink
      ? `Hi ${customer.name}! Join our WhatsApp group "${shop.whatsappGroupName}" for updates and offers from ${shop.shopName}: ${shop.whatsappGroupLink}`
      : `Hi ${customer.name}! We have a WhatsApp group "${shop.whatsappGroupName}" for updates and offers from ${shop.shopName} — let us know if you'd like to join!`;
    shareViaWhatsApp({ message, phone: customer.phone });
  };

  const [entriesValue] = useCollection(
    shopId && customerId
      ? query(collection(db, 'shops', shopId, 'customers', customerId, 'creditEntries'), orderBy('createdAt', 'desc'))
      : null,
  );
  const entries = entriesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [salesValue] = useCollection(
    shopId && customerId ? query(collection(db, 'shops', shopId, 'sales'), where('customerId', '==', customerId)) : null,
  );
  const sales = (salesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || []).sort((a, b) => b.date.localeCompare(a.date));

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !shopId || !customerId) return;
    const amount = parseFloat(paymentAmount);
    if (!amount || amount <= 0) return;
    setSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const customerRef = doc(db, 'shops', shopId, 'customers', customerId);
        const snap = await transaction.get(customerRef);
        if (!snap.exists()) throw new Error('Not found');
        const newBalance = Math.max(0, (snap.data().creditBalance || 0) - amount);
        const entryRef = doc(collection(db, 'shops', shopId, 'customers', customerId, 'creditEntries'));
        transaction.set(entryRef, {
          type: 'payment_received',
          amount,
          description: 'Payment received',
          addedBy: user.uid,
          createdAt: new Date().toISOString(),
        });
        transaction.update(customerRef, { creditBalance: newBalance, updatedAt: new Date().toISOString() });
      });
      logShopActivity(shopId, 'credit_payment', `${user.displayName || 'Someone'} recorded a payment of ${amount.toLocaleString()} from ${customer?.name || 'a customer'}`, user.displayName || undefined);
      setPaymentAmount('');
      setShowPaymentForm(false);
    } catch (err) {
      console.error('Failed to record payment:', err);
      alert('Failed to record payment.');
    } finally {
      setSaving(false);
    }
  };

  if (!customer) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <p className="text-sm text-text-muted">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <button onClick={() => navigate('/shop/customers')} className="text-xs font-bold text-[#7C3AED] flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          All customers
        </button>

        <div className="bg-white rounded-2xl border border-border-subtle p-6 text-center space-y-2">
          <div className="w-14 h-14 rounded-full bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] font-bold text-xl mx-auto">
            {customer.name?.slice(0, 1) || '?'}
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <h1 className="text-lg font-black text-primary">{customer.name}</h1>
            <button onClick={startEditContact} className="text-text-muted">
              <span className="material-symbols-outlined text-[16px]">edit</span>
            </button>
          </div>
          <p className="text-xs text-text-muted">{customer.email || customer.phone || 'No contact info'}</p>

          {editingContact && (
            <form onSubmit={handleSaveContact} className="text-left bg-surface rounded-xl p-4 space-y-2 mt-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                className="w-full bg-white p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
              />
              <input
                type="tel"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
                placeholder="Phone"
                className="w-full bg-white p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
              />
              <input
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="Email"
                className="w-full bg-white p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditingContact(false)} className="flex-1 py-2 rounded-xl text-xs font-bold text-text-muted border border-border-subtle">Cancel</button>
                <button type="submit" disabled={savingContact} className="flex-1 py-2 bg-[#7C3AED] text-white rounded-xl text-xs font-bold disabled:opacity-50">{savingContact ? '…' : 'Save'}</button>
              </div>
            </form>
          )}

          {shop?.whatsappGroupName && (
            customer.phone ? (
              <button
                onClick={handleAddToWhatsAppGroup}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#25D366]/10 text-[#128C4A] rounded-xl text-xs font-bold border border-[#25D366]/20"
              >
                <span className="material-symbols-outlined text-[16px]">group_add</span>
                Add to WhatsApp Group
              </button>
            ) : (
              <button onClick={startEditContact} className="text-[10px] text-text-muted italic underline">
                Add a phone number to invite this customer to "{shop.whatsappGroupName}"
              </button>
            )
          )}

          <p className="text-[11px] text-text-muted uppercase font-bold tracking-wider pt-2">Credit Balance (Udhaar)</p>
          <p className={clsx('text-3xl font-black', customer.creditBalance > 0 ? 'text-error' : 'text-[#0F7A38]')}>
            {(customer.creditBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
          {customer.creditBalance > 0 && (
            <button
              onClick={() => setShowPaymentForm(!showPaymentForm)}
              className="mt-2 px-4 py-2 bg-[#7C3AED] text-white rounded-xl text-xs font-bold"
            >
              Record Payment
            </button>
          )}
        </div>

        {showPaymentForm && (
          <form onSubmit={handleRecordPayment} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-3">
            <input
              type="number"
              step="0.01"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              placeholder="Amount paid"
              autoFocus
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowPaymentForm(false)} className="flex-1 py-2.5 rounded-xl font-bold text-text-muted border border-border-subtle text-sm">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="flex-1 py-2.5 bg-[#7C3AED] text-white font-bold rounded-xl text-sm disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest px-1">Credit History</h2>
          {entries.length === 0 && <p className="text-sm text-text-muted italic px-1">No credit activity yet.</p>}
          {entries.map((e: any) => (
            <div key={e.id} className="bg-white rounded-xl border border-border-subtle p-3 flex items-center gap-3">
              <span className="material-symbols-outlined text-[18px] text-text-muted">
                {e.type === 'sale_credit' ? 'call_made' : 'undo'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">{e.description || (e.type === 'sale_credit' ? 'Credit sale' : 'Payment received')}</p>
                <p className="text-[10px] text-text-muted">{timeAgo(e.createdAt)}</p>
              </div>
              <span className={clsx('text-sm font-bold shrink-0', e.type === 'sale_credit' ? 'text-error' : 'text-[#0F7A38]')}>
                {e.type === 'sale_credit' ? '+' : '-'}{e.amount?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest px-1">Purchase History</h2>
          {sales.length === 0 && <p className="text-sm text-text-muted italic px-1">No purchases yet.</p>}
          {sales.map((s: any) => (
            <div key={s.id} className="bg-white rounded-xl border border-border-subtle p-3 flex items-center gap-3">
              {s.itemPhoto ? (
                <img src={s.itemPhoto} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-text-muted text-[18px]">inventory_2</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">{s.itemName}</p>
                <p className="text-[10px] text-text-muted">{new Date(s.date).toLocaleDateString()} · {s.paymentStatus === 'credit' ? 'Credit' : 'Paid'}</p>
              </div>
              <span className="text-sm font-bold text-primary shrink-0">{s.price?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
