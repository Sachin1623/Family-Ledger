import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { Policy, POLICY_TYPES, decryptPoliciesList, fromMinorUnits, isRenewalDueSoon, isRenewalOverdue } from '../lib/policies';
import { todayLocalDateString } from '../lib/dateUtils';

// List screen — mirrors GoalsHub.tsx's own/shared merge pattern: own policies (userId == me),
// policies shared via a group I'm in, and policies shared directly with me as a friend, deduped by
// id and excluding my own (those are already covered by the first query).
export default function PolicyVault() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const cappedGroupIds = groupIds.slice(0, 30); // Firestore 'in' query cap, same as elsewhere in this app

  const [ownPoliciesValue] = useCollection(user ? query(collection(db, 'policies'), where('userId', '==', user.uid)) : null);
  const [groupSharedValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'policies'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedValue] = useCollection(user ? query(collection(db, 'policies'), where('friendUids', 'array-contains', user.uid)) : null);

  const [ownPolicies, setOwnPolicies] = useState<Policy[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = ownPoliciesValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptPoliciesList(raw).then((decrypted) => { if (!cancelled) setOwnPolicies(decrypted); })
      .catch((err) => console.error('Failed to decrypt policies:', err));
    return () => { cancelled = true; };
  }, [ownPoliciesValue]);

  const [sharedPolicies, setSharedPolicies] = useState<Policy[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    groupSharedValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    friendSharedValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    decryptPoliciesList(Array.from(byId.values())).then((decrypted) => { if (!cancelled) setSharedPolicies(decrypted); })
      .catch((err) => console.error('Failed to decrypt shared policies:', err));
    return () => { cancelled = true; };
  }, [groupSharedValue, friendSharedValue, user?.uid]);

  const today = todayLocalDateString();
  const visibleOwnPolicies = ownPolicies.filter((p) => p.status !== 'archived');
  const archivedPolicies = ownPolicies.filter((p) => p.status === 'archived');
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  const renderCard = (p: Policy, shared: boolean) => {
    const meta = POLICY_TYPES.find((pt) => pt.id === p.type);
    const overdue = isRenewalOverdue(p, today);
    const dueSoon = !overdue && isRenewalDueSoon(p, today);
    return (
      <button
        key={p.id} type="button" onClick={() => navigate(`/policies/${p.id}`)}
        className="w-full bg-white rounded-2xl border border-border-subtle shadow-sm p-4 flex items-center gap-3 text-left hover:border-primary/30 transition-colors"
      >
        <span className="text-2xl shrink-0">{meta?.icon || '📋'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-bold text-on-surface truncate">{p.name}</p>
            {shared && <span className="material-symbols-outlined text-[14px] text-text-muted shrink-0">group</span>}
          </div>
          <p className="text-xs text-text-muted truncate">{p.provider || meta?.label}</p>
          {p.renewalDate && (
            <p className={clsx('text-[11px] font-bold mt-0.5', overdue ? 'text-error' : dueSoon ? 'text-warning' : 'text-text-muted')}>
              {overdue ? t('policies.renewalOverdue', { date: p.renewalDate }) : t('policies.renewsOn', { date: p.renewalDate })}
            </p>
          )}
        </div>
        {p.sumInsuredMinor != null && (
          <span className="text-xs font-bold text-primary shrink-0">{getCurrencySymbol(p.currency)}{fromMinorUnits(p.sumInsuredMinor).toLocaleString()}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">{t('policies.title')}</h1>
            <p className="text-sm text-text-muted mt-1">{t('policies.subtitle')}</p>
          </div>
          <button
            onClick={() => navigate('/policies/new')}
            title={t('policies.addPolicy')}
            className="shrink-0 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined text-[20px]">add</span>
          </button>
        </div>

        {visibleOwnPolicies.length === 0 && sharedPolicies.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-8 text-center space-y-3">
            <span className="text-4xl block">🛡️</span>
            <p className="text-sm font-bold text-on-surface">{t('policies.emptyStateTitle')}</p>
            <p className="text-xs text-text-muted">{t('policies.emptyStateDesc')}</p>
            <button type="button" onClick={() => navigate('/policies/new')} className="mt-2 px-5 py-2.5 bg-primary text-white font-bold rounded-xl text-sm">
              {t('policies.addPolicy')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">{visibleOwnPolicies.map((p) => renderCard(p, false))}</div>
        )}

        {sharedPolicies.length > 0 && (
          <div className="space-y-2 pt-2">
            <h2 className="text-sm font-bold text-primary px-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">group</span>
              {t('policies.sharedWithMe')}
            </h2>
            <div className="space-y-3">{sharedPolicies.map((p) => renderCard(p, true))}</div>
          </div>
        )}

        {archivedPolicies.length > 0 && (
          <div className="pt-2">
            <button type="button" onClick={() => setArchivedCollapsed((c) => !c)} className="w-full flex items-center justify-between mb-2">
              <h2 className="text-sm font-black text-text-muted uppercase tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">archive</span>
                {t('policies.archivedPolicies')} ({archivedPolicies.length})
              </h2>
              <span className={clsx('material-symbols-outlined text-text-muted transition-transform', archivedCollapsed && '-rotate-90')}>expand_more</span>
            </button>
            {!archivedCollapsed && (
              <div className="space-y-2 opacity-70">{archivedPolicies.map((p) => renderCard(p, false))}</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
