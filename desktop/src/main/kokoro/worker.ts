/**
 * Entry point of the Kokoro utility process (Electron `utilityProcess`).
 *
 * Runs the model with ONNX Runtime's native CPU backend in its own Node
 * process, so loading and synthesis never block the app's main process or UI.
 * It talks only to the main process (parentPort) and never to the network.
 */
import { installNetworkGuard } from './networkGuard';
import { KokoroWorkerCore, type LoadTts, type Tts } from './workerCore';
import type { FromWorker, ToWorker } from './protocol';
import { KOKORO_DTYPE } from '@shared/kokoro';

const port = process.parentPort;
const send = (msg: FromWorker) => port.postMessage(msg);

installNetworkGuard((url) => send({ type: 'network-blocked', url }));

const loadTts: LoadTts = async (modelRoot, modelDirName, threads) => {
  const transformers = await import('@huggingface/transformers');
  const { env, StyleTextToSpeech2Model, AutoTokenizer } = transformers;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelRoot;
  env.useFSCache = false;
  env.useBrowserCache = false;
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelDirName, {
      dtype: KOKORO_DTYPE,
      device: 'cpu',
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    }),
    AutoTokenizer.from_pretrained(modelDirName),
  ]);
  return withoutForeignProcessHandlers(async () => {
    const { KokoroTTS } = await import('kokoro-js');
    // kokoro-js's constructor takes an already-loaded model and tokenizer; its
    // types only declare from_pretrained, which can't set threads or local paths.
    const Ctor = KokoroTTS as unknown as new (model: unknown, tokenizer: unknown) => Tts;
    const tts = new Ctor(model, tokenizer);
    // Warm-up: the first run pays one-time graph and phonemizer setup costs.
    await tts.generate('Ready.', { voice: 'af_heart', speed: 1 });
    return tts;
  });
};

/**
 * phonemizer's Emscripten runtime registers process-wide handlers that rethrow
 * every unhandled rejection, which would take this process down. Remove any
 * handler a library adds while `fn` runs; our own handling stays in charge.
 */
async function withoutForeignProcessHandlers<T>(fn: () => Promise<T>): Promise<T> {
  const exceptions = new Set(process.listeners('uncaughtException'));
  const rejections = new Set(process.listeners('unhandledRejection'));
  try {
    return await fn();
  } finally {
    for (const l of process.listeners('uncaughtException')) if (!exceptions.has(l)) process.removeListener('uncaughtException', l);
    for (const l of process.listeners('unhandledRejection')) if (!rejections.has(l)) process.removeListener('unhandledRejection', l);
  }
}

process.on('unhandledRejection', (err) => console.error('[kokoro] unhandled rejection', err));

const core = new KokoroWorkerCore(loadTts, send);
port.on('message', (event: { data: ToWorker }) => core.handle(event.data));
