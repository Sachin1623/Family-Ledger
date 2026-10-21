import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../context/LanguageContext';
import { SpeechRecognition, speechLanguageFor, type SpeechListenerHandle } from '../lib/speech';

// Bottom sheet for "talk to add an expense": asks for the microphone, shows what is being heard as it is heard, and hands the finished
// sentence back. The sentence is turned into fields by lib/voiceExpense.ts (and saved by VoiceQuickAdd / AddExpense).
//
// The phone's recogniser sends its FINAL words a moment after it announces the speech has ended, so the sentence is only handed over
// once those final words arrive (or a short wait runs out) — closing earlier used half-finished words.
export default function VoiceExpenseSheet({ onClose, onHeard }: { onClose: () => void; onHeard: (sentence: string) => void }) {
  const { t, language } = useLanguage();
  const [phase, setPhase] = useState<'starting' | 'listening' | 'nothing' | 'denied' | 'unavailable' | 'error'>('starting');
  const [heard, setHeard] = useState('');
  const [errorText, setErrorText] = useState('');
  const heardRef = useRef('');
  const finished = useRef(false);
  const timers = useRef<{ settle?: number; silence?: number }>({});
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
    timers.current = {};
  };

  const finish = useCallback(() => {
    if (finished.current) return;
    clearTimers();
    const sentence = heardRef.current.trim();
    if (sentence) {
      finished.current = true;
      SpeechRecognition.stop().catch(() => {});
      onHeardRef.current(sentence);
      onCloseRef.current();
    } else {
      setPhase('nothing');
    }
  }, []);

  const begin = useCallback(async () => {
    finished.current = false;
    heardRef.current = '';
    setHeard('');
    setErrorText('');
    setPhase('starting');
    clearTimers();
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
          // The final words: done.
          if (timers.current.settle) window.clearTimeout(timers.current.settle);
          timers.current.settle = window.setTimeout(finish, 250);
        }),
        await SpeechRecognition.addListener('listeningState', (d) => {
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
          setErrorText(`${d.message || 'error'}${d.code ? ` (${d.code})` : ''}`);
          setPhase('error');
        }),
      ];
      setPhase('listening');
      // Nothing heard at all after a while: say so instead of listening forever.
      timers.current.silence = window.setTimeout(() => {
        if (!heardRef.current) { SpeechRecognition.stop().catch(() => {}); setPhase('nothing'); }
      }, 15000);
      await SpeechRecognition.start({ language: speechLanguageFor(languageRef.current) });
    } catch (err: any) {
      console.error('speech start failed:', err);
      setErrorText(String(err?.message || err || 'could not start'));
      setPhase('error');
    }
  }, [finish]);

  useEffect(() => {
    begin();
    return () => {
      clearTimers();
      SpeechRecognition.stop().catch(() => {});
      handles.current.forEach((h) => h.remove().catch(() => {}));
      handles.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = () => {
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
              {phase === 'listening' && <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />}
              <span className="relative w-16 h-16 rounded-full bg-primary text-white flex items-center justify-center">
                <span className="material-symbols-outlined text-[32px]">mic</span>
              </span>
            </div>
            <p className="text-sm font-black text-primary">
              {phase === 'starting' ? t('voiceExpense.starting') : phase === 'nothing' ? t('voiceExpense.nothing') : t('voiceExpense.listening')}
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
