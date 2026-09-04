export type LanguageCode = 'en' | 'hi' | 'ar' | 'de' | 'fr' | 'ro' | 'es' | 'it' | 'ru' | 'zh' | 'ja';

export interface LanguageMeta {
  code: LanguageCode;
  label: string;
  nativeLabel: string;
  rtl?: boolean;
}

export const LANGUAGES: LanguageMeta[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية', rtl: true },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'ro', label: 'Romanian', nativeLabel: 'Română' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'it', label: 'Italian', nativeLabel: 'Italiano' },
  { code: 'ru', label: 'Russian', nativeLabel: 'Русский' },
  { code: 'zh', label: 'Mandarin', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

// Languages offered in the picker UI. All 11 are enabled — note that only `en` (and mostly `hi`)
// are fully caught up with every key added across this app's lifetime; the rest fall back to
// English for anything newer (see LanguageContext.tsx's `t()`, which always resolves a missing
// key through DICTIONARIES.en before ever showing a raw key), so a language other than English
// will show some mixed-language text until its dictionary is fully caught up. That's an accepted,
// incremental rollout tradeoff, not a bug — narrow this list back down if a language's gaps ever
// become disruptive enough to pull it until it's caught up.
const ENABLED_LANGUAGE_CODES: LanguageCode[] = LANGUAGE_CODES;
export const ENABLED_LANGUAGES: LanguageMeta[] = LANGUAGES.filter((l) => ENABLED_LANGUAGE_CODES.includes(l.code));
