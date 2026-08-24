import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { requestFriend } from '../lib/friendsApi';

const FEATURES: { icon: string; titleKey: string; descKey: string }[] = [
  { icon: '🧾', titleKey: 'addFriendInvite.featureSplitTitle', descKey: 'addFriendInvite.featureSplitDesc' },
  { icon: '💬', titleKey: 'addFriendInvite.featureChatTitle', descKey: 'addFriendInvite.featureChatDesc' },
  { icon: '🎲', titleKey: 'addFriendInvite.featureGamesTitle', descKey: 'addFriendInvite.featureGamesDesc' },
  { icon: '🤝', titleKey: 'addFriendInvite.featureLoansTitle', descKey: 'addFriendInvite.featureLoansDesc' },
];

// Public landing page for a shareable "add me as a friend" link (see Friends.tsx's share
// buttons). Mirrors JoinGroup.tsx's shape (public route, `?`/state-based post-login redirect back
// here) but for a person-to-person friend connection instead of a group — and, since there's no
// group to auto-join, it also has to sell what FamilyLedger actually offers to someone who may
// not have an account yet at all.
export default function AddFriendInvite() {
  const { uid: inviterUid } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [inviter, setInviter] = useState<{ displayName: string; photoURL: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!inviterUid) { setLoading(false); return; }
    fetch(`/api/public-profile/${inviterUid}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setInviter(data))
      .catch(() => setInviter(null))
      .finally(() => setLoading(false));
  }, [inviterUid]);

  useEffect(() => {
    if (!user || !inviterUid || status !== 'idle') return;
    if (user.uid === inviterUid) {
      setStatus('error');
      setResultMessage(t('addFriendInvite.ownLink'));
      return;
    }
    setStatus('sending');
    requestFriend({ uid: inviterUid })
      .then((result) => {
        setStatus('done');
        if (result.status === 'already_friends') setResultMessage(t('friends.alreadyFriends'));
        else if (result.status === 'accepted') setResultMessage(t('friends.nowFriends'));
        else setResultMessage(t('addFriendInvite.requestSentTo', { name: inviter?.displayName || t('common.someone') }));
      })
      .catch((err) => {
        setStatus('error');
        setResultMessage(err instanceof Error ? err.message : t('friends.requestFailed'));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, inviterUid]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md p-8 rounded-3xl border border-border-subtle shadow-xl space-y-6"
      >
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center border-2 border-primary/20 overflow-hidden">
            {inviter?.photoURL ? (
              <img src={inviter.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <span className="text-4xl font-black text-primary">{inviter?.displayName?.slice(0, 1) || '👋'}</span>
            )}
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-primary">
              {t('addFriendInvite.title', { name: inviter?.displayName || t('common.someone') })}
            </h1>
            <p className="text-sm text-text-muted">{t('addFriendInvite.subtitle')}</p>
          </div>
        </div>

        {!user && (
          <div className="space-y-2.5">
            {FEATURES.map((f) => (
              <div key={f.titleKey} className="flex items-start gap-3 bg-surface p-3.5 rounded-2xl border border-border-subtle">
                <span className="text-2xl shrink-0">{f.icon}</span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-primary">{t(f.titleKey)}</p>
                  <p className="text-xs text-text-muted mt-0.5">{t(f.descKey)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {user && (
          <div className="bg-surface p-6 rounded-2xl border border-border-subtle text-center space-y-2">
            {status === 'sending' && (
              <p className="text-sm font-bold text-text-muted">{t('addFriendInvite.connecting')}</p>
            )}
            {(status === 'done' || status === 'error') && (
              <p className={status === 'error' ? 'text-sm font-bold text-error' : 'text-sm font-bold text-success'}>
                {resultMessage}
              </p>
            )}
          </div>
        )}

        <div className="space-y-3 pt-2">
          {!user ? (
            <button
              onClick={() => navigate('/login', { state: { from: `/add-friend/${inviterUid}` } })}
              className="w-full bg-primary text-white h-14 rounded-2xl font-bold shadow-lg shadow-primary/20 active:scale-95 transition-all text-lg"
            >
              {t('addFriendInvite.signUpCta')}
            </button>
          ) : (
            <button
              onClick={() => navigate('/friends')}
              className="w-full bg-primary text-white h-14 rounded-2xl font-bold shadow-lg shadow-primary/20 active:scale-95 transition-all text-lg"
            >
              {t('addFriendInvite.openApp')}
            </button>
          )}
          <button
            onClick={() => navigate('/')}
            className="w-full h-14 rounded-2xl font-bold text-text-muted hover:bg-surface transition-all text-sm"
          >
            {t('addFriendInvite.notNow')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
