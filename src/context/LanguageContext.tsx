import React, { createContext, useContext, useEffect, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from './AuthContext';
import { LANGUAGES, ENABLED_LANGUAGES, LanguageCode } from '../lib/i18n/languages';
import en from '../lib/i18n/en';
import gameRanks from '../lib/i18n/games/gameRanks';

export type { LanguageCode };
export { LANGUAGES, ENABLED_LANGUAGES };

// Per-game translation files (src/lib/i18n/games/*.ts) are kept separate from the main
// per-language dictionaries above and merged in here, rather than appending their keys directly
// into en.ts/hi.ts/etc. — those 11 files are shared, monolithic, and already large; letting each
// game own a single self-contained file (one file, all languages, all its own keys) means adding
// or editing a game's translations never touches — or conflicts with — any other game's or the
// core app's dictionary file.
const GAME_PARTIALS: Partial<Record<LanguageCode, Record<string, string>>>[] = [gameRanks];
// English ships in the first download; every other language is fetched only when someone actually uses it, so a first-time
// visitor's download isn't weighed down by ten dictionaries they will never read.
const LOADERS: Record<Exclude<LanguageCode, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  hi: () => import('../lib/i18n/hi'),
  ar: () => import('../lib/i18n/ar'),
  de: () => import('../lib/i18n/de'),
  fr: () => import('../lib/i18n/fr'),
  ro: () => import('../lib/i18n/ro'),
  es: () => import('../lib/i18n/es'),
  it: () => import('../lib/i18n/it'),
  ru: () => import('../lib/i18n/ru'),
  zh: () => import('../lib/i18n/zh'),
  ja: () => import('../lib/i18n/ja'),
};
const merged = (code: LanguageCode, base: Record<string, string>) =>
  Object.assign({}, base, ...GAME_PARTIALS.map((p) => p[code] || {}));
const DICTIONARIES: Partial<Record<LanguageCode, Record<string, string>>> = { en: merged('en', en) };
const EN: Record<string, string> = DICTIONARIES.en!;

const STORAGE_KEY = 'familyledger_language';

function isLanguageCode(v: unknown): v is LanguageCode {
  return typeof v === 'string' && (v === 'en' || v in LOADERS);
}

function detectInitialLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguageCode(stored)) return stored;
  } catch {
    // localStorage unavailable (private browsing etc.) — default to English
  }
  return 'en';
}

interface LanguageContextValue {
  language: LanguageCode;
  setLanguage: (lang: LanguageCode) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'en',
  setLanguage: () => {},
  t: (key) => key,
  isRTL: false,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { user, profile } = useAuth();
  const [language, setLanguageState] = useState<LanguageCode>(detectInitialLanguage);
  // bumps when a language's dictionary finishes downloading, so the screen re-renders in it (English shows meanwhile)
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    if (language === 'en' || DICTIONARIES[language]) return;
    let cancelled = false;
    LOADERS[language]().then((m) => {
      DICTIONARIES[language] = merged(language, m.default);
      if (!cancelled) setLoadedTick((n) => n + 1);
    }).catch((err) => console.error('Failed to load language:', language, err));
    return () => { cancelled = true; };
  }, [language]);
  const isRTL = LANGUAGES.find((l) => l.code === language)?.rtl ?? false;

  // Whole-document lang/dir attributes — this is what actually flips the UI to RTL (Tailwind's
  // `rtl:`/`ltr:` variants, and every browser default like text alignment and scrollbar side,
  // key off the `dir` attribute on an ancestor, normally <html>).
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  }, [language, isRTL]);

  // First load on a device with no locally-remembered choice yet (e.g. a fresh sign-in on a new
  // device/browser) — adopt whatever language is saved on the account. Only ever applies once,
  // and never overrides a choice already made locally, so it can't clobber someone switching
  // languages right before signing in.
  const profileSyncedRef = React.useRef(false);
  useEffect(() => {
    if (profileSyncedRef.current) return;
    if (!isLanguageCode(profile?.language)) return;
    let hadStored = false;
    try {
      hadStored = !!localStorage.getItem(STORAGE_KEY);
    } catch {
      // treat as "no stored preference" — falls through to adopting the profile's language
    }
    if (hadStored) return;
    profileSyncedRef.current = true;
    setLanguageState(profile.language);
    try {
      localStorage.setItem(STORAGE_KEY, profile.language);
    } catch {
      // non-fatal — just won't persist across a full reload this session
    }
  }, [profile?.language]);

  const setLanguage = (lang: LanguageCode) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // non-fatal — the picker will just default to English again next visit on this device
    }
    if (user) {
      // updateDoc, not setDoc(...,{merge:true}) — this can fire within moments of a brand-new
      // sign-in (the language picker itself is one of the very first things a new user sees), and
      // a merge-write reaching Firestore before the account's own creation logic has run would
      // CREATE the user doc with only `language` set, silently skipping `hasSeenOnboarding: false`/
      // `hasCompletedProfileSetup: false` forever — see AuthContext.tsx's matching comment for the
      // full reasoning. updateDoc can only touch an EXISTING doc, so this just fails harmlessly on
      // that exact race (caught below); the preference is still applied locally either way
      // (setLanguageState + localStorage above), and syncs to the doc on the next change/login.
      updateDoc(doc(db, 'users', user.uid), { language: lang }).catch((err) =>
        console.error('Failed to save language preference:', err),
      );
    }
  };

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTIONARIES[language] || EN;
      let str = dict[key] ?? EN[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return str;
    },
    [language, DICTIONARIES[language]],
  );

  return <LanguageContext.Provider value={{ language, setLanguage, t, isRTL }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
