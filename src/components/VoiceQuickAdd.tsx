import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import VoiceExpenseSheet from './VoiceExpenseSheet';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getCategoryNameOverride, getGroupCategories } from '../lib/constants';
import type { SpokenStructured } from '../lib/voiceExpense';
import { lastUsedGroupId, loadMyGroups, quickAddFromSpeech, type MyGroup, type QuickAddResult } from '../lib/voiceQuickAdd';

const UNDO_SECONDS = 7;
const GROUPS_CACHE_KEY = 'fl_voice_groups';

// One-tap "say it and it is added": the listening sheet, then the expense is saved straight away, and a small bar appears with
// what was added and an Undo. The rest of the family is only told after the Undo time runs out.
// `groupId` is set when started from one group's tile (that group, fixed). From the global mic it is left out: the group last added to
// is used, shown on the listening sheet, and can be changed there.
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
  // The last known groups are shown instantly (kept from the previous time), then refreshed — so the sheet never sits on "Choose a group"
  // while the list loads.
  const [groups, setGroups] = useState<MyGroup[]>(() => {
    try { return JSON.parse(localStorage.getItem(GROUPS_CACHE_KEY) || '[]'); } catch { return []; }
  });
  const [targetId, setTargetId] = useState<string>(() => {
    if (groupId) return groupId;
    const last = lastUsedGroupId();
    try {
      const cached: MyGroup[] = JSON.parse(localStorage.getItem(GROUPS_CACHE_KEY) || '[]');
      if (last && cached.some((g) => g.id === last)) return last;
      if (cached.length === 1) return cached[0].id;
    } catch { /* ignore */ }
    return '';
  });
  useEffect(() => {
    if (!user) return;
    let alive = true;
    loadMyGroups(user.uid).then((list) => {
      if (!alive) return;
      setGroups(list);
      try { localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
      if (groupId) return;
      // Default: the group last added to; otherwise the only group; otherwise ask.
      const last = lastUsedGroupId();
      setTargetId((cur) => cur || (list.find((g) => g.id === last)?.id ?? (list.length === 1 ? list[0].id : '')));
    }).catch(() => {});
    return () => { alive = false; };
  }, [user, groupId]);
  const targetRef = useRef(targetId);
  targetRef.current = targetId;
  const lastStructured = useRef<SpokenStructured | undefined>(undefined);

  // The categories of the group being added to (custom ones included), handed to the speech service so it can pick the right one.
  const ctxRef = useRef<{ categories: { id: string; name: string }[]; incomeCategories: { id: string; name: string }[]; currency?: string } | null>(null);
  useEffect(() => {
    ctxRef.current = null;
    if (!targetId) return;
    let alive = true;
    getDoc(doc(db, 'groups', targetId)).then((snap) => {
      if (!alive || !snap.exists()) return;
      const g: any = snap.data();
      const named = (list: { id: string; name: string }[]) => list.map((c) => ({ id: c.id, name: getCategoryNameOverride(g, c.id) || c.name }));
      ctxRef.current = { categories: named(getGroupCategories(g, 'expense')), incomeCategories: g.incomeEnabled ? named(getGroupCategories(g, 'income')) : [], currency: g.currency };
    }).catch(() => {});
    return () => { alive = false; };
  }, [targetId]);

  const onHeard = useCallback(
    async (sentence: string, alternatives: string[] = [], structured?: SpokenStructured, allowBlank = false) => {
      if (!user) return;
      heardOnce.current = true;
      setBusy(true);
      const r = await quickAddFromSpeech({ sentence, alternatives, structured, allowBlank, user, profile, groupId: targetRef.current || groupId });
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

  // Edit: take the quick add back out and open the usual form with the same words filled in, for the same group. Nothing was sent to
  // the group yet (that waits for the undo time), so there is nothing to retract.
  const edit = async () => {
    if (!result?.ok) return;
    const { groupId: addedTo, amount, description, categoryId, date, isIncome, sentence } = result;
    okRef.current = null;
    await result.undo().catch((err) => console.error('undo failed:', err));
    // The same query-string prefill a shared receipt uses: the form starts already filled, with no waiting for anything to load first.
    const q = new URLSearchParams({ groupId: addedTo, amount: String(amount), description, category: categoryId, date });
    navigate(isIncome ? `/add-expense?groupId=${addedTo}` : `/add-expense?${q.toString()}`, isIncome ? { state: { voiceText: sentence } } : undefined);
    onDone();
  };

  // OK: confirm now instead of waiting out the undo time (the group is told and points claimed straight away).
  const confirmNow = () => {
    if (!result?.ok) return;
    result.finalize();
    okRef.current = null;
    onDone();
  };

  return (
    <>
      {listening && (
        <VoiceExpenseSheet
          onClose={() => { setListening(false); if (!heardOnce.current) onDone(); }}
          onHeard={(s, alts, structured) => { lastStructured.current = structured; return onHeard(s, alts, structured); }}
          getContext={() => ctxRef.current || { categories: [], incomeCategories: [] }}
          target={{
            name: groups.find((g) => g.id === targetId)?.name || '',
            options: groupId ? undefined : groups,
            selectedId: targetId,
            onSelect: setTargetId,
          }}
        />
      )}
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
                  <div className="shrink-0 flex flex-col gap-1">
                    <button type="button" onClick={confirmNow} className="px-3 py-1.5 rounded-lg bg-success text-white font-black text-xs">
                      {t('voiceExpense.ok')}
                    </button>
                    <div className="flex gap-1">
                      <button type="button" onClick={edit} className="px-3 py-1.5 rounded-lg bg-white text-primary font-black text-xs">
                        {t('voiceExpense.edit')}
                      </button>
                      <button type="button" onClick={undo} className="px-3 py-1.5 rounded-lg bg-white/20 font-black text-xs">
                        {t('voiceExpense.undo')} ({left})
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {result && !result.ok && (
                <div className="space-y-2">
                  <p className="font-bold">
                    {result.reason === 'no-amount' ? t('voiceExpense.noAmount') : result.reason === 'no-detail' ? t('voiceExpense.noDetail') : t('voiceExpense.failed')}
                    {(result.reason === 'no-amount' || result.reason === 'no-detail') && (
                      <span className="block font-medium opacity-80 mt-0.5">&ldquo;{result.sentence}&rdquo;</span>
                    )}
                  </p>
                  <div className="flex gap-2">
                    {result.reason === 'no-detail' && (
                      <button
                        type="button"
                        onClick={() => { const s = result.sentence; setResult(null); onHeard(s, [], lastStructured.current, true); }}
                        className="flex-1 py-2 rounded-lg bg-white/20 font-black text-xs"
                      >
                        {t('voiceExpense.addAsOther')}
                      </button>
                    )}
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
