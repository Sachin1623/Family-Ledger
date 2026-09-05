import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db, trackEvent } from '../lib/firebase';
import { collection, setDoc, doc } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firebase';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { updateGlobalStats } from '../services/statsService';
import { fireWrite } from '../lib/offlineWrite';
import { resizeImageFile } from '../lib/imageUtils';

import { CURRENCY_SYMBOLS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, CustomCategory, makeCustomCategoryId } from '../lib/constants';
import { GROUP_ICONS } from '../lib/groupIcons';
import { useLanguage } from '../context/LanguageContext';

const CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

export default function CreateGroup() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [icon, setIcon] = useState('🏠');
  const [loading, setLoading] = useState(false);
  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [incomeEnabled, setIncomeEnabled] = useState(false);
  const [groupType, setGroupType] = useState<'regular' | 'event'>('regular');
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [customCategories, setCustomCategories] = useState<CustomCategory[]>([]);
  const [newExpenseCatIcon, setNewExpenseCatIcon] = useState('🏷️');
  const [newExpenseCatName, setNewExpenseCatName] = useState('');
  const [newIncomeCatIcon, setNewIncomeCatIcon] = useState('🏷️');
  const [newIncomeCatName, setNewIncomeCatName] = useState('');

  const ICONS = GROUP_ICONS;

  const toggleHiddenCategory = (categoryId: string) => {
    setHiddenCategories((prev) => (prev.includes(categoryId) ? prev.filter((id) => id !== categoryId) : [...prev, categoryId]));
  };
  const addCustomCategory = (type: 'expense' | 'income') => {
    const trimmedName = (type === 'expense' ? newExpenseCatName : newIncomeCatName).trim();
    if (!trimmedName) return;
    const trimmedIcon = (type === 'expense' ? newExpenseCatIcon : newIncomeCatIcon).trim() || '🏷️';
    setCustomCategories((prev) => [...prev, { id: makeCustomCategoryId(), name: trimmedName, icon: trimmedIcon, type }]);
    if (type === 'expense') { setNewExpenseCatName(''); setNewExpenseCatIcon('🏷️'); }
    else { setNewIncomeCatName(''); setNewIncomeCatIcon('🏷️'); }
  };
  const removeCustomCategory = (categoryId: string) => {
    setCustomCategories((prev) => prev.filter((c) => c.id !== categoryId));
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoError(null);
    try {
      // See Profile.tsx's own handleFileChange for the full story: this used to be a local,
      // hand-rolled resize with no reader.onerror/img.onerror wired up, so an undecodable image
      // (HEIC/HEIF straight off an Android camera, most commonly) hung the Promise forever
      // instead of failing — resizeImageFile actually rejects, so this can surface an error now.
      const resized = await resizeImageFile(file, 800, 800, 0.6);
      setPhotoURL(resized);
    } catch (error) {
      console.error('Photo resize error:', error);
      setPhotoError("Couldn't read that photo — try a different one (some camera formats like HEIC aren't supported).");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || loading || !user) return;

    setLoading(true);
    try {
      // Firestore generates document IDs client-side, so this ref (and its .id) is available
      // immediately with no network round trip — letting every write below fire without waiting
      // on each other, and navigation happen right away instead of blocking on server
      // acknowledgement (which — offline — wouldn't arrive until back online; see offlineWrite.ts).
      // The offline queue preserves write order, so these still land server-side group-then-
      // member-then-activity once synced, same as before.
      const groupRef = doc(collection(db, 'groups'));
      fireWrite(setDoc(groupRef, {
        name,
        description,
        currency,
        icon,
        photoURL,
        splitEnabled,
        incomeEnabled,
        groupType,
        ...(hiddenCategories.length > 0 && { hiddenCategories }),
        ...(customCategories.length > 0 && { customCategories }),
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
        totalSpending: 0,
        totalIncome: 0,
        memberCount: 1,
        coverImage: photoURL || 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&q=80&w=1000'
      }), 'create group');

      fireWrite(setDoc(doc(db, 'members', `${user.uid}_${groupRef.id}`), {
        userId: user.uid,
        groupId: groupRef.id,
        role: 'owner',
        canInvite: true,
        joinedAt: new Date().toISOString(),
        displayName: profile?.displayName || user.displayName || 'Owner',
        photoURL: profile?.photoURL || user.photoURL || ''
      }), 'create group membership');

      fireWrite(setDoc(doc(collection(db, 'activities')), {
        groupId: groupRef.id,
        userId: user.uid,
        userName: profile?.displayName || user.displayName || 'Owner',
        userPhoto: profile?.photoURL || user.photoURL || '',
        type: 'create_group',
        description: `${profile?.displayName || user.displayName || 'Someone'} created the group "${name}"`,
        data: { name, currency, icon },
        createdAt: new Date().toISOString()
      }), 'log group-creation activity');

      updateGlobalStats({ groups: 1 }).catch((err) => console.error('updateGlobalStats failed:', err));
      trackEvent('group_created', { currency, group_type: groupType });

      // Invite-flow spec: every group (not just a user's first) gets the one-tap invite prompt
      // right after creation — see ManageGroup.tsx's `?justCreated=1` handling.
      navigate(`/groups/${groupRef.id}/manage?justCreated=1`);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'groups');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 pb-32">
        <div className="max-w-2xl mx-auto space-y-4">
          <section className="bg-white rounded-2xl p-5 border border-border-subtle shadow-sm flex flex-col items-center">
            <div className="w-full space-y-4">
              <div className="flex flex-col items-center gap-2 py-0">
                <div className="relative group">
                  <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center border-2 border-primary/20 shadow-inner overflow-hidden">
                    {photoURL ? (
                      <img src={photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="text-4xl">{icon}</span>
                    )}
                  </div>
                  <label className="absolute -bottom-2 -right-2 w-8 h-8 bg-white rounded-full shadow-lg border border-border-subtle flex items-center justify-center text-primary hover:bg-surface transition-all active:scale-90 cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">photo_camera</span>
                    <input type="file" className="hidden" accept="image/*" onChange={handlePhotoChange} />
                  </label>
                </div>
                {photoError && <p className="text-xs text-error font-bold text-center">{photoError}</p>}

                {!photoURL && (
                  <div className="w-full">
                    <label className="text-[9px] font-bold text-text-muted uppercase tracking-wider mb-1 block text-center">{t('createGroup.selectIcon')}</label>
                    <div className="grid grid-cols-5 gap-1 max-w-xs mx-auto">
                      {ICONS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setIcon(item.icon)}
                          className={clsx(
                            "p-1.5 rounded-lg border transition-all active:scale-95",
                            icon === item.icon 
                              ? "bg-primary text-white border-primary shadow-md" 
                              : "bg-surface text-on-surface border-border-subtle hover:bg-surface-container"
                          )}
                        >
                          <span className="text-base">{item.icon}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-text-muted px-1 font-bold">{t('createGroup.groupName')}</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium text-sm"
                  placeholder={t('createGroup.groupNamePlaceholder')}
                  type="text"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-text-muted px-1">{t('createGroup.descriptionOptional')}</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full p-3 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none text-sm"
                  placeholder={t('createGroup.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-text-muted px-1">{t('createGroup.groupCurrency')}</label>
                <div className="flex gap-1 overflow-x-auto pb-1 no-scrollbar">
                  {CURRENCIES.map(curr => (
                    <button
                      key={curr}
                      type="button"
                      onClick={() => setCurrency(curr)}
                      className={clsx(
                        "flex-none px-3 py-1 rounded-lg text-[10px] font-bold transition-all border",
                        currency === curr 
                          ? 'bg-primary text-white border-primary shadow-sm' 
                          : 'bg-white text-on-surface border-border-subtle'
                      )}
                    >
                      {curr}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2.5 pt-2 border-t border-border-subtle">
                <div>
                  <label className="text-[11px] text-text-muted px-1 font-bold block">{t('createGroup.categoriesTitle')}</label>
                  <p className="text-[10px] text-text-muted px-1">{t('createGroup.categoriesSubtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EXPENSE_CATEGORIES.map((cat) => {
                    const hidden = hiddenCategories.includes(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => toggleHiddenCategory(cat.id)}
                        className={clsx(
                          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-bold transition-all',
                          hidden ? 'bg-surface-container/40 text-text-muted border-border-subtle line-through opacity-60' : 'bg-white text-on-surface border-border-subtle',
                        )}
                      >
                        <span>{cat.icon}</span>{t(`category.${cat.id}`)}
                      </button>
                    );
                  })}
                  {customCategories.filter((c) => c.type === 'expense').map((cat) => (
                    <div key={cat.id} className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-[11px] font-bold text-primary">
                      <span>{cat.icon}</span>{cat.name}
                      <button type="button" onClick={() => removeCustomCategory(cat.id)} className="w-4 h-4 flex items-center justify-center text-primary/60 hover:text-primary">
                        <span className="material-symbols-outlined text-[13px]">close</span>
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={newExpenseCatIcon}
                    onChange={(e) => setNewExpenseCatIcon(e.target.value)}
                    maxLength={4}
                    className="w-10 h-8 text-center rounded-lg border border-border-subtle text-sm shrink-0"
                    placeholder="🏷️"
                  />
                  <input
                    value={newExpenseCatName}
                    onChange={(e) => setNewExpenseCatName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomCategory('expense'); } }}
                    className="flex-1 h-8 px-2.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    placeholder={t('createGroup.addCategoryPlaceholder')}
                  />
                  <button type="button" onClick={() => addCustomCategory('expense')} className="h-8 px-3 rounded-lg bg-primary text-white text-[11px] font-bold shrink-0">
                    {t('common.add')}
                  </button>
                </div>

                {incomeEnabled && (
                  <div className="space-y-2.5 pt-2">
                    <label className="text-[11px] text-text-muted px-1 font-bold block">{t('createGroup.incomeCategoriesTitle')}</label>
                    <div className="flex flex-wrap gap-1.5">
                      {INCOME_CATEGORIES.map((cat) => {
                        const hidden = hiddenCategories.includes(cat.id);
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => toggleHiddenCategory(cat.id)}
                            className={clsx(
                              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-bold transition-all',
                              hidden ? 'bg-surface-container/40 text-text-muted border-border-subtle line-through opacity-60' : 'bg-white text-on-surface border-border-subtle',
                            )}
                          >
                            <span>{cat.icon}</span>{t(`income.${cat.id}`)}
                          </button>
                        );
                      })}
                      {customCategories.filter((c) => c.type === 'income').map((cat) => (
                        <div key={cat.id} className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-[11px] font-bold text-primary">
                          <span>{cat.icon}</span>{cat.name}
                          <button type="button" onClick={() => removeCustomCategory(cat.id)} className="w-4 h-4 flex items-center justify-center text-primary/60 hover:text-primary">
                            <span className="material-symbols-outlined text-[13px]">close</span>
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        value={newIncomeCatIcon}
                        onChange={(e) => setNewIncomeCatIcon(e.target.value)}
                        maxLength={4}
                        className="w-10 h-8 text-center rounded-lg border border-border-subtle text-sm shrink-0"
                        placeholder="🏷️"
                      />
                      <input
                        value={newIncomeCatName}
                        onChange={(e) => setNewIncomeCatName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomCategory('income'); } }}
                        className="flex-1 h-8 px-2.5 rounded-lg border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                        placeholder={t('createGroup.addCategoryPlaceholder')}
                      />
                      <button type="button" onClick={() => addCustomCategory('income')} className="h-8 px-3 rounded-lg bg-primary text-white text-[11px] font-bold shrink-0">
                        {t('common.add')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4 pt-2 border-t border-border-subtle">
                <div className="space-y-1">
                  <label className="text-[11px] text-text-muted px-1 font-bold">{t('createGroup.groupType')}</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setGroupType('regular')}
                      className={clsx(
                        'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                        groupType === 'regular' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                      )}
                    >
                      {t('createGroup.regularMonthly')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setGroupType('event')}
                      className={clsx(
                        'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                        groupType === 'event' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                      )}
                    >
                      {t('createGroup.oneOffEvent')}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-surface rounded-xl border border-border-subtle group cursor-pointer" onClick={() => setSplitEnabled(!splitEnabled)}>
                  <div className="flex items-center gap-3">
                    <div className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                      splitEnabled ? "bg-primary text-white" : "bg-white text-text-muted border border-border-subtle"
                    )}>
                      <span className="material-symbols-outlined">payments</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-primary">{t('createGroup.expenseSplitting')}</span>
                      <span className="text-[10px] text-text-muted">{t('createGroup.expenseSplittingDesc')}</span>
                    </div>
                  </div>
                  <div className={clsx(
                    "w-12 h-6 rounded-full transition-all relative",
                    splitEnabled ? "bg-primary" : "bg-border-subtle"
                  )}>
                    <div className={clsx(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm",
                      splitEnabled ? "left-7" : "left-1"
                    )} />
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-surface rounded-xl border border-border-subtle group cursor-pointer" onClick={() => setIncomeEnabled(!incomeEnabled)}>
                  <div className="flex items-center gap-3">
                    <div className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                      incomeEnabled ? "bg-primary text-white" : "bg-white text-text-muted border border-border-subtle"
                    )}>
                      <span className="material-symbols-outlined">add_card</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-primary">{t('createGroup.trackIncome')}</span>
                      <span className="text-[10px] text-text-muted">{t('createGroup.trackIncomeDesc')}</span>
                    </div>
                  </div>
                  <div className={clsx(
                    "w-12 h-6 rounded-full transition-all relative",
                    incomeEnabled ? "bg-primary" : "bg-border-subtle"
                  )}>
                    <div className={clsx(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm",
                      incomeEnabled ? "left-7" : "left-1"
                    )} />
                  </div>
                </div>

                <div className="pt-6">
                  <button 
                    type="button"
                    onClick={handleSubmit}
                    disabled={loading || !name}
                    className="w-full h-12 bg-primary text-white rounded-2xl font-bold text-base flex items-center justify-center gap-2 shadow-lg hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    {loading ? t('createGroup.creating') : (
                      <>
                        <span className="material-symbols-outlined">group_add</span>
                        {t('createGroup.create')}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
