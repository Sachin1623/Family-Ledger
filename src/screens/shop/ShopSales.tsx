import React, { useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { collection, addDoc, doc, query, orderBy, limit, runTransaction, updateDoc } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { todayLocalDateString } from '../../lib/dateUtils';
import { buildSaleMessage, shareViaWhatsApp, resizeShopImage, logShopActivity, generateCustomerCode } from '../../lib/shop';

// Masked cost input — password-style dots while typing, with an eye toggle to reveal, so the
// shopkeeper can key in cost right at the register without it being readable if the customer's
// eyes land on the screen (explicit request — cost is the shopkeeper's margin, not the
// customer's business).
function MaskedCostInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <input
        type={revealed ? 'text' : 'password'}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Cost (kept private)"
        className="w-full bg-surface p-3 pr-10 rounded-xl border border-border-subtle text-sm outline-none"
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted p-1"
      >
        <span className="material-symbols-outlined text-[18px]">{revealed ? 'visibility_off' : 'visibility'}</span>
      </button>
    </div>
  );
}

export default function ShopSales() {
  const { user, profile } = useAuth();
  const { shopId } = useShopMode();

  const [shopDocValue] = useDocument(shopId ? doc(db, 'shops', shopId) : null);
  const shop = shopDocValue?.data() as any;

  const [customersValue] = useCollection(shopId ? collection(db, 'shops', shopId, 'customers') : null);
  const customers = customersValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [salesValue] = useCollection(
    shopId ? query(collection(db, 'shops', shopId, 'sales'), orderBy('createdAt', 'desc'), limit(200)) : null,
  );
  const sales = salesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  // --- New sale form state ---
  const [showForm, setShowForm] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'credit'>('paid');
  const [message, setMessage] = useState('');
  const [itemPhoto, setItemPhoto] = useState<string | null>(null);
  const [processingPhoto, setProcessingPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSale, setLastSale] = useState<{ customerName: string; customerPhone?: string; itemName: string; quantity?: number; price: number; itemPhoto?: string } | null>(null);

  // --- List filters ---
  const [pendingCostOnly, setPendingCostOnly] = useState(false);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  const matchingCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return [];
    return customers.filter(
      (c) => (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q),
    ).slice(0, 5);
  }, [customers, customerSearch]);

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);
  const visibleSales = pendingCostOnly ? sales.filter((s) => s.costPending) : sales;

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessingPhoto(true);
    try {
      setItemPhoto(await resizeShopImage(file));
    } catch (err) {
      console.error('Photo resize failed:', err);
    } finally {
      setProcessingPhoto(false);
    }
  };

  const resetForm = () => {
    setCustomerSearch('');
    setSelectedCustomerId('');
    setNewCustomerName('');
    setNewCustomerPhone('');
    setItemName('');
    setCategory('');
    setCustomCategory('');
    setPrice('');
    setCost('');
    setQuantity('1');
    setPaymentStatus('paid');
    setMessage('');
    setItemPhoto(null);
    setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !shopId) return;
    const parsedPrice = parseFloat(price);
    const parsedQuantity = parseFloat(quantity) || 1;
    if (!itemName.trim() || !parsedPrice || parsedPrice <= 0) return;
    const resolvedCategory = category && category !== '__other__' ? category : customCategory.trim();
    setSaving(true);
    try {
      let customerId = selectedCustomerId;
      let customerName = selectedCustomer?.name || '';
      let customerPhone = selectedCustomer?.phone || '';

      if (!customerId) {
        // Walk-in customers sometimes don't want to share a name or number — auto-generate a
        // short stand-in code rather than blocking the sale on having one.
        const code = generateCustomerCode();
        const finalName = newCustomerName.trim() || code;
        const ref = await addDoc(collection(db, 'shops', shopId, 'customers'), {
          name: finalName,
          customerCode: code,
          phone: newCustomerPhone.trim() || null,
          email: null,
          creditBalance: 0,
          createdAt: new Date().toISOString(),
          createdBy: user.uid,
        });
        customerId = ref.id;
        customerName = finalName;
        customerPhone = newCustomerPhone.trim();
      }

      const parsedCost = cost ? parseFloat(cost) : null;
      const saleRef = doc(collection(db, 'shops', shopId, 'sales'));

      await runTransaction(db, async (transaction) => {
        const customerRef = doc(db, 'shops', shopId, 'customers', customerId);
        const customerSnap = await transaction.get(customerRef);
        if (!customerSnap.exists()) throw new Error('Customer not found');

        transaction.set(saleRef, {
          customerId,
          customerName,
          customerPhone: customerPhone || null,
          itemName: itemName.trim(),
          category: resolvedCategory || null,
          quantity: parsedQuantity,
          itemPhoto: itemPhoto || null,
          price: parsedPrice,
          cost: parsedCost,
          costPending: parsedCost == null,
          paymentStatus,
          message: message.trim() || null,
          soldBy: user.uid,
          soldByName: profile?.displayName || user.displayName || 'Someone',
          date: todayLocalDateString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        if (paymentStatus === 'credit') {
          const newBalance = (customerSnap.data().creditBalance || 0) + parsedPrice;
          transaction.update(customerRef, { creditBalance: newBalance, updatedAt: new Date().toISOString() });
          const creditEntryRef = doc(collection(db, 'shops', shopId, 'customers', customerId, 'creditEntries'));
          transaction.set(creditEntryRef, {
            type: 'sale_credit',
            amount: parsedPrice,
            saleId: saleRef.id,
            description: itemName.trim(),
            addedBy: user.uid,
            createdAt: new Date().toISOString(),
          });
        }
      });

      const actorName = profile?.displayName || user.displayName || 'Someone';
      logShopActivity(shopId, 'sale_created', `${actorName} sold "${itemName.trim()}" to ${customerName} for ${parsedPrice.toLocaleString()}`, actorName);

      setLastSale({ customerName, customerPhone, itemName: itemName.trim(), quantity: parsedQuantity, price: parsedPrice, itemPhoto: itemPhoto || undefined });
      resetForm();
    } catch (err) {
      console.error('Failed to save sale:', err);
      alert('Failed to save sale.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendWhatsApp = (sale: { customerName: string; customerPhone?: string; itemName: string; quantity?: number; price: number; itemPhoto?: string }) => {
    const msg = buildSaleMessage({
      shopName: shop?.shopName || 'Our Shop',
      sellerName: profile?.displayName || user?.displayName || 'The seller',
      itemName: sale.itemName,
      quantity: sale.quantity,
      price: sale.price,
      currencySymbol: '',
    });
    shareViaWhatsApp({ message: msg, phone: sale.customerPhone, imageDataUri: sale.itemPhoto });
  };

  const handleUpdateSaleCost = async (saleId: string, itemLabel: string, newCost: string) => {
    if (!shopId) return;
    const parsed = parseFloat(newCost);
    if (!parsed || parsed <= 0) return;
    try {
      await updateDoc(doc(db, 'shops', shopId, 'sales', saleId), { cost: parsed, costPending: false, updatedAt: new Date().toISOString() });
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      logShopActivity(shopId, 'cost_set', `${actorName} set the cost for "${itemLabel}"`, actorName);
    } catch (err) {
      console.error('Failed to update cost:', err);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div data-tour="shop-sales-title">
          <h1 className="text-2xl font-black text-[#7C3AED]">Sales</h1>
          <p className="text-sm text-text-muted mt-1">Ring up a sale and manage your history.</p>
        </div>

        {lastSale && (
          <div className="bg-[#0F7A38]/10 border border-[#0F7A38]/20 rounded-2xl p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[#0F7A38]">Sale saved!</p>
              <p className="text-xs text-text-muted truncate">{lastSale.itemName} — {lastSale.customerName}</p>
            </div>
            <button
              onClick={() => handleSendWhatsApp(lastSale)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold"
            >
              <span className="material-symbols-outlined text-[16px]">chat</span>
              WhatsApp
            </button>
          </div>
        )}

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            data-tour="shop-sales-new"
            className="w-full py-3.5 bg-[#7C3AED] text-white font-bold rounded-2xl flex items-center justify-center gap-2 shadow-sm"
          >
            <span className="material-symbols-outlined">point_of_sale</span>
            New Sale
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Customer</label>
              {selectedCustomer ? (
                <div className="flex items-center justify-between bg-surface p-3 rounded-xl border border-border-subtle">
                  <span className="text-sm font-bold text-primary">{selectedCustomer.name}</span>
                  <button type="button" onClick={() => setSelectedCustomerId('')} className="text-[11px] font-bold text-[#7C3AED]">Change</button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Search name, email or phone…"
                    className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                  />
                  {matchingCustomers.length > 0 && (
                    <div className="border border-border-subtle rounded-xl overflow-hidden divide-y divide-border-subtle">
                      {matchingCustomers.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => { setSelectedCustomerId(c.id); setCustomerSearch(''); }}
                          className="w-full text-left p-2.5 text-sm hover:bg-surface-container/40"
                        >
                          {c.name} <span className="text-text-muted text-xs">{c.email || c.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {customerSearch.trim() && matchingCustomers.length === 0 && (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <input
                        type="text"
                        value={newCustomerName}
                        onChange={(e) => setNewCustomerName(e.target.value)}
                        placeholder="New customer name"
                        defaultValue={customerSearch}
                        className="bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
                      />
                      <input
                        type="tel"
                        value={newCustomerPhone}
                        onChange={(e) => setNewCustomerPhone(e.target.value)}
                        placeholder="Phone (optional)"
                        className="bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none"
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="Item name"
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
              {(shop?.categories || []).length > 0 ? (
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                >
                  <option value="">Category (optional)</option>
                  {(shop.categories as string[]).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  <option value="__other__">Other…</option>
                </select>
              ) : (
                <input
                  type="text"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder="Category (optional)"
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
                />
              )}
            </div>
            {category === '__other__' && (shop?.categories || []).length > 0 && (
              <input
                type="text"
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="Type a new category"
                autoFocus
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Quantity</label>
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="1"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price charged"
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              />
              <MaskedCostInput value={cost} onChange={setCost} />
            </div>
            <p className="text-[10px] text-text-muted px-1">Cost is optional now — leave blank and fill it in later from "Pending Cost" below.</p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPaymentStatus('paid')}
                className={clsx('py-2.5 rounded-xl text-xs font-bold border', paymentStatus === 'paid' ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle')}
              >
                Paid Now
              </button>
              <button
                type="button"
                onClick={() => setPaymentStatus('credit')}
                className={clsx('py-2.5 rounded-xl text-xs font-bold border', paymentStatus === 'credit' ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle')}
              >
                On Credit (Udhaar)
              </button>
            </div>

            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message (optional)"
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
            />

            <div className="space-y-1">
              {itemPhoto ? (
                <div className="relative w-24 h-24">
                  <img src={itemPhoto} alt="" className="w-full h-full object-cover rounded-xl border border-border-subtle" />
                  <button type="button" onClick={() => setItemPhoto(null)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-error text-white rounded-full flex items-center justify-center">
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <label className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED] cursor-pointer">
                    <span className="material-symbols-outlined text-[16px]">photo_camera</span>
                    {processingPhoto ? '…' : 'Take Photo'}
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoChange} disabled={processingPhoto} />
                  </label>
                  <label className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED] cursor-pointer">
                    <span className="material-symbols-outlined text-[16px]">image</span>
                    {processingPhoto ? '…' : 'Gallery'}
                    <input type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} disabled={processingPhoto} />
                  </label>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={resetForm} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                Cancel
              </button>
              <button type="submit" disabled={saving || processingPhoto} className="flex-1 py-3 bg-[#7C3AED] text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Sale'}
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center justify-between px-1">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest">Recent Sales</h2>
          <button
            onClick={() => setPendingCostOnly(!pendingCostOnly)}
            className={clsx('text-[11px] font-bold px-3 py-1.5 rounded-full border', pendingCostOnly ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle')}
          >
            Pending Cost {sales.filter((s) => s.costPending).length > 0 && `(${sales.filter((s) => s.costPending).length})`}
          </button>
        </div>

        <section className="space-y-2">
          {visibleSales.length === 0 && <p className="text-sm text-text-muted italic px-1">No sales found.</p>}
          {visibleSales.map((s: any) => {
            const isExpanded = expandedSaleId === s.id;
            return (
              <div key={s.id} className="bg-white rounded-xl border border-border-subtle overflow-hidden">
                <div
                  onClick={() => setExpandedSaleId(isExpanded ? null : s.id)}
                  className="p-3 flex items-center gap-3 cursor-pointer hover:bg-surface-container/20"
                >
                  {s.itemPhoto ? (
                    <img src={s.itemPhoto} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-text-muted text-[18px]">inventory_2</span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface truncate">
                      {s.itemName}
                      {s.quantity > 1 && <span className="text-[#7C3AED]"> ×{s.quantity}</span>}
                    </p>
                    <p className="text-[10px] text-text-muted truncate">
                      {s.category ? `${s.category} · ` : ''}{s.customerName} · {new Date(s.date).toLocaleDateString()}
                    </p>
                  </div>
                  {s.costPending && <span className="text-[9px] font-bold text-error uppercase shrink-0">Cost pending</span>}
                  <span className="text-sm font-bold text-primary shrink-0">{s.price?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                </div>
                {isExpanded && (
                  <SaleExpandedRow sale={s} shopId={shopId} onSendWhatsApp={() => handleSendWhatsApp(s)} onSetCost={(v) => handleUpdateSaleCost(s.id, s.itemName, v)} />
                )}
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}

function SaleExpandedRow({ sale, shopId, onSendWhatsApp, onSetCost }: { sale: any; shopId: string | null; onSendWhatsApp: () => void; onSetCost: (v: string) => void }) {
  const { user, profile } = useAuth();
  const [costInput, setCostInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [itemName, setItemName] = useState(sale.itemName);
  const [price, setPrice] = useState(String(sale.price));
  const [editCost, setEditCost] = useState(sale.costPending ? '' : String(sale.cost ?? ''));
  const [editQuantity, setEditQuantity] = useState(String(sale.quantity || 1));
  const [saving, setSaving] = useState(false);

  const handleSaveEdit = async () => {
    if (!shopId) return;
    setSaving(true);
    try {
      const parsedCost = editCost ? parseFloat(editCost) : null;
      await updateDoc(doc(db, 'shops', shopId, 'sales', sale.id), {
        itemName: itemName.trim(),
        price: parseFloat(price) || sale.price,
        cost: parsedCost,
        costPending: parsedCost == null,
        quantity: parseFloat(editQuantity) || 1,
        updatedAt: new Date().toISOString(),
      });
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      logShopActivity(shopId, 'sale_updated', `${actorName} edited the sale "${itemName.trim()}"`, actorName);
      setEditing(false);
    } catch (err) {
      console.error('Failed to update sale:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-3 pb-3 pt-1 border-t border-border-subtle space-y-3">
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <p className="text-text-muted uppercase font-bold tracking-wider">Payment</p>
          <p className="text-on-surface">{sale.paymentStatus === 'credit' ? 'On Credit' : 'Paid'}</p>
        </div>
        <div>
          <p className="text-text-muted uppercase font-bold tracking-wider">Category</p>
          <p className="text-on-surface">{sale.category || '—'}</p>
        </div>
        <div>
          <p className="text-text-muted uppercase font-bold tracking-wider">Quantity</p>
          <p className="text-on-surface">{sale.quantity || 1}</p>
        </div>
        <div>
          <p className="text-text-muted uppercase font-bold tracking-wider">Sold by</p>
          <p className="text-on-surface">{sale.soldByName}</p>
        </div>
        <div>
          <p className="text-text-muted uppercase font-bold tracking-wider">Cost</p>
          <p className="text-on-surface">{sale.costPending ? 'Not set' : sale.cost?.toLocaleString()}</p>
        </div>
      </div>

      {sale.costPending && (
        <div className="flex gap-2">
          <MaskedCostInput value={costInput} onChange={setCostInput} />
          <button onClick={() => onSetCost(costInput)} className="px-3 py-2 bg-[#7C3AED] text-white rounded-xl text-xs font-bold shrink-0">Set</button>
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <input value={itemName} onChange={(e) => setItemName(e.target.value)} className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none" />
          <div className="grid grid-cols-2 gap-2">
            <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Price" className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none" />
            <input type="number" min="1" step="1" value={editQuantity} onChange={(e) => setEditQuantity(e.target.value)} placeholder="Quantity" className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-xs outline-none" />
          </div>
          <MaskedCostInput value={editCost} onChange={setEditCost} />
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="flex-1 py-2 rounded-xl text-xs font-bold text-text-muted border border-border-subtle">Cancel</button>
            <button onClick={handleSaveEdit} disabled={saving} className="flex-1 py-2 bg-[#7C3AED] text-white rounded-xl text-xs font-bold disabled:opacity-50">{saving ? '…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setEditing(true)} className="flex-1 py-2 rounded-xl text-xs font-bold text-primary border border-border-subtle">Edit</button>
          <button onClick={onSendWhatsApp} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold">
            <span className="material-symbols-outlined text-[14px]">chat</span>
            WhatsApp
          </button>
        </div>
      )}
    </div>
  );
}
