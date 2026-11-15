/**
 * The local ASL recognizer (Umar's `ml` live.py on ws://localhost:8765): message
 * validation and normalization, shared by the Electron main process (which
 * receives the untrusted WebSocket messages) and the renderer (which gets only
 * the normalized events below).
 *
 * Wire format (one JSON text message per event), from the recognizer's README:
 *   14-sign demo model (default):
 *     {"type":"sign","sign":"HELP","confidence":0.91,"candidates":[["HELP",0.91],["STOP",0.05]],"ts":1794708452.9}
 *   116-sign keyword model (--keyword; allowed by default here, can be turned off):
 *     {"type":"sign","candidates":[["HEADACHE",0.62],["HOT",0.14],...],"top1":"HEADACHE","confident":true,"ts":...}
 *   both:
 *     {"type":"end_of_sentence","signs":["HELP","DOCTOR"],"ts":...}   (keyword adds "confident":[...])
 * `ts` is Unix time in SECONDS.
 */

/** Loopback only: the app never talks to a recognizer on another machine. */
export const RECOGNIZER_HOST = '127.0.0.1';
export const RECOGNIZER_DEFAULT_PORT = 8765;
/** Real messages are ~200-400 bytes; anything far larger is not from the recognizer. */
export const RECOGNIZER_MAX_MESSAGE_CHARS = 8192;
export const RECOGNIZER_MAX_CANDIDATES = 10;
/**
 * Preview frames (SignFlow's recognizer launcher, desktop/scripts/asl/): a small JPEG
 * of what the recognizer's camera sees. ~320 px wide is ~15-30 KB of base64.
 */
export const RECOGNIZER_MAX_PREVIEW_CHARS = 200_000;

/** A camera preview frame from the recognizer (base64 JPEG), shown in place of a local camera. */
export interface RecognizerPreview {
  jpeg: string;
  width: number;
  height: number;
}

export type RecognizerModel = 'demo14' | 'keyword116';

export interface RecognizerAlternative {
  gloss: string;
  confidence: number;
}

/** A recognized sign, already in SignFlow's `RecognizedSign` shape (plus what the model told us). */
export interface RecognizerSign {
  /** Stable for a given event: the same message delivered twice gets the same id. */
  id: string;
  gloss: string;
  /** The model's (calibrated, for the keyword model) top-1 probability, 0..1. Not an accuracy guarantee. */
  confidence: number;
  /** ms since epoch. */
  ts: number;
  final: true;
  /**
   * The model itself marked this sign as not confident (keyword model `confident: false`).
   * Shown in the live feed, never used for a draft.
   */
  uncertain: boolean;
  /** The other candidates, most likely first, for display only. */
  alternatives: RecognizerAlternative[];
  model: RecognizerModel;
}

export type RecognizerEvent =
  | { type: 'sign'; sign: RecognizerSign }
  /** The signer's hands have been down for ~1.5 s after at least one sign. */
  | { type: 'sentence-end'; ts: number; model: RecognizerModel };

export type RecognizerState = 'idle' | 'connecting' | 'ready' | 'error';

/** Which camera SignFlow's recognizer launcher uses (desktop/scripts/asl/camera_select.py). */
export interface RecognizerCamera {
  active: string;
  /** OpenCV index. */
  index: number;
  selection: 'automatic' | 'explicit-index' | 'explicit-name' | 'unidentified';
  /** The index was physically verified to be that camera (or chosen explicitly). */
  verified: boolean;
  note: string;
  available: { name: string; kind: 'built-in' | 'iPhone' | 'external' }[];
}

export interface RecognizerStatus {
  state: RecognizerState;
  message?: string;
  camera?: RecognizerCamera;
  /** Which model the recognizer is running, once a message has told us. */
  model?: RecognizerModel;
}

export type ParseResult =
  | { ok: true; event: RecognizerEvent }
  | { ok: true; preview: RecognizerPreview }
  | { ok: true; camera: RecognizerCamera }
  | { ok: false; reason: string };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isDim = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= 1280;

const SELECTIONS = ['automatic', 'explicit-index', 'explicit-name', 'unidentified'] as const;
const KINDS = ['built-in', 'iPhone', 'external'] as const;
const shortText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120;

function parseCamera(o: Record<string, unknown>): ParseResult {
  const available = o['available'];
  if (
    !shortText(o['active']) ||
    typeof o['index'] !== 'number' || !Number.isInteger(o['index']) || o['index'] < 0 || o['index'] > 64 ||
    !SELECTIONS.includes(o['selection'] as (typeof SELECTIONS)[number]) ||
    typeof o['verified'] !== 'boolean' ||
    !(o['note'] === undefined || (typeof o['note'] === 'string' && o['note'].length <= 300)) ||
    !Array.isArray(available) || available.length > 16 ||
    !available.every((a) => a && typeof a === 'object' && shortText(a.name) && KINDS.includes(a.kind))
  ) {
    return { ok: false, reason: 'malformed camera message' };
  }
  return {
    ok: true,
    camera: {
      active: o['active'],
      index: o['index'],
      selection: o['selection'] as RecognizerCamera['selection'],
      verified: o['verified'],
      note: typeof o['note'] === 'string' ? o['note'] : '',
      available: available.map((a: { name: string; kind: RecognizerCamera['available'][number]['kind'] }) => ({ name: a.name, kind: a.kind })),
    },
  };
}

function parsePreview(o: Record<string, unknown>): ParseResult {
  const jpeg = o['jpeg'];
  // "/9j/" is the base64 of the JPEG start-of-image marker (FF D8 FF).
  if (typeof jpeg !== 'string' || !jpeg.startsWith('/9j/') || !BASE64.test(jpeg)) return { ok: false, reason: 'preview is not a JPEG' };
  if (!isDim(o['width']) || !isDim(o['height'])) return { ok: false, reason: 'preview has bad dimensions' };
  return { ok: true, preview: { jpeg, width: o['width'], height: o['height'] } };
}

/** The same pattern SignFlow's backend enforces on glosses for POST /translate. */
const GLOSS_PATTERN = /^[A-Z0-9#][A-Z0-9#'+.-]{0,39}$/;

/** Recognizer labels that differ from SignFlow's gloss conventions. */
const GLOSS_ALIASES: Readonly<Record<string, string>> = {
  THANKYOU: 'THANK-YOU',
};

/** The keyword model's non-sign class. The recognizer never sends it, but never trust that. */
const NON_SIGNS = new Set(['NOTHING']);

/** "thank you" / "THANKYOU" → "THANK-YOU". Returns null if it can't be a valid gloss. */
export function normalizeGloss(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const g = raw.trim().toUpperCase().replace(/[\s_]+/g, '-');
  const gloss = GLOSS_ALIASES[g] ?? g;
  if (!GLOSS_PATTERN.test(gloss) || NON_SIGNS.has(gloss)) return null;
  return gloss;
}

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Seconds → ms. A timestamp that isn't plausible for "just now" (a replayed
 * recording, a clock far off) is replaced by the receive time, so the app never
 * orders or ages signs by a bogus clock.
 */
export function toMillis(ts: unknown, now: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return now;
  const ms = Math.round(ts * 1000);
  return ms > now - 60_000 && ms < now + 5_000 ? ms : now;
}

function parseCandidates(raw: unknown): RecognizerAlternative[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > RECOGNIZER_MAX_CANDIDATES) return null;
  const out: RecognizerAlternative[] = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length !== 2 || !isProb(c[1])) return null;
    const gloss = normalizeGloss(c[0]);
    if (gloss) out.push({ gloss, confidence: c[1] });
  }
  return out;
}

const round = (p: number) => Math.round(p * 1000) / 1000;

/**
 * Validate and normalize one WebSocket message. Never throws; anything
 * malformed, oversized, or of an unknown type comes back as `{ ok: false }`.
 * The sign id is derived from the event (time + gloss), so a duplicate delivery
 * keeps its id and can be dropped (see RecognizerBridge).
 */
export function parseRecognizerMessage(text: unknown, now: number): ParseResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not a text message' };
  if (text.length > RECOGNIZER_MAX_PREVIEW_CHARS) return { ok: false, reason: 'message too large' };
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, reason: 'not an object' };
  const o = msg as Record<string, unknown>;
  if (o['type'] === 'preview') return parsePreview(o);
  if (text.length <= RECOGNIZER_MAX_MESSAGE_CHARS && o['type'] === 'camera') return parseCamera(o);
  // Only preview frames may be large.
  if (text.length > RECOGNIZER_MAX_MESSAGE_CHARS) return { ok: false, reason: 'message too large' };

  if (o['type'] === 'end_of_sentence') {
    const keyword = Array.isArray(o['confident']);
    return { ok: true, event: { type: 'sentence-end', ts: toMillis(o['ts'], now), model: keyword ? 'keyword116' : 'demo14' } };
  }
  if (o['type'] !== 'sign') return { ok: false, reason: `unknown type ${JSON.stringify(o['type'])?.slice(0, 40)}` };

  const candidates = parseCandidates(o['candidates']);
  if (!candidates) return { ok: false, reason: 'malformed candidates' };
  const ts = toMillis(o['ts'], now);

  let gloss: string | null;
  let confidence: number;
  let uncertain: boolean;
  let model: RecognizerModel;
  if (typeof o['top1'] === 'string' || typeof o['confident'] === 'boolean') {
    // Keyword model: top-1 plus the model's own "confident" flag.
    if (typeof o['confident'] !== 'boolean' || candidates.length === 0) return { ok: false, reason: 'malformed keyword sign' };
    gloss = normalizeGloss(o['top1']);
    const top = gloss ? candidates.find((c) => c.gloss === gloss) : undefined;
    if (!gloss || !top) return { ok: false, reason: 'top1 missing from candidates' };
    confidence = top.confidence;
    uncertain = !o['confident'];
    model = 'keyword116';
  } else {
    // 14-sign demo model: the recognizer only sends signs at or above its 0.5 threshold.
    gloss = normalizeGloss(o['sign']);
    if (!gloss || !isProb(o['confidence'])) return { ok: false, reason: 'malformed sign' };
    confidence = o['confidence'];
    uncertain = false;
    model = 'demo14';
  }

  const alternatives = candidates.filter((c) => c.gloss !== gloss).slice(0, 4).map((c) => ({ gloss: c.gloss, confidence: round(c.confidence) }));
  return {
    ok: true,
    event: {
      type: 'sign',
      sign: { id: `asl-${ts}-${gloss}`, gloss, confidence: round(confidence), ts, final: true, uncertain, alternatives, model },
    },
  };
}

// ---------- IPC (renderer → main) ----------

export interface RecognizerStartRequest {
  /** The 116-sign keyword model is allowed (the default); if false, its messages are refused. */
  allowKeyword: boolean;
}

export function validateRecognizerStart(value: unknown): RecognizerStartRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Recognizer start request must be an object');
  const allow = (value as Record<string, unknown>)['allowKeyword'];
  if (typeof allow !== 'boolean') throw new TypeError('allowKeyword must be a boolean');
  return { allowKeyword: allow };
}

/** Port override for tests (SIGNFLOW_RECOGNIZER_PORT); always loopback. */
export function recognizerPort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : RECOGNIZER_DEFAULT_PORT;
}
