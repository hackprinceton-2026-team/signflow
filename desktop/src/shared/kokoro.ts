/**
 * Kokoro-82M local neural speech: the contract shared by the main process, the
 * Kokoro utility process, the renderer, and the install script.
 *
 * Everything runs on this device. The model comes from a pinned revision of
 * onnx-community/Kokoro-82M-v1.0-ONNX (Apache-2.0, converted from hexgrad/Kokoro-82M)
 * and is checked against the SHA-256 values below when installed.
 *
 * Plain TypeScript only (no enums, no path aliases): `scripts/kokoro-install.mts`
 * imports this file directly with Node's type stripping.
 */

export const KOKORO_MODEL_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Pinned upstream commit, so the install is reproducible and checkable. */
export const KOKORO_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
/** Folder name under the models directory (also the transformers.js model id). */
export const KOKORO_MODEL_DIRNAME = 'Kokoro-82M-v1.0-ONNX';
/** Full-precision weights: the reference quality, and the fastest variant on Apple Silicon CPUs. */
export const KOKORO_DTYPE = 'fp32';
export const KOKORO_SAMPLE_RATE = 24_000;

export interface KokoroModelFile {
  /** Path inside the model folder (and the upstream repo). */
  path: string;
  size: number;
  sha256: string;
}

export const KOKORO_MODEL_FILES: readonly KokoroModelFile[] = [
  { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
  { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
  { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
  { path: 'onnx/model.onnx', size: 325_532_232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
];

export const KOKORO_MODEL_BYTES = KOKORO_MODEL_FILES.reduce((sum, f) => sum + f.size, 0);

export function kokoroFileUrl(path: string): string {
  return `https://huggingface.co/${KOKORO_MODEL_REPO}/resolve/${KOKORO_MODEL_REVISION}/${path}`;
}

/** The command shown to users when the model is missing. */
export const KOKORO_INSTALL_COMMAND = 'cd desktop && npm run kokoro:install';

// ---------- Voices ----------

export type KokoroVoiceId = 'af_heart' | 'af_bella' | 'am_michael';

export interface KokoroVoice {
  id: KokoroVoiceId;
  name: string;
  description: string;
}

/**
 * The voices offered in the app. Kokoro's own grades: Heart A, Bella A-, Michael C+.
 * Voice embeddings ship inside the kokoro-js package (same SHA-256 as upstream).
 */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { id: 'af_heart', name: 'Heart', description: 'Recommended · US English, female, warm and clear' },
  { id: 'af_bella', name: 'Bella', description: 'US English, female, brighter' },
  { id: 'am_michael', name: 'Michael', description: 'US English, male' },
];

export const DEFAULT_KOKORO_VOICE: KokoroVoice = KOKORO_VOICES[0]!;

/** SHA-256 of the voice embeddings kokoro-js ships (identical to the upstream repo's voices/*.bin). */
export const KOKORO_VOICE_SHA256: Readonly<Record<KokoroVoiceId, string>> = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
};

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return KOKORO_VOICES.some((v) => v.id === value);
}

/** The voice to use: the user's pick if offered, otherwise Heart. */
export function resolveKokoroVoice(id: string | undefined): KokoroVoice {
  return KOKORO_VOICES.find((v) => v.id === id) ?? DEFAULT_KOKORO_VOICE;
}

// ---------- Status ----------

/**
 * missing:   the model files aren't installed (or are incomplete).
 * installed: on disk, not loaded yet (loads on first use or on `prepare`).
 * loading:   the utility process is loading the model.
 * ready:     loaded; synthesis is fast.
 * error:     loading failed or the engine crashed; `message` says why.
 */
export type KokoroState = 'missing' | 'installed' | 'loading' | 'ready' | 'error';

export interface KokoroStatus {
  state: KokoroState;
  /** User-facing explanation for missing/error. */
  message?: string;
  /** Model load time of the current engine, once ready. */
  loadMs?: number;
}

export const KOKORO_STATES: readonly KokoroState[] = ['missing', 'installed', 'loading', 'ready', 'error'];

export function isKokoroStatus(value: unknown): value is KokoroStatus {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    KOKORO_STATES.includes(o['state'] as KokoroState) &&
    (o['message'] === undefined || typeof o['message'] === 'string') &&
    (o['loadMs'] === undefined || typeof o['loadMs'] === 'number')
  );
}

// ---------- Synthesis requests (renderer → main, untrusted) ----------

/**
 * The renderer sends one sentence-sized chunk (≤ 220 chars) at a time. Kokoro
 * silently drops whatever exceeds its 510-token context (~450 characters of
 * English), so the main process refuses anything longer instead of speaking
 * part of it.
 */
export const KOKORO_MAX_TEXT_CHARS = 400;
/** Queued + running requests the engine accepts at once (a long confirmed text is ~25 sentences). */
export const KOKORO_MAX_PENDING = 64;
export const KOKORO_SPEED_RANGE = [0.5, 2] as const;

export interface KokoroSynthesizeRequest {
  /** Renderer-chosen id, used to cancel. */
  id: string;
  text: string;
  voice: KokoroVoiceId;
  /** Kokoro's native speaking rate (keeps natural pitch). */
  speed: number;
}

export interface KokoroSynthesizeResult {
  id: string;
  /** 16-bit mono PCM WAV at KOKORO_SAMPLE_RATE, leading/trailing silence trimmed. */
  wav: Uint8Array;
  /** Audio length in seconds. */
  durationS: number;
  /** Time spent in the model. */
  synthMs: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function validateKokoroRequestId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new TypeError('Invalid Kokoro request id');
  return value;
}

export function validateKokoroSynthesize(value: unknown): KokoroSynthesizeRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Kokoro request must be an object');
  const o = value as Record<string, unknown>;
  const id = validateKokoroRequestId(o['id']);
  const text = o['text'];
  if (typeof text !== 'string') throw new TypeError('Kokoro text must be a string');
  const trimmed = text.trim();
  if (!trimmed) throw new RangeError('Kokoro text is empty');
  if (trimmed.length > KOKORO_MAX_TEXT_CHARS) throw new RangeError('Kokoro text is too long');
  if (!isKokoroVoiceId(o['voice'])) throw new TypeError('Unknown Kokoro voice');
  const speed = o['speed'];
  if (typeof speed !== 'number' || !Number.isFinite(speed)) throw new TypeError('Kokoro speed must be a number');
  const [min, max] = KOKORO_SPEED_RANGE;
  return { id, text: trimmed, voice: o['voice'], speed: Math.min(max, Math.max(min, speed)) };
}

/** Why a synthesis request failed, so the renderer can explain it and fall back. */
export type KokoroErrorCode = 'missing' | 'load_failed' | 'synthesis_failed' | 'cancelled' | 'timeout' | 'crashed';

const CODE_PREFIX = 'KOKORO_';

/** Errors cross IPC as plain messages; the code travels as a prefix. */
export function encodeKokoroError(code: KokoroErrorCode, message: string): string {
  return `${CODE_PREFIX}${code}: ${message}`;
}

export function decodeKokoroError(raw: string): { code: KokoroErrorCode | 'unknown'; message: string } {
  const m = /KOKORO_(missing|load_failed|synthesis_failed|cancelled|timeout|crashed): ([\s\S]*)$/.exec(raw);
  if (!m) return { code: 'unknown', message: raw };
  return { code: m[1] as KokoroErrorCode, message: m[2] ?? '' };
}
