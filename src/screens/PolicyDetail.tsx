import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, deleteDoc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { Policy, POLICY_TYPES, PREMIUM_FREQUENCIES, decryptPolicyAmounts, fromMinorUnits, isRenewalDueSoon, isRenewalOverdue } from '../lib/policies';
import { todayLocalDateString } from '../lib/dateUtils';
import ImageLightbox from '../components/ImageLightbox';

// Read-only view + Edit/Archive/Delete actions — same header/action-row treatment as
// GoalDetail.tsx/AccountDetail.tsx. Role default is 'view' (not goals' 'edit') — see
// policies.ts's own doc comment on why, matching FinancialAccount's precedent.
export default function PolicyDetail() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { policyId } = useParams<{ policyId: string }>();

  const [policyDoc] = useDocument(policyId ? doc(db, 'policies', policyId) : null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!policyDoc?.exists()) { setPolicy(null); return; }
    decryptPolicyAmounts({ id: policyDoc.id, ...(policyDoc.data() as any) })
      .then((decrypted) => { if (!cancelled) setPolicy(decrypted); })
      .catch((err) => console.error('Failed to decrypt policy:', err));
    return () => { cancelled = true; };
  }, [policyDoc]);

  const isOwner = !!user && !!policy && policy.userId === user.uid;
  const viewerCanEdit = isOwner || (!!user && !!policy && (
    policy.friendUids?.includes(user.uid) ? (policy.friendRoles?.[user.uid] || 'view') === 'edit' : (policy.groupRole || 'view') === 'edit'
  ));

  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!policy || !isOwner || deleting) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'policies', policy.id));
      navigate('/policies');
    } catch (err) {
      console.error('Failed to delete policy:', err);
      setDeleting(false);
    }
  };

  const toggleArchive = async () => {
    if (!policy || !isOwner) return;
    await updateDoc(doc(db, 'policies', policy.id), {
      status: policy.status === 'archived' ? 'active' : 'archived',
      updatedAt: new Date().toISOString(),
    }).catch((err) => console.error('Failed to update policy status:', err));
  };

  if (policyDoc && !policyDoc.exists()) {
    return (
      <div className="p-8 text-center text-text-muted">
        {t('policies.notFound')}
      </div>
    );
  }
  if (!policy) {
    return <div className="p-8 text-center text-text-muted">{t('goals.loading')}</div>;
  }

  const meta = POLICY_TYPES.find((pt) => pt.id === policy.type);
  const today = todayLocalDateString();
  const overdue = isRenewalOverdue(policy, today);
  const dueSoon = !overdue && isRenewalDueSoon(policy, today);
  const currencySymbol = getCurrencySymbol(policy.currency);
  const premiumFreqLabel = PREMIUM_FREQUENCIES.find((f) => f.id === policy.premiumFrequency)?.label;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <button onClick={() => navigate('/policies')} className="flex items-center gap-1 text-sm font-bold text-text-muted hover:text-primary">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          {t('policies.title')}
        </button>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className="text-3xl shrink-0">{meta?.icon || '📋'}</span>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-bold text-primary">{policy.name}</h1>
              <p className="text-xs text-text-muted">{policy.provider || meta?.label}</p>
              {policy.status === 'archived' && (
                <span className="inline-block mt-1 text-[10px] font-bold text-text-muted bg-surface-container px-2 py-0.5 rounded-full uppercase tracking-wider">
                  {t('policies.archived')}
                </span>
              )}
            </div>
            {!isOwner && (
              <span className="text-[10px] font-bold text-text-muted bg-surface-container px-2 py-1 rounded-full uppercase tracking-wider shrink-0">
                {viewerCanEdit ? t('goals.shareRoleEdit') : t('policies.viewingShared')}
              </span>
            )}
          </div>

          {policy.renewalDate && (
            <div className={clsx('rounded-xl px-3 py-2.5 text-sm font-bold flex items-center gap-2',
              overdue ? 'bg-error/10 text-error' : dueSoon ? 'bg-warning/10 text-warning' : 'bg-surface text-text-muted')}
            >
              <span className="material-symbols-outlined text-[18px]">event</span>
              {overdue ? t('policies.renewalOverdue', { date: policy.renewalDate }) : t('policies.renewsOn', { date: policy.renewalDate })}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {policy.policyNumber && (
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.policyNumber')}</p>
                <p className="text-sm font-bold text-on-surface">{policy.policyNumber}</p>
              </div>
            )}
            {policy.sumInsuredMinor != null && (
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.sumInsured')}</p>
                <p className="text-sm font-bold text-on-surface">{currencySymbol}{fromMinorUnits(policy.sumInsuredMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
              </div>
            )}
            {policy.premiumAmountMinor != null && (
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.premiumAmount')}</p>
                <p className="text-sm font-bold text-on-surface">
                  {currencySymbol}{fromMinorUnits(policy.premiumAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  {premiumFreqLabel && <span className="text-text-muted font-medium"> / {premiumFreqLabel}</span>}
                </p>
              </div>
            )}
            {policy.startDate && (
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.startDate')}</p>
                <p className="text-sm font-bold text-on-surface">{policy.startDate}</p>
              </div>
            )}
          </div>

          {policy.membersCovered?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.membersCovered')}</p>
              <div className="flex flex-wrap gap-1.5">
                {policy.membersCovered.map((m) => (
                  <span key={m.name} className="bg-surface text-on-surface text-xs font-bold px-2.5 py-1 rounded-full">
                    {m.name}{m.memberId && <span className="text-text-muted font-medium"> · {m.memberId}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {policy.images?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.photos')}</p>
              <div className="flex flex-wrap gap-2">
                {policy.images.map((src, i) => (
                  <button key={i} type="button" onClick={() => setLightboxSrc(src)}>
                    <img src={src} alt="" className="w-16 h-16 object-cover rounded-xl border border-border-subtle" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {policy.notes && (
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('policies.notes')}</p>
              <p className="text-sm text-on-surface whitespace-pre-wrap">{policy.notes}</p>
            </div>
          )}

          {isOwner && (policy.groupId || policy.friendUids?.length > 0) && (
            <p className="text-[11px] text-text-muted flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">group</span>
              {t('policies.sharedIndicator', { count: (policy.friendUids?.length || 0) + (policy.groupId ? 1 : 0) })}
            </p>
          )}
        </div>

        {viewerCanEdit && (
          <button
            onClick={() => navigate(`/policies/${policy.id}/edit`)}
            className="w-full py-3 bg-primary text-white font-bold rounded-xl flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
            {t('common.edit')}
          </button>
        )}

        {isOwner && (
          <div className="flex gap-2">
            <button onClick={toggleArchive} className="flex-1 py-2.5 border border-border-subtle text-text-muted font-bold rounded-xl text-sm">
              {policy.status === 'archived' ? t('policies.unarchive') : t('policies.archive')}
            </button>
            <button onClick={() => setShowDeleteConfirm(true)} className="flex-1 py-2.5 border border-error/30 text-error font-bold rounded-xl text-sm">
              {t('common.delete')}
            </button>
          </div>
        )}

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !deleting && setShowDeleteConfirm(false)}>
            <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-black text-primary">{t('policies.confirmDeleteTitle')}</h3>
              <p className="text-sm text-text-muted">{t('policies.confirmDeleteBody')}</p>
              <div className="flex gap-2">
                <button onClick={() => setShowDeleteConfirm(false)} disabled={deleting} className="flex-1 py-3 border border-border-subtle text-text-muted font-bold rounded-xl disabled:opacity-50">
                  {t('common.cancel')}
                </button>
                <button onClick={handleDelete} disabled={deleting} className="flex-1 py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
                  {deleting ? t('policies.deleting') : t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        )}

        {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </main>
    </div>
  );
}
