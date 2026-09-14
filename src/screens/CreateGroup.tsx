import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db, trackEvent } from '../lib/firebase';
import { collection, setDoc, doc } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firebase';
import { clsx } from 'clsx';
import { updateGlobalStats } from '../services/statsService';
import { fireWrite } from '../lib/offlineWrite';
import { resizeImageFile } from '../lib/imageUtils';

import { CURRENCY_SYMBOLS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, CustomCategory, makeCustomCategoryId, currencyForCountry, getCurrencySymbol } from '../lib/constants';
import { GROUP_ICONS } from '../lib/groupIcons';
import { useLanguage } from '../context/LanguageContext';
import { currentLocalMonthKey } from '../lib/dateUtils';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';

const CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

// Paired name/description/icon suggestions for the first-time guided flow (see `guide` below) —
// clicking one fills all three at once, since a beginner staring at a blank "name your group"
// field is exactly the moment a few concrete starting points help most. Deliberately NOT shown
// on every visit to this screen — an experienced user creating their 5th group doesn't need
// training wheels every time.
const GROUP_SUGGESTIONS: { icon: string; name: string; description: string }[] = [
  { icon: '👨‍👩‍👧‍👦', name: 'Family Expenses', description: 'Everyday spending we track together as a family.' },
  { icon: '🏡', name: 'Roommates', description: 'Shared rent, groceries, and bills split between roommates.' },
  { icon: '✈️', name: 'Trip Fund', description: 'Expenses for our upcoming trip, split evenly.' },
  { icon: '💍', name: 'Wedding Planning', description: 'Tracking costs for the big day.' },
  { icon: '👥', name: 'Friends Hangout', description: 'Splitting bills when we go out together.' },
];

// The guided flow's own step sequence — deliberately NOT built on OnboardingTour.tsx's generic
// spotlight engine (used by every other tour in the app). That engine is a read-only "look at
// this, click Next" explainer over EXISTING UI, with a floating tooltip card as the visual focus —
// exactly what explicit feedback said this flow shouldn't be. Here, the real form controls ARE the
// guide: each step reveals progressively (nothing after the current step renders at all yet),
// the active step gets a highlighted/glowing border directly on the real field, and advancing
// happens either automatically the moment the user acts (picks an icon, taps a currency) or via a
// small inline "Next" button gated on that step's own validity — never a separate floating window.
const GUIDE_STEPS = ['suggestions', 'icon', 'name', 'description', 'currency', 'budget', 'categories', 'grouptype'] as const;
type GuideStepId = typeof GUIDE_STEPS[number];

export default function CreateGroup() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  // First-time guided experience — see ProfileSetupWizard.tsx's "Create your first group" step,
  // which is the only place this ever gets set (plus the header's "Test: New User Guide" button
  // for localhost testing, which routes through that exact same wizard).
  const guide = searchParams.get('guide') === '1';
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  // null once every step is done (or guide mode is off) — the rest of the form (categories tail,
  // split/income toggles, Create button) only renders once this goes null, same progressive-
  // disclosure treatment as every step before it.
  const currentGuideStep: GuideStepId | null = guide && guideStepIndex < GUIDE_STEPS.length ? GUIDE_STEPS[guideStepIndex] : null;
  const guideDone = !guide || guideStepIndex >= GUIDE_STEPS.length;
  const guideReached = (step: GuideStepId) => !guide || GUIDE_STEPS.indexOf(step) <= guideStepIndex;
  const guideActive = (step: GuideStepId) => currentGuideStep === step;
  const goToNextGuideStep = () => setGuideStepIndex((i) => Math.min(i + 1, GUIDE_STEPS.length));
  const skipGuide = () => setGuideStepIndex(GUIDE_STEPS.length);
  // Small "Step N of 8 · Skip guide" strip shown only above whichever section is currently active
  // — this, plus each step's own short instruction line, is the entire "tooltip" for this flow;
  // there's no separate floating card fighting the real form for attention.
  const stepBadge = (step: GuideStepId) =>
    guideActive(step) && (
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black text-primary uppercase tracking-wider">
          Step {GUIDE_STEPS.indexOf(step) + 1} of {GUIDE_STEPS.length}
        </span>
        <button type="button" onClick={skipGuide} className="text-[9px] font-bold text-text-muted hover:text-primary">
          Skip guide
        </button>
      </div>
    );
  // Wrap a step's real form section in this — the highlighted/glowing border sits directly on the
  // actual field, not on a floating overlay elsewhere on screen.
  const guideWrapClass = (step: GuideStepId) =>
    clsx(guideActive(step) && 'fl-tour-glow ring-2 ring-primary/70 rounded-2xl p-3 -m-3 bg-primary/5');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Defaults to match the country set in ProfileSetupWizard, falling back to INR only when there's
  // no country on file yet (e.g. an existing account creating another group before ever visiting
  // Profile) — same currencyForCountry lookup Settlements.tsx already uses for a similar guess.
  const [currency, setCurrency] = useState(() => currencyForCountry(profile?.country) || 'INR');
  const [icon, setIcon] = useState('🏠');
  const [loading, setLoading] = useState(false);
  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [splitEnabled, setSplitEnabled] = useState(false);
  // Defaults to ON now (was off) — most groups end up wanting a full income+expense picture, and
  // it's one tap to turn off for the minority that just want spend tracking. Applies to every
  // group creation, not just the guided flow.
  const [incomeEnabled, setIncomeEnabled] = useState(true);
  const [groupType, setGroupType] = useState<'regular' | 'event'>('regular');
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [customCategories, setCustomCategories] = useState<CustomCategory[]>([]);
  const [newExpenseCatIcon, setNewExpenseCatIcon] = useState('🏷️');
  const [newExpenseCatName, setNewExpenseCatName] = useState('');
  const [newIncomeCatIcon, setNewIncomeCatIcon] = useState('🏷️');
  const [newIncomeCatName, setNewIncomeCatName] = useState('');
  // Optional — sets groupBudgets/{groupId}_{monthKey} the same way ManageGroup.tsx's own "Set a
  // budget" form does, just available right at creation time too so a new group doesn't need a
  // separate trip there immediately after. General, not guide-only.
  const [budgetInput, setBudgetInput] = useState('');

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

  const applySuggestion = (s: { icon: string; name: string; description: string }) => {
    setIcon(s.icon);
    setName(s.name);
    setDescription(s.description);
    setPhotoURL(null); // a suggestion picks an icon, so any photo already chosen would hide it
    if (guideActive('suggestions')) goToNextGuideStep();
  };

  const handleIconPick = (iconValue: string) => {
    setIcon(iconValue);
    if (guideActive('icon')) goToNextGuideStep();
  };

  const handleCurrencyPick = (curr: string) => {
    setCurrency(curr);
    if (guideActive('currency')) goToNextGuideStep();
  };

  const handleGroupTypePick = (type: 'regular' | 'event') => {
    setGroupType(type);
    if (guideActive('grouptype')) goToNextGuideStep();
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
      if (guideActive('icon')) goToNextGuideStep();
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

      // Optional initial monthly budget — same groupBudgets/{groupId}_{monthKey} doc shape
      // ManageGroup.tsx's own "Set a budget" form writes, so this group shows a budget-progress
      // tile on Dashboard immediately rather than needing a separate visit to set one.
      const parsedBudget = evaluateAmountSum(budgetInput);
      if (parsedBudget && parsedBudget > 0) {
        const monthKey = currentLocalMonthKey();
        fireWrite(setDoc(doc(db, 'groupBudgets', `${groupRef.id}_${monthKey}`), {
          groupId: groupRef.id,
          month: monthKey,
          amount: parsedBudget,
          setBy: user.uid,
          createdAt: new Date().toISOString(),
        }), 'set initial monthly budget');
      }

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
              {guideActive('suggestions') && (
                <div className="w-full bg-primary/5 border-2 border-primary/70 rounded-2xl p-4 space-y-3 fl-tour-glow">
                  {stepBadge('suggestions')}
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-[20px] text-primary shrink-0">tips_and_updates</span>
                    <div>
                      <p className="text-sm font-black text-primary">Let's set up your first group</p>
                      <p className="text-[11px] text-text-muted mt-0.5">
                        A group is where you'll track expenses (and optionally income) with your family, roommates, or friends. Tap a starting point below — it fills in the name, description, and icon for you — or skip ahead and fill everything in yourself.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {GROUP_SUGGESTIONS.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        onClick={() => applySuggestion(s)}
                        className={clsx(
                          'flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all active:scale-95',
                          name === s.name ? 'bg-primary text-white border-primary' : 'bg-white text-on-surface border-border-subtle hover:bg-surface-container',
                        )}
                      >
                        <span>{s.icon}</span>{s.name}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                    Skip suggestions, I'll fill it in myself →
                  </button>
                </div>
              )}

              {guideReached('icon') && (
                <div data-step="icon" className={clsx('flex flex-col items-center gap-2 py-0', guideWrapClass('icon'))}>
                  {stepBadge('icon')}
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
                  {guideActive('icon') && !photoURL && (
                    <p className="text-[10px] text-text-muted text-center max-w-[220px]">
                      👉 Pick an icon below that fits your group, or tap the small camera button above to add a real photo of your family or group instead.
                    </p>
                  )}
                  {photoError && <p className="text-xs text-error font-bold text-center">{photoError}</p>}

                  {!photoURL && (
                    <div className="w-full">
                      <label className="text-[9px] font-bold text-text-muted uppercase tracking-wider mb-1 block text-center">{t('createGroup.selectIcon')}</label>
                      <div className="grid grid-cols-5 gap-1 max-w-xs mx-auto">
                        {ICONS.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleIconPick(item.icon)}
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
                  {guideActive('icon') && (
                    <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline pt-1">
                      Looks good, Next →
                    </button>
                  )}
                </div>
              )}

              {guideReached('name') && (
                <div className={clsx('space-y-1', guideWrapClass('name'))}>
                  {stepBadge('name')}
                  <label className="text-[11px] text-text-muted px-1 font-bold">{t('createGroup.groupName')}</label>
                  <input
                    required
                    autoFocus={guideActive('name')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && guideActive('name') && name.trim()) { e.preventDefault(); goToNextGuideStep(); } }}
                    className="w-full h-10 px-4 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium text-sm"
                    placeholder={t('createGroup.groupNamePlaceholder')}
                    type="text"
                  />
                  {guideActive('name') && (
                    <button
                      type="button"
                      onClick={goToNextGuideStep}
                      disabled={!name.trim()}
                      className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline"
                    >
                      Next →
                    </button>
                  )}
                </div>
              )}

              {guideReached('description') && (
                <div className={clsx('space-y-1', guideWrapClass('description'))}>
                  {stepBadge('description')}
                  <label className="text-[11px] text-text-muted px-1">{t('createGroup.descriptionOptional')}</label>
                  <textarea
                    autoFocus={guideActive('description')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full p-3 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none text-sm"
                    placeholder={t('createGroup.descriptionPlaceholder')}
                    rows={2}
                  />
                  {guideActive('description') && (
                    <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                      {description.trim() ? 'Next →' : 'Skip, Next →'}
                    </button>
                  )}
                </div>
              )}

              {guideReached('currency') && (
                <div className={clsx('space-y-2', guideWrapClass('currency'))}>
                  {stepBadge('currency')}
                  <label className="text-[11px] text-text-muted px-1">{t('createGroup.groupCurrency')}</label>
                  {guideActive('currency') && (
                    <p className="text-[10px] text-text-muted px-1">
                      👉 We've picked {currency} to match your profile's country — tap a different one if this group tracks something else.
                    </p>
                  )}
                  <div className="flex gap-1 overflow-x-auto pb-1 no-scrollbar">
                    {CURRENCIES.map(curr => (
                      <button
                        key={curr}
                        type="button"
                        onClick={() => handleCurrencyPick(curr)}
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
                  {guideActive('currency') && (
                    <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                      {currency} looks right, Next →
                    </button>
                  )}
                </div>
              )}

              {guideReached('budget') && (
                <div className={clsx('space-y-1', guideWrapClass('budget'))}>
                  {stepBadge('budget')}
                  <label className="text-[11px] text-text-muted px-1">Monthly Budget (Optional)</label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-text-muted shrink-0 w-6 text-center">{getCurrencySymbol(currency)}</span>
                    <input
                      autoFocus={guideActive('budget')}
                      value={budgetInput}
                      onChange={(e) => setBudgetInput(e.target.value)}
                      inputMode="decimal"
                      className="flex-1 h-10 px-4 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all text-sm"
                      placeholder="e.g., 20000 or 15000+5000"
                    />
                  </div>
                  {hasAmountSumOperator(budgetInput) && evaluateAmountSum(budgetInput) !== null && (
                    <p className="text-xs font-bold text-success px-1">= {getCurrencySymbol(currency)}{evaluateAmountSum(budgetInput)!.toFixed(2)}</p>
                  )}
                  <p className="text-[10px] text-text-muted px-1">Get a heads-up as spending approaches this each month — you can set or change this anytime later too.</p>
                  {guideActive('budget') && (
                    <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                      {budgetInput.trim() ? 'Next →' : 'Skip, Next →'}
                    </button>
                  )}
                </div>
              )}

              {guideReached('categories') && (
                <div className={clsx('space-y-2.5 pt-2 border-t border-border-subtle', guideWrapClass('categories'))}>
                  {stepBadge('categories')}
                  <div>
                    <label className="text-[11px] text-text-muted px-1 font-bold block">{t('createGroup.categoriesTitle')}</label>
                    <p className="text-[10px] text-text-muted px-1">{t('createGroup.categoriesSubtitle')} Built-in categories can't be deleted — you can rename them anytime from Group Settings after creating this group.</p>
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
                  {guideActive('categories') && (
                    <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                      Next →
                    </button>
                  )}
                </div>
              )}

              {guideReached('grouptype') && (
                <div className="space-y-4 pt-2 border-t border-border-subtle">
                  <div className={clsx('space-y-1', guideWrapClass('grouptype'))}>
                    {stepBadge('grouptype')}
                    <label className="text-[11px] text-text-muted px-1 font-bold">{t('createGroup.groupType')}</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleGroupTypePick('regular')}
                        className={clsx(
                          'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                          groupType === 'regular' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                        )}
                      >
                        {t('createGroup.regularMonthly')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGroupTypePick('event')}
                        className={clsx(
                          'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                          groupType === 'event' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                        )}
                      >
                        {t('createGroup.oneOffEvent')}
                      </button>
                    </div>
                    <p className="text-[10px] text-text-muted px-1">
                      Regular/Monthly resets budgets and spending each month — pick this for ongoing groups. One-off Event is for a single trip or occasion instead.
                    </p>
                    {guideActive('grouptype') && (
                      <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">
                        {groupType === 'regular' ? 'Regular/Monthly looks right, Next →' : 'One-off Event looks right, Next →'}
                      </button>
                    )}
                  </div>

                  {guideDone && (
                    <>
                      <div>
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
                        {guide && (
                          <p className="text-[10px] text-text-muted px-3 pt-1.5">
                            💡 Turn this <b>on</b> if you're sharing bills with roommates, friends, or family — rent, groceries, a trip. Leave it <b>off</b> if this group is just for tracking your own personal spending.
                          </p>
                        )}
                      </div>

                      <div>
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
                        {guide && (
                          <p className="text-[10px] text-text-muted px-3 pt-1.5">
                            💡 Turn this <b>on</b> if you also want to log money coming in — salary, refunds, contributions — for a full household or shared-fund picture. Leave it <b>off</b> if you only want to track spending.
                          </p>
                        )}
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
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
