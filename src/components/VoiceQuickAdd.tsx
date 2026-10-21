import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import VoiceExpenseSheet from './VoiceExpenseSheet';
import { quickAddFromSpeech, type QuickAddResult } from '../lib/voiceQuickAdd';

const UNDO_SECONDS = 7;

// One-tap "say it and it is added": the listening sheet, then the expense is saved straight away, and a small bar appears with
// what was added and an Undo. The rest of the family is only told after the Undo time runs out.
// `groupId` is set when started from one group's tile; from the global mic it is left out and the last-used group is chosen.
export default function VoiceQuickAdd({ groupId, onDone, afterAdd }: { groupId?: string; onDone: () => void; afterAdd?: () => void }) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [listening, setListening] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuickAddResult | null>(null);
  const [left, setLeft] = useState(UNDO_SECONDS);
  const okRef = useRef<Extract<QuickAddResult, { ok: true }> | null>(null);
  const heardOnce = useRef(false);

  const onHeard = useCallback(
    async (sentence: string) => {
      if (!user) return;
      heardOnce.current = true;
      setBusy(true);
      const r = await quickAddFromSpeech({ sentence, user, profile, groupId });
      setBusy(false);
      // Several groups and none used yet: ask in the usual form, with the words already filled in.
      if (r.ok === false && r.reason === 'no-group') {
        navigate('/add-expense', { state: { voiceText: sentence } });
        onDone();
        return;
      }
      if (r.ok) {
        okRef.current = r;
        setLeft(UNDO_SECONDS);
        afterAdd?.();
      }
      setResult(r);
    },
    [user, profile, groupId, navigate, onDone, afterAdd],
  );

  // The undo window: counts down, then makes the add final (tells the group, claims points).
  useEffect(() => {
    if (!result?.ok) return;
    if (left <= 0) {
      result.finalize();
      okRef.current = null;
      onDone();
      return;
    }
    const id = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [result, left, onDone]);

  // Leaving while the bar is still up counts as keeping it.
  useEffect(() => () => { okRef.current?.finalize(); }, []);

  const undo = async () => {
    if (!result?.ok) return;
    okRef.current = null;
    await result.undo().catch((err) => console.error('undo failed:', err));
    onDone();
  };

  return (
    <>
      {listening && <VoiceExpenseSheet onClose={() => { setListening(false); if (!heardOnce.current) onDone(); }} onHeard={onHeard} />}
      {(busy || result) &&
        createPortal(
          <div className="fixed left-3 right-3 z-[310]" style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}>
            <div className="mx-auto max-w-md rounded-2xl bg-primary text-white shadow-2xl px-4 py-3 text-sm">
              {busy && !result && <p className="font-bold">{t('voiceExpense.adding')}</p>}
              {result?.ok && (
                <div className="flex items-center gap-3">
                  <span className="text-2xl shrink-0">{result.categoryIcon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-black truncate">
                      {t(result.isIncome ? 'voiceExpense.addedIncome' : 'voiceExpense.added')} {result.currencySymbol}
                      {result.amount.toLocaleString()} · {result.description}
                    </p>
                    <p className="text-[11px] opacity-80 truncate">{result.categoryName}{result.groupName ? ` · ${result.groupName}` : ''}</p>
                  </div>
                  <button type="button" onClick={undo} className="shrink-0 px-3 py-1.5 rounded-lg bg-white/20 font-black text-xs">
                    {t('voiceExpense.undo')} ({left})
                  </button>
                </div>
              )}
              {result && !result.ok && (
                <div className="space-y-2">
                  <p className="font-bold">
                    {result.reason === 'no-amount' ? t('voiceExpense.noAmount') : t('voiceExpense.failed')}
                    {result.reason === 'no-amount' && <span className="block font-medium opacity-80 mt-0.5">&ldquo;{result.sentence}&rdquo;</span>}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { heardOnce.current = false; setResult(null); setListening(true); }} className="flex-1 py-2 rounded-lg bg-white/20 font-black text-xs">{t('voiceExpense.tryAgain')}</button>
                    <button
                      type="button"
                      onClick={() => { navigate(groupId ? `/add-expense?groupId=${groupId}` : '/add-expense', { state: { voiceText: result.sentence } }); onDone(); }}
                      className="flex-1 py-2 rounded-lg bg-white text-primary font-black text-xs"
                    >
                      {t('voiceExpense.openForm')}
                    </button>
                    <button type="button" onClick={onDone} className="px-3 py-2 rounded-lg bg-white/10 font-black text-xs">{t('voiceExpense.close')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
