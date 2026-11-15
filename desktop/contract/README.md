# Backend/ML contract → TypeScript

**Source of truth:** the canonical **Pydantic models** in `backend/` (originally written by Muhammad; maintained by Raimbek since 2026-11-14). The desktop app does not define wire types. It **generates** them from the OpenAPI document those models produce, and tests itself against that document.

```
backend/ Pydantic models ──► openapi.json ──► npm run contract:generate ──► src/renderer/src/contract/generated/openapi.ts
         (backend)           (committed)        (openapi-typescript)            (committed, never hand-edited)
                                   │
                                   └──► contract tests: drift check, concept mapping, example payloads
```

## Status

🟢 **Official schema pinned.** `contract/openapi.json` is a byte-for-byte copy of `backend/openapi.json` (backend PR `fix/backend-integration`), generated from the backend's Pydantic models. The TypeScript types in `src/renderer/src/contract/generated/openapi.ts` come from it.

- **Live mode** uses these types for `/health`, `/translate`, and `/speak`. Demo mode (mock adapters) is unchanged and needs no backend.
- **Recognition** is not served by the backend yet (`recognizedSign` is unmapped), so signs come from the demo recognizer in both modes.
- When `backend/openapi.json` is present (on `main`, after both PRs merge), the contract tests require the pinned copy to match it exactly.

### Updating the contract

```bash
npm run contract:sync                                   # copy ../backend/openapi.json → contract/openapi.json, regenerate types
SIGNFLOW_CONTRACT_UPSTREAM=http://localhost:8000/openapi.json npm run contract:sync   # from a running backend
```

Then fix any TypeScript errors: renamed or removed fields fail the typecheck, and new enum values fail the exhaustive guards in `adapters/remote/guards.ts`.

## Commands

```bash
npm run contract:generate          # writes generated/openapi.ts from `source`
npm run contract:check             # fails if generated types are stale (no-op until a schema exists)
SIGNFLOW_CONTRACT_SOURCE=http://localhost:8000/openapi.json npm run contract:generate   # from a running backend
```

`npm run check` includes `contract:check`.

## Using the generated types

```ts
import type { Schema } from '@renderer/contract';
type WireSign = Schema<'TheOfficialName'>; // exact generated type
```

UI components keep using the domain types in `src/renderer/src/adapters/types.ts`. When the schema lands, a `remote` adapter (WebSocket) gets a small **codec** that maps `Schema<...>` → domain types, registered in `createAdapters()`. Components, reducers, and mock mode don't change.

## Contract tests (`contract.test.ts`)

Once `source` exists they become a hard gate:

1. committed TS types are byte-for-byte what the schema generates
2. every required concept is mapped to a schema that exists
3. every required concept has an example, valid examples validate, and invalid ones are rejected

To rehearse against another config: `SIGNFLOW_CONTRACT_CONFIG=/path/to/config.json npx vitest run contract`.

## Security note

Validation uses Ajv, which compiles schemas with `new Function`. That only runs in **Node** (tests and CLI). The renderer's CSP forbids `unsafe-eval`, and that must stay. If runtime validation is ever needed in the app, use precompiled validators (Ajv standalone code generated at build time) or the hand-written codec. Do not relax the CSP.
