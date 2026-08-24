import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { collection, addDoc, doc, query, orderBy, limit } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { buildPromoMessage, shareViaWhatsApp, resizeShopImage, logShopActivity, generateCustomerCode } from '../../lib/shop';

const WIN_BACK_DAYS = 30;

export default function ShopCustomers() {
  const { user, profile } = useAuth();
  const { shopId } = useShopMode();
  const navigate = useNavigate();

  const [shopDocValue] = useDocument(shopId ? doc(db, 'shops', shopId) : null);
  const shop = shopDocValue?.data() as any;

  const [showPromo, setShowPromo] = useState(false);
  const [promoItemName, setPromoItemName] = useState('');
  const [promoMessage, setPromoMessage] = useState('');
  const [promoPhoto, setPromoPhoto] = useState<string | null>(null);
  const [processingPromoPhoto, setProcessingPromoPhoto] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [promoResult, setPromoResult] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const [customersValue, customersLoading] = useCollection(shopId ? collection(db, 'shops', shopId, 'customers') : null);
  const customers = customersValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [salesValue] = useCollection(
    shopId ? query(collection(db, 'shops', shopId, 'sales'), orderBy('date', 'desc'), limit(1000)) : null,
  );
  const sales = salesValue?.docs.map((d) => d.data() as any) || [];

  // Per-customer stats derived from sales — last purchase date and total spend, used for the
  // repeat-customer / win-back insights below.
  const statsByCustomer = useMemo(() => {
    const map = new Map<string, { lastDate: string; total: number; count: number }>();
    sales.forEach((s) => {
      const existing = map.get(s.customerId);
      const total = (existing?.total || 0) + (s.price || 0);
      const count = (existing?.count || 0) + 1;
      const lastDate = !existing || s.date > existing.lastDate ? s.date : existing.lastDate;
      map.set(s.customerId, { lastDate, total, count });
    });
    return map;
  }, [sales]);

  const winBackList = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WIN_BACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return customers
      .filter((c) => {
        const stat = statsByCustomer.get(c.id);
        return stat && stat.lastDate < cutoffStr;
      })
      .sort((a, b) => (statsByCustomer.get(b.id)?.total || 0) - (statsByCustomer.get(a.id)?.total || 0));
  }, [customers, statsByCustomer]);

  const topCustomers = useMemo(() => {
    return [...customers]
      .filter((c) => statsByCustomer.has(c.id))
      .sort((a, b) => (statsByCustomer.get(b.id)?.total || 0) - (statsByCustomer.get(a.id)?.total || 0))
      .slice(0, 5);
  }, [customers, statsByCustomer]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q),
    );
  }, [customers, search]);

  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId) return;
    setSaving(true);
    try {
      // Walk-in customers sometimes don't want to share a name or number — auto-generate a short
      // stand-in code rather than blocking the sale/credit entry on having one.
      const code = generateCustomerCode();
      const finalName = name.trim() || code;
      const ref = await addDoc(collection(db, 'shops', shopId, 'customers'), {
        name: finalName,
        customerCode: code,
        email: email.trim() || null,
        phone: phone.trim() || null,
        creditBalance: 0,
        createdAt: new Date().toISOString(),
        createdBy: user?.uid,
      });
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      logShopActivity(shopId, 'customer_created', `${actorName} added customer "${finalName}"`, actorName);
      setName('');
      setEmail('');
      setPhone('');
      setShowForm(false);
      navigate(`/shop/customers/${ref.id}`);
    } catch (err) {
      console.error('Failed to add customer:', err);
      alert('Failed to add customer.');
    } finally {
      setSaving(false);
    }
  };

  const handlePromoPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessingPromoPhoto(true);
    try {
      setPromoPhoto(await resizeShopImage(file));
    } catch (err) {
      console.error('Promo photo resize failed:', err);
    } finally {
      setProcessingPromoPhoto(false);
    }
  };

  const handleSendPromoEmail = async () => {
    if (!user || !shopId || !promoMessage.trim()) return;
    setSendingEmail(true);
    setPromoResult(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/shops/${shopId}/send-promo-email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: `New at ${shop?.shopName || 'our shop'}: ${promoItemName}`,
          message: promoMessage.trim(),
          imageDataUri: promoPhoto || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to send.');
      setPromoResult(`Emailed ${data.sent} of ${data.total} customers.`);
    } catch (err: any) {
      setPromoResult(err.message || 'Failed to send emails.');
    } finally {
      setSendingEmail(false);
    }
  };

  const handleSendPromoWhatsApp = (customer: any) => {
    const msg = buildPromoMessage({ shopName: shop?.shopName || 'Our shop', itemName: promoItemName, message: promoMessage });
    shareViaWhatsApp({ message: msg, phone: customer.phone, imageDataUri: promoPhoto || undefined });
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-black text-[#7C3AED]">Customers</h1>
            <p className="text-sm text-text-muted mt-1">Your customer list and insights.</p>
          </div>
          <button
            onClick={() => setShowPromo(!showPromo)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-[#7C3AED]/10 text-[#7C3AED] rounded-xl text-xs font-bold"
          >
            <span className="material-symbols-outlined text-[16px]">campaign</span>
            Promo
          </button>
        </div>

        {showPromo && (
          <section className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <h2 className="text-sm font-bold text-primary">New Item Promotion</h2>
            <input
              type="text"
              value={promoItemName}
              onChange={(e) => setPromoItemName(e.target.value)}
              placeholder="Item name"
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
            />
            <textarea
              value={promoMessage}
              onChange={(e) => setPromoMessage(e.target.value)}
              rows={3}
              placeholder="What's new / why they'll like it…"
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none resize-none"
            />
            {promoPhoto ? (
              <div className="relative w-20 h-20">
                <img src={promoPhoto} alt="" className="w-full h-full object-cover rounded-xl border border-border-subtle" />
                <button type="button" onClick={() => setPromoPhoto(null)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-error text-white rounded-full flex items-center justify-center">
                  <span className="material-symbols-outlined text-[12px]">close</span>
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED] cursor-pointer">
                  <span className="material-symbols-outlined text-[16px]">photo_camera</span>
                  {processingPromoPhoto ? '…' : 'Take Photo'}
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePromoPhotoChange} disabled={processingPromoPhoto} />
                </label>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED] cursor-pointer">
                  <span className="material-symbols-outlined text-[16px]">image</span>
                  {processingPromoPhoto ? '…' : 'Gallery'}
                  <input type="file" accept="image/*" className="hidden" onChange={handlePromoPhotoChange} disabled={processingPromoPhoto} />
                </label>
              </div>
            )}
            <button
              onClick={handleSendPromoEmail}
              disabled={sendingEmail || !promoMessage.trim()}
              className="w-full py-3 bg-[#7C3AED] text-white font-bold rounded-xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">mail</span>
              {sendingEmail ? 'Sending…' : 'Email All Customers'}
            </button>
            {promoResult && <p className="text-xs text-text-muted text-center">{promoResult}</p>}

            <div className="pt-2 border-t border-border-subtle space-y-2">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Or send via WhatsApp, one at a time</p>
              <div className="flex flex-wrap gap-2">
                {customers.filter((c) => c.phone).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSendPromoWhatsApp(c)}
                    disabled={!promoMessage.trim()}
                    className="px-3 py-1.5 bg-[#25D366]/10 text-[#128C4A] rounded-full text-xs font-bold border border-[#25D366]/20 disabled:opacity-40"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {winBackList.length > 0 && (
          <section className="bg-[#7C3AED]/5 border border-[#7C3AED]/20 rounded-2xl p-4 space-y-2">
            <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest">
              Win-back — no purchase in {WIN_BACK_DAYS}+ days
            </h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {winBackList.slice(0, 10).map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/shop/customers/${c.id}`)}
                  className="shrink-0 px-3 py-2 bg-white rounded-xl border border-border-subtle text-xs font-bold text-primary"
                >
                  {c.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {topCustomers.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest px-1">Top Customers</h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {topCustomers.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/shop/customers/${c.id}`)}
                  className="shrink-0 px-3 py-2 bg-white rounded-xl border border-border-subtle text-xs font-bold text-primary flex items-center gap-1.5"
                >
                  {c.name}
                  <span className="text-[#7C3AED]">{statsByCustomer.get(c.id)?.count}x</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or phone…"
            className="w-full h-11 pl-10 pr-3 bg-white rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
          />
        </div>

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="w-full py-3.5 bg-[#7C3AED]/5 border border-[#7C3AED]/20 text-[#7C3AED] font-bold rounded-2xl flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined">person_add</span>
            New Customer
          </button>
        ) : (
          <form onSubmit={handleAddCustomer} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional — a code is generated if left blank)"
              autoFocus
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email (optional)"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone (optional)"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="flex-1 py-3 bg-[#7C3AED] text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}

        <section className="space-y-2">
          {customersLoading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!customersLoading && filteredCustomers.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">No customers found.</p>
          )}
          {filteredCustomers.map((c: any) => {
            const stat = statsByCustomer.get(c.id);
            return (
              <div
                key={c.id}
                onClick={() => navigate(`/shop/customers/${c.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between cursor-pointer hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] font-bold shrink-0">
                    {c.name?.slice(0, 1) || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{c.name}</p>
                    <p className="text-[10px] text-text-muted truncate">{c.email || c.phone || ''}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {c.creditBalance > 0 && (
                    <p className="text-xs font-bold text-error">Owes {c.creditBalance.toLocaleString()}</p>
                  )}
                  {stat && <p className="text-[10px] text-text-muted">{stat.count} purchase{stat.count !== 1 ? 's' : ''}</p>}
                </div>
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
