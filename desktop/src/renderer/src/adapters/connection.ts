import { isTranslationMode, type TranslationMode } from './remote/guards';

/** Demo: mock translator, no backend. Live: the SignFlow backend translates (and can speak). */
export type AdapterMode = 'demo' | 'live';
/** Where confirmed text is spoken: system voices (offline) or the backend's cloud voice. */
export type VoiceSource = 'system' | 'cloud';

export interface ConnectionSettings {
  mode: AdapterMode;
  voice: VoiceSource;
  context: TranslationMode;
}

export const DEFAULT_CONNECTION: ConnectionSettings = { mode: 'demo', voice: 'system', context: 'chat' };

export function isConnectionSettings(v: unknown): v is ConnectionSettings {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o['mode'] === 'demo' || o['mode'] === 'live') && (o['voice'] === 'system' || o['voice'] === 'cloud') && isTranslationMode(o['context']);
}
