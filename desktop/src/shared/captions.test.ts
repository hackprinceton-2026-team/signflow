// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CAPTION_LIMITS,
  DEFAULT_CAPTION_SETTINGS,
  isCaptionSettings,
  sanitizeCaptionPayload,
  sanitizeCaptionSettings,
} from './captions';

describe('caption payload validation', () => {
  it('rejects non-objects and missing lines', () => {
    expect(() => sanitizeCaptionPayload(null)).toThrow(TypeError);
    expect(() => sanitizeCaptionPayload('hi')).toThrow(TypeError);
    expect(() => sanitizeCaptionPayload({ lines: 'nope' })).toThrow(TypeError);
  });

  it('clamps settings and falls back to defaults', () => {
    expect(sanitizeCaptionSettings({ fontSize: 500, opacity: -3, showLive: 'yes', maxLines: 99 })).toEqual({
      fontSize: CAPTION_LIMITS.fontSize[1],
      opacity: CAPTION_LIMITS.opacity[0],
      showLive: DEFAULT_CAPTION_SETTINGS.showLive,
      maxLines: CAPTION_LIMITS.maxLines[1],
    });
    expect(sanitizeCaptionSettings(undefined)).toEqual(DEFAULT_CAPTION_SETTINGS);
  });

  it('keeps only the last maxLines non-empty lines and clips long text', () => {
    const p = sanitizeCaptionPayload({
      lines: [{ id: 'a', text: 'one' }, { id: 'b', text: '  ' }, null, { id: 'c', text: 'two' }, { id: 'd', text: 'x'.repeat(5000) }],
      live: 42,
      settings: { ...DEFAULT_CAPTION_SETTINGS, maxLines: 2 },
    });
    expect(p.lines.map((l) => l.id)).toEqual(['c', 'd']);
    expect(p.lines[1]?.text).toHaveLength(CAPTION_LIMITS.textChars);
    expect(p.live).toBe('');
  });

  it('isCaptionSettings only accepts already-valid settings', () => {
    expect(isCaptionSettings(DEFAULT_CAPTION_SETTINGS)).toBe(true);
    expect(isCaptionSettings({ ...DEFAULT_CAPTION_SETTINGS, fontSize: 900 })).toBe(false);
    expect(isCaptionSettings(null)).toBe(false);
  });
});
