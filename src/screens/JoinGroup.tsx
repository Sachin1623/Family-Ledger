import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, getDoc, setDoc, updateDoc, increment, collection, addDoc, query, where, getDocs, runTransaction } from 'firebase/firestore';
import { motion } from 'motion/react';
import { clsx } from 'clsx';
import { groupIconEmoji } from '../lib/groupIcons';
import { claimPoints } from '../lib/pointsApi';

export default function JoinGroup() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [resolvedGroupId, setResolvedGroupId] = useState<string | null>(null);
  const [group, setGroup] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchGroup = async () => {
      // Allow groupId from params or query string for resilience
      const finalGroupId = groupId || new URLSearchParams(window.location.search).get('groupId');
      setResolvedGroupId(finalGroupId);
      
      if (!finalGroupId) {
        setLoading(false);
        return;
      }

      try {
        const groupRef = doc(db, 'groups', finalGroupId);
        const groupDoc = await getDoc(groupRef);
        if (groupDoc.exists()) {
          setGroup({ id: groupDoc.id, ...groupDoc.data() });
          
          // If already a member, just redirect
          if (user) {
            const memberQuery = query(
              collection(db, 'members'),
              where('groupId', '==', finalGroupId),
              where('userId', '==', user.uid)
            );
            const memberSnap = await getDocs(memberQuery);
            if (!memberSnap.empty) {
              navigate(`/groups/${finalGroupId}`);
            }
          }
        } else {
          setError('Group not found');
        }
      } catch (err) {
        console.error('Error fetching group:', err);
        setError('Failed to load group details');
      } finally {
        setLoading(false);
      }
    };

    fetchGroup();
  }, [groupId, user, navigate]);

  const handleJoin = async () => {
    if (!user || !resolvedGroupId || !group) return;
    setJoining(true);
    const membershipId = `${user.uid}_${resolvedGroupId}`;
    
    try {
      await runTransaction(db, async (transaction) => {
        const groupRef = doc(db, 'groups', resolvedGroupId);
        const groupDoc = await transaction.get(groupRef);
        
        if (!groupDoc.exists()) {
          throw new Error("Group no longer exists");
        }

        // 1. Create membership
        const memberRef = doc(db, 'members', membershipId);
        transaction.set(memberRef, {
          userId: user.uid,
          groupId: resolvedGroupId,
          displayName: profile?.displayName || user.displayName || 'Anonymous',
          photoURL: profile?.photoURL || user.photoURL || '',
          role: 'member',
          joinedAt: new Date().toISOString(),
          canInvite: true
        });

        // 2. Update group member count
        transaction.update(groupRef, {
          memberCount: (groupDoc.data().memberCount || 0) + 1
        });

        // 3. Log Activity
        const activityRef = doc(collection(db, 'activities'));
        transaction.set(activityRef, {
          groupId: resolvedGroupId,
          userId: user.uid,
          userName: profile?.displayName || user.displayName || 'Someone',
          userPhoto: profile?.photoURL || user.photoURL || '',
          type: 'join',
          description: `${profile?.displayName || user.displayName || 'Someone'} joined the group!`,
          data: {
            groupName: group.name
          },
          createdAt: new Date().toISOString()
        });
      });

      // Best-effort: mark any pending invite(s) sent to this email as accepted, so it drops
      // off the sender's pending-invites list. Never blocks navigation if this fails.
      if (user.email) {
        try {
          const invitesSnap = await getDocs(query(
            collection(db, 'groups', resolvedGroupId, 'invites'),
            where('email', '==', user.email.trim().toLowerCase()),
            where('status', '==', 'pending'),
          ));
          await Promise.all(invitesSnap.docs.map((d) => updateDoc(d.ref, { status: 'accepted' })));
        } catch (inviteErr) {
          console.error('Failed to mark invite accepted:', inviteErr);
        }
      }

      claimPoints('group_milestone', { groupId: resolvedGroupId });
      navigate(`/groups/${resolvedGroupId}`);
    } catch (err) {
      console.error('Join error:', err);
      try {
        handleFirestoreError(err, OperationType.WRITE, `members/${membershipId}`);
      } catch (formattedErr: any) {
        setError('Failed to join group. ' + (formattedErr.message || 'Please try again.'));
      }
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center space-y-4">
        <span className="material-symbols-outlined text-error text-6xl">error_outline</span>
        <h1 className="text-2xl font-bold text-primary">{error || 'Group not found'}</h1>
        <p className="text-text-muted">The link might be broken or the group may have been deleted.</p>
        <button 
          onClick={() => navigate('/')}
          className="bg-primary text-white px-8 py-3 rounded-xl font-bold shadow-lg"
        >
          Go to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md p-8 rounded-3xl border border-border-subtle shadow-xl space-y-8"
      >
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-24 h-24 rounded-2xl bg-primary/10 flex items-center justify-center border-2 border-primary/20">
            <span className="text-5xl">{groupIconEmoji(group.icon)}</span>
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-primary">Join "{group.name}"</h1>
            <p className="text-sm text-text-muted">You've been invited to track expenses together</p>
          </div>
        </div>

        <div className="bg-surface p-6 rounded-2xl border border-border-subtle space-y-4">
          <div className="flex justify-between items-center pb-4 border-b border-border-subtle">
            <span className="text-xs font-bold text-text-muted uppercase">Members</span>
            <span className="text-sm font-bold text-primary">{group.memberCount} people</span>
          </div>
          <div className="flex justify-between items-center pt-2">
            <span className="text-xs font-bold text-text-muted uppercase">Currency</span>
            <span className="text-sm font-bold text-primary">{group.currency}</span>
          </div>
        </div>

        <div className="space-y-3 pt-4">
          {!user ? (
            <button 
              onClick={() => navigate('/login', { state: { from: resolvedGroupId ? `/join/${resolvedGroupId}` : '/join' } })}
              className="w-full bg-primary text-white h-14 rounded-2xl font-bold shadow-lg shadow-primary/20 active:scale-95 transition-all text-lg"
            >
              Sign in to Join
            </button>
          ) : (
            <button 
              onClick={handleJoin}
              disabled={joining}
              className="w-full bg-primary text-white h-14 rounded-2xl font-bold shadow-lg shadow-primary/20 active:scale-95 transition-all text-lg disabled:opacity-50"
            >
              {joining ? 'Joining...' : 'Join Group'}
            </button>
          )}
          
          <button 
            onClick={() => navigate('/')}
            className="w-full h-14 rounded-2xl font-bold text-text-muted hover:bg-surface transition-all text-sm"
          >
            Not now
          </button>
        </div>
      </motion.div>
    </div>
  );
}
