// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIPBOARD_CHARS,
  MAX_EXPORT_CHARS,
  sanitizeFileName,
  toCameraAccessStatus,
  validateClipboardText,
  validateNotesExport,
} from './ipc';

describe('IPC payload validation', () => {
  it('normalizes camera status', () => {
    expect(toCameraAccessStatus('granted')).toBe('granted');
    expect(toCameraAccessStatus('bogus')).toBe('unknown');
    expect(toCameraAccessStatus(undefined)).toBe('unknown');
  });

  it('validates clipboard text', () => {
    expect(validateClipboardText('hello')).toBe('hello');
    expect(() => validateClipboardText(42)).toThrow(TypeError);
    expect(() => validateClipboardText({ toString: () => 'x' })).toThrow(TypeError);
    expect(() => validateClipboardText('x'.repeat(MAX_CLIPBOARD_CHARS + 1))).toThrow(RangeError);
  });

  it('validates export requests', () => {
    expect(validateNotesExport({ suggestedName: 'Lecture 1', content: '# Hi' })).toEqual({
      suggestedName: 'Lecture 1',
      content: '# Hi',
    });
    expect(() => validateNotesExport(null)).toThrow(TypeError);
    expect(() => validateNotesExport({ suggestedName: 'x', content: 5 })).toThrow(TypeError);
    expect(() => validateNotesExport({ suggestedName: 'x', content: 'x'.repeat(MAX_EXPORT_CHARS + 1) })).toThrow(
      RangeError,
    );
    expect(validateNotesExport({ content: 'ok' }).suggestedName).toBe('SignFlow notes');
  });

  it('sanitizes file names against traversal and reserved characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('-..-etc-passwd');
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFileName('  ...hidden  ')).toBe('hidden');
    expect(sanitizeFileName('line\nbreak\u0000')).toBe('linebreak');
    expect(sanitizeFileName('')).toBe('SignFlow notes');
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(80);
  });
});
