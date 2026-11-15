import type { KokoroErrorCode, KokoroVoiceId } from '@shared/kokoro';

/** main → Kokoro utility process */
export type ToWorker =
  | { type: 'load'; modelRoot: string; modelDirName: string; threads: number }
  | { type: 'synthesize'; id: string; text: string; voice: KokoroVoiceId; speed: number }
  | { type: 'cancel'; ids: string[] | 'all' };

/** Kokoro utility process → main */
export type FromWorker =
  | { type: 'loaded'; loadMs: number }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: string; wav: Uint8Array; durationS: number; synthMs: number }
  | { type: 'error'; id: string; code: KokoroErrorCode; message: string }
  | { type: 'network-blocked'; url: string };
