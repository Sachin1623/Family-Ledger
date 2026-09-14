import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { doc, updateDoc, collection } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { logShopActivity } from '../../lib/shop';

export default function ShopProfile() {
  const { user } = useAuth();
  const { shopId, shopRole } = useShopMode();
  const isOwner = shopRole === 'owner';

  const [shopDocValue] = useDocument(shopId ? doc(db, 'shops', shopId) : null);
  const shop = shopDocValue?.data() as any;

  const [staffValue] = useCollection(shopId ? collection(db, 'shops', shopId, 'staff') : null);
  const staff = staffValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [editing, setEditing] = useState(false);
  const [shopName, setShopName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsappGroupName, setWhatsappGroupName] = useState('');
  const [whatsappGroupLink, setWhatsappGroupLink] = useState('');
  const [saving, setSaving] = useState(false);

  const [staffEmail, setStaffEmail] = useState('');
  const [addingStaff, setAddingStaff] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);

  const [newCategory, setNewCategory] = useState('');
  const [newCategoryPrice, setNewCategoryPrice] = useState('');
  const [newCategoryCost, setNewCategoryCost] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editCost, setEditCost] = useState('');
  const [savingCategoryPricing, setSavingCategoryPricing] = useState(false);
  // Categories used to be a plain string[] — normalize old shop docs on read so existing
  // categories keep working with no migration step; every NEW write always uses the object shape.
  const categories: { name: string; price?: number; cost?: number }[] = (shop?.categories || []).map(
    (c: any) => (typeof c === 'string' ? { name: c } : c),
  );

  const startEdit = () => {
    setShopName(shop?.shopName || '');
    setOwnerName(shop?.ownerName || '');
    setPhone(shop?.phone || '');
    setWhatsappGroupName(shop?.whatsappGroupName || '');
    setWhatsappGroupLink(shop?.whatsappGroupLink || '');
    setEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId || !shopName.trim()) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        shopName: shopName.trim(),
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        whatsappGroupName: whatsappGroupName.trim(),
        whatsappGroupLink: whatsappGroupLink.trim(),
        updatedAt: new Date().toISOString(),
      });
      setEditing(false);
    } catch (err) {
      console.error('Failed to update shop:', err);
      alert('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !shopId || !staffEmail.trim()) return;
    setAddingStaff(true);
    setStaffError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/shops/${shopId}/add-staff`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: staffEmail.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStaffError(data.error || 'Failed to add staff.');
        return;
      }
      logShopActivity(shopId, 'staff_added', `${user.displayName || 'Someone'} added ${staffEmail.trim()} as staff`, user.displayName || undefined);
      setStaffEmail('');
    } catch (err) {
      console.error('Failed to add staff:', err);
      setStaffError('Failed to add staff.');
    } finally {
      setAddingStaff(false);
    }
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId || !newCategory.trim()) return;
    const trimmed = newCategory.trim();
    if (categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      setNewCategory('');
      return;
    }
    const price = newCategoryPrice.trim() ? parseFloat(newCategoryPrice) : undefined;
    const cost = newCategoryCost.trim() ? parseFloat(newCategoryCost) : undefined;
    setSavingCategory(true);
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        categories: [...categories, { name: trimmed, ...(price != null && !isNaN(price) ? { price } : {}), ...(cost != null && !isNaN(cost) ? { cost } : {}) }],
        updatedAt: new Date().toISOString(),
      });
      logShopActivity(shopId, 'category_added', `${user?.displayName || 'Someone'} added category "${trimmed}"`, user?.displayName || undefined);
      setNewCategory('');
      setNewCategoryPrice('');
      setNewCategoryCost('');
    } catch (err) {
      console.error('Failed to add category:', err);
    } finally {
      setSavingCategory(false);
    }
  };

  const handleRemoveCategory = async (categoryName: string) => {
    if (!shopId) return;
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        categories: categories.filter((c) => c.name !== categoryName),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to remove category:', err);
    }
  };

  const startEditCategoryPricing = (c: { name: string; price?: number; cost?: number }) => {
    setEditingCategory(c.name);
    setEditPrice(c.price != null ? String(c.price) : '');
    setEditCost(c.cost != null ? String(c.cost) : '');
  };

  const handleSaveCategoryPricing = async (e: React.FormEvent, categoryName: string) => {
    e.preventDefault();
    if (!shopId) return;
    const price = editPrice.trim() ? parseFloat(editPrice) : undefined;
    const cost = editCost.trim() ? parseFloat(editCost) : undefined;
    setSavingCategoryPricing(true);
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        categories: categories.map((c) =>
          c.name === categoryName
            ? { name: c.name, ...(price != null && !isNaN(price) ? { price } : {}), ...(cost != null && !isNaN(cost) ? { cost } : {}) }
            : c,
        ),
        updatedAt: new Date().toISOString(),
      });
      setEditingCategory(null);
    } catch (err) {
      console.error('Failed to update category pricing:', err);
    } finally {
      setSavingCategoryPricing(false);
    }
  };

  const handleRemoveStaff = async (staffUid: string, staffName: string) => {
    if (!user || !shopId || !window.confirm('Remove this staff member?')) return;
    try {
      const idToken = await user.getIdToken();
      await fetch(`/api/shops/${shopId}/remove-staff`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffUid }),
      });
      logShopActivity(shopId, 'staff_removed', `${user.displayName || 'Someone'} removed ${staffName} from staff`, user.displayName || undefined);
    } catch (err) {
      console.error('Failed to remove staff:', err);
    }
  };

  if (!shop) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full pb-24">
          <p className="text-sm text-text-muted">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-[#7C3AED]">Shop Profile</h1>
          <p className="text-sm text-text-muted mt-1">Your shop details and staff.</p>
        </div>

        {editing ? (
          <form onSubmit={handleSave} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Shop Name</label>
              <input
                type="text"
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Owner Name</label>
              <input
                type="text"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">WhatsApp Group Name</label>
              <input
                type="text"
                value={whatsappGroupName}
                onChange={(e) => setWhatsappGroupName(e.target.value)}
                placeholder="e.g. Sharma General Store — Updates"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">WhatsApp Group Invite Link (optional)</label>
              <input
                type="url"
                value={whatsappGroupLink}
                onChange={(e) => setWhatsappGroupLink(e.target.value)}
                placeholder="https://chat.whatsapp.com/…"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
              />
              <p className="text-[10px] text-text-muted px-1">Adding the invite link lets the "Add to WhatsApp Group" button on a customer's page send it directly — without it, the button just mentions the group name.</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="flex-1 py-3 bg-[#7C3AED] text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        ) : (
          <div className="bg-white rounded-2xl border border-border-subtle p-6 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-lg font-black text-primary">{shop.shopName}</p>
                <p className="text-sm text-text-muted">{shop.ownerName}</p>
                {shop.phone && <p className="text-sm text-text-muted">{shop.phone}</p>}
                {shop.whatsappGroupName && (
                  <p className="text-sm text-[#25D366] font-bold flex items-center gap-1 mt-1">
                    <span className="material-symbols-outlined text-[16px]">chat</span>
                    {shop.whatsappGroupName}
                  </p>
                )}
              </div>
              {isOwner && (
                <button onClick={startEdit} className="text-xs font-bold text-[#7C3AED] flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">edit</span>
                  Edit
                </button>
              )}
            </div>
          </div>
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest px-1">Categories</h2>
          <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-3">
            {categories.length === 0 ? (
              <p className="text-xs text-text-muted italic">No categories yet — add some below to speed up sales entry.</p>
            ) : (
              <div className="space-y-2">
                {categories.map((c) => (
                  <div key={c.name} className="flex items-center justify-between gap-2 bg-surface rounded-xl border border-border-subtle p-2.5">
                    {editingCategory === c.name ? (
                      <form onSubmit={(e) => handleSaveCategoryPricing(e, c.name)} className="flex-1 flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-[#7C3AED] shrink-0">{c.name}</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value)}
                          placeholder="Price"
                          className="w-20 bg-white p-1.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editCost}
                          onChange={(e) => setEditCost(e.target.value)}
                          placeholder="Cost"
                          className="w-20 bg-white p-1.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                        />
                        <button
                          type="submit"
                          disabled={savingCategoryPricing}
                          className="px-2.5 py-1 bg-[#7C3AED] text-white rounded-lg text-[11px] font-bold disabled:opacity-50"
                        >
                          {savingCategoryPricing ? '…' : 'Save'}
                        </button>
                        <button type="button" onClick={() => setEditingCategory(null)} className="px-2.5 py-1 text-[11px] font-bold text-text-muted">
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-[#7C3AED] truncate">{c.name}</p>
                          <p className="text-[10px] text-text-muted">
                            {c.price != null || c.cost != null
                              ? `Price ${c.price != null ? c.price : '—'} · Cost ${c.cost != null ? c.cost : '—'}`
                              : 'No default price/cost set'}
                          </p>
                        </div>
                        {isOwner && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => startEditCategoryPricing(c)} className="text-text-muted hover:text-[#7C3AED] p-1" title="Edit price/cost">
                              <span className="material-symbols-outlined text-[16px]">edit</span>
                            </button>
                            <button onClick={() => handleRemoveCategory(c.name)} className="text-text-muted hover:text-error p-1" title="Remove category">
                              <span className="material-symbols-outlined text-[16px]">close</span>
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isOwner && (
              <form onSubmit={handleAddCategory} className="space-y-2 pt-2 border-t border-border-subtle">
                <input
                  type="text"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="New category name"
                  className="w-full bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                />
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={newCategoryPrice}
                    onChange={(e) => setNewCategoryPrice(e.target.value)}
                    placeholder="Price (optional)"
                    className="flex-1 min-w-0 bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={newCategoryCost}
                    onChange={(e) => setNewCategoryCost(e.target.value)}
                    placeholder="Cost (optional)"
                    className="flex-1 min-w-0 bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                  />
                  <button
                    type="submit"
                    disabled={savingCategory || !newCategory.trim()}
                    className="px-4 py-2 bg-[#7C3AED] text-white rounded-xl text-sm font-bold disabled:opacity-50 shrink-0"
                  >
                    {savingCategory ? '…' : 'Add'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest px-1">Staff</h2>
          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            <div className="p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] font-bold text-xs shrink-0">
                {(shop.ownerName || 'O').slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">{shop.ownerName}</p>
                <p className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Owner</p>
              </div>
            </div>
            {staff.map((s: any) => (
              <div key={s.id} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] font-bold text-xs shrink-0">
                  {(s.name || '?').slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-on-surface truncate">{s.name}</p>
                  <p className="text-[10px] text-text-muted truncate">{s.email}</p>
                </div>
                {isOwner && (
                  <button onClick={() => handleRemoveStaff(s.id, s.name || 'this staff member')} className="p-1.5 text-error shrink-0">
                    <span className="material-symbols-outlined text-[18px]">person_remove</span>
                  </button>
                )}
              </div>
            ))}
          </div>

          {isOwner && (
            <form onSubmit={handleAddStaff} className="bg-white rounded-2xl border border-border-subtle p-4 space-y-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Add Staff by Email</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={staffEmail}
                  onChange={(e) => setStaffEmail(e.target.value)}
                  placeholder="staff@example.com"
                  className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                />
                <button
                  type="submit"
                  disabled={addingStaff || !staffEmail.trim()}
                  className={clsx('px-4 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50', 'bg-[#7C3AED]')}
                >
                  {addingStaff ? '…' : 'Add'}
                </button>
              </div>
              <p className="text-[10px] text-text-muted px-1">They need a FamilyLedger account already — staff can't be added by email alone.</p>
              {staffError && <p className="text-xs font-bold text-error px-1">{staffError}</p>}
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
