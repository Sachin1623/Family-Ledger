import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { SpeechRecognition, speechLanguageFor, useSpeechDialog, useServerVoice, type SpeechListenerHandle } from '../lib/speech';
import { startVoiceRecording, type VoiceRecording } from '../lib/voiceRecorder';
import type { SpokenStructured } from '../lib/voiceExpense';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';

// Bottom sheet for "talk to add an expense": asks for the microphone, shows what is being heard as it is heard, and hands the finished
// sentence back. The sentence is turned into fields by lib/voiceExpense.ts (and saved by VoiceQuickAdd / AddExpense).
//
// The phone's recogniser sends its FINAL words a moment after it announces the speech has ended, so the sentence is only handed over
// once those final words arrive (or a short wait runs out) — closing earlier used half-finished words.
export interface VoiceTarget {
  /** Name of the group the expense will be added to ('' when none is chosen yet). */
  name: string;
  /** When given, the person can change the group while talking. */
  options?: { id: string; name: string }[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export interface VoiceContext {
  categories: { id: string; name: string }[];
  incomeCategories: { id: string; name: string }[];
  currency?: string;
}

export default function VoiceExpenseSheet({
  onClose,
  onHeard,
  target,
  getContext,
}: {
  onClose: () => void;
  onHeard: (sentence: string, alternatives: string[], structured?: SpokenStructured) => void;
  target?: VoiceTarget;
  /** The categories of the group being added to, so the speech service can pick the right one. Built-in categories when omitted. */
  getContext?: () => VoiceContext;
}) {
  const [pickingGroup, setPickingGroup] = useState(false);
  const { user } = useAuth();
  const [level, setLevel] = useState(0);
  const recRef = useRef<VoiceRecording | null>(null);
  const structuredRef = useRef<SpokenStructured | undefined>(undefined);
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  const { t, language } = useLanguage();
  const [phase, setPhase] = useState<'starting' | 'listening' | 'thinking' | 'nothing' | 'denied' | 'unavailable' | 'error'>('starting');
  const [heard, setHeard] = useState('');
  const [errorText, setErrorText] = useState('');
  const heardRef = useRef('');
  const altsRef = useRef<string[]>([]);
  const autoRetries = useRef(0);
  const finished = useRef(false);
  const timers = useRef<{ settle?: number; silence?: number; ready?: number }>({});
  const gotFinal = useRef(false);
  const handles = useRef<SpeechListenerHandle[]>([]);
  // The parent hands in fresh callback functions on almost every render. If listening were started from effects that depend on
  // them, every re-render would stop and restart the microphone — which looked like it flipping between listening and recording.
  // So the latest callbacks are kept in refs and the listening itself is started exactly once, when the sheet opens.
  const onHeardRef = useRef(onHeard);
  const onCloseRef = useRef(onClose);
  const languageRef = useRef(language);
  onHeardRef.current = onHeard;
  onCloseRef.current = onClose;
  languageRef.current = language;

  const clearTimers = () => {
    if (timers.current.settle) window.clearTimeout(timers.current.settle);
    if (timers.current.silence) window.clearTimeout(timers.current.silence);
    if (timers.current.ready) window.clearTimeout(timers.current.ready);
    timers.current = {};
  };

  const finish = useCallback(() => {
    if (finished.current) return;
    clearTimers();
    const sentence = heardRef.current.trim();
    if (sentence) {
      finished.current = true;
      // After the final words the recogniser has already ended by itself; only a session cut short needs to be cancelled.
      if (!gotFinal.current) SpeechRecognition.cancel?.().catch(() => {});
      onHeardRef.current(sentence, altsRef.current.filter((a) => a && a !== sentence), structuredRef.current);
      onCloseRef.current();
    } else {
      setPhase('nothing');
    }
  }, []);

  // Stops the recording and asks the speech service what expense it describes.
  const sendRecording = async () => {
    const rec = recRef.current;
    if (!rec || finished.current) return;
    recRef.current = null;
    setPhase('thinking');
    try {
      const clip = await rec.stop();
      // A recording that is completely flat means the microphone was given silence, typically because another app is using it (a screen
      // recorder with sound switched on, a call, a game's voice chat). Say so instead of a vague "did not catch that".
      if (clip.peak !== undefined && clip.peak < 0.003 && clip.durationMs > 1500) {
        setErrorText(t('voiceExpense.micBusy'));
        setPhase('error');
        return;
      }
      if (!clip.heardVoice || clip.durationMs < 500) { setPhase('nothing'); return; }
      const given = getContextRef.current?.();
      const ctx = {
        categories: given?.categories?.length ? given.categories : EXPENSE_CATEGORIES,
        incomeCategories: given?.incomeCategories?.length ? given.incomeCategories : INCOME_CATEGORIES,
        currency: given?.currency,
      };
      const token = await user?.getIdToken();
      const res = await fetch('/api/voice-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          audio: clip.wavBase64,
          mimeType: 'audio/wav',
          categories: ctx.categories.map((c) => ({ id: c.id, name: c.name })),
          incomeCategories: ctx.incomeCategories.map((c) => ({ id: c.id, name: c.name })),
          today: todayLocalDateString(),
          currency: ctx.currency || 'INR',
        }),
      });
      if (finished.current) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorText(String(data?.error || `error ${res.status}`));
        setPhase('error');
        return;
      }
      const transcript = String(data.transcript || '').trim();
      if (!data.amount && !transcript) { setPhase('nothing'); return; }
      structuredRef.current = {
        amount: typeof data.amount === 'number' ? data.amount : null,
        description: String(data.description || ''),
        categoryId: data.categoryId || null,
        isIncome: !!data.isIncome,
        date: data.date || null,
      };
      heardRef.current = transcript || `${data.amount ?? ''} ${data.description ?? ''}`.trim();
      altsRef.current = [];
      setHeard(heardRef.current);
      gotFinal.current = true;
      finish();
    } catch (err: any) {
      console.error('voice service failed:', err);
      setErrorText(String(err?.message || err || 'could not reach the service'));
      setPhase('error');
    }
  };

  const begin = useCallback(async () => {
    finished.current = false;
    heardRef.current = '';
    altsRef.current = [];
    gotFinal.current = false;
    structuredRef.current = undefined;
    setHeard('');
    setErrorText('');
    setPhase('starting');
    clearTimers();

    // Phones and (while developing) the browser: record a short clip and let the speech service on our server read the expense from it.
    if (useServerVoice) {
      try {
        recRef.current?.cancel();
        recRef.current = await startVoiceRecording({
          onLevel: setLevel,
          onAutoStop: () => { void sendRecording(); },
        });
        setPhase('listening');
        return;
      } catch (err: any) {
        console.error('could not start recording:', err);
        // No microphone access for the app's own recording: on Android fall through to the phone's speech box instead.
        if (!(useSpeechDialog && SpeechRecognition.listenDialog)) {
          setPhase(String(err?.name || '') === 'NotAllowedError' ? 'denied' : 'error');
          setErrorText(String(err?.message || err || 'microphone unavailable'));
          return;
        }
      }
    }
    if (useSpeechDialog && SpeechRecognition.listenDialog) {
      // Android: the phone's own "Speak now" box does the listening (and its own retries); we only wait for its answer.
      try {
        setPhase('listening');
        const res = await SpeechRecognition.listenDialog({ language: speechLanguageFor(languageRef.current), maxResults: 5, prompt: t('voiceExpense.prompt') });
        if (finished.current) return;
        const matches = (res?.matches || []).filter(Boolean);
        if (matches.length === 0) { setPhase('nothing'); return; }
        heardRef.current = matches[0];
        altsRef.current = matches.slice(1);
        setHeard(matches[0]);
        gotFinal.current = true;
        finish();
      } catch (err: any) {
        console.error('speech dialog failed:', err);
        setErrorText(String(err?.message || err || 'could not open'));
        setPhase('error');
      }
      return;
    }
    try {
      const avail = await SpeechRecognition.available();
      if (!avail.available) { setPhase('unavailable'); return; }
      let perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== 'granted') perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') { setPhase('denied'); return; }
      await Promise.all(handles.current.map((h) => h.remove().catch(() => {})));
      handles.current = [
        await SpeechRecognition.addListener('partialResults', (d) => {
          const text = d.matches?.[0] || '';
          if (!text) return;
          heardRef.current = text;
          setHeard(text);
          if (timers.current.silence) { window.clearTimeout(timers.current.silence); timers.current.silence = undefined; }
        }),
        await SpeechRecognition.addListener('results', (d) => {
          const text = d.matches?.[0] || '';
          if (text) { heardRef.current = text; setHeard(text); }
          // The recogniser's other guesses at the same words, kept so the best-fitting one can be chosen.
          altsRef.current = (d.matches || []).slice(1);
          // The final words: done.
          gotFinal.current = true;
          if (timers.current.settle) window.clearTimeout(timers.current.settle);
          timers.current.settle = window.setTimeout(finish, 250);
        }),
        await SpeechRecognition.addListener('listeningState', (d) => {
          if (d.status === 'ready') {
            // The microphone really is recording now.
            if (timers.current.ready) { window.clearTimeout(timers.current.ready); timers.current.ready = undefined; }
            setPhase('listening');
            return;
          }
          if (d.status !== 'speechEnd') return;
          // Final words normally follow within a moment; if they never do, use what was heard.
          if (timers.current.settle) window.clearTimeout(timers.current.settle);
          timers.current.settle = window.setTimeout(finish, 2500);
        }),
        await SpeechRecognition.addListener('error', (d) => {
          clearTimers();
          // No speech / no match just means nothing usable was heard; anything else is a real fault worth showing.
          if (heardRef.current) { finish(); return; }
          if (d.code === 7 || d.code === 6) { setPhase('nothing'); return; }
          // The speech service dropping its connection (11), being busy (8), or a client hiccup (5, 10) is usually momentary: start again by
          // itself, up to twice, before bothering the person.
          if ([5, 8, 10, 11].includes(d.code) && autoRetries.current < 3) {
            autoRetries.current += 1;
            SpeechRecognition.cancel?.().catch(() => {});
            // Wait longer each time: a dropped connection to the speech service needs a moment to come back.
            window.setTimeout(() => { if (!finished.current) begin(); }, 600 + autoRetries.current * 700);
            return;
          }
          setErrorText(`${d.message || 'error'}${d.code ? ` (${d.code})` : ''}`);
          setPhase('error');
        }),
      ];
      // Nothing heard at all after a while: say so instead of listening forever.
      timers.current.silence = window.setTimeout(() => {
        if (!heardRef.current) { SpeechRecognition.cancel?.().catch(() => {}); setPhase('nothing'); }
      }, 18000);
      // If the recogniser never reports that it is recording, it is not: start it again (up to three times) rather than showing a
      // "Listening" that is not true.
      timers.current.ready = window.setTimeout(() => {
        if (finished.current || autoRetries.current >= 3) { setErrorText('the microphone did not start'); setPhase('error'); return; }
        autoRetries.current += 1;
        SpeechRecognition.cancel?.().catch(() => {});
        window.setTimeout(() => { if (!finished.current) begin(); }, 400);
      }, 4500);
      await SpeechRecognition.start({ language: speechLanguageFor(languageRef.current), maxResults: 5 });
    } catch (err: any) {
      console.error('speech start failed:', err);
      setErrorText(String(err?.message || err || 'could not start'));
      setPhase('error');
    }
  }, [finish, t]);

  useEffect(() => {
    autoRetries.current = 0;
    begin();
    return () => {
      clearTimers();
      recRef.current?.cancel();
      recRef.current = null;
      if (!gotFinal.current) SpeechRecognition.cancel?.().catch(() => {});
      handles.current.forEach((h) => h.remove().catch(() => {}));
      handles.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = () => {
    if (recRef.current) { void sendRecording(); return; }
    SpeechRecognition.stop().catch(() => {});
    if (timers.current.settle) window.clearTimeout(timers.current.settle);
    timers.current.settle = window.setTimeout(finish, 1500);
  };

  const blocked = phase === 'denied' || phase === 'unavailable' || phase === 'error';

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end bg-black/50" onClick={() => onCloseRef.current()}>
      <div
        className="w-full bg-white rounded-t-[28px] overflow-hidden text-center shadow-[0_-12px_40px_rgba(13,59,78,0.25)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Brand header: the FamilyLedger mark and name on the app's own green-to-blue, so this reads as part of the app, not a system box. */}
        <div className="relative px-5 pt-3 pb-4 text-left" style={{ background: 'linear-gradient(135deg,#0d3b4e 0%,#1E3A8A 100%)' }}>
          <div className="w-10 h-1 rounded-full bg-white/30 mx-auto mb-3" />
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-white p-1.5 shadow-sm">
              <svg viewBox="0 0 100 120" className="w-9 h-11 shrink-0" aria-hidden="true">
                <defs><linearGradient id="vx_g" x1="10" y1="10" x2="90" y2="110" gradientUnits="userSpaceOnUse"><stop stopColor="#4ADE80" /><stop offset="1" stopColor="#3B82F6" /></linearGradient></defs>
                <rect x="10" y="10" width="80" height="100" rx="12" fill="url(#vx_g)" />
                <path d="M70 40C70 36.7 72.7 34 76 34H90V86H76C72.7 86 70 83.3 70 80V40Z" fill="#1E3A8A" />
                <circle cx="35" cy="40" r="8" fill="#fff" fillOpacity=".9" /><path d="M25 50C25 48.9 25.9 48 27 48H43C44.1 48 45 48.9 45 50V75H25V50Z" fill="#fff" fillOpacity=".9" />
                <circle cx="55" cy="45" r="7" fill="#fff" fillOpacity=".8" /><path d="M48 52C48 50.9 48.9 50 50 50H60C61.1 50 62 50.9 62 52V75H48V52Z" fill="#fff" fillOpacity=".8" />
                <circle cx="45" cy="70" r="5" fill="#fff" /><path d="M40 75C40 74.4 40.4 74 41 74H49C49.6 74 50 74.4 50 75V85H40V75Z" fill="#fff" />
                <circle cx="65" cy="72" r="5" fill="#fff" /><path d="M60 77C60 76.4 60.4 76 61 76H69C69.6 76 70 76.4 70 77V85H60V77Z" fill="#fff" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-white text-lg font-black leading-tight tracking-tight">Family<span className="text-[#4ADE80]">Ledger</span></p>
              <p className="text-white/70 text-[11px] font-bold uppercase tracking-[0.14em]">{t('voiceExpense.brandSub')}</p>
            </div>
          </div>
          <span aria-hidden="true" className="pointer-events-none absolute -right-6 -top-6 w-28 h-28 rounded-full" style={{ background: 'radial-gradient(circle,rgba(74,222,128,0.35),transparent 70%)' }} />
        </div>
        <div className="p-5 space-y-4">
        {target && (
          <div className="text-left">
            <button
              type="button"
              onClick={() => target.options && target.options.length > 1 && setPickingGroup((v) => !v)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-sm ${target.name ? 'bg-primary/5 border-primary/20' : 'bg-warning/10 border-warning/40'}`}
            >
              <span className="material-symbols-outlined text-[18px] text-primary">group</span>
              <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">{t('voiceExpense.addingTo')}</span>
              <span className="flex-1 truncate font-black text-primary">{target.name || t('voiceExpense.chooseGroup')}</span>
              {target.options && target.options.length > 1 && (
                <span className="text-[11px] font-black text-primary">{pickingGroup ? t('voiceExpense.close') : t('voiceExpense.change')}</span>
              )}
            </button>
            {pickingGroup && target.options && (
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-border-subtle divide-y divide-border-subtle">
                {target.options.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => { target.onSelect?.(g.id); setPickingGroup(false); }}
                    className={`w-full text-left px-3 py-2.5 text-sm font-semibold flex items-center gap-2 ${g.id === target.selectedId ? 'bg-primary/10 text-primary' : 'text-text-main'}`}
                  >
                    <span className="flex-1 truncate">{g.name}</span>
                    {g.id === target.selectedId && <span className="text-primary font-black">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {blocked ? (
          <>
            <p className="text-sm font-bold text-text-main">
              {phase === 'denied' ? t('voiceExpense.denied') : phase === 'unavailable' ? t('voiceExpense.unavailable') : t('voiceExpense.errorTitle')}
            </p>
            {phase === 'error' && errorText && <p className="text-xs text-text-muted break-words">{errorText}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 py-3 rounded-xl bg-surface border border-border-subtle text-sm font-bold text-text-muted">{t('voiceExpense.close')}</button>
              {phase === 'error' && (
                <button type="button" onClick={begin} className="flex-1 py-3 rounded-xl bg-primary text-white text-sm font-bold">{t('voiceExpense.tryAgain')}</button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="relative w-28 h-28 mx-auto flex items-center justify-center">
              {phase === 'listening' && !useServerVoice && <span className="absolute inset-0 rounded-full bg-[#4ADE80]/25 animate-ping" />}
              {phase === 'listening' && useServerVoice && (
                <>
                  <span className="absolute inset-0 rounded-full bg-[#4ADE80]/20 transition-transform duration-100" style={{ transform: `scale(${1 + level * 0.55})` }} />
                  <span className="absolute inset-2 rounded-full bg-[#3B82F6]/20 transition-transform duration-100" style={{ transform: `scale(${1 + level * 0.3})` }} />
                </>
              )}
              {phase === 'thinking' && <span className="absolute inset-0 rounded-full border-4 border-[#3B82F6]/25 border-t-[#4ADE80] animate-spin" />}
              <span
                className="relative w-20 h-20 rounded-full text-white flex items-center justify-center shadow-lg"
                style={{ background: 'linear-gradient(135deg,#4ADE80 0%,#3B82F6 100%)' }}
              >
                <span className="material-symbols-outlined text-[38px]">mic</span>
              </span>
            </div>
            <p className="text-base font-black text-[#0d3b4e]">
              {phase === 'starting' ? t('voiceExpense.starting') : phase === 'thinking' ? t('voiceExpense.thinking') : phase === 'nothing' ? t('voiceExpense.nothing') : t('voiceExpense.listening')}
            </p>
            <p className="min-h-[44px] text-base font-semibold text-text-main px-2">
              {heard || (
                <span className="flex flex-wrap justify-center gap-1.5">
                  {[t('voiceExpense.ex1'), t('voiceExpense.ex2'), t('voiceExpense.ex3')].map((x) => (
                    <span key={x} className="px-2.5 py-1 rounded-full bg-[#4ADE80]/10 text-[#0d3b4e] text-[11px] font-bold border border-[#4ADE80]/30">&ldquo;{x}&rdquo;</span>
                  ))}
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 py-3.5 rounded-2xl bg-surface border border-border-subtle text-sm font-bold text-text-muted">{t('voiceExpense.cancel')}</button>
              {phase === 'nothing' ? (
                <button type="button" onClick={begin} className="flex-1 py-3.5 rounded-2xl text-white text-sm font-black shadow-md" style={{ background: 'linear-gradient(135deg,#0d3b4e,#1E3A8A)' }}>{t('voiceExpense.tryAgain')}</button>
              ) : (
                <button type="button" onClick={done} disabled={phase !== 'listening'} className="flex-1 py-3.5 rounded-2xl text-white text-sm font-black shadow-md disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#0d3b4e,#1E3A8A)' }}>{t('voiceExpense.done')}</button>
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
