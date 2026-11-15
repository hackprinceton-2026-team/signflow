/**
 * npm run kokoro:bench                 measure Kokoro on this machine (no audio)
 * npm run kokoro:bench -- --play       ...and play every clip through the speakers (macOS afplay)
 * npm run kokoro:bench -- --out <dir>  where to write the WAVs (default: a temp folder, never the repo)
 *
 * Uses the same settings as the app (fp32 model, performance-core threads,
 * silence trimming) in plain Node, with the network blocked. Reports cold
 * load, per-sentence synthesis time, real-time factor, a multi-sentence run,
 * and memory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeWav16, splitForSpeech, trimSilence } from '../src/shared/audio.ts';
import { KOKORO_DTYPE, KOKORO_MODEL_DIRNAME, KOKORO_VOICES, type KokoroVoiceId } from '../src/shared/kokoro.ts';
import { installNetworkGuard } from '../src/main/kokoro/networkGuard.ts';
import { argValue, defaultModelsRoot } from './kokoroPaths.mts';

const PHRASES = [
  'This is how SignFlow will sound.',
  'I am allergic to penicillin.',
  'I have never smoked.',
  "My doctor's appointment is tomorrow at three.",
];
const SEVERAL = 'Hello. My name is Sam. I am deaf. I am allergic to penicillin. Please write it down. Thank you.';

const play = process.argv.includes('--play');
const out = argValue('--out') ?? join(tmpdir(), 'signflow-kokoro-bench');
const root = defaultModelsRoot();
const mbRss = () => Math.round(process.memoryUsage().rss / 1_000_000);

function threads(): number {
  try {
    const p = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' }).trim());
    if (Number.isInteger(p) && p > 0) return Math.min(8, p);
  } catch {
    /* not macOS */
  }
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

type Tts = { generate(text: string, o: { voice: KokoroVoiceId; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };

installNetworkGuard((url) => console.error(`blocked network request: ${url}`));
mkdirSync(out, { recursive: true });
const rss0 = mbRss();
const t0 = performance.now();
const T = await import('@huggingface/transformers');
T.env.allowRemoteModels = false;
T.env.localModelPath = `${root}/`;
T.env.useFSCache = false;
const [model, tokenizer] = await Promise.all([
  T.StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL_DIRNAME, {
    dtype: KOKORO_DTYPE,
    device: 'cpu',
    session_options: { intraOpNumThreads: threads(), interOpNumThreads: 1 },
  }),
  T.AutoTokenizer.from_pretrained(KOKORO_MODEL_DIRNAME),
]);
const { KokoroTTS } = await import('kokoro-js');
const tts = new (KokoroTTS as unknown as new (m: unknown, t: unknown) => Tts)(model, tokenizer);
const loadMs = performance.now() - t0;
const w0 = performance.now();
await tts.generate('Ready.', { voice: 'af_heart', speed: 1 });
const warmupMs = performance.now() - w0;
console.log(`Model: ${root}/${KOKORO_MODEL_DIRNAME} (${KOKORO_DTYPE}), ${threads()} threads`);
console.log(`Cold load ${loadMs.toFixed(0)} ms + first-run warm-up ${warmupMs.toFixed(0)} ms; RSS ${rss0} → ${mbRss()} MB\n`);

async function synth(text: string, voice: KokoroVoiceId) {
  const s = performance.now();
  const raw = await tts.generate(text, { voice, speed: 1 });
  const ms = performance.now() - s;
  const trimmed = trimSilence(raw.audio, raw.sampling_rate);
  return { ms, rawS: raw.audio.length / raw.sampling_rate, audioS: trimmed.length / raw.sampling_rate, wav: encodeWav16(trimmed, raw.sampling_rate) };
}

console.log('voice       phrase                                           synth   audio  RTF');
for (const v of KOKORO_VOICES) {
  for (const [i, text] of PHRASES.entries()) {
    const r = await synth(text, v.id);
    const file = join(out, `${v.id}_${i + 1}.wav`);
    writeFileSync(file, r.wav);
    console.log(
      `${v.id.padEnd(11)} ${JSON.stringify(text).padEnd(48)} ${r.ms.toFixed(0).padStart(5)} ms ${r.audioS.toFixed(2)} s  ${(r.ms / 1000 / r.audioS).toFixed(2)}`,
    );
    if (play) execFileSync('/usr/bin/afplay', [file]);
  }
}

// Several short sentences, the way the app runs them: each sentence is
// synthesized in order; playback of sentence 1 starts as soon as it's ready.
const chunks = splitForSpeech(SEVERAL);
const s0 = performance.now();
let firstReady = 0;
let audioTotal = 0;
const times: number[] = [];
for (const [i, c] of chunks.entries()) {
  const r = await synth(c, 'af_heart');
  if (i === 0) firstReady = performance.now() - s0;
  audioTotal += r.audioS;
  times.push(Math.round(r.ms));
}
const all = performance.now() - s0;
console.log(
  `\n${chunks.length} short sentences (${SEVERAL.length} chars): first audio ready after ${firstReady.toFixed(0)} ms, all synthesized in ${all.toFixed(0)} ms for ${audioTotal.toFixed(2)} s of audio (per sentence: ${times.join(', ')} ms)`,
);
console.log(`Peak RSS ${mbRss()} MB. WAVs in ${out}`);
