import React, { useEffect, useState } from 'react';
import { collection, doc, query, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { ChatPanel, useGameChat } from './GameChat';
import { setChatPopupListener, type ChatTarget } from '../lib/chatPopup';

// Always mounted once (see App.tsx): shows a direct or group chat as a popup on top of the current
// screen when a message notification / banner is tapped, instead of navigating to another page.
export default function GlobalChatPopup() {
  const { user, profile } = useAuth();
  const [target, setTarget] = useState<ChatTarget | null>(null);

  useEffect(() => {
    setChatPopupListener(setTarget);
    return () => setChatPopupListener(null);
  }, []);

  const dmId = user && target?.kind === 'dm' ? [user.uid, target.uid].sort().join('_') : undefined;
  const groupId = target?.kind === 'group' ? target.groupId : undefined;
  const chatCollection = target?.kind === 'dm' ? 'directChats' : 'groups';
  const { messages, loading } = useGameChat(chatCollection, dmId || groupId);
  const [dmUserSnap] = useDocument(target?.kind === 'dm' ? doc(db, 'users', target.uid) : null);
  const [membersSnap] = useCollection(groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null);

  if (!user || !target) return null;
  const otherUids =
    target.kind === 'dm'
      ? [target.uid]
      : (membersSnap?.docs.map((d) => d.data().userId as string) || []).filter((u) => u !== user.uid);
  const dmName = dmUserSnap?.data()?.displayName;

  return (
    <ChatPanel
      collectionName={chatCollection}
      gameId={(dmId || groupId)!}
      messages={messages}
      loading={loading}
      myUid={user.uid}
      myDisplayName={profile?.displayName || user.displayName || 'Someone'}
      myPhotoURL={profile?.photoURL || user.photoURL || ''}
      otherUids={otherUids}
      onClose={() => setTarget(null)}
      title={target.kind === 'dm' ? (dmName ? `Chat with ${dmName}` : 'Direct Message') : 'Group Chat'}
    />
  );
}
