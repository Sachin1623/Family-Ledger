import React from 'react';
import { doc, updateDoc, arrayRemove, arrayUnion } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// Star toggle used on GamesHub/Tools tiles — writes straight to `users/{uid}.favorites` (an array
// of FavoritableItem keys, see lib/favorites.ts), already covered by that doc's existing
// self-update rule so no rules change was needed. Stops propagation since every tile it sits on
// is itself a click target that navigates elsewhere.
export const FavoriteButton: React.FC<{ itemKey: string; className?: string }> = ({ itemKey, className }) => {
  const { user, profile } = useAuth();
  const favorites: string[] = profile?.favorites || [];
  const active = favorites.includes(itemKey);

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), {
      favorites: active ? arrayRemove(itemKey) : arrayUnion(itemKey),
    }).catch((err) => console.error('Failed to toggle favorite:', err));
  };

  return (
    <button
      onClick={toggle}
      className={`p-1.5 rounded-full transition-colors shrink-0 ${active ? 'text-warning' : 'text-text-muted/40 hover:text-text-muted'} ${className || ''}`}
      aria-label={active ? 'Remove from favorites' : 'Add to favorites'}
      title={active ? 'Remove from favorites' : 'Add to favorites'}
    >
      <span className="material-symbols-outlined text-[20px] block" style={{ fontVariationSettings: `'FILL' ${active ? 1 : 0}` }}>
        star
      </span>
    </button>
  );
};
