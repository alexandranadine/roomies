/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
  /** Public R2 S3 origin only (scheme://host). Never a credential. */
  readonly VITE_R2_S3_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
