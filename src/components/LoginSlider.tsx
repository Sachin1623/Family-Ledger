import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';

// The first thing a new visitor sees on the login screen: what the app gives them, before the buttons ask for anything. Swipeable
// (native scroll-snap) and advances by itself until the person touches it.
const SLIDES = [
  { key: 'finance', icon: '💸', bg: 'bg-emerald-100', chips: ['💸 Splits', '🧾 Receipts', '👨‍👩‍👧 Groups'] },
  { key: 'goals', icon: '🎯', bg: 'bg-blue-100', chips: ['🎯 Goals', '🏦 Accounts', '📈 Investments'] },
  { key: 'health', icon: '💊', bg: 'bg-red-100', chips: ['💊 Medicine', '💉 Vaccines', '🤝 Caregivers'] },
  { key: 'connect', icon: '💬', bg: 'bg-amber-100', chips: ['💬 Chat', '🧮 Share expenses', '🎲 Games'] },
] as const;

export default function LoginSlider() {
  const { t } = useLanguage();
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const touched = useRef(false);

  const goTo = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  useEffect(() => {
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* assume motion is fine */ }
    if (reduce) return;
    const id = window.setInterval(() => {
      if (touched.current) return;
      setIndex((cur) => {
        const next = (cur + 1) % SLIDES.length;
        goTo(next);
        return next;
      });
    }, 4500);
    return () => window.clearInterval(id);
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !el.clientWidth) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  return (
    <div className="space-y-3" aria-roledescription="carousel">
      <div
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={() => { touched.current = true; }}
        onMouseDown={() => { touched.current = true; }}
        className="flex overflow-x-auto snap-x snap-mandatory no-scrollbar -mx-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {SLIDES.map((s) => (
          <div key={s.key} className="snap-center shrink-0 w-full px-1">
            <div className="rounded-2xl border border-border-subtle bg-surface/60 p-4 text-left h-full">
              <div className="flex items-center gap-3">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-2xl ${s.bg}`}>{s.icon}</div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.14em] text-teal-700">{t(`auth.slide.${s.key}.tag`)}</p>
                  <p className="text-lg font-black text-primary leading-tight">{t(`auth.slide.${s.key}.title`)}</p>
                </div>
              </div>
              <p className="text-[13px] text-text-muted leading-snug mt-2.5 min-h-[56px]">{t(`auth.slide.${s.key}.body`)}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {s.chips.map((c) => (
                  <span key={c} className="px-2.5 py-1 rounded-full bg-white border border-border-subtle text-[11px] font-bold text-text-secondary">{c}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-center gap-1.5">
        {SLIDES.map((s, i) => (
          <button
            key={s.key}
            type="button"
            aria-label={`Slide ${i + 1}`}
            onClick={() => { touched.current = true; goTo(i); }}
            className={`h-2 rounded-full transition-all ${i === index ? 'w-6 bg-primary' : 'w-2 bg-border-subtle'}`}
          />
        ))}
      </div>
    </div>
  );
}
