/**
 * npm run contract:sync       → copy the backend's openapi.json into the pinned snapshot, then generate
 * npm run contract:generate   → write TS types from the pinned OpenAPI document
 * npm run contract:check      → fail if committed types are stale (CI-friendly)
 *
 * Source: contract/config.json "source", or SIGNFLOW_CONTRACT_SOURCE
 * (a file path, or e.g. http://localhost:8000/openapi.json).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { contractSource, contractUpstream, DESKTOP_ROOT, generateTypes, isUrl, loadConfig, parseOpenApi, readSourceText } from './lib.mts';

const command = process.argv[2];
const config = loadConfig();
const source = contractSource(config);
// SIGNFLOW_CONTRACT_OUTPUT exists for the tooling tests (never overwrite the real file there).
const output = resolve(DESKTOP_ROOT, process.env['SIGNFLOW_CONTRACT_OUTPUT'] || config.output);
const rel = (p: string) => (isUrl(p) ? p : relative(process.cwd(), p));

function noSource(): never {
  console.error(
    `No official contract found at ${rel(source)}.\n` +
      'The canonical schema comes from the backend Pydantic models (owner: Muhammad).\n' +
      'Until it exists, the app keeps running on mock adapters and the committed placeholder types.\n' +
      'Point SIGNFLOW_CONTRACT_SOURCE at a file or a running backend, e.g.\n' +
      '  SIGNFLOW_CONTRACT_SOURCE=http://localhost:8000/openapi.json npm run contract:generate',
  );
  process.exit(command === 'check' ? 0 : 1);
}

async function main(): Promise<void> {
  if (command !== 'generate' && command !== 'check' && command !== 'sync') {
    console.error('Usage: contract/cli.mts <sync|generate|check>');
    process.exit(2);
  }

  if (command === 'sync') {
    const upstream = contractUpstream(config);
    if (!upstream) throw new Error('No upstream configured (contract/config.json "upstream" or SIGNFLOW_CONTRACT_UPSTREAM)');
    if (isUrl(upstream)) {
      const text = await readSourceText(upstream);
      parseOpenApi(text); // refuse to pin something that isn't OpenAPI
      writeFileSync(source, text.endsWith('\n') ? text : `${text}\n`);
    } else {
      if (!existsSync(upstream)) throw new Error(`Upstream contract not found: ${rel(upstream)}`);
      parseOpenApi(readFileSync(upstream, 'utf8'));
      copyFileSync(upstream, source);
    }
    console.log(`✓ Pinned ${rel(source)} from ${rel(upstream)}`);
  }
  if (!isUrl(source) && !existsSync(source)) noSource();

  const generated = await generateTypes(await readSourceText(source));
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';

  if (command === 'check') {
    if (current === generated) {
      console.log(`✓ ${rel(output)} is up to date with ${rel(source)}`);
      return;
    }
    console.error(`✗ ${rel(output)} is stale. Run: npm run contract:generate`);
    process.exit(1);
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated);
  console.log(`✓ Wrote ${rel(output)} from ${rel(source)}${current === generated ? ' (unchanged)' : ''}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
