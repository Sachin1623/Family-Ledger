import React, { useEffect, useMemo, useState } from 'react';
import { installHelpText } from '../lib/installLinks';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import { collection, doc, deleteDoc, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { useAllGroupMembers } from '../lib/useAllGroupMembers';
import {
  requestFriend, acceptFriendRequest, friendshipId, getFriendSuggestions, FriendSuggestion,
  resendFriendRequest, resendAllFriendRequests, searchUsersForFriends, FriendSearchResult,
} from '../lib/friendsApi';
import { fireWrite } from '../lib/offlineWrite';
import { formatRelativeTimeAgo } from '../lib/dateUtils';
import { getLeaderboard, LeaderboardEntry } from '../lib/pointsApi';
import PeopleTabs from '../components/PeopleTabs';
import WhatsAppIcon from '../components/WhatsAppIcon';

type Feedback = { type: 'success' | 'error'; text: string } | null;

export default function Friends() {
  const navigate = useNavigate();
  // Read directly on every render rather than in a mount-only effect — a push tap or feed-item
  // click can update this `?request=` param while Friends.tsx is already mounted (React Router
  // reuses the instance across same-pattern route changes), so a mount-only read would miss it.
  const [searchParams] = useSearchParams();
  const requestModalUid = searchParams.get('request');
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const myUid = user?.uid;

  const [tab, setTab] = useState<'people' | 'family'>('people');

  const { accepted, incomingPending, outgoingPending, usersByUid, acceptedUids, pendingUids } = useFriendships(myUid);

  // Level/coins badge shown per friend row — reuses the same friends-scoped leaderboard endpoint
  // rather than a separate one, since it already returns exactly this per-uid shape in one call.
  // Refetches whenever the accepted list changes (a friend request just accepted, say), not just
  // once on mount.
  const [friendPoints, setFriendPoints] = useState<Map<string, LeaderboardEntry>>(new Map());
  useEffect(() => {
    if (!myUid || accepted.length === 0) { setFriendPoints(new Map()); return; }
    getLeaderboard('friends')
      .then((entries) => setFriendPoints(new Map(entries.map((e) => [e.uid, e]))))
      .catch((err) => console.error('getLeaderboard (friends badge) failed:', err));
  }, [myUid, accepted.length]);

  const [membershipsValue] = useCollection(
    myUid ? query(collection(db, 'members'), where('userId', '==', myUid)) : null,
  );
  const myGroupIds = useMemo(() => membershipsValue?.docs.map((d) => (d.data() as any).groupId) || [], [membershipsValue]);
  const { sortedMembers } = useAllGroupMembers(myGroupIds, myUid);
  const addableCoMembers = useMemo(
    () => sortedMembers.filter((m: any) => !acceptedUids.has(m.userId) && !pendingUids.has(m.userId)),
    [sortedMembers, acceptedUids, pendingUids],
  );

  // --- Add friend ---
  const [showAdd, setShowAdd] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FriendSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addFeedback, setAddFeedback] = useState<Feedback>(null);
  const [actingUid, setActingUid] = useState<string | null>(null);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      searchUsersForFriends(q)
        .then((users) => setSearchResults(users.filter((u) => !acceptedUids.has(u.uid) && !pendingUids.has(u.uid))))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const buildFriendInviteMessage = () => {
    const inviterName = profile?.displayName || user?.displayName || 'A friend';
    const link = `${window.location.origin}/add-friend/${myUid}`;
    return t('friends.inviteMessage', { name: inviterName, link }) + installHelpText();
  };

  const handleShareFriendLink = async () => {
    const link = `${window.location.origin}/add-friend/${myUid}`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: 'FamilyLedger', text: buildFriendInviteMessage(), url: link }); }
      catch (err) { console.log('Share failed:', err); }
    } else {
      navigator.clipboard.writeText(buildFriendInviteMessage());
      setAddFeedback({ type: 'success', text: t('friends.linkCopied') });
    }
  };

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const handleShowQr = async () => {
    try {
      const QRCode = (await import('qrcode')).default;
      setQrUrl(await QRCode.toDataURL(`${window.location.origin}/add-friend/${myUid}`, { margin: 1, width: 480, color: { dark: '#06222f', light: '#ffffff' } }));
    } catch {
      setAddFeedback({ type: 'error', text: 'Could not make the QR code.' });
    }
  };
  const handleCopyFriendLink = async () => {
    try {
      await navigator.clipboard.writeText(buildFriendInviteMessage());
      setAddFeedback({ type: 'success', text: t('friends.linkCopied') });
    } catch {
      setAddFeedback({ type: 'error', text: 'Could not copy. Use WhatsApp or the QR code instead.' });
    }
  };

  const handleWhatsAppFriendInvite = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(buildFriendInviteMessage())}`, '_blank');
  };

  const handleEmailFriendInvite = () => {
    const url = `mailto:?subject=${encodeURIComponent(t('friends.inviteEmailSubject'))}&body=${encodeURIComponent(buildFriendInviteMessage())}`;
    window.location.href = url;
  };

  const handleSendRequest = async (uid: string) => {
    setActingUid(uid);
    setAddFeedback(null);
    try {
      const result = await requestFriend({ uid });
      if (result.status === 'already_friends') setAddFeedback({ type: 'error', text: t('friends.alreadyFriends') });
      else if (result.status === 'already_pending') setAddFeedback({ type: 'error', text: t('friends.alreadyPending') });
      else if (result.status === 'accepted') setAddFeedback({ type: 'success', text: t('friends.nowFriends') });
      else setAddFeedback({ type: 'success', text: t('friends.requestSent') });
      setSearchResults((prev) => prev.filter((u) => u.uid !== uid));
      setSuggestions((prev) => prev.filter((s) => s.uid !== uid));
    } catch (error) {
      setAddFeedback({ type: 'error', text: error instanceof Error ? error.message : t('friends.requestFailed') });
    } finally {
      setActingUid(null);
    }
  };

  // --- Suggestions ("people you may know") ---
  const [suggestions, setSuggestions] = useState<FriendSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  useEffect(() => {
    if (tab !== 'people' || !myUid) return;
    setLoadingSuggestions(true);
    getFriendSuggestions()
      .then(setSuggestions)
      .catch((err) => console.error('getFriendSuggestions failed:', err))
      .finally(() => setLoadingSuggestions(false));
  }, [tab, myUid]);

  const handleAccept = async (uid: string) => {
    setActingUid(uid);
    try { await acceptFriendRequest(uid); }
    catch (error) { alert(error instanceof Error ? error.message : t('friends.requestFailed')); }
    finally { setActingUid(null); }
  };

  const handleDeclineOrCancel = async (uid: string) => {
    setActingUid(uid);
    try { await deleteDoc(doc(db, 'friendships', friendshipId(myUid!, uid))); }
    catch (error) { console.error('friendships delete failed:', error); }
    finally { setActingUid(null); }
  };

  const handleRemoveFriend = async (uid: string) => {
    if (!window.confirm(t('friends.confirmRemove'))) return;
    try { await deleteDoc(doc(db, 'friendships', friendshipId(myUid!, uid))); }
    catch (error) { console.error('friendships delete failed:', error); }
  };

  const [resendFeedback, setResendFeedback] = useState<Feedback>(null);
  const [resendingAll, setResendingAll] = useState(false);

  const handleResend = async (uid: string) => {
    setActingUid(uid);
    setResendFeedback(null);
    try {
      await resendFriendRequest(uid);
      setResendFeedback({ type: 'success', text: t('friends.resendSuccess', { name: usersByUid.get(uid)?.displayName || t('common.someone') }) });
    } catch (error) {
      setResendFeedback({ type: 'error', text: error instanceof Error ? error.message : t('friends.requestFailed') });
    } finally {
      setActingUid(null);
    }
  };

  const handleResendAll = async () => {
    setResendingAll(true);
    setResendFeedback(null);
    try {
      const count = await resendAllFriendRequests();
      setResendFeedback({ type: 'success', text: t('friends.resendAllSuccess', { count: String(count) }) });
    } catch (error) {
      setResendFeedback({ type: 'error', text: error instanceof Error ? error.message : t('friends.requestFailed') });
    } finally {
      setResendingAll(false);
    }
  };

  // Deep-linked from a friend-request push tap, feed-item click, or the in-app InviteBanner (all
  // three land on `/friends?request=<uid>`) — pops the accept/decline prompt straight up instead
  // of making the recipient dig for it under the Requests tab themselves.
  const closeRequestModal = () => navigate('/friends', { replace: true });
  const requestModalOpen = !!requestModalUid && incomingPending.some((r) => r.friendUid === requestModalUid);
  const handleModalAccept = async () => {
    if (!requestModalUid) return;
    await handleAccept(requestModalUid);
    closeRequestModal();
  };
  const handleModalDecline = async () => {
    if (!requestModalUid) return;
    await handleDeclineOrCancel(requestModalUid);
    closeRequestModal();
  };

  // --- Family ---
  const { families, myRoleByFamilyId, membersByFamilyId } = useFamilies(myUid);
  const [expandedFamilyId, setExpandedFamilyId] = useState<string | null>(null);
  const [showNewFamily, setShowNewFamily] = useState(false);
  const [newFamilyName, setNewFamilyName] = useState('');
  const [addToFamilyUid, setAddToFamilyUid] = useState('');

  const handleCreateFamily = () => {
    const name = newFamilyName.trim();
    if (!name || !myUid) return;
    const familyRef = doc(collection(db, 'families'));
    fireWrite(setDoc(familyRef, { name, createdBy: myUid, createdAt: new Date().toISOString() }), 'create family');
    fireWrite(
      setDoc(doc(db, 'familyMembers', `${myUid}_${familyRef.id}`), {
        userId: myUid, familyId: familyRef.id, role: 'owner', joinedAt: new Date().toISOString(),
        displayName: profile?.displayName || user?.displayName || 'Owner',
        photoURL: profile?.photoURL || user?.photoURL || '',
      }),
      'create family membership',
    );
    setNewFamilyName('');
    setShowNewFamily(false);
    setExpandedFamilyId(familyRef.id);
  };

  const [editingFamilyId, setEditingFamilyId] = useState<string | null>(null);
  const [editFamilyNameValue, setEditFamilyNameValue] = useState('');

  const handleRenameFamily = async (familyId: string) => {
    const name = editFamilyNameValue.trim();
    if (!name) return;
    try {
      await updateDoc(doc(db, 'families', familyId), { name });
      setEditingFamilyId(null);
    } catch (error) {
      console.error('rename family failed:', error);
    }
  };

  const handleDeleteFamily = async (familyId: string) => {
    if (!window.confirm(t('friends.confirmDeleteFamily'))) return;
    try {
      const members = membersByFamilyId.get(familyId) || [];
      await Promise.all(members.map((m) => deleteDoc(doc(db, 'familyMembers', m.id))));
      await deleteDoc(doc(db, 'families', familyId));
    } catch (error) {
      console.error('delete family failed:', error);
    }
  };

  const handleLeaveFamily = async (familyId: string) => {
    if (!myUid) return;
    try { await deleteDoc(doc(db, 'familyMembers', `${myUid}_${familyId}`)); }
    catch (error) { console.error('leave family failed:', error); }
  };

  const handleRemoveFromFamily = async (memberDocId: string) => {
    try { await deleteDoc(doc(db, 'familyMembers', memberDocId)); }
    catch (error) { console.error('remove family member failed:', error); }
  };

  const handleAddFriendToFamily = (familyId: string) => {
    if (!addToFamilyUid) return;
    const friend = usersByUid.get(addToFamilyUid);
    fireWrite(
      setDoc(doc(db, 'familyMembers', `${addToFamilyUid}_${familyId}`), {
        userId: addToFamilyUid, familyId, role: 'member', joinedAt: new Date().toISOString(),
        displayName: friend?.displayName || 'Someone', photoURL: friend?.photoURL || '',
      }),
      'add family member',
    );
    setAddToFamilyUid('');
  };

  const openChat = (uid: string) => navigate(`/?dm=${uid}`);

  const TABS: { key: typeof tab; labelKey: string; count?: number }[] = [
    { key: 'friends', labelKey: 'friends.tabFriends', count: accepted.length },
    { key: 'requests', labelKey: 'friends.tabRequests', count: incomingPending.length },
    { key: 'family', labelKey: 'friends.tabFamily', count: families.length },
    { key: 'suggestions', labelKey: 'friends.tabSuggestions' },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24 md:pb-24">
        <PeopleTabs active="friends" />
        <div className="flex gap-2">
          {([['people', 'People', accepted.length], ['family', 'Families', families.length]] as const).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={clsx('px-4 py-1.5 rounded-full text-xs font-extrabold border-[1.5px] transition-colors', tab === key ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
            >
              {label}{count > 0 ? ` · ${count}` : ''}
            </button>
          ))}
        </div>

        {tab === 'people' && (() => {
          // everyone worth suggesting: friends of friends first, then people from my groups, each once
          const seen = new Set<string>();
          const suggestionRows: { uid: string; name: string; photoURL?: string; note: string }[] = [];
          suggestions.forEach((x) => { if (!seen.has(x.uid) && !acceptedUids.has(x.uid) && !pendingUids.has(x.uid)) { seen.add(x.uid); suggestionRows.push({ uid: x.uid, name: x.displayName, photoURL: x.photoURL, note: t('friends.mutualFriends', { count: String(x.mutualCount) }) }); } });
          addableCoMembers.forEach((m: any) => { if (!seen.has(m.userId)) { seen.add(m.userId); suggestionRows.push({ uid: m.userId, name: m.displayName || t('common.someone'), photoURL: m.photoURL, note: 'In your groups' }); } });
          const sectionTitle = (text: string, count?: number) => (
            <div className="flex items-center gap-2 px-1 pt-1">
              <h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">{text}</h2>
              {!!count && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-black flex items-center justify-center">{count}</span>}
            </div>
          );
          const listCard = 'bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden';
          return (
            <div className="space-y-4">
              {/* the invite card: the quickest ways to bring someone in */}
              <section className="rounded-3xl p-4 text-white shadow-md" style={{ background: 'linear-gradient(135deg,#06222f,#0f4a5c)' }}>
                <p className="text-[11px] font-bold tracking-[0.1em] text-[#9fc3d1]">GROW YOUR CIRCLE</p>
                <h2 className="text-lg font-extrabold mt-0.5">Invite family and friends</h2>
                <p className="text-xs text-[#b8d2dc] mt-1 leading-snug">They join with your link and you become friends straight away.</p>
                <button onClick={handleWhatsAppFriendInvite} className="mt-3 w-full h-12 rounded-2xl bg-[#25d366] text-[#073b1a] font-extrabold text-[15px] flex items-center justify-center gap-2.5 active:scale-[0.98] transition-transform">
                  <span className="w-7 h-7 rounded-full bg-white text-[#25d366] flex items-center justify-center"><WhatsAppIcon className="w-[17px] h-[17px]" /></span>
                  Invite on WhatsApp
                </button>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <button onClick={handleCopyFriendLink} className="h-10 rounded-xl bg-white/12 text-white text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95"><span className="material-symbols-outlined text-[17px]">link</span>Copy link</button>
                  <button onClick={handleShowQr} className="h-10 rounded-xl bg-white/12 text-white text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95"><span className="material-symbols-outlined text-[17px]">qr_code_2</span>My QR</button>
                  <button onClick={handleEmailFriendInvite} className="h-10 rounded-xl bg-white/12 text-white text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95"><span className="material-symbols-outlined text-[17px]">mail</span>Email</button>
                </div>
                {addFeedback && (
                  <p className={clsx('text-[12px] font-bold mt-2.5', addFeedback.type === 'success' ? 'text-[#5fe0c4]' : 'text-[#fda4af]')}>{addFeedback.text}</p>
                )}
              </section>

              {/* find someone who is already on the app */}
              <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div className="relative">
                  <span className="material-symbols-outlined text-[20px] text-text-muted absolute left-3 top-1/2 -translate-y-1/2">search</span>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Find by email or FamilyLedger ID"
                    className="w-full pl-10 pr-3 h-11 text-sm rounded-xl border-[1.5px] border-border-subtle focus:border-[#12b89a] outline-none transition-all bg-surface/30"
                  />
                  {searching && <span className="material-symbols-outlined animate-spin text-[16px] text-text-muted absolute right-3 top-1/2 -translate-y-1/2">sync</span>}
                </div>
                {searchResults.map((u) => (
                  <div key={u.uid} className="flex items-center gap-3 py-1">
                    <Avatar photoURL={u.photoURL} name={u.displayName} size={10} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-primary truncate">{u.displayName}</p>
                      {u.shortId && <p className="text-[11px] text-text-muted truncate">ID: {u.shortId}</p>}
                    </div>
                    <button onClick={() => handleSendRequest(u.uid)} disabled={actingUid === u.uid} className="px-4 py-1.5 bg-primary text-white rounded-full text-xs font-extrabold disabled:opacity-50 shrink-0">{actingUid === u.uid ? '…' : t('friends.add')}</button>
                  </div>
                ))}
                {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                  <p className="text-xs text-text-muted px-1">No one found. Send them your invite link above instead.</p>
                )}
              </section>

              {/* 1. requests that need an answer */}
              {incomingPending.length > 0 && (
                <section className="space-y-2">
                  {sectionTitle('Requests for you', incomingPending.length)}
                  <div className={listCard}>
                    {incomingPending.map(({ friendUid }) => {
                      const u = usersByUid.get(friendUid);
                      return (
                        <div key={friendUid} className="p-3.5 flex items-center gap-3">
                          <Avatar photoURL={u?.photoURL} name={u?.displayName} size={10} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-primary truncate">{u?.displayName || '…'}</p>
                            <p className="text-[11px] text-text-muted">wants to be your friend</p>
                          </div>
                          <button onClick={() => handleAccept(friendUid)} disabled={actingUid === friendUid} className="px-4 py-1.5 bg-[#12b89a] text-[#06222f] rounded-full text-xs font-extrabold disabled:opacity-50">{t('friends.accept')}</button>
                          <button onClick={() => handleDeclineOrCancel(friendUid)} disabled={actingUid === friendUid} aria-label={t('friends.decline')} className="w-8 h-8 rounded-full text-text-muted flex items-center justify-center disabled:opacity-50"><span className="material-symbols-outlined text-[20px]">close</span></button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 2. people you may know */}
              {(loadingSuggestions || suggestionRows.length > 0) && (
                <section className="space-y-2">
                  {sectionTitle('People you may know')}
                  <div className={listCard}>
                    {loadingSuggestions && suggestionRows.length === 0 && <p className="p-5 text-sm text-text-muted italic text-center">{t('common.loading')}</p>}
                    {suggestionRows.slice(0, 6).map((r) => (
                      <div key={r.uid} className="p-3.5 flex items-center gap-3">
                        <Avatar photoURL={r.photoURL} name={r.name} size={10} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-primary truncate">{r.name}</p>
                          <p className="text-[11px] text-text-muted truncate">{r.note}</p>
                        </div>
                        <button onClick={() => handleSendRequest(r.uid)} disabled={actingUid === r.uid} className="px-4 py-1.5 bg-primary text-white rounded-full text-xs font-extrabold disabled:opacity-50 shrink-0">{actingUid === r.uid ? '…' : t('friends.add')}</button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 3. requests I sent that are still waiting */}
              {outgoingPending.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    {sectionTitle('Sent · waiting')}
                    {outgoingPending.length > 1 && (
                      <button onClick={handleResendAll} disabled={resendingAll} className="text-[11px] font-extrabold text-primary flex items-center gap-1 disabled:opacity-50">
                        <span className={clsx('material-symbols-outlined text-[14px]', resendingAll && 'animate-spin')}>refresh</span>{t('friends.resendAll')}
                      </button>
                    )}
                  </div>
                  {resendFeedback && (
                    <p className={clsx('text-[11px] font-medium px-1', resendFeedback.type === 'success' ? 'text-success' : 'text-error')}>{resendFeedback.text}</p>
                  )}
                  <div className={listCard}>
                    {outgoingPending.map(({ friendUid, lastSentAt }) => {
                      const u = usersByUid.get(friendUid);
                      return (
                        <div key={friendUid} className="p-3.5 flex items-center gap-3">
                          <Avatar photoURL={u?.photoURL} name={u?.displayName} size={10} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-primary truncate">{u?.displayName || '…'}</p>
                            {lastSentAt && <p className="text-[11px] text-text-muted">{t('friends.sentTime', { time: formatRelativeTimeAgo(lastSentAt) })}</p>}
                          </div>
                          <button onClick={() => handleResend(friendUid)} disabled={actingUid === friendUid} className="px-3.5 py-1.5 rounded-full border-[1.5px] border-border-subtle text-primary text-xs font-extrabold disabled:opacity-50 shrink-0">Remind</button>
                          <button onClick={() => handleDeclineOrCancel(friendUid)} disabled={actingUid === friendUid} aria-label={t('friends.cancel')} className="w-8 h-8 rounded-full text-text-muted flex items-center justify-center disabled:opacity-50"><span className="material-symbols-outlined text-[20px]">close</span></button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 4. my friends */}
              <section className="space-y-2">
                {sectionTitle(`Your friends${accepted.length ? ` · ${accepted.length}` : ''}`)}
                <div className={listCard}>
                  {accepted.length === 0 && <p className="p-6 text-sm text-text-muted italic text-center">No friends yet. Invite someone with the card above.</p>}
                  {accepted.map(({ friendUid }) => {
                    const u = usersByUid.get(friendUid);
                    const fp = friendPoints.get(friendUid);
                    return (
                      <div key={friendUid} className="p-3.5 flex items-center gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onClick={() => navigate(`/u/${friendUid}`)}>
                          <Avatar photoURL={u?.photoURL} name={u?.displayName} size={10} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-primary truncate">{u?.displayName || '…'}</p>
                            {fp && (
                              <p className="text-[11px] text-text-muted font-bold flex items-center gap-1.5">
                                <span>{t('progress.level', { level: String(fp.level) })}</span>
                                <span className="flex items-center gap-0.5">🪙 {fp.coins}</span>
                              </p>
                            )}
                          </div>
                        </div>
                        <button onClick={() => openChat(friendUid)} className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0" title={t('friends.chat')}>
                          <span className="material-symbols-outlined text-[18px]">chat</span>
                        </button>
                        <button onClick={() => handleRemoveFriend(friendUid)} className="w-9 h-9 rounded-full bg-surface text-text-muted flex items-center justify-center shrink-0" title={t('friends.remove')}>
                          <span className="material-symbols-outlined text-[18px]">person_remove</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          );
        })()}

        {tab === 'family' && (
          <div className="space-y-3">
            <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-3">
              <button
                onClick={() => setShowNewFamily((v) => !v)}
                className="w-full flex items-center justify-between text-sm font-bold text-primary"
              >
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[18px]">add_home</span>
                  {t('friends.newFamily')}
                </span>
                <span className="material-symbols-outlined text-[18px] text-text-muted">{showNewFamily ? 'expand_less' : 'expand_more'}</span>
              </button>
              {showNewFamily && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newFamilyName}
                    onChange={(e) => setNewFamilyName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFamily(); }}
                    placeholder={t('friends.familyNamePlaceholder')}
                    className="flex-1 min-w-0 px-3 py-2.5 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all bg-surface/30"
                  />
                  <button
                    onClick={handleCreateFamily}
                    disabled={!newFamilyName.trim()}
                    className="px-4 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                  >
                    {t('friends.create')}
                  </button>
                </div>
              )}
            </section>

            {families.length === 0 && (
              <p className="p-6 text-sm text-text-muted italic text-center bg-white rounded-2xl border border-border-subtle shadow-sm">
                {t('friends.noFamiliesYet')}
              </p>
            )}

            {families.map((family: any) => {
              const members = membersByFamilyId.get(family.id) || [];
              const myRole = myRoleByFamilyId.get(family.id);
              const isOwner = myRole === 'owner';
              const expanded = expandedFamilyId === family.id;
              const addableFriends = accepted
                .map(({ friendUid }) => friendUid)
                .filter((uid) => !members.some((m) => m.userId === uid));

              return (
                <section key={family.id} className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
                  <button
                    onClick={() => setExpandedFamilyId(expanded ? null : family.id)}
                    className="w-full p-4 flex items-center gap-3"
                  >
                    <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center shrink-0">
                      <span className="text-xl">🏠</span>
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-bold text-primary truncate">{family.name}</p>
                      <p className="text-[11px] text-text-muted">{t('friends.memberCount', { count: String(members.length) })}</p>
                    </div>
                    <span className="material-symbols-outlined text-text-muted">{expanded ? 'expand_less' : 'expand_more'}</span>
                  </button>

                  {expanded && (
                    <div className="px-4 pb-4 space-y-3 border-t border-border-subtle/50 pt-3">
                      {isOwner && (
                        editingFamilyId === family.id ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editFamilyNameValue}
                              onChange={(e) => setEditFamilyNameValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameFamily(family.id); }}
                              className="flex-1 min-w-0 px-3 py-2 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all bg-surface/30"
                              autoFocus
                            />
                            <button
                              onClick={() => handleRenameFamily(family.id)}
                              disabled={!editFamilyNameValue.trim()}
                              className="px-3 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                            >
                              {t('common.save')}
                            </button>
                            <button
                              onClick={() => setEditingFamilyId(null)}
                              className="px-3 text-text-muted text-xs font-bold"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setEditingFamilyId(family.id); setEditFamilyNameValue(family.name); }}
                            className="flex items-center gap-1 text-[11px] font-bold text-primary"
                          >
                            <span className="material-symbols-outlined text-[14px]">edit</span>
                            {t('friends.renameFamily')}
                          </button>
                        )
                      )}
                      <div className="space-y-1.5">
                        {members.map((m) => (
                          <div key={m.id} className="flex items-center gap-2.5 p-2 rounded-xl bg-surface/40">
                            <Avatar photoURL={m.photoURL} name={m.displayName} />
                            <p className="flex-1 min-w-0 text-xs font-bold text-on-surface truncate">{m.displayName}</p>
                            {m.role === 'owner' && (
                              <span className="text-[9px] font-bold text-primary uppercase px-1.5 py-0.5 bg-primary/10 rounded">{t('friends.owner')}</span>
                            )}
                            {(isOwner && m.userId !== myUid) && (
                              <button onClick={() => handleRemoveFromFamily(m.id)} className="text-text-muted">
                                <span className="material-symbols-outlined text-[16px]">close</span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      {isOwner && addableFriends.length > 0 && (
                        <div className="flex gap-2">
                          <select
                            value={addToFamilyUid}
                            onChange={(e) => setAddToFamilyUid(e.target.value)}
                            className="flex-1 min-w-0 px-3 py-2 text-xs rounded-xl border border-border-subtle bg-surface/30 outline-none"
                          >
                            <option value="">{t('friends.addFriendToFamily')}</option>
                            {addableFriends.map((uid) => (
                              <option key={uid} value={uid}>{usersByUid.get(uid)?.displayName || uid}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleAddFriendToFamily(family.id)}
                            disabled={!addToFamilyUid}
                            className="px-3 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                          >
                            {t('friends.add')}
                          </button>
                        </div>
                      )}

                      <div className="flex justify-end">
                        {isOwner ? (
                          <button onClick={() => handleDeleteFamily(family.id)} className="text-[11px] font-bold text-error">
                            {t('friends.deleteFamily')}
                          </button>
                        ) : (
                          <button onClick={() => handleLeaveFamily(family.id)} className="text-[11px] font-bold text-error">
                            {t('friends.leaveFamily')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

      </main>

      {qrUrl && (
        <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-6" onClick={() => setQrUrl(null)}>
          <div className="bg-white rounded-3xl p-5 w-full max-w-xs text-center space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-extrabold text-primary">Scan to be my friend</p>
            <img src={qrUrl} alt="QR code of my friend link" className="w-full aspect-square rounded-2xl border border-border-subtle" />
            <p className="text-xs text-text-muted">Ask them to point their phone camera here.</p>
            <button type="button" onClick={() => setQrUrl(null)} className="w-full h-11 rounded-2xl bg-primary text-white font-extrabold text-sm">Done</button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {requestModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={closeRequestModal}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-xs p-6 text-center space-y-4"
            >
              <div className="flex justify-center">
                <Avatar
                  photoURL={usersByUid.get(requestModalUid || '')?.photoURL}
                  name={usersByUid.get(requestModalUid || '')?.displayName}
                  size={10}
                />
              </div>
              <p className="text-sm font-bold text-on-surface">
                {t('friends.requestFrom', { name: usersByUid.get(requestModalUid || '')?.displayName || t('common.someone') })}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleModalDecline}
                  disabled={actingUid === requestModalUid}
                  className="flex-1 py-2.5 bg-surface text-text-muted rounded-xl text-xs font-bold disabled:opacity-50"
                >
                  {t('friends.decline')}
                </button>
                <button
                  onClick={handleModalAccept}
                  disabled={actingUid === requestModalUid}
                  className="flex-1 py-2.5 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
                >
                  {t('friends.accept')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Avatar({ photoURL, name, size = 8 }: { photoURL?: string; name?: string; size?: number }) {
  const px = size === 10 ? 'w-10 h-10' : 'w-8 h-8';
  return (
    <div className={clsx(px, 'rounded-full bg-surface-container-high overflow-hidden shrink-0')}>
      {photoURL ? (
        <img src={photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-primary text-xs font-bold">
          {name?.slice(0, 1) || '?'}
        </div>
      )}
    </div>
  );
}
