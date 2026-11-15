/**
 * npm run kokoro:install            download + verify the Kokoro-82M model (~326 MB)
 * npm run kokoro:install -- --verify  only check what's installed (no network)
 * npm run kokoro:install -- --dir <folder>  install somewhere else (then set SIGNFLOW_KOKORO_MODELS)
 *
 * Downloads a pinned revision of onnx-community/Kokoro-82M-v1.0-ONNX from
 * Hugging Face, checks every file's size and SHA-256 against
 * src/shared/kokoro.ts, and only then moves it into place. Files that already
 * verify are skipped, so re-running is cheap and safe. Also checks the voice
 * files bundled in the kokoro-js npm package.
 *
 * The model never goes into git: it lives in the per-user app-data folder.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import {
  KOKORO_MODEL_BYTES,
  KOKORO_MODEL_DIRNAME,
  KOKORO_MODEL_FILES,
  KOKORO_MODEL_REPO,
  KOKORO_MODEL_REVISION,
  KOKORO_VOICE_SHA256,
  kokoroFileUrl,
  type KokoroModelFile,
} from '../src/shared/kokoro.ts';
import { argValue, defaultModelsRoot } from './kokoroPaths.mts';

const verifyOnly = process.argv.includes('--verify');
const root = argValue('--dir') ?? defaultModelsRoot();
const modelDir = join(root, KOKORO_MODEL_DIRNAME);
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function verified(path: string, file: { size: number; sha256: string }): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== file.size) return false;
  return (await sha256Of(path)) === file.sha256;
}

async function download(file: KokoroModelFile, dest: string): Promise<void> {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(kokoroFileUrl(file.path), { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.path}`);
  const hash = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  const started = Date.now();
  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (file.size > 5_000_000 && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      const rate = received / Math.max(1, (Date.now() - started) / 1000);
      process.stdout.write(`  ${file.path}: ${mb(received)} / ${mb(file.size)} (${mb(rate)}/s)\n`);
    }
  });
  await pipeline(body, createWriteStream(part));
  const digest = hash.digest('hex');
  if (received !== file.size || digest !== file.sha256) {
    rmSync(part, { force: true });
    throw new Error(
      `${file.path} failed verification (got ${received} bytes, sha256 ${digest}; expected ${file.size} bytes, ${file.sha256}). Nothing was installed for this file.`,
    );
  }
  renameSync(part, dest);
}

async function checkVoices(): Promise<boolean> {
  const voicesDir = join(dirname(fileURLToPath(import.meta.resolve('kokoro-js'))), '..', 'voices');
  let ok = true;
  for (const [voice, sha] of Object.entries(KOKORO_VOICE_SHA256)) {
    const path = join(voicesDir, `${voice}.bin`);
    const good = existsSync(path) && (await sha256Of(path)) === sha;
    console.log(`  ${good ? 'ok ' : 'BAD'} voice ${voice} (kokoro-js package)`);
    ok &&= good;
  }
  return ok;
}

async function main(): Promise<void> {
  console.log(`Kokoro-82M (${KOKORO_MODEL_REPO} @ ${KOKORO_MODEL_REVISION.slice(0, 7)}, Apache-2.0)`);
  console.log(`Model folder: ${modelDir}`);
  let missing = 0;
  for (const file of KOKORO_MODEL_FILES) {
    const dest = join(modelDir, file.path);
    if (await verified(dest, file)) {
      console.log(`  ok  ${file.path} (${mb(file.size)}, sha256 verified)`);
      continue;
    }
    if (verifyOnly) {
      console.log(`  --  ${file.path} missing or does not match`);
      missing++;
      continue;
    }
    console.log(`  ↓   ${file.path} (${mb(file.size)})`);
    await download(file, dest);
    console.log(`  ok  ${file.path} (sha256 verified)`);
  }
  const voicesOk = await checkVoices();
  if (missing > 0 || !voicesOk) {
    console.error(verifyOnly ? '\nNot installed. Run: npm run kokoro:install' : '\nVoice files in node_modules/kokoro-js do not match; run npm ci.');
    process.exit(1);
  }
  console.log(`\nKokoro is installed (${mb(KOKORO_MODEL_BYTES)}). Choose Settings › Speech › Kokoro in SignFlow.`);
  if (argValue('--dir')) console.log(`Custom folder: start SignFlow with SIGNFLOW_KOKORO_MODELS="${root}"`);
}

main().catch((err: unknown) => {
  console.error(`\nInstall failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
