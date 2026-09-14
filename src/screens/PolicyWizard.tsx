import React, { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, updateDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';
import {
  Policy, POLICY_TYPES, PREMIUM_FREQUENCIES, PolicyType, PremiumFrequency, CoveredMember,
  toMinorUnits, fromMinorUnits, validatePolicyName, validateAmountMinor, validateRenewalDate,
  decryptPolicyAmounts, encryptPolicyAmounts,
} from '../lib/policies';
import { useSharePicker } from '../lib/useSharePicker';
import SharePickerFields from '../components/SharePickerFields';
import ImageAttachments from '../components/ImageAttachments';

// Create/Edit — same form for both; editing loads the existing policy via the :policyId route
// param. Structurally mirrors GoalWizard.tsx (same modal shell, same share picker — now via the
// shared useSharePicker hook/SharePickerFields component rather than a 3rd copy-paste). No guided
// walkthrough for v1 — could be added later the same way it was for Accounts/Goals.
export default function PolicyWizard() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { policyId } = useParams<{ policyId?: string }>();
  const [searchParams] = useSearchParams();
  const isEditing = !!policyId;

  const closeDestination = () => {
    navigate(isEditing ? `/policies/${policyId}` : '/policies');
  };

  const [loaded, setLoaded] = useState(!isEditing);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);

  const [type, setType] = useState<PolicyType>('health');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [membersCovered, setMembersCovered] = useState<CoveredMember[]>([]);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberId, setNewMemberId] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [sumInsured, setSumInsured] = useState('');
  const [premiumAmount, setPremiumAmount] = useState('');
  const [premiumFrequency, setPremiumFrequency] = useState<PremiumFrequency | ''>('');
  const [currency, setCurrency] = useState('INR');
  const [startDate, setStartDate] = useState('');
  const [renewalDate, setRenewalDate] = useState('');
  const [reminderDaysBefore, setReminderDaysBefore] = useState('30');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const picker = useSharePicker(user?.uid);

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds.slice(0, 30))) : null);
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];

  React.useEffect(() => {
    if (!isEditing && groups.length > 0 && currency === 'INR' && groups[0].currency) setCurrency(groups[0].currency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  React.useEffect(() => {
    if (!isEditing || !policyId) return;
    (async () => {
      const snap = await getDoc(doc(db, 'policies', policyId));
      if (snap.exists()) {
        const p = await decryptPolicyAmounts({ id: snap.id, ...(snap.data() as any) });
        setEditingPolicy(p);
        setType(p.type);
        setName(p.name);
        setProvider(p.provider);
        setPolicyNumber(p.policyNumber);
        setMembersCovered(p.membersCovered || []);
        setImages(p.images || []);
        setSumInsured(p.sumInsuredMinor != null ? String(fromMinorUnits(p.sumInsuredMinor)) : '');
        setPremiumAmount(p.premiumAmountMinor != null ? String(fromMinorUnits(p.premiumAmountMinor)) : '');
        setPremiumFrequency(p.premiumFrequency || '');
        setCurrency(p.currency);
        setStartDate(p.startDate || '');
        setRenewalDate(p.renewalDate || '');
        setReminderDaysBefore(String(p.reminderDaysBefore ?? 30));
        setNotes(p.notes || '');
        picker.seedShare({ groupId: p.groupId, groupRole: p.groupRole, friendUids: p.friendUids, friendRoles: p.friendRoles });
      }
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, policyId]);

  const addMember = () => {
    const trimmed = newMemberName.trim();
    if (!trimmed || membersCovered.some((m) => m.name === trimmed)) return;
    setMembersCovered((prev) => [...prev, { name: trimmed, memberId: newMemberId.trim() || null }]);
    setNewMemberName('');
    setNewMemberId('');
  };
  const removeMember = (name: string) => setMembersCovered((prev) => prev.filter((m) => m.name !== name));

  const handleSave = async () => {
    if (!user || saving) return;
    const nextErrors: Record<string, string> = {};
    const nameErr = validatePolicyName(name);
    if (nameErr) nextErrors.name = nameErr;
    const sumInsuredMinor = sumInsured.trim() ? toMinorUnits(parseFloat(sumInsured)) : null;
    const sumErr = validateAmountMinor(sumInsuredMinor);
    if (sumErr) nextErrors.sumInsured = sumErr;
    const premiumAmountMinor = premiumAmount.trim() ? toMinorUnits(parseFloat(premiumAmount)) : null;
    const premiumErr = validateAmountMinor(premiumAmountMinor);
    if (premiumErr) nextErrors.premiumAmount = premiumErr;
    const dateErr = validateRenewalDate(renewalDate || null);
    if (dateErr) nextErrors.renewalDate = dateErr;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      const daysBefore = Math.max(0, parseInt(reminderDaysBefore, 10) || 30);

      if (isEditing && editingPolicy) {
        const encryptedAmounts = await encryptPolicyAmounts(editingPolicy.id, sumInsuredMinor, premiumAmountMinor);
        // Editing the renewal date re-arms the reminder — only keep the old dedupe guard if the
        // date hasn't actually changed.
        const keepReminderGuard = renewalDate === editingPolicy.renewalDate;
        await updateDoc(doc(db, 'policies', editingPolicy.id), {
          type, name: name.trim(), provider: provider.trim(), policyNumber: policyNumber.trim(),
          membersCovered,
          images,
          sumInsuredMinor: encryptedAmounts.sumInsuredMinor,
          premiumAmountMinor: encryptedAmounts.premiumAmountMinor,
          premiumFrequency: premiumFrequency || null,
          currency,
          startDate: startDate || null,
          renewalDate: renewalDate || null,
          reminderDaysBefore: daysBefore,
          ...(keepReminderGuard ? {} : { lastRenewalReminderSentFor: null }),
          notes: notes.trim() || null,
          groupId: picker.shareGroupId,
          groupRole: picker.shareGroupId ? picker.shareGroupRole : null,
          friendUids: picker.shareFriendUids,
          friendRoles: picker.buildFriendRoles(),
          updatedAt: nowIso,
        });
        navigate(`/policies/${editingPolicy.id}`);
      } else {
        // Two-phase write, same reasoning as GoalWizard/AccountsHub: the crypto/key endpoint
        // authorizes a 'policy' scope by reading policies/{id} and checking userId, which doesn't
        // exist yet for a brand-new record — create with harmless plaintext-null amounts first,
        // then encrypt for real once the id exists.
        const ref = doc(collection(db, 'policies'));
        await setDoc(ref, {
          userId: user.uid,
          type, name: name.trim(), provider: provider.trim(), policyNumber: policyNumber.trim(),
          membersCovered,
          images,
          sumInsuredMinor: null,
          premiumAmountMinor: null,
          premiumFrequency: premiumFrequency || null,
          currency,
          startDate: startDate || null,
          renewalDate: renewalDate || null,
          reminderDaysBefore: daysBefore,
          lastRenewalReminderSentFor: null,
          notes: notes.trim() || null,
          status: 'active',
          groupId: picker.shareGroupId,
          groupRole: picker.shareGroupId ? picker.shareGroupRole : null,
          friendUids: picker.shareFriendUids,
          friendRoles: picker.buildFriendRoles(),
          createdBy: user.uid,
          createdByName: actorName,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        const encryptedAmounts = await encryptPolicyAmounts(ref.id, sumInsuredMinor, premiumAmountMinor);
        await updateDoc(ref, {
          sumInsuredMinor: encryptedAmounts.sumInsuredMinor,
          premiumAmountMinor: encryptedAmounts.premiumAmountMinor,
        });
        navigate(`/policies/${ref.id}`);
      }
    } catch (err) {
      console.error('Failed to save policy:', err);
      alert(t('policies.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-8 text-center text-text-muted">{t('goals.loading')}</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeDestination}>
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <h1 className="text-xl font-bold text-primary">{isEditing ? t('policies.editPolicy') : t('policies.addPolicy')}</h1>
          <button onClick={closeDestination} className="p-1.5 -mr-1.5 text-text-muted hover:bg-surface rounded-full shrink-0" aria-label={t('common.close')}>
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.type')}</label>
            <div className="flex flex-wrap gap-1.5">
              {POLICY_TYPES.map((pt) => (
                <button
                  key={pt.id} type="button" onClick={() => setType(pt.id)}
                  className={clsx('px-3 py-2 rounded-xl text-xs font-bold border flex items-center gap-1', type === pt.id ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-muted')}
                >
                  <span>{pt.icon}</span>{pt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.name')} <span className="text-error">*</span></label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('policies.namePlaceholder')}
              className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.name ? 'border-error' : 'border-border-subtle')}
            />
            {errors.name && <p className="text-xs text-error font-bold px-1">{errors.name}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.provider')}</label>
              <input
                type="text" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder={t('policies.providerPlaceholder')}
                className="w-full h-12 bg-white px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.policyNumber')}</label>
              <input
                type="text" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} placeholder={t('policies.policyNumberPlaceholder')}
                className="w-full h-12 bg-white px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.membersCovered')}</label>
            <p className="text-[10px] text-text-muted px-1">{t('policies.membersCoveredDesc')}</p>
            <div className="flex flex-wrap gap-1.5">
              {membersCovered.map((m) => (
                <span key={m.name} className="flex items-center gap-1 bg-primary/5 border border-primary/20 text-primary text-xs font-bold px-2.5 py-1.5 rounded-full">
                  {m.name}
                  {m.memberId && <span className="font-medium text-primary/70">· {m.memberId}</span>}
                  <button type="button" onClick={() => removeMember(m.name)} className="text-primary/60 hover:text-error">
                    <span className="material-symbols-outlined text-[14px] block">close</span>
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
                placeholder={t('policies.addMemberPlaceholder')}
                className="flex-1 h-11 bg-white px-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <input
                type="text" value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
                placeholder={t('policies.addMemberIdPlaceholder')}
                className="w-32 h-11 bg-white px-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button type="button" onClick={addMember} disabled={!newMemberName.trim()} className="px-4 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-40 shrink-0">
                {t('policies.addMember')}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.photos')}</label>
            <p className="text-[10px] text-text-muted px-1">{t('policies.photosDesc')}</p>
            <ImageAttachments images={images} onChange={setImages} maxImages={5} label={t('policies.addPhoto')} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.sumInsured')}</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
                <input
                  type="text" inputMode="decimal" value={sumInsured} onChange={(e) => setSumInsured(e.target.value)} placeholder="500000"
                  className={clsx('w-full h-12 bg-white pl-8 pr-3 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.sumInsured ? 'border-error' : 'border-border-subtle')}
                />
              </div>
              {errors.sumInsured && <p className="text-xs text-error font-bold px-1">{errors.sumInsured}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.currency')}</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full h-12 bg-white px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                {Array.from(new Set([currency, 'INR', 'USD', 'EUR', 'GBP', ...groups.map((g: any) => g.currency)].filter(Boolean))).map((c) => (
                  <option key={c} value={c}>{c} ({getCurrencySymbol(c)})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.premiumAmount')}</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
                <input
                  type="text" inputMode="decimal" value={premiumAmount} onChange={(e) => setPremiumAmount(e.target.value)} placeholder="12000"
                  className={clsx('w-full h-12 bg-white pl-8 pr-3 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.premiumAmount ? 'border-error' : 'border-border-subtle')}
                />
              </div>
              {errors.premiumAmount && <p className="text-xs text-error font-bold px-1">{errors.premiumAmount}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.premiumFrequency')}</label>
              <select value={premiumFrequency} onChange={(e) => setPremiumFrequency(e.target.value as PremiumFrequency | '')} className="w-full h-12 bg-white px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                <option value="">{t('policies.premiumFrequencyNone')}</option>
                {PREMIUM_FREQUENCIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.startDate')}</label>
              <input
                type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="w-full h-12 bg-white px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.renewalDate')}</label>
              <input
                type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)}
                className={clsx('w-full h-12 bg-white px-4 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-primary/20', errors.renewalDate ? 'border-error' : 'border-border-subtle')}
              />
              {errors.renewalDate && <p className="text-xs text-error font-bold px-1">{errors.renewalDate}</p>}
            </div>
          </div>

          {renewalDate && (
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.reminderDaysBefore')}</label>
              <p className="text-[10px] text-text-muted px-1">{t('policies.reminderDaysBeforeDesc')}</p>
              <input
                type="text" inputMode="numeric" value={reminderDaysBefore} onChange={(e) => setReminderDaysBefore(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-24 h-11 bg-white px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none text-center"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('policies.notes')}</label>
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t('policies.notesPlaceholder')}
              className="w-full bg-white p-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
          </div>

          <SharePickerFields picker={picker} groups={groups} shareWithDesc={t('policies.shareWithDesc')} />

          <button type="button" onClick={handleSave} disabled={saving} className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">
            {saving ? t('goals.saving') : isEditing ? t('common.save') : t('policies.addPolicy')}
          </button>
        </div>
      </div>
    </div>
  );
}
