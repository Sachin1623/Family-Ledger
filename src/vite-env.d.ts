/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADSENSE_CLIENT_ID: string;
  readonly VITE_AD_SLOT_EXPENSE: string;
  readonly VITE_AD_SLOT_INVITE: string;
  readonly VITE_AD_SLOT_ANALYSIS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
