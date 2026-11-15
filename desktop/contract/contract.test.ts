// @vitest-environment node
/**
 * Contract tests against the OFFICIAL schema (backend Pydantic models →
 * backend/openapi.json → pinned copy at contract/openapi.json):
 *
 *  1. the pinned copy equals the backend's file whenever both are present
 *  2. committed TS types are regenerated from exactly the pinned schema
 *  3. every frontend concept is mapped to a real schema
 *  4. every example (embedded in the schema, or in examplesDir) validates
 *
 * Before an official schema existed these were skipped; the "no official
 * schema yet" block keeps that state honest if the pinned copy is removed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contractSource,
  contractUpstream,
  createValidator,
  DESKTOP_ROOT,
  generateTypes,
  inlineExamples,
  isUrl,
  listExamples,
  loadConfig,
  mappingProblems,
  parseOpenApi,
  resolveSource,
} from './lib.mts';

const config = loadConfig();
const source = contractSource(config);
const upstream = contractUpstream(config);
// Tests read local files only, never a live server, so they stay deterministic.
const hasOfficialSchema = !isUrl(source) && existsSync(source);
const hasUpstream = Boolean(upstream && !isUrl(upstream) && existsSync(upstream));
const outputPath = resolve(DESKTOP_ROOT, config.output);
const examplesDir = resolveSource(config.examplesDir);
const label = (p: string) => relative(DESKTOP_ROOT, p);

describe.skipIf(hasOfficialSchema)('contract: no official schema yet', () => {
  it('keeps the committed placeholder (no hand-written wire types)', () => {
    const committed = readFileSync(outputPath, 'utf8');
    expect(committed).toContain('PLACEHOLDER');
    expect(committed).toContain('export const CONTRACT_GENERATED = false as const;');
  });
});

describe.runIf(hasUpstream)('contract: pinned copy matches the backend', () => {
  it(`contract/openapi.json is identical to ${upstream ? label(upstream) : 'upstream'} (run: npm run contract:sync)`, () => {
    expect(readFileSync(source, 'utf8')).toBe(readFileSync(upstream!, 'utf8'));
  });
});

describe.runIf(hasOfficialSchema)(`contract: official schema (${label(source)})`, () => {
  const text = hasOfficialSchema ? readFileSync(source, 'utf8') : '{}';
  const doc = hasOfficialSchema ? parseOpenApi(text) : null;
  const validate = doc ? createValidator(doc) : null;
  const files = listExamples(examplesDir);
  const inline = doc ? inlineExamples(doc) : [];

  it('committed TypeScript types match the schema (run: npm run contract:generate)', async () => {
    expect(readFileSync(outputPath, 'utf8')).toBe(await generateTypes(text));
  });

  it('every frontend concept maps to a schema that exists (contract/config.json)', () => {
    expect(mappingProblems(config, doc!)).toEqual([]);
  });

  it('every required concept has at least one example payload', () => {
    const withExamples = new Set([...inline.map((e) => e.schema), ...files.filter((e) => e.expectValid).map((e) => e.schema)]);
    const missing = Object.entries(config.concepts)
      .filter(([, m]) => m.required && m.schema && !withExamples.has(m.schema))
      .map(([concept, m]) => `${concept} (${m.schema})`);
    expect(missing).toEqual([]);
  });

  it.each(inline.map((e) => [`${e.schema}#${e.index}`, e] as const))('embedded example %s validates', (_name, example) => {
    expect(validate!(example.schema, example.value).errors).toEqual([]);
  });

  it.each(files.map((e) => [label(e.file), e] as const))('example file %s', (_name, example) => {
    const result = validate!(example.schema, JSON.parse(readFileSync(example.file, 'utf8')));
    if (example.expectValid) expect(result.errors).toEqual([]);
    else expect(result.valid, 'invalid example was accepted').toBe(false);
  });
});
