import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { SpeechRecognition, speechLanguageFor } from '../lib/speech';

// Bottom sheet for "talk to add an expense": asks for the microphone, shows what is being heard as it is heard, and hands the finished
// sentence back. The sentence is turned into fields by lib/voiceExpense.ts; nothing is saved until the person reviews and taps Save.
export default function VoiceExpenseSheet({ onClose, onHeard }: { onClose: () => void; onHeard: (sentence: string) => void }) {
  const { t, language } = useLanguage();
  const [phase, setPhase] = useState<'starting' | 'listening' | 'nothing' | 'denied' | 'unavailable'>('starting');
  const [heard, setHeard] = useState('');
  const heardRef = useRef('');
  const finished = useRef(false);
  const listeners = useRef<Array<{ remove: () => Promise<void> }>>([]);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    const sentence = heardRef.current.trim();
    if (sentence) {
      onHeard(sentence);
      onClose();
    } else {
      finished.current = false;
      setPhase('nothing');
    }
  }, [onClose, onHeard]);

  const begin = useCallback(async () => {
    finished.current = false;
    heardRef.current = '';
    setHeard('');
    setPhase('starting');
    try {
      const avail = await SpeechRecognition.available();
      if (!avail.available) { setPhase('unavailable'); return; }
      let perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== 'granted') perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') { setPhase('denied'); return; }
      await Promise.all(listeners.current.map((l) => l.remove().catch(() => {})));
      listeners.current = [
        await SpeechRecognition.addListener('partialResults', (d) => {
          const text = d.matches?.[0] || '';
          heardRef.current = text;
          setHeard(text);
        }),
        await SpeechRecognition.addListener('listeningState', (d) => {
          if (d.status === 'stopped') finish();
        }),
      ];
      setPhase('listening');
      const result = await SpeechRecognition.start({ language: speechLanguageFor(language), maxResults: 1, partialResults: true, popup: false });
      if (result?.matches?.[0]) heardRef.current = result.matches[0];
    } catch (err) {
      console.error('speech start failed:', err);
      setPhase('unavailable');
    }
  }, [finish, language]);

  useEffect(() => {
    begin();
    return () => {
      SpeechRecognition.stop().catch(() => {});
      listeners.current.forEach((l) => l.remove().catch(() => {}));
      listeners.current = [];
    };
  }, [begin]);

  const done = () => {
    SpeechRecognition.stop().catch(() => {});
    // The recogniser reports "stopped" itself; this covers a recogniser that does not.
    window.setTimeout(finish, 350);
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-end bg-black/50" onClick={onClose}>
      <div
        className="w-full bg-white rounded-t-3xl p-5 space-y-4 text-center"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-border-subtle mx-auto" />
        {phase === 'denied' || phase === 'unavailable' ? (
          <>
            <p className="text-sm font-bold text-text-main">{phase === 'denied' ? t('voiceExpense.denied') : t('voiceExpense.unavailable')}</p>
            <button type="button" onClick={onClose} className="w-full py-3 rounded-xl bg-primary text-white text-sm font-bold">{t('voiceExpense.close')}</button>
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
    </div>
  );
}
