/**
 * Typed access to the official backend/ML wire contract.
 *
 * Wire types are GENERATED from the backend's Pydantic models (see
 * desktop/contract/README.md). UI code keeps using the domain types in
 * ../adapters/types.ts; a codec in the future remote adapter maps wire
 * messages to them, so components and mock mode never depend on wire shapes.
 */
import type { components } from './generated/openapi';

export { CONTRACT_GENERATED, CONTRACT_OPENAPI_VERSION, CONTRACT_SOURCE_SHA256 } from './generated/openapi';

/** Every model name in the official contract (while the placeholder is committed, any name resolves to `never`). */
export type SchemaName = Extract<keyof components['schemas'], string>;

/** The generated TypeScript type for one official model, e.g. `Schema<'SignEvent'>`. */
export type Schema<N extends SchemaName> = components['schemas'][N];
