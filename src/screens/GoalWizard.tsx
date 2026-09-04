import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, updateDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { Goal, toMinorUnits, fromMinorUnits, validateGoalName, validateTargetAmount, validateTargetDate, decryptGoalAmounts, encryptGoalAmounts } from '../lib/goals';
import { encryptAmount } from '../lib/fieldCrypto';
import ImageAttachments from '../components/ImageAttachments';

const ICONS = ['🎯', '✈️', '🏠', '🚗', '🎓', '💍', '👶', '🏥', '🎉', '💻', '📱', '🛡️', '🏖️', '🐶', '🎸', '💰'];

// Create/Edit — same form for both; editing loads the existing goal via the :goalId route param.
// Sharing (optional group + specific friends/family, same dual model as RemindersHub.tsx's own
// share picker, reused directly) makes the goal visible to others and lets THEM add boosts — the
// automatic monthly allocation always still comes from the owner's own aggregated savings only.
export default function GoalWizard() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { goalId } = useParams<{ goalId?: string }>();
  const isEditing = !!goalId;

  const [loaded, setLoaded] = useState(!isEditing);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [notes, setNotes] = useState('');
  const [icon, setIcon] = useState('🎯');
  const [images, setImages] = useState<string[]>([]);
  const [currency, setCurrency] = useState('');
  const [shareGroupId, setShareGroupId] = useState<string | null>(null);
  const [shareFriendUids, setShareFriendUids] = useState<string[]>([]);
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
        setTargetAmount(String(fromMinorUnits(g.targetAmountMinor)));
        setTargetDate(g.targetDate || '');
        setNotes(g.notes || '');
        setIcon(g.icon || '🎯');
        setImages(g.imageUrl ? [g.imageUrl] : []);
        setCurrency(g.currency);
        setShareGroupId(g.groupId);
        setShareFriendUids(g.friendUids || []);
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
  const filteredFriends = acceptedFriends.filter(({ friendUid }) => {
    if (!friendSearch.trim()) return true;
    const fname = friendUsersByUid.get(friendUid)?.displayName || '';
    return fname.toLowerCase().includes(friendSearch.trim().toLowerCase());
  });

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
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      if (isEditing && editingGoal) {
        const encryptedTarget = await encryptAmount('goal', editingGoal.id, amountMinor);
        await updateDoc(doc(db, 'goals', editingGoal.id), {
          name: name.trim(),
          targetAmountMinor: encryptedTarget,
          targetDate: targetDate || null,
          notes: notes.trim() || null,
          icon,
          imageUrl: images[0] || null,
          groupId: shareGroupId,
          friendUids: shareFriendUids,
          updatedAt: nowIso,
        });
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
          notes: notes.trim() || null,
          icon,
          imageUrl: images[0] || null,
          currency: currency || 'INR',
          groupId: shareGroupId,
          friendUids: shareFriendUids,
          createdBy: user.uid,
          createdByName: actorName,
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: null,
        });
        const encryptedAmounts = await encryptGoalAmounts(ref.id, amountMinor, 0);
        await updateDoc(ref, {
          targetAmountMinor: encryptedAmounts.targetAmountMinor,
          currentAmountMinor: encryptedAmounts.currentAmountMinor,
        });
        navigate('/goals/allocate');
      }
    } catch (err) {
      console.error('Failed to save goal:', err);
      alert(t('goals.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return <div className="p-8 text-center text-text-muted">{t('goals.loading')}</div>;
  }

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-primary">{isEditing ? t('goals.editGoal') : t('goals.newGoal')}</h1>
        <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
          <span className="material-symbols-outlined text-[20px] block">close</span>
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.icon')}</label>
        <div className="flex flex-wrap gap-2">
          {ICONS.map((ic) => (
            <button
              key={ic}
              type="button"
              onClick={() => setIcon(ic)}
              className={clsx('w-11 h-11 rounded-xl flex items-center justify-center text-xl border-2 transition-all', icon === ic ? 'border-primary bg-primary/10' : 'border-border-subtle bg-white')}
            >
              {ic}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.coverPhoto')}</label>
        <ImageAttachments images={images} onChange={setImages} maxImages={1} label={t('goals.addCoverPhoto')} />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.goalName')} <span className="text-error">*</span></label>
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('goals.goalNamePlaceholder')}
          className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.name ? 'border-error' : 'border-border-subtle')}
        />
        {errors.name && <p className="text-xs text-error font-bold px-1">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.targetAmount')} <span className="text-error">*</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
            <input
              type="text" inputMode="decimal" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="200000"
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

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.targetDate')}</label>
        <input
          type="date" value={targetDate} min={!isEditing ? todayLocalDateString() : undefined} onChange={(e) => setTargetDate(e.target.value)}
          className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.targetDate ? 'border-error' : 'border-border-subtle')}
        />
        {errors.targetDate && <p className="text-xs text-error font-bold px-1">{errors.targetDate}</p>}
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.notes')}</label>
        <textarea
          value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('goals.notesPlaceholder')}
          className="w-full bg-white p-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
        />
      </div>

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
                  return (
                    <button key={friendUid} type="button" onClick={() => toggleFriend(friendUid)} className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors">
                      <img src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                      <span className="flex-1 text-left text-xs font-bold truncate">{friend?.displayName || t('common.someone')}</span>
                      <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                        {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                      </span>
                    </button>
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
    </div>
  );
}
