/** Caption state streamed from the main window to the floating captions window. */

export interface CaptionLine {
  id: string;
  text: string;
}

export interface CaptionSettings {
  fontSize: number;
  /** Background opacity 0.2..1 */
  opacity: number;
  /** Show in-progress text (pending draft or current signs) below confirmed lines. */
  showLive: boolean;
  /** How many confirmed lines to keep on screen. */
  maxLines: number;
}

export interface CaptionPayload {
  lines: CaptionLine[];
  live: string;
  settings: CaptionSettings;
}

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  fontSize: 30,
  opacity: 0.75,
  showLive: true,
  maxLines: 2,
};

export const CAPTION_LIMITS = {
  fontSize: [16, 72],
  opacity: [0.2, 1],
  maxLines: [1, 5],
  textChars: 2000,
} as const;

const clamp = (v: unknown, [min, max]: readonly [number, number], fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const clipText = (v: unknown): string => (typeof v === 'string' ? v.slice(0, CAPTION_LIMITS.textChars) : '');

export function sanitizeCaptionSettings(value: unknown): CaptionSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_CAPTION_SETTINGS;
  return {
    fontSize: Math.round(clamp(v['fontSize'], CAPTION_LIMITS.fontSize, d.fontSize)),
    opacity: clamp(v['opacity'], CAPTION_LIMITS.opacity, d.opacity),
    showLive: typeof v['showLive'] === 'boolean' ? v['showLive'] : d.showLive,
    maxLines: Math.round(clamp(v['maxLines'], CAPTION_LIMITS.maxLines, d.maxLines)),
  };
}

/** Validate + normalize an untrusted payload from a renderer. Throws on wrong shape. */
export function sanitizeCaptionPayload(value: unknown): CaptionPayload {
  if (!value || typeof value !== 'object') throw new TypeError('Caption payload must be an object');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['lines'])) throw new TypeError('Caption lines must be an array');
  const settings = sanitizeCaptionSettings(v['settings']);
  const lines = v['lines']
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object')
    .map((l) => ({ id: clipText(l['id']).slice(0, 64), text: clipText(l['text']) }))
    .filter((l) => l.text.trim())
    .slice(-settings.maxLines);
  return { lines, live: clipText(v['live']), settings };
}

export function isCaptionSettings(value: unknown): value is CaptionSettings {
  if (!value || typeof value !== 'object') return false;
  const s = sanitizeCaptionSettings(value);
  const v = value as Record<string, unknown>;
  return (
    s.fontSize === v['fontSize'] && s.opacity === v['opacity'] && s.showLive === v['showLive'] && s.maxLines === v['maxLines']
  );
}

export const EMPTY_CAPTIONS: CaptionPayload = { lines: [], live: '', settings: DEFAULT_CAPTION_SETTINGS };
