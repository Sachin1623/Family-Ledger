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
        className="w-full bg-white rounded-t-3xl p-5 space-y-4 text-center"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-border-subtle mx-auto" />
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
            <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
              {phase === 'listening' && !useServerVoice && <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />}
              {phase === 'listening' && useServerVoice && (
                <span className="absolute inset-0 rounded-full bg-primary/20 transition-transform duration-100" style={{ transform: `scale(${1 + level * 0.5})` }} />
              )}
              {phase === 'thinking' && <span className="absolute inset-0 rounded-full border-4 border-primary/30 border-t-primary animate-spin" />}
              <span className="relative w-16 h-16 rounded-full bg-primary text-white flex items-center justify-center">
                <span className="material-symbols-outlined text-[32px]">mic</span>
              </span>
            </div>
            <p className="text-sm font-black text-primary">
              {phase === 'starting' ? t('voiceExpense.starting') : phase === 'thinking' ? t('voiceExpense.thinking') : phase === 'nothing' ? t('voiceExpense.nothing') : t('voiceExpense.listening')}
            </p>
            <p className="min-h-[44px] text-base font-semibold text-text-main px-2">
              {heard || <span className="text-text-muted text-xs font-medium">{t('voiceExpense.example')}</span>}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 py-3 rounded-xl bg-surface border border-border-subtle text-sm font-bold text-text-muted">{t('voiceExpense.cancel')}</button>
              {phase === 'nothing' ? (
                <button type="button" onClick={begin} className="flex-1 py-3 rounded-xl bg-primary text-white text-sm font-bold">{t('voiceExpense.tryAgain')}</button>
              ) : (
                <button type="button" onClick={done} disabled={phase !== 'listening'} className="flex-1 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-50">{t('voiceExpense.done')}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
