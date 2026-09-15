import React, { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, updateDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db, auth } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { Goal, toMinorUnits, fromMinorUnits, goalTotalMinor, validateGoalName, validateTargetAmount, validateTargetDate, validateInflationRate, inflationAdjustedAmountMinor, decryptGoalAmounts, encryptGoalAmounts } from '../lib/goals';
import { encryptAmount } from '../lib/fieldCrypto';
import { unfreezeGoalReservations } from '../lib/accountAllocations';
import ImageAttachments from '../components/ImageAttachments';
import GoalExplainerModal from '../components/GoalExplainerModal';
import { startTour } from '../lib/tourRef';

const ICONS = ['🎯', '✈️', '🏠', '🚗', '🎓', '💍', '👶', '🏥', '🎉', '💻', '📱', '🛡️', '🏖️', '🐶', '🎸', '💰'];

// First-time guided flow — same engine as CreateGroup.tsx's guide (progressive reveal, a glowing
// highlight directly on the real field via the shared `.fl-tour-glow` CSS class, no floating
// tooltip card). Create-mode only (`?guide=1`, set by the header's "Test: Create Goal Flow"
// button) — editing an existing goal never shows this.
const GUIDE_STEPS = ['icon', 'name', 'amount', 'date', 'inflation', 'notes'] as const;
type GuideStepId = typeof GUIDE_STEPS[number];

// Create/Edit — same form for both; editing loads the existing goal via the :goalId route param.
// Sharing (optional group + specific friends/family, same dual model as RemindersHub.tsx's own
// share picker, reused directly) makes the goal visible to others and lets THEM add boosts — the
// automatic monthly allocation always still comes from the owner's own aggregated savings only.
export default function GoalWizard() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { goalId } = useParams<{ goalId?: string }>();
  const [searchParams] = useSearchParams();
  const isEditing = !!goalId;
  const guide = searchParams.get('guide') === '1' && !isEditing;
  // Part of the new-user onboarding chain (see OnboardingTour.tsx's 'group-explore' finish handler
  // and AccountsHub.tsx's own onboardingChain) — `?onboarding=1` alongside `?guide=1` means: show
  // the "what is a Goal?" explainer before the guide steps begin, and once saved, head into the
  // 'goals-explore' tour instead of GoalWizard's normal post-create destination. A standalone
  // "Create a Goal" from the Guides menu never carries this marker.
  const onboardingChain = guide && searchParams.get('onboarding') === '1';
  const [showGoalExplainer, setShowGoalExplainer] = useState(onboardingChain);
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  const currentGuideStep: GuideStepId | null = guide && guideStepIndex < GUIDE_STEPS.length ? GUIDE_STEPS[guideStepIndex] : null;
  const guideDone = !guide || guideStepIndex >= GUIDE_STEPS.length;
  const guideReached = (step: GuideStepId) => !guide || GUIDE_STEPS.indexOf(step) <= guideStepIndex;
  const guideActive = (step: GuideStepId) => currentGuideStep === step;
  const goToNextGuideStep = () => setGuideStepIndex((i) => Math.min(i + 1, GUIDE_STEPS.length));
  const skipGuide = () => setGuideStepIndex(GUIDE_STEPS.length);
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
  const guideWrapClass = (step: GuideStepId) =>
    clsx(guideActive(step) && 'fl-tour-glow ring-2 ring-primary/70 rounded-2xl p-3 -m-3 bg-primary/5');

  // Editing always returns to that goal's own detail page (where the Edit button lives) — same as
  // the old plain `navigate(-1)` did for this branch, just not dependent on browser history actually
  // matching. Creating a NEW goal returns to whichever GoalsHub tab launched it (tagged as
  // `?from=<tab>` by GoalsHub.tsx's own "New Goal" buttons) — GoalsHub's tabs are React state, not
  // routes, so a hardcoded '/goals' would always land back on its default 'reports' tab regardless.
  // Used by both the on-screen close button below AND the hardware/gesture back handler (App.tsx,
  // via navigationParents.ts's matching '/goals/new' special-case), so the two always agree.
  const closeDestination = () => {
    if (isEditing) { navigate(`/goals/${goalId}`); return; }
    const from = searchParams.get('from');
    navigate(from ? `/goals?tab=${from}` : '/goals');
  };

  const [loaded, setLoaded] = useState(!isEditing);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [targetDate, setTargetDate] = useState('');
  // The amount entered above is always taken as TODAY's cost of whatever the goal is for — this is
  // an optional annual rate that, together with targetDate, adjusts it forward to a future value
  // (see inflationAdjustedAmountMinor in lib/goals.ts) at save time. Left blank, nothing changes
  // from before this existed: the amount typed is exactly what's saved/tracked.
  const [inflationRateInput, setInflationRateInput] = useState('');
  const [notes, setNotes] = useState('');
  const [icon, setIcon] = useState('🎯');
  const [images, setImages] = useState<string[]>([]);
  const [currency, setCurrency] = useState('');
  const [shareGroupId, setShareGroupId] = useState<string | null>(null);
  const [shareFriendUids, setShareFriendUids] = useState<string[]>([]);
  // 'view' (read-only) or 'edit' (can also post a boost) — one role for the whole shared group, a
  // role per individual friend. New shares default to 'view', the safer starting point (existing
  // shared goals default the other way when this field is absent — see goals.ts's doc comment).
  const [shareGroupRole, setShareGroupRole] = useState<'view' | 'edit'>('view');
  const [shareFriendRoles, setShareFriendRoles] = useState<Record<string, 'view' | 'edit'>>({});
  const [friendSearch, setFriendSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds.slice(0, 30))) : null);
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];

  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(user?.uid);
  const { families: myFamilies, membersByFamilyId } = useFamilies(user?.uid);

  React.useEffect(() => {
    if (!currency && groups.length > 0 && !isEditing) setCurrency(groups[0].currency || 'INR');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  React.useEffect(() => {
    if (!isEditing || !goalId) return;
    (async () => {
      const snap = await getDoc(doc(db, 'goals', goalId));
      if (snap.exists()) {
        const g = await decryptGoalAmounts({ id: snap.id, ...(snap.data() as any) });
        setEditingGoal(g);
        setName(g.name);
        // Editing always shows/edits TODAY's cost, never the already-inflated target — falling
        // back to targetAmountMinor itself for a goal that has no inflation adjustment set, so
        // this reads exactly as it did before that existed.
        setTargetAmount(String(fromMinorUnits(g.targetAmountTodayMinor ?? g.targetAmountMinor)));
        setInflationRateInput(g.inflationRatePct != null ? String(g.inflationRatePct) : '');
        setTargetDate(g.targetDate || '');
        setNotes(g.notes || '');
        setIcon(g.icon || '🎯');
        setImages(g.imageUrl ? [g.imageUrl] : []);
        setCurrency(g.currency);
        setShareGroupId(g.groupId);
        setShareFriendUids(g.friendUids || []);
        setShareGroupRole(g.groupRole || 'edit');
        setShareFriendRoles(g.friendRoles || {});
      }
      setLoaded(true);
    })();
  }, [isEditing, goalId]);

  const [existingGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const existingActiveGoals = (existingGoalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
    .filter((g: any) => g.status !== 'archived') as { id: string; name: string }[];

  const isFamilyFullySelected = (familyId: string) => {
    const members = membersByFamilyId.get(familyId) || [];
    return members.length > 0 && members.every((m) => shareFriendUids.includes(m.userId));
  };
  const toggleFamily = (familyId: string) => {
    const memberUids = (membersByFamilyId.get(familyId) || []).map((m) => m.userId);
    const allSelected = isFamilyFullySelected(familyId);
    setShareFriendUids((prev) => (allSelected ? prev.filter((u) => !memberUids.includes(u)) : Array.from(new Set([...prev, ...memberUids]))));
  };
  const toggleFriend = (uid: string) => {
    setShareFriendUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  };
  const setFriendRole = (uid: string, role: 'view' | 'edit') => {
    setShareFriendRoles((prev) => ({ ...prev, [uid]: role }));
  };
  // Only the currently-selected friends' roles are ever written — a friend removed from the share
  // list shouldn't leave a stale role entry behind. Missing entries (a friend just added, never
  // explicitly given a role) default to 'view', same as the field's own absent-value default.
  const buildFriendRoles = (): Record<string, 'view' | 'edit'> =>
    Object.fromEntries(shareFriendUids.map((uid) => [uid, shareFriendRoles[uid] || 'view']));
  const filteredFriends = acceptedFriends.filter(({ friendUid }) => {
    if (!friendSearch.trim()) return true;
    const fname = friendUsersByUid.get(friendUid)?.displayName || '';
    return fname.toLowerCase().includes(friendSearch.trim().toLowerCase());
  });

  // Live preview for the inflation-rate field below — same calculation handleSave itself runs at
  // save time, just recomputed on every keystroke so the user sees the adjusted figure before
  // committing to it.
  const previewInflationRatePct = inflationRateInput.trim() ? parseFloat(inflationRateInput) : null;
  const previewAdjustedAmountMinor = inflationAdjustedAmountMinor(
    toMinorUnits(parseFloat(targetAmount || '0')),
    previewInflationRatePct,
    targetDate || null,
    todayLocalDateString(),
  );
  const showInflationPreview = !!previewInflationRatePct && previewInflationRatePct > 0 && !!targetDate && parseFloat(targetAmount || '0') > 0;

  const handleSave = async () => {
    if (!user || saving) return;
    const nextErrors: Record<string, string> = {};
    const nameErr = validateGoalName(name, existingActiveGoals, goalId);
    if (nameErr) nextErrors.name = nameErr;
    const amountMinor = toMinorUnits(parseFloat(targetAmount || '0'));
    const amountErr = validateTargetAmount(amountMinor);
    if (amountErr) nextErrors.targetAmount = amountErr;
    if (!isEditing) {
      const dateErr = validateTargetDate(targetDate || null, todayLocalDateString());
      if (dateErr) nextErrors.targetDate = dateErr;
    }
    const inflationRatePct = inflationRateInput.trim() ? parseFloat(inflationRateInput) : null;
    if (inflationRatePct != null) {
      const inflationErr = validateInflationRate(inflationRatePct);
      if (inflationErr) nextErrors.inflationRate = inflationErr;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    // The amount typed is always TODAY's cost; when a rate is set, what's actually saved/tracked
    // as targetAmountMinor is the future value at targetDate (see inflationAdjustedAmountMinor's
    // own doc comment) — recomputed from TODAY regardless of create vs. edit, so editing a goal
    // months later adjusts against however much runway is actually left, not a stale original date.
    const adjustedAmountMinor = inflationAdjustedAmountMinor(amountMinor, inflationRatePct, targetDate || null, todayLocalDateString());
    const targetAmountTodayMinorToSave = inflationRatePct != null ? amountMinor : null;

    setSaving(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      if (isEditing && editingGoal) {
        // A goal auto-completes (and freezes every account's own reservedAmountMinor share of it
        // — see accountAllocations.ts's header comment) the moment its total reaches target,
        // whether or not the user ever explicitly hit "Mark Completed." A target isn't actually
        // immutable, though: raising it back above the goal's current total means it's genuinely
        // no longer met, so it should behave like any other active goal again — reopened, with
        // every account's frozen share released back to tracking its live balance/% (not stuck
        // immutable), rather than staying permanently "done" against a target that no longer holds.
        const reopening = editingGoal.status === 'completed' && adjustedAmountMinor > goalTotalMinor(editingGoal);
        const [encryptedTarget, encryptedTargetToday] = await Promise.all([
          encryptAmount('goal', editingGoal.id, adjustedAmountMinor),
          targetAmountTodayMinorToSave == null ? Promise.resolve(null) : encryptAmount('goal', editingGoal.id, targetAmountTodayMinorToSave),
        ]);
        await updateDoc(doc(db, 'goals', editingGoal.id), {
          name: name.trim(),
          targetAmountMinor: encryptedTarget,
          targetAmountTodayMinor: encryptedTargetToday,
          inflationRatePct,
          targetDate: targetDate || null,
          notes: notes.trim() || null,
          icon,
          imageUrl: images[0] || null,
          groupId: shareGroupId,
          groupRole: shareGroupId ? shareGroupRole : null,
          friendUids: shareFriendUids,
          friendRoles: buildFriendRoles(),
          updatedAt: nowIso,
          ...(reopening ? { status: 'active', completedAt: null } : {}),
        });
        if (reopening) {
          await unfreezeGoalReservations(editingGoal.id, editingGoal.userId);
          const encryptedZero = await encryptAmount('goal', editingGoal.id, 0);
          await setDoc(doc(collection(db, 'goals', editingGoal.id, 'ledger')), {
            type: 'reset', amountMinor: encryptedZero, monthKey: null,
            note: t('goals.reopenedNote'), createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
          });
        }
        navigate(`/goals/${editingGoal.id}`);
      } else {
        // Two-phase write: the crypto/key endpoint authorizes a 'goal' scope by reading
        // goals/{id} and checking its userId — which doesn't exist yet for a brand-new goal.
        // Create the doc first with a harmless plaintext-zero placeholder (establishing
        // ownership, satisfying isValidGoal — 0 is a valid int amount), then immediately
        // encrypt the real target and overwrite it. Never writes the real amount as plaintext.
        const ref = doc(collection(db, 'goals'));
        await setDoc(ref, {
          userId: user.uid,
          name: name.trim(),
          targetAmountMinor: 0,
          currentAmountMinor: 0,
          accountAllocatedMinor: 0, // starts unfunded — the (repurposed) Allocation Manager or an account's own edit form is where it gets a share
          status: 'active',
          targetDate: targetDate || null,
          inflationRatePct,
          notes: notes.trim() || null,
          icon,
          imageUrl: images[0] || null,
          currency: currency || 'INR',
          groupId: shareGroupId,
          groupRole: shareGroupId ? shareGroupRole : null,
          friendUids: shareFriendUids,
          friendRoles: buildFriendRoles(),
          createdBy: user.uid,
          createdByName: actorName,
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: null,
        });
        const encryptedAmounts = await encryptGoalAmounts(ref.id, adjustedAmountMinor, 0, targetAmountTodayMinorToSave);
        await updateDoc(ref, {
          targetAmountMinor: encryptedAmounts.targetAmountMinor,
          currentAmountMinor: encryptedAmounts.currentAmountMinor,
          targetAmountTodayMinor: encryptedAmounts.targetAmountTodayMinor,
        });
        if (onboardingChain) {
          navigate('/goals');
          startTour('goals-explore');
        } else {
          navigate(`/goals/${ref.id}/allocate`);
        }
      }
      // Only the newly-added friends get notified — re-saving with the same share list (or
      // removing someone) shouldn't re-notify anyone already on it.
      const previouslyShared = new Set(isEditing && editingGoal ? (editingGoal.friendUids || []) : []);
      const newlyAdded = shareFriendUids.filter((uid) => !previouslyShared.has(uid));
      if (newlyAdded.length > 0) {
        auth.currentUser
          ?.getIdToken()
          .then((idToken) =>
            fetch('/api/health/notify-glucose-shared', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ friendUids: newlyAdded, readingLabel: name.trim(), kind: 'goal', actorName }),
            }),
          )
          .catch((err) => console.error('notify goal-shared failed:', err));
      }
    } catch (err) {
      console.error('Failed to save goal:', err);
      alert(t('goals.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Floating centered modal — same pattern as AccountsHub's Add/Edit Account (fixed inset-0
  // backdrop, centered white box, a `shrink-0` header that never scrolls, and everything else in a
  // `flex-1 overflow-y-auto` body) — replacing the previous full-screen-page-with-a-fixed-header
  // treatment this used before. Wrapping the loading state (the `!loaded` branch, hit while an Edit
  // fetches the existing goal) in the same shell too, so there's no flash of bare unstyled text
  // before the modal chrome appears.
  if (!loaded) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-8 text-center text-text-muted">{t('goals.loading')}</div>
      </div>
    );
  }

  if (showGoalExplainer) {
    return <GoalExplainerModal onClose={() => setShowGoalExplainer(false)} />;
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeDestination}>
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <h1 className="text-xl font-bold text-primary">{isEditing ? t('goals.editGoal') : t('goals.newGoal')}</h1>
          <button onClick={closeDestination} className="p-1.5 -mr-1.5 text-text-muted hover:bg-surface rounded-full shrink-0" aria-label={t('common.close')}>
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {guideReached('icon') && (
        <div className={clsx('space-y-1.5', guideWrapClass('icon'))}>
          {stepBadge('icon')}
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.icon')}</label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.iconDesc')}</p>
          <div className="flex flex-wrap gap-2">
            {ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                onClick={() => { setIcon(ic); if (guideActive('icon')) goToNextGuideStep(); }}
                className={clsx('w-11 h-11 rounded-xl flex items-center justify-center text-xl border-2 transition-all', icon === ic ? 'border-primary bg-primary/10' : 'border-border-subtle bg-white')}
              >
                {ic}
              </button>
            ))}
          </div>
          {guideActive('icon') && (
            <>
              <p className="text-[10px] text-text-muted px-1">👉 Pick an icon that fits this goal — you can also add a cover photo just below.</p>
              <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">Looks good, Next →</button>
            </>
          )}
        </div>
      )}

      {guideReached('icon') && (
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.coverPhoto')}</label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.coverPhotoDesc')}</p>
          <ImageAttachments images={images} onChange={setImages} maxImages={1} label={t('goals.addCoverPhoto')} />
        </div>
      )}

      {guideReached('name') && (
        <div className={clsx('space-y-1.5', guideWrapClass('name'))}>
          {stepBadge('name')}
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.goalName')} <span className="text-error">*</span></label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.goalNameDesc')}</p>
          <input
            type="text" autoFocus={guideActive('name')} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && guideActive('name') && name.trim()) { e.preventDefault(); goToNextGuideStep(); } }}
            placeholder={t('goals.goalNamePlaceholder')}
            className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.name ? 'border-error' : 'border-border-subtle')}
          />
          {errors.name && <p className="text-xs text-error font-bold px-1">{errors.name}</p>}
          {guideActive('name') && (
            <button type="button" onClick={goToNextGuideStep} disabled={!name.trim()} className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline">Next →</button>
          )}
        </div>
      )}

      {guideReached('amount') && (
        <div className={guideWrapClass('amount')}>
          {stepBadge('amount')}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.targetAmount')} <span className="text-error">*</span></label>
              <p className="text-[10px] text-text-muted px-1">{t('goals.targetAmountDesc')}</p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
                <input
                  type="text" inputMode="decimal" autoFocus={guideActive('amount')} value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="200000"
                  className={clsx('w-full h-12 bg-white pl-8 pr-3 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.targetAmount ? 'border-error' : 'border-border-subtle')}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.currency')}</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full h-12 bg-white px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                {Array.from(new Set([currency, ...groups.map((g: any) => g.currency)].filter(Boolean))).map((c) => (
                  <option key={c} value={c}>{c} ({getCurrencySymbol(c)})</option>
                ))}
              </select>
            </div>
          </div>
          {errors.targetAmount && <p className="text-xs text-error font-bold px-1">{errors.targetAmount}</p>}
          {guideActive('amount') && (
            <button
              type="button"
              onClick={() => { if (parseFloat(targetAmount || '0') > 0) goToNextGuideStep(); }}
              disabled={!(parseFloat(targetAmount || '0') > 0)}
              className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline mt-1"
            >
              Next →
            </button>
          )}
        </div>
      )}

      {guideReached('date') && (
        <div className={clsx('space-y-1.5', guideWrapClass('date'))}>
          {stepBadge('date')}
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.targetDate')}</label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.targetDateDesc')}</p>
          <input
            type="date" autoFocus={guideActive('date')} value={targetDate} min={!isEditing ? todayLocalDateString() : undefined} onChange={(e) => setTargetDate(e.target.value)}
            className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.targetDate ? 'border-error' : 'border-border-subtle')}
          />
          {errors.targetDate && <p className="text-xs text-error font-bold px-1">{errors.targetDate}</p>}
          {guideActive('date') && (
            <button type="button" onClick={goToNextGuideStep} disabled={!targetDate} className="text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline">Next →</button>
          )}
        </div>
      )}

      {guideReached('inflation') && (
        <div className={clsx('space-y-1.5', guideWrapClass('inflation'))}>
          {stepBadge('inflation')}
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.inflationRate')}</label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.inflationRateDesc')}</p>
          <div className="relative">
            <input
              type="text" inputMode="decimal" autoFocus={guideActive('inflation')} value={inflationRateInput}
              onChange={(e) => setInflationRateInput(e.target.value)} placeholder="e.g. 6"
              className={clsx('w-full h-12 bg-white pr-8 pl-3 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.inflationRate ? 'border-error' : 'border-border-subtle')}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">%/yr</span>
          </div>
          {errors.inflationRate && <p className="text-xs text-error font-bold px-1">{errors.inflationRate}</p>}
          {showInflationPreview && (
            <p className="text-[11px] font-bold text-primary bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
              {t('goals.inflationPreview', {
                today: `${getCurrencySymbol(currency)}${targetAmount}`,
                adjusted: `${getCurrencySymbol(currency)}${fromMinorUnits(previewAdjustedAmountMinor).toLocaleString()}`,
                date: targetDate,
              })}
            </p>
          )}
          {!targetDate && inflationRateInput.trim() && (
            <p className="text-[11px] text-text-muted px-1">{t('goals.inflationNeedsDate')}</p>
          )}
          {guideActive('inflation') && (
            <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">{inflationRateInput.trim() ? 'Next →' : 'Skip, Next →'}</button>
          )}
        </div>
      )}

      {guideReached('notes') && (
        <div className={clsx('space-y-1.5', guideWrapClass('notes'))}>
          {stepBadge('notes')}
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.notes')}</label>
          <p className="text-[10px] text-text-muted px-1">{t('goals.notesDesc')}</p>
          <textarea
            autoFocus={guideActive('notes')} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('goals.notesPlaceholder')}
            className="w-full bg-white p-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
          />
          {guideActive('notes') && (
            <button type="button" onClick={goToNextGuideStep} className="text-[11px] font-bold text-primary hover:underline">{notes.trim() ? 'Next →' : 'Skip, Next →'}</button>
          )}
        </div>
      )}

      {guideDone && (
      <>
      <div className="space-y-1.5 pt-1 border-t border-border-subtle">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.shareWith')}</label>
        <p className="text-[11px] text-text-muted px-1">{t('goals.shareWithDesc')}</p>
        <select
          value={shareGroupId || ''}
          onChange={(e) => setShareGroupId(e.target.value || null)}
          className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
        >
          <option value="">{t('goals.noGroupShare')}</option>
          {groups.map((g: any) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        {shareGroupId && (
          <div className="flex bg-surface rounded-lg border border-border-subtle p-0.5 gap-0.5">
            {(['view', 'edit'] as const).map((role) => (
              <button
                key={role} type="button" onClick={() => setShareGroupRole(role)}
                className={clsx('flex-1 py-1.5 rounded-md text-[10px] font-bold transition-all', shareGroupRole === role ? 'bg-primary text-white' : 'text-text-muted')}
              >
                {t(role === 'view' ? 'goals.shareRoleView' : 'goals.shareRoleEdit')}
              </button>
            ))}
          </div>
        )}
        {myFamilies.length > 0 && (
          <div className="space-y-1">
            {myFamilies.map((fam: any) => {
              const members = membersByFamilyId.get(fam.id) || [];
              const selected = isFamilyFullySelected(fam.id);
              return (
                <button
                  key={fam.id} type="button" onClick={() => toggleFamily(fam.id)}
                  className={clsx('w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}
                >
                  <span className="text-xs font-bold flex items-center gap-1.5">
                    <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                      {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                    </span>
                    {fam.name}
                  </span>
                  <span className="text-[10px] font-bold text-text-muted shrink-0">{members.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {acceptedFriends.length > 0 && (
          <div className="space-y-1">
            <input
              type="text" value={friendSearch} onChange={(e) => setFriendSearch(e.target.value)} placeholder={t('health.searchFriends')}
              className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none"
            />
            <div className="max-h-32 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
              {filteredFriends.length === 0 ? (
                <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
              ) : (
                filteredFriends.map(({ friendUid }) => {
                  const friend = friendUsersByUid.get(friendUid);
                  const selected = shareFriendUids.includes(friendUid);
                  const role = shareFriendRoles[friendUid] || 'view';
                  return (
                    <div key={friendUid} className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors">
                      <button type="button" onClick={() => toggleFriend(friendUid)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                        <img src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                        <span className="flex-1 min-w-0 text-xs font-bold truncate">{friend?.displayName || t('common.someone')}</span>
                        <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                          {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                        </span>
                      </button>
                      {selected && (
                        <div className="flex bg-surface rounded-md border border-border-subtle p-0.5 gap-0.5 shrink-0">
                          {(['view', 'edit'] as const).map((r) => (
                            <button
                              key={r} type="button" onClick={() => setFriendRole(friendUid, r)}
                              className={clsx('px-2 py-1 rounded text-[9px] font-bold transition-all', role === r ? 'bg-primary text-white' : 'text-text-muted')}
                            >
                              {t(r === 'view' ? 'goals.shareRoleView' : 'goals.shareRoleEdit')}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      <button type="button" onClick={handleSave} disabled={saving} className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">
        {saving ? t('goals.saving') : isEditing ? t('common.save') : t('goals.createGoal')}
      </button>
      </>
      )}
        </div>
      </div>
    </div>
  );
}
