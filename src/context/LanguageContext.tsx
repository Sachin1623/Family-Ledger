import React, { createContext, useContext, useEffect, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from './AuthContext';
import { LANGUAGES, ENABLED_LANGUAGES, LanguageCode } from '../lib/i18n/languages';
import en from '../lib/i18n/en';
import hi from '../lib/i18n/hi';
import ar from '../lib/i18n/ar';
import de from '../lib/i18n/de';
import fr from '../lib/i18n/fr';
import ro from '../lib/i18n/ro';
import es from '../lib/i18n/es';
import it from '../lib/i18n/it';
import ru from '../lib/i18n/ru';
import zh from '../lib/i18n/zh';
import ja from '../lib/i18n/ja';
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
const BASE_DICTIONARIES: Record<LanguageCode, Record<string, string>> = { en, hi, ar, de, fr, ro, es, it, ru, zh, ja };
const DICTIONARIES: Record<LanguageCode, Record<string, string>> = Object.fromEntries(
  (Object.keys(BASE_DICTIONARIES) as LanguageCode[]).map((code) => [
    code,
    Object.assign({}, BASE_DICTIONARIES[code], ...GAME_PARTIALS.map((p) => p[code] || {})),
  ]),
) as Record<LanguageCode, Record<string, string>>;

const STORAGE_KEY = 'familyledger_language';

function isLanguageCode(v: unknown): v is LanguageCode {
  return typeof v === 'string' && v in DICTIONARIES;
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
      setDoc(doc(db, 'users', user.uid), { language: lang }, { merge: true }).catch((err) =>
        console.error('Failed to save language preference:', err),
      );
    }
  };

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTIONARIES[language] || DICTIONARIES.en;
      let str = dict[key] ?? DICTIONARIES.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return str;
    },
    [language],
  );

  return <LanguageContext.Provider value={{ language, setLanguage, t, isRTL }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
