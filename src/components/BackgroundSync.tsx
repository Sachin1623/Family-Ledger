import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { applyBackground, normalizeBg, DEFAULT_BG } from '../lib/appBackground';

// Applies the signed-in person's saved background (users/{uid}.appBackground) so it follows them to a new phone.
export default function BackgroundSync() {
  const { profile } = useAuth();
  const saved = profile?.appBackground;
  useEffect(() => {
    if (!profile) return; // not loaded yet: keep whatever the phone cached
    applyBackground(saved ? normalizeBg(saved) : DEFAULT_BG);
  }, [profile, saved?.tint, saved?.pattern]);
  return null;
}
