# Backend/ML contract → TypeScript

**Source of truth:** Muhammad's canonical **Pydantic models** in `backend/`. The desktop app does not define wire types. It **generates** them from the OpenAPI document those models produce, and tests itself against that document.

```
backend/ Pydantic models ──► openapi.json ──► npm run contract:generate ──► src/renderer/src/contract/generated/openapi.ts
         (Muhammad)          (committed)        (openapi-typescript)            (committed, never hand-edited)
                                   │
                                   └──► contract tests: drift check, concept mapping, example payloads
```

## Status

🟡 **Waiting for the official schema.** Until it exists:

- the app runs on **mock adapters**, unchanged (`createAdapters('mock')`)
- `generated/openapi.ts` is a **placeholder** (`CONTRACT_GENERATED = false`) with no wire types
- the official contract tests are **skipped**; the tooling self-tests run against a synthetic fixture (`fixtures/tooling`, deliberately named `Tooling*`)

## What the frontend needs from the backend

1. **An OpenAPI 3.1 (or 3.0) JSON document** generated from the Pydantic models, committed at the shared path in `config.json` (`source`, proposed: `docs/contract/openapi.json`). It must include every model that crosses the wire under `components.schemas`, **including WebSocket messages**. FastAPI only puts models used by HTTP routes into `/openapi.json`, so WebSocket message models need to be added explicitly, e.g. a small export script using `pydantic.json_schema.models_json_schema(...)` with `ref_template="#/components/schemas/{model}"`.
2. **Example payloads** for each message: `<examplesDir>/<SchemaName>/*.json` (valid) and optionally `<SchemaName>/invalid/*.json` (must be rejected). Proposed `examplesDir`: `docs/contract/examples`.
3. **Names for the concepts below**, filled into `config.json` → `concepts.*.schema`:

| Concept             | Required | UI type it feeds   |
| ------------------- | -------- | ------------------ |
| `recognizedSign`    | yes      | `RecognizedSign`   |
| `englishDraft`      | yes      | `EnglishDraft`     |
| `errorMessage`      | no       | error banners      |
| `recognitionInput`  | no       | frame sampler      |
| `draftConfirmation` | no       | confirm action     |
| `sessionControl`    | no       | start/stop         |

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
