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

// Languages actually offered in the picker UI. The full LANGUAGES list/dictionaries above stay
// intact and fully translated — maintaining new keys across all 11 languages for every future
// feature was too time-consuming, so the picker is trimmed to just these until re-enabled. To
// bring a language back, just add its code here; no other setup is needed.
const ENABLED_LANGUAGE_CODES: LanguageCode[] = ['en', 'hi'];
export const ENABLED_LANGUAGES: LanguageMeta[] = LANGUAGES.filter((l) => ENABLED_LANGUAGE_CODES.includes(l.code));
