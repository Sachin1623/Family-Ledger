import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, deleteDoc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db, auth } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { acceptFriendRequest, friendshipId } from '../lib/friendsApi';
import { usePendingActions, PendingActionItem, GAME_TABLE_COLLECTIONS } from '../lib/usePendingActions';

// Every item across the app awaiting an explicit accept/reject decision from the signed-in user —
// friend requests, health-delegation consent, group invites, game invites — gathered in one place
// instead of scattered across four different screens' own notice banners. See usePendingActions.ts
// for exactly which Firestore doc backs each kind, and each row component below for how accept/
// reject is applied and how a since-deleted/cancelled underlying object is detected and handled
// (shown as a dismissible "no longer needed" row rather than a broken Accept button).

function Avatar({ name, photo }: { name: string; photo: string }) {
  return photo ? (
    <img src={photo} alt="" className="w-11 h-11 rounded-full object-cover shrink-0 border border-border-subtle" />
  ) : (
    <div className="w-11 h-11 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center shrink-0 text-sm">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

function ActionRow({
  photo, name, title, subtitle, children,
}: { photo: string; name: string; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 flex items-start gap-3">
      <Avatar name={name} photo={photo} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-black text-primary uppercase tracking-wider">{title}</p>
        <p className="text-sm font-bold text-on-surface mt-0.5">{subtitle}</p>
        <div className="flex items-center gap-2 mt-2.5">{children}</div>
      </div>
    </div>
  );
}

function AcceptButton({ onClick, label, busy }: { onClick: () => void; label: string; busy: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="px-4 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50">
      {label}
    </button>
  );
}
function RejectButton({ onClick, label, busy }: { onClick: () => void; label: string; busy: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="px-4 py-1.5 bg-surface border border-border-subtle text-text-muted text-xs font-bold rounded-lg disabled:opacity-50">
      {label}
    </button>
  );
}

const FriendRequestRow: React.FC<{ item: PendingActionItem }> = ({ item }) => {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try { await acceptFriendRequest(item.friendUid!); } catch (err) { console.error(err); alert(t('pendingActions.actionFailed')); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    const myUid = auth.currentUser?.uid;
    if (!myUid) return;
    setBusy(true);
    try { await deleteDoc(doc(db, 'friendships', friendshipId(myUid, item.friendUid!))); } catch (err) { console.error(err); alert(t('pendingActions.actionFailed')); }
    finally { setBusy(false); }
  };
  return (
    <ActionRow photo={item.senderPhoto} name={item.senderName} title={t('pendingActions.friendRequestTitle')} subtitle={t('pendingActions.friendRequestSubtitle', { name: item.senderName })}>
      <AcceptButton onClick={accept} busy={busy} label={t('common.accept')} />
      <RejectButton onClick={reject} busy={busy} label={t('common.decline')} />
    </ActionRow>
  );
};

const HEALTH_KIND_LABEL_KEY: Record<string, string> = {
  medicine: 'pendingActions.healthKindMedicine',
  glucose: 'pendingActions.healthKindGlucose',
  bp: 'pendingActions.healthKindBp',
};

const HealthDelegationRow: React.FC<{ item: PendingActionItem }> = ({ item }) => {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const respond = async (status: 'accepted' | 'declined') => {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'healthDelegateInvites', item.inviteDocId!), { status, respondedAt: new Date().toISOString() });
    } catch (err) { console.error(err); alert(t('pendingActions.actionFailed')); }
    finally { setBusy(false); }
  };
  const kindLabel = t(HEALTH_KIND_LABEL_KEY[item.healthKind || 'medicine']);
  return (
    <ActionRow
      photo={item.senderPhoto}
      name={item.senderName}
      title={t('pendingActions.healthDelegationTitle', { kind: kindLabel })}
      subtitle={t('pendingActions.healthDelegationSubtitle', { name: item.senderName, kind: kindLabel })}
    >
      <AcceptButton onClick={() => respond('accepted')} busy={busy} label={t('common.accept')} />
      <RejectButton onClick={() => respond('declined')} busy={busy} label={t('common.decline')} />
    </ActionRow>
  );
};

const BabyCaregiverInviteRow: React.FC<{ item: PendingActionItem }> = ({ item }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [profileSnap, profileLoading] = useDocument(item.babyProfileId ? doc(db, 'babyProfiles', item.babyProfileId) : null);

  if (profileLoading) return null;
  const stale = !profileSnap?.exists();

  const respond = async (status: 'accepted' | 'declined') => {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'babyCaregiverInvites', item.inviteDocId!), { status, respondedAt: new Date().toISOString() });
      if (status === 'accepted') navigate('/baby-vaccinations');
    } catch (err) { console.error(err); alert(t('pendingActions.actionFailed')); }
    finally { setBusy(false); }
  };

  if (stale) {
    return (
      <ActionRow photo={item.senderPhoto} name={item.senderName} title={t('pendingActions.babyCaregiverTitle')} subtitle={t('pendingActions.babyCaregiverStale', { name: item.babyProfileName })}>
        <RejectButton onClick={() => respond('declined')} busy={busy} label={t('pendingActions.dismiss')} />
      </ActionRow>
    );
  }
  return (
    <ActionRow
      photo={item.senderPhoto}
      name={item.senderName}
      title={t('pendingActions.babyCaregiverTitle')}
      subtitle={t('pendingActions.babyCaregiverSubtitle', { name: item.senderName, child: item.babyProfileName })}
    >
      <AcceptButton onClick={() => respond('accepted')} busy={busy} label={t('common.accept')} />
      <RejectButton onClick={() => respond('declined')} busy={busy} label={t('common.decline')} />
    </ActionRow>
  );
};

const GroupInviteRow: React.FC<{ item: PendingActionItem }> = ({ item }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [senderSnap, senderLoading] = useDocument(item.senderUid ? doc(db, 'users', item.senderUid) : null);
  const [groupSnap, groupLoading] = useDocument(item.groupId ? doc(db, 'groups', item.groupId) : null);
  const senderName = senderSnap?.exists() ? (senderSnap.data() as any).displayName || t('common.someone') : t('common.someone');
  const senderPhoto = senderSnap?.exists() ? (senderSnap.data() as any).photoURL || '' : '';

  if (groupLoading || senderLoading) return null;
  const stale = !groupSnap?.exists();

  const dismiss = async () => {
    setBusy(true);
    try { await deleteDoc(doc(db, item.groupInvitePath!)); } catch (err) { console.error(err); }
    finally { setBusy(false); }
  };
  const accept = () => navigate(`/join/${item.groupId}`);
  const reject = async () => {
    setBusy(true);
    try { await updateDoc(doc(db, item.groupInvitePath!), { status: 'declined' }); } catch (err) { console.error(err); alert(t('pendingActions.actionFailed')); }
    finally { setBusy(false); }
  };

  if (stale) {
    return (
      <ActionRow photo={senderPhoto} name={senderName} title={t('pendingActions.groupInviteTitle')} subtitle={t('pendingActions.groupInviteStale', { group: item.groupName })}>
        <RejectButton onClick={dismiss} busy={busy} label={t('pendingActions.dismiss')} />
      </ActionRow>
    );
  }
  return (
    <ActionRow photo={senderPhoto} name={senderName} title={t('pendingActions.groupInviteTitle')} subtitle={t('pendingActions.groupInviteSubtitle', { name: senderName, group: item.groupName })}>
      <AcceptButton onClick={accept} busy={busy} label={t('common.accept')} />
      <RejectButton onClick={reject} busy={busy} label={t('common.decline')} />
    </ActionRow>
  );
};

const GameInviteRow: React.FC<{ item: PendingActionItem }> = ({ item }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const collectionName = GAME_TABLE_COLLECTIONS[item.routeSegment || ''] || '';
  const [tableSnap, tableLoading] = useDocument(collectionName && item.gameId ? doc(db, collectionName, item.gameId) : null);

  if (tableLoading) return null;
  const stale = !tableSnap?.exists();

  const remove = async () => {
    setBusy(true);
    try { await deleteDoc(doc(db, 'gameInvites', item.gameInviteId!)); } catch (err) { console.error(err); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    navigate(`/games/${item.routeSegment}/${item.gameId}`);
    await deleteDoc(doc(db, 'gameInvites', item.gameInviteId!)).catch(() => {});
  };

  if (stale) {
    return (
      <ActionRow photo={item.senderPhoto} name={item.senderName} title={t('pendingActions.gameInviteTitle', { game: item.gameLabel })} subtitle={t('pendingActions.gameInviteStale')}>
        <RejectButton onClick={remove} busy={busy} label={t('pendingActions.dismiss')} />
      </ActionRow>
    );
  }
  return (
    <ActionRow
      photo={item.senderPhoto}
      name={item.senderName}
      title={t('pendingActions.gameInviteTitle', { game: item.gameLabel })}
      subtitle={t('pendingActions.gameInviteSubtitle', { name: item.senderName, code: item.code || '' })}
    >
      <AcceptButton onClick={accept} busy={busy} label={t('common.accept')} />
      <RejectButton onClick={remove} busy={busy} label={t('common.decline')} />
    </ActionRow>
  );
};

export default function PendingActions() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { items } = usePendingActions(user?.uid);

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('pendingActions.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('pendingActions.subtitle')}</p>
        </div>

        {items.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-8 text-center space-y-2">
            <span className="material-symbols-outlined text-4xl text-text-muted">task_alt</span>
            <p className="text-sm font-bold text-on-surface">{t('pendingActions.emptyTitle')}</p>
            <p className="text-xs text-text-muted">{t('pendingActions.emptyDesc')}</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => {
              if (item.kind === 'friend') return <FriendRequestRow key={item.key} item={item} />;
              if (item.kind === 'health') return <HealthDelegationRow key={item.key} item={item} />;
              if (item.kind === 'babyCaregiver') return <BabyCaregiverInviteRow key={item.key} item={item} />;
              if (item.kind === 'group') return <GroupInviteRow key={item.key} item={item} />;
              return <GameInviteRow key={item.key} item={item} />;
            })}
          </div>
        )}
      </main>
    </div>
  );
}
