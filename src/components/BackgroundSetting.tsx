import React, { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { TINTS, PATTERNS, CARD_STYLES, DEFAULT_BG, applyBackground, normalizeBg, BgChoice } from '../lib/appBackground';

// Profile > App Settings row: pick a colour tint and a faint pattern for the page behind the cards. Applies instantly, saves to the profile.
export default function BackgroundSetting() {
  const { user, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const current = normalizeBg(profile?.appBackground);
  const [local, setLocal] = useState<BgChoice | null>(null);
  const shown = local || current;

  const choose = (next: BgChoice) => {
    setLocal(next);
    applyBackground(next);
    if (user) updateDoc(doc(db, 'users', user.uid), { appBackground: next }).catch((err) => console.error('Could not save the background:', err));
  };
  const tintName = TINTS.find((t) => t.id === shown.tint)?.name;
  const patName = PATTERNS.find((p) => p.id === shown.pattern)?.name;
  const tintColor = (id: string) => TINTS.find((t) => t.id === id)!.color;

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined">wallpaper</span>
          </div>
          <div className="text-left">
            <p className="font-bold text-sm text-on-surface">Background</p>
            <p className="text-xs text-text-muted">Pick a colour and a pattern</p>
          </div>
        </div>
        <div className="flex items-center gap-1 text-text-muted shrink-0">
          <span className="text-sm font-bold text-primary">{tintName}{shown.pattern !== 'none' ? ` · ${patName}` : ''}</span>
          <span className="material-symbols-outlined text-[20px]">{open ? 'expand_less' : 'expand_more'}</span>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 bg-surface/50">
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.2em] mb-2 pt-3">Colour</p>
            <div className="grid grid-cols-4 gap-2">
              {TINTS.map((t) => (
                <button key={t.id} type="button" onClick={() => choose({ ...shown, tint: t.id })} className="flex flex-col items-center gap-1 active:scale-95 transition-transform">
                  <span className={clsx('w-full h-12 rounded-xl border-2 flex items-center justify-center', shown.tint === t.id ? 'border-primary' : 'border-border-subtle')} style={{ background: t.color }}>
                    {shown.tint === t.id && <span className="material-symbols-outlined text-primary text-[20px]">check</span>}
                  </span>
                  <span className="text-[10px] font-bold text-on-surface">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.2em] mb-2">Pattern</p>
            <div className="grid grid-cols-4 gap-2">
              {PATTERNS.map((p) => (
                <button key={p.id} type="button" onClick={() => choose({ ...shown, pattern: p.id })} className="flex flex-col items-center gap-1 active:scale-95 transition-transform">
                  <span className={clsx('w-full h-12 rounded-xl border-2 flex items-center justify-center', shown.pattern === p.id ? 'border-primary' : 'border-border-subtle')} style={{ backgroundColor: tintColor(shown.tint), backgroundImage: p.image, backgroundSize: p.size }}>
                    {shown.pattern === p.id && <span className="material-symbols-outlined text-primary text-[20px] bg-white/80 rounded-full">check</span>}
                  </span>
                  <span className="text-[10px] font-bold text-on-surface">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.2em] mb-2">Cards</p>
            <div className="grid grid-cols-3 gap-2">
              {CARD_STYLES.map((c) => (
                <button key={c.id} type="button" onClick={() => choose({ ...shown, cards: c.id })} className={clsx('rounded-xl border-2 p-2 text-left active:scale-95 transition-transform', shown.cards === c.id ? 'border-primary bg-white' : 'border-border-subtle bg-white/60')}>
                  <span className="block text-xs font-bold text-primary">{c.name}</span>
                  <span className="block text-[10px] text-text-muted leading-tight mt-0.5">{c.hint}</span>
                </button>
              ))}
            </div>
          </div>
          {(shown.tint !== 'default' || shown.pattern !== 'none') && (
            <button type="button" onClick={() => choose(DEFAULT_BG)} className="text-xs font-bold text-text-muted underline">Back to the classic look</button>
          )}
        </div>
      )}
    </div>
  );
}
