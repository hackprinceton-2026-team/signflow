/* eslint-disable */
/**
 * PLACEHOLDER: there is no official contract yet.
 *
 * The canonical wire schema comes from the backend's Pydantic models (owner:
 * Muhammad). `npm run contract:generate` replaces this file with types
 * generated from the official OpenAPI document. Do not hand-write wire types here.
 */

export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
  schemas: Record<string, never>;
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

/** True once types come from the official contract (false in the placeholder). */
export const CONTRACT_GENERATED = false as const;
export const CONTRACT_SOURCE_SHA256: string | null = null;
export const CONTRACT_OPENAPI_VERSION: string | null = null;
