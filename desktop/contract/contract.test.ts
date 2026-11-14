// @vitest-environment node
/**
 * Contract tests against the OFFICIAL schema (backend Pydantic models →
 * OpenAPI). They are skipped until that document exists at the configured
 * `source` (contract/config.json), then become a hard gate:
 *
 *  1. committed TS types are regenerated from exactly this schema
 *  2. every frontend concept is mapped to a real schema
 *  3. official example payloads validate (and invalid ones are rejected)
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contractSource,
  createValidator,
  DESKTOP_ROOT,
  generateTypes,
  isUrl,
  listExamples,
  loadConfig,
  mappingProblems,
  parseOpenApi,
  resolveSource,
} from './lib.mts';

const config = loadConfig();
const source = contractSource(config);
// Tests read a local file only, never a live server, so they stay deterministic.
const hasOfficialSchema = !isUrl(source) && existsSync(source);
const outputPath = resolve(DESKTOP_ROOT, config.output);
const examplesDir = resolveSource(config.examplesDir);
const label = (p: string) => relative(DESKTOP_ROOT, p);

describe.skipIf(hasOfficialSchema)('contract: no official schema yet', () => {
  it('keeps the committed placeholder (no hand-written wire types)', () => {
    const committed = readFileSync(outputPath, 'utf8');
    expect(committed).toContain('PLACEHOLDER');
    expect(committed).toContain('export const CONTRACT_GENERATED = false as const;');
  });

  it('leaves every concept unmapped until the official names are known', () => {
    for (const [concept, m] of Object.entries(config.concepts)) {
      expect(m.schema, `${concept} is mapped but there is no official schema`).toBeNull();
    }
  });
});

describe.runIf(hasOfficialSchema)(`contract: official schema (${label(source)})`, () => {
  const text = hasOfficialSchema ? readFileSync(source, 'utf8') : '{}';
  const doc = hasOfficialSchema ? parseOpenApi(text) : null;
  const validate = doc ? createValidator(doc) : null;
  const examples = listExamples(examplesDir);

  it('committed TypeScript types match the schema (run: npm run contract:generate)', async () => {
    expect(readFileSync(outputPath, 'utf8')).toBe(await generateTypes(text));
  });

  it('every frontend concept maps to a schema that exists (contract/config.json)', () => {
    expect(mappingProblems(config, doc!)).toEqual([]);
  });

  it('every required concept has at least one official example payload', () => {
    const withExamples = new Set(examples.filter((e) => e.expectValid).map((e) => e.schema));
    const missing = Object.entries(config.concepts)
      .filter(([, m]) => m.required && m.schema && !withExamples.has(m.schema))
      .map(([concept, m]) => `${concept} (${m.schema}) → add ${label(resolve(examplesDir, m.schema!))}/*.json`);
    expect(missing).toEqual([]);
  });

  it.each(examples.map((e) => [label(e.file), e] as const))('example %s', (_name, example) => {
    const result = validate!(example.schema, JSON.parse(readFileSync(example.file, 'utf8')));
    if (example.expectValid) expect(result.errors).toEqual([]);
    else expect(result.valid, 'invalid example was accepted').toBe(false);
  });
});
