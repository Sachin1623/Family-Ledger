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
  const [savingCategory, setSavingCategory] = useState(false);
  const categories: string[] = shop?.categories || [];

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
    if (categories.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      setNewCategory('');
      return;
    }
    setSavingCategory(true);
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        categories: [...categories, trimmed],
        updatedAt: new Date().toISOString(),
      });
      logShopActivity(shopId, 'category_added', `${user?.displayName || 'Someone'} added category "${trimmed}"`, user?.displayName || undefined);
      setNewCategory('');
    } catch (err) {
      console.error('Failed to add category:', err);
    } finally {
      setSavingCategory(false);
    }
  };

  const handleRemoveCategory = async (category: string) => {
    if (!shopId) return;
    try {
      await updateDoc(doc(db, 'shops', shopId), {
        categories: categories.filter((c) => c !== category),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to remove category:', err);
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
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => (
                  <span key={c} className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 bg-[#7C3AED]/10 text-[#7C3AED] rounded-full text-xs font-bold">
                    {c}
                    {isOwner && (
                      <button onClick={() => handleRemoveCategory(c)} className="hover:text-error">
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {isOwner && (
              <form onSubmit={handleAddCategory} className="flex gap-2">
                <input
                  type="text"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="New category name"
                  className="flex-1 bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
                />
                <button
                  type="submit"
                  disabled={savingCategory || !newCategory.trim()}
                  className="px-4 py-2 bg-[#7C3AED] text-white rounded-xl text-sm font-bold disabled:opacity-50"
                >
                  {savingCategory ? '…' : 'Add'}
                </button>
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
