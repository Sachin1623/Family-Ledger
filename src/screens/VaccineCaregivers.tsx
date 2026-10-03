import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, doc, query, setDoc, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { BabyCaregiverInvite, babyCaregiverInviteId } from '../lib/vaccinations';

function Avatar({ name, photo }: { name: string; photo?: string }) {
  return photo ? (
    <img src={photo} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
  ) : (
    <div className="w-10 h-10 rounded-full bg-primary/15 text-primary font-black flex items-center justify-center shrink-0 text-sm">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

interface Candidate {
  uid: string;
  displayName: string;
  photoURL: string;
  via: 'friend' | 'family' | 'group';
}

export default function VaccineCaregivers() {
  const { profileId } = useParams<{ profileId: string }>();
  const { user, profile } = useAuth();
  const { t } = useLanguage();

  const [profileSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const babyProfile = profileSnap?.exists() ? { id: profileSnap.id, ...(profileSnap.data() as any) } : null;

  const [invitesValue] = useCollection(profileId ? query(collection(db, 'babyCaregiverInvites'), where('profileId', '==', profileId)) : null);
  const invites: BabyCaregiverInvite[] = useMemo(() => (invitesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [invitesValue]);

  // Caregiver candidates are drawn from people the owner already has a real connection to —
  // friends, Family-feature members, and co-members of any finance group — never a global
  // all-users search (adding a random stranger as a caregiver for your child makes no sense).
  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(user?.uid);
  const { families: myFamilies, membersByFamilyId } = useFamilies(user?.uid);
  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId) || [], [membershipsValue]);
  const [allMembersValue] = useCollection(groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null);

  const candidates: Candidate[] = useMemo(() => {
    const byUid = new Map<string, Candidate>();
    acceptedFriends.forEach(({ friendUid }) => {
      const u = friendUsersByUid.get(friendUid);
      byUid.set(friendUid, { uid: friendUid, displayName: u?.displayName || t('common.someone'), photoURL: u?.photoURL || '', via: 'friend' });
    });
    myFamilies.forEach((fam) => {
      (membersByFamilyId.get(fam.id) || []).forEach((m: any) => {
        if (m.userId === user?.uid || byUid.has(m.userId)) return;
        byUid.set(m.userId, { uid: m.userId, displayName: m.displayName || t('common.someone'), photoURL: m.photoURL || '', via: 'family' });
      });
    });
    (allMembersValue?.docs || []).forEach((d) => {
      const m = d.data() as any;
      if (m.userId === user?.uid || byUid.has(m.userId)) return;
      byUid.set(m.userId, { uid: m.userId, displayName: m.displayName || t('common.someone'), photoURL: m.photoURL || '', via: 'group' });
    });
    return Array.from(byUid.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedFriends, friendUsersByUid, myFamilies, membersByFamilyId, allMembersValue, user]);

  const [searchQuery, setSearchQuery] = useState('');
  const filteredCandidates = candidates.filter((c) => !searchQuery.trim() || c.displayName.toLowerCase().includes(searchQuery.trim().toLowerCase()));

  const [inviting, setInviting] = useState<string | null>(null);
  const alreadyInvitedUids = new Set(invites.map((i) => i.caregiverUid));

  const handleInvite = async (target: Candidate) => {
    if (!user || !babyProfile || inviting) return;
    setInviting(target.uid);
    try {
      const id = babyCaregiverInviteId(babyProfile.id, target.uid);
      await setDoc(doc(db, 'babyCaregiverInvites', id), {
        profileId: babyProfile.id,
        profileName: babyProfile.name,
        ownerUid: user.uid,
        caregiverUid: target.uid,
        status: 'pending',
        ownerName: profile?.displayName || user.displayName || t('common.someone'),
        ownerPhoto: profile?.photoURL || user.photoURL || '',
        createdAt: new Date().toISOString(),
        respondedAt: null,
      });
    } catch (err) {
      console.error('Failed to invite caregiver:', err);
      alert(t('babyVax.inviteFailed'));
    } finally {
      setInviting(null);
    }
  };

  if (!babyProfile) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <p className="text-sm text-text-muted text-center mt-10">{t('common.loading')}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-10">
        <div>
          <h1 className="text-xl font-black text-primary">{t('babyVax.caregivers')}</h1>
          <p className="text-xs text-text-muted mt-1">{t('babyVax.caregiversSubtitle', { name: babyProfile.name })}</p>
        </div>

        <div className="space-y-2">
          <div className="bg-white border border-border-subtle rounded-2xl p-3.5 flex items-center gap-3">
            <Avatar name={babyProfile.ownerUid === user?.uid ? (profile?.displayName || t('common.someone')) : t('common.someone')} photo={profile?.photoURL} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-primary">{babyProfile.ownerUid === user?.uid ? t('babyVax.you') : t('babyVax.owner')}</p>
              <p className="text-[11px] text-text-muted">{t('babyVax.ownerRole')}</p>
            </div>
            <span className="text-[10px] font-black uppercase tracking-wide px-2 py-1 rounded-full bg-primary/10 text-primary">{t('babyVax.roleOwner')}</span>
          </div>

          {invites.map((inv) => {
            const known = candidates.find((c) => c.uid === inv.caregiverUid);
            return (
              <div key={inv.id} className={inv.status === 'pending' ? 'bg-warning/5 border border-warning/25 rounded-2xl p-3.5 flex items-center gap-3' : 'bg-white border border-border-subtle rounded-2xl p-3.5 flex items-center gap-3'}>
                <Avatar name={known?.displayName || inv.caregiverUid} photo={known?.photoURL} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-primary">{inv.caregiverUid === user?.uid ? t('babyVax.you') : known?.displayName || t('common.someone')}</p>
                  <p className="text-[11px] text-text-muted">
                    {inv.status === 'pending' ? t('babyVax.invitedNotYetAccepted') : inv.status === 'accepted' ? t('babyVax.ownerRole') : t('babyVax.declined')}
                  </p>
                </div>
                <span className={inv.status === 'pending' ? 'text-[10px] font-black uppercase tracking-wide px-2 py-1 rounded-full bg-warning/20 text-warning' : 'text-[10px] font-black uppercase tracking-wide px-2 py-1 rounded-full bg-surface text-text-muted border border-border-subtle'}>
                  {t(`babyVax.role${inv.status.charAt(0).toUpperCase()}${inv.status.slice(1)}`)}
                </span>
              </div>
            );
          })}
        </div>

        {babyProfile.ownerUid === user?.uid && (
          <div className="bg-white border border-border-subtle rounded-2xl p-4 space-y-2.5">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.addCaregiver')}</p>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('babyVax.searchPlaceholder')}
              className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
            />
            <div className="max-h-72 overflow-y-auto divide-y divide-border-subtle -mx-1">
              {filteredCandidates.length === 0 ? (
                <p className="text-xs text-text-muted text-center py-4">{t('babyVax.noCandidatesFound')}</p>
              ) : (
                filteredCandidates.map((c) => (
                  <div key={c.uid} className="flex items-center gap-3 py-2 px-1">
                    <Avatar name={c.displayName} photo={c.photoURL} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-primary truncate">{c.displayName}</p>
                      <p className="text-[10px] text-text-muted">{t(`babyVax.via.${c.via}`)}</p>
                    </div>
                    {alreadyInvitedUids.has(c.uid) ? (
                      <span className="text-[11px] font-bold text-text-muted shrink-0">{t('babyVax.alreadyInvited')}</span>
                    ) : (
                      <button type="button" onClick={() => handleInvite(c)} disabled={inviting === c.uid} className="shrink-0 px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50">
                        {inviting === c.uid ? '…' : t('babyVax.invite')}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <p className="text-[11px] text-text-muted leading-relaxed">{t('babyVax.caregiverConsentHint')}</p>
          </div>
        )}
      </main>
    </div>
  );
}
