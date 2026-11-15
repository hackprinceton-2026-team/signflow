// @vitest-environment node
/**
 * Self-tests for the contract tooling, run against a synthetic fixture
 * (contract/fixtures/tooling, NOT the SignFlow schema). They prove that
 * generation, type-checking, validation, and drift detection work before the
 * official Pydantic-derived schema exists.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createValidator,
  DESKTOP_ROOT,
  generateTypes,
  listExamples,
  mappingProblems,
  parseOpenApi,
  type ContractConfig,
} from './lib.mts';

const FIXTURES = join(DESKTOP_ROOT, 'contract', 'fixtures', 'tooling');
const spec31 = readFileSync(join(FIXTURES, 'openapi-3.1.json'), 'utf8');
const spec30 = readFileSync(join(FIXTURES, 'openapi-3.0.json'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'signflow-contract-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Type-check `files` with the project's strict settings; returns diagnostics as text. */
function typecheck(files: Record<string, string>): string[] {
  const paths = Object.entries(files).map(([name, text]) => {
    const p = join(tmp, name);
    writeFileSync(p, text);
    return p;
  });
  const program = ts.createProgram(paths, {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file ? d.file.fileName.split('/').pop() : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('parseOpenApi', () => {
  it('accepts OpenAPI 3.0 and 3.1 documents', () => {
    expect(parseOpenApi(spec31).openapi).toBe('3.1.0');
    expect(parseOpenApi(spec30).openapi).toBe('3.0.3');
  });

  it('rejects non-JSON, non-OpenAPI, and unsupported versions with clear errors', () => {
    expect(() => parseOpenApi('{nope')).toThrow(/not valid JSON/);
    expect(() => parseOpenApi('{"type":"object"}')).toThrow(/not an OpenAPI document/);
    expect(() => parseOpenApi('{"openapi":"2.0"}')).toThrow(/Unsupported OpenAPI version/);
  });
});

describe('generateTypes', () => {
  it('is deterministic and stamps the source hash', async () => {
    const a = await generateTypes(spec31);
    const b = await generateTypes(spec31);
    expect(a).toBe(b);
    expect(a).toContain('AUTO-GENERATED');
    expect(a).toContain('export const CONTRACT_GENERATED = true as const;');
    expect(a).toMatch(/CONTRACT_SOURCE_SHA256 = '[0-9a-f]{64}'/);
    expect(await generateTypes(spec31.replace('"first"', '"second"'))).toBe(a); // fixture text not in schema
    expect(await generateTypes(spec31.replace('Tooling fixture', 'Tooling fixture v2'))).not.toBe(a);
  });

  it('maps Pydantic-style schemas to precise TypeScript types that compile under strict mode', async () => {
    const generated = await generateTypes(spec31);
    const usage = `
      import type { components } from './gen31';
      type S = components['schemas'];

      export const ok: S['ToolingWidget'] = {
        id: 'x', label: 'l', score: 0.5, kind: 'alpha', note: null, created_at: '2026-01-01T00:00:00Z',
      };
      // @ts-expect-error score must be a number
      export const badScore: S['ToolingWidget'] = { ...ok, score: 'high' };
      // @ts-expect-error kind is a closed enum
      export const badKind: S['ToolingWidget'] = { ...ok, kind: 'gamma' };
      // @ts-expect-error label is required
      export const missing: S['ToolingWidget'] = { id: 'x', score: 1, kind: 'beta', created_at: 'x' };

      // Discriminated unions narrow on the literal tag.
      export function describe(e: S['ToolingEvent']): string {
        return e.type === 'pong' ? e.widget.label : String(e.seq);
      }
    `;
    expect(typecheck({ 'gen31.ts': generated, 'usage31.ts': usage })).toEqual([]);
  });

  it('handles OpenAPI 3.0 nullable', async () => {
    const usage = `
      import type { components } from './gen30';
      export const a: components['schemas']['ToolingLegacy'] = { id: 'x', note: null };
      // @ts-expect-error note is required (nullable, not optional)
      export const b: components['schemas']['ToolingLegacy'] = { id: 'x' };
    `;
    expect(typecheck({ 'gen30.ts': await generateTypes(spec30), 'usage30.ts': usage })).toEqual([]);
  });
});

describe('createValidator', () => {
  const validate31 = createValidator(parseOpenApi(spec31));

  it('accepts valid payloads, including refs, nulls, formats, and discriminated unions', () => {
    const widget = JSON.parse(readFileSync(join(FIXTURES, 'examples/ToolingWidget/basic.json'), 'utf8'));
    expect(validate31('ToolingWidget', widget)).toEqual({ valid: true, errors: [] });
    expect(validate31('ToolingEvent', { type: 'pong', widget }).valid).toBe(true);
    expect(validate31('ToolingEvent', { type: 'ping', seq: 3 }).valid).toBe(true);
  });

  it('rejects wrong payloads with readable errors', () => {
    const r = validate31('ToolingWidget', { id: 'not-a-uuid', label: '', score: 2, kind: 'gamma' });
    expect(r.valid).toBe(false);
    expect(r.errors.join('\n')).toMatch(/created_at/);
    expect(r.errors.join('\n')).toMatch(/\/score must be <= 1/);
    expect(r.errors.join('\n')).toMatch(/\/id must match format "uuid"/);
    expect(validate31('ToolingEvent', { type: 'ping' }).valid).toBe(false);
    expect(validate31('ToolingEvent', { type: 'other', seq: 1 }).valid).toBe(false);
  });

  it('reports unknown schema names', () => {
    expect(validate31('Nope', {}).errors[0]).toMatch(/does not exist/);
  });

  it('supports OpenAPI 3.0 nullable', () => {
    const v = createValidator(parseOpenApi(spec30));
    expect(v('ToolingLegacy', { id: 'x', note: null }).valid).toBe(true);
    expect(v('ToolingLegacy', { id: 'x', note: 5 }).valid).toBe(false);
  });
});

describe('examples and concept mapping', () => {
  it('discovers valid and invalid example files per schema', () => {
    const found = listExamples(join(FIXTURES, 'examples')).map((e) => [e.schema, e.file.split('/').pop(), e.expectValid]);
    expect(found).toEqual([
      ['ToolingEvent', 'ping.json', true],
      ['ToolingWidget', 'basic.json', true],
      ['ToolingWidget', 'score-out-of-range.json', false],
    ]);
    expect(listExamples(join(tmp, 'missing'))).toEqual([]);
  });

  it('flags unmapped required concepts and mappings to missing schemas', () => {
    const config: ContractConfig = {
      source: '',
      examplesDir: '',
      output: '',
      concepts: {
        a: { schema: null, required: true, description: '' },
        b: { schema: null, required: false, description: '' },
        c: { schema: 'ToolingWidget', required: true, description: '' },
        d: { schema: 'Missing', required: false, description: '' },
      },
    };
    expect(mappingProblems(config, parseOpenApi(spec31))).toEqual([
      '"a" is required but not mapped to a schema in contract/config.json',
      '"d" maps to "Missing", which is not in components.schemas',
    ]);
  });
});

describe('contract CLI', () => {
  const cli = join(DESKTOP_ROOT, 'contract', 'cli.mts');
  const run = (cmd: string, env: Record<string, string>) => {
    try {
      const out = execFileSync(process.execPath, [cli, cmd], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  // Spawns Node three times; allow for a busy machine running the suite in parallel.
  it('generate → check passes → source changes → check fails', { timeout: 30_000 }, () => {
    const source = join(tmp, 'openapi.json');
    const output = join(tmp, 'out', 'openapi.ts');
    writeFileSync(source, spec31);
    const env = { SIGNFLOW_CONTRACT_SOURCE: source, SIGNFLOW_CONTRACT_OUTPUT: output };

    expect(run('generate', env).code).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('ToolingWidget');
    expect(run('check', env)).toMatchObject({ code: 0, out: expect.stringContaining('up to date') });

    writeFileSync(source, spec31.replace('"Label"', '"Label (renamed)"'));
    expect(run('check', env)).toMatchObject({ code: 1, out: expect.stringContaining('stale') });
  });

  it('without an official schema: generate explains and fails, check is a no-op', { timeout: 30_000 }, () => {
    const env = { SIGNFLOW_CONTRACT_SOURCE: join(tmp, 'absent.json'), SIGNFLOW_CONTRACT_OUTPUT: join(tmp, 'x.ts') };
    expect(run('generate', env)).toMatchObject({ code: 1, out: expect.stringContaining('No official contract') });
    expect(run('check', env).code).toBe(0);
  });
});
