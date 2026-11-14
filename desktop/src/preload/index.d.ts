import type { SignflowApi } from '../shared/api';

declare global {
  interface Window {
    /** Typed bridge exposed by the preload script (see src/preload/index.ts). */
    signflow: SignflowApi;
  }
}

export {};
