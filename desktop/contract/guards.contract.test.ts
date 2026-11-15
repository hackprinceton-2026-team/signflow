// @vitest-environment node
/**
 * The renderer validates backend responses with hand-written guards (Ajv can't
 * run under the renderer's CSP). These tests keep those guards honest against
 * the official schema: they must accept every schema example, reject what the
 * schema rejects for the fields we rely on, and know every enum value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isErrorResponse,
  isHealthResponse,
  isSpeechResponse,
  isTranslationResponse,
  TRANSLATION_MODES,
} from '../src/renderer/src/adapters/remote/guards';
import { contractSource, createValidator, DESKTOP_ROOT, inlineExamples, loadConfig, parseOpenApi } from './lib.mts';

const doc = parseOpenApi(readFileSync(resolve(DESKTOP_ROOT, contractSource(loadConfig())), 'utf8'));
const validate = createValidator(doc);
const GUARDS = {
  TranslationResponse: isTranslationResponse,
  SpeechResponse: isSpeechResponse,
  HealthResponse: isHealthResponse,
  ErrorResponse: isErrorResponse,
} as const;

describe('response guards vs. the official schema', () => {
  const examples = inlineExamples(doc).filter((e) => e.schema in GUARDS);

  it('has examples for every guarded response', () => {
    expect(new Set(examples.map((e) => e.schema))).toEqual(new Set(Object.keys(GUARDS)));
  });

  it.each(examples.map((e) => [`${e.schema}#${e.index}`, e] as const))('accepts schema example %s', (_n, e) => {
    expect(validate(e.schema, e.value).valid).toBe(true);
    expect(GUARDS[e.schema as keyof typeof GUARDS](e.value)).toBe(true);
  });

  const base = { translated_text: 'Hello.', mode: 'chat', model: 'm' };
  it.each([
    ['missing text', { mode: 'chat', model: 'm' }],
    ['empty text', { ...base, translated_text: '' }],
    ['unknown mode', { ...base, mode: 'poetry' }],
    ['text not a string', { ...base, translated_text: 42 }],
  ])('rejects a TranslationResponse with %s (as the schema does)', (_n, value) => {
    expect(validate('TranslationResponse', value).valid).toBe(false);
    expect(isTranslationResponse(value)).toBe(false);
  });

  it('rejects non-mp3 speech and empty audio (as the schema does)', () => {
    for (const value of [
      { audio_base64: 'AAA', audio_format: 'wav', voice_id: 'Joanna' },
      { audio_base64: '', audio_format: 'mp3', voice_id: 'Joanna' },
    ]) {
      expect(validate('SpeechResponse', value).valid).toBe(false);
      expect(isSpeechResponse(value)).toBe(false);
    }
  });

  it('knows exactly the translation modes the schema defines', () => {
    const schema = doc.components!.schemas!['TranslationRequest'] as unknown as { properties: { mode: { enum: string[] } } };
    expect([...TRANSLATION_MODES].sort()).toEqual([...schema.properties.mode.enum].sort());
  });
});
