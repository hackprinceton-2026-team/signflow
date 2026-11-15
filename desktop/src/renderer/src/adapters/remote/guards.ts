/**
 * Runtime checks for backend responses, typed against the generated contract.
 *
 * The renderer cannot use Ajv (it compiles validators with `new Function`, which
 * our CSP forbids), so these small guards validate what we rely on. The
 * `satisfies Record<…, true>` tables make TypeScript fail if the backend adds an
 * enum value, and contract tests check every schema example passes these guards.
 */
import type { Schema } from '../../contract';

export type TranslationRequest = Schema<'TranslationRequest'>;
export type TranslationResponse = Schema<'TranslationResponse'>;
export type SpeechRequest = Schema<'SpeechRequest'>;
export type SpeechResponse = Schema<'SpeechResponse'>;
export type HealthResponse = Schema<'HealthResponse'>;
export type ErrorResponse = Schema<'ErrorResponse'>;
export type TranslationMode = TranslationResponse['mode'];
export type ErrorCode = ErrorResponse['error']['code'];

const MODES = { chat: true, medical: true, emergency: true } satisfies Record<TranslationMode, true>;
const PROVIDER_STATUS = { ready: true, not_configured: true } satisfies Record<HealthResponse['translation'], true>;
const ERROR_CODES = {
  invalid_request: true,
  not_found: true,
  method_not_allowed: true,
  translation_unavailable: true,
  speech_unavailable: true,
  upstream_error: true,
  upstream_timeout: true,
  internal_error: true,
} satisfies Record<ErrorCode, true>;

export const TRANSLATION_MODES = Object.keys(MODES) as TranslationMode[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isTranslationMode(v: unknown): v is TranslationMode {
  return typeof v === 'string' && Object.hasOwn(MODES, v);
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.hasOwn(ERROR_CODES, v);
}

export function isTranslationResponse(v: unknown): v is TranslationResponse {
  return isObject(v) && isNonEmptyString(v['translated_text']) && isTranslationMode(v['mode']) && typeof v['model'] === 'string';
}

export function isSpeechResponse(v: unknown): v is SpeechResponse {
  return (
    isObject(v) &&
    isNonEmptyString(v['audio_base64']) &&
    (v['audio_format'] === undefined || v['audio_format'] === 'mp3') &&
    typeof v['voice_id'] === 'string'
  );
}

export function isHealthResponse(v: unknown): v is HealthResponse {
  return (
    isObject(v) &&
    (v['status'] === undefined || v['status'] === 'ok') &&
    typeof v['version'] === 'string' &&
    typeof v['model'] === 'string' &&
    typeof v['translation'] === 'string' &&
    Object.hasOwn(PROVIDER_STATUS, v['translation']) &&
    typeof v['speech'] === 'string' &&
    Object.hasOwn(PROVIDER_STATUS, v['speech'])
  );
}

/** Lenient on `code` (unknown future codes are still errors we can show). */
export function isErrorResponse(v: unknown): v is ErrorResponse {
  return isObject(v) && isObject(v['error']) && typeof v['error']['message'] === 'string' && typeof v['error']['code'] === 'string';
}
