import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, utilityProcess } from 'electron';
import { IpcChannels } from '@shared/ipc';
import { validateKokoroRequestId, validateKokoroSynthesize, type KokoroStatus, type KokoroSynthesizeResult } from '@shared/kokoro';
import { checkModelFiles, KokoroService, type WorkerHandle } from './service';
import type { FromWorker } from './protocol';

/**
 * Where the model lives: `SIGNFLOW_KOKORO_MODELS` if set, otherwise
 * `~/Library/Application Support/SignFlow/models` (the per-OS app-data folder).
 * Deliberately not under userData, so E2E runs with a throwaway profile still
 * find an installed model. `npm run kokoro:install` uses the same rule.
 */
export function kokoroModelRoot(): string {
  return process.env['SIGNFLOW_KOKORO_MODELS'] || join(app.getPath('appData'), 'SignFlow', 'models');
}

/**
 * ONNX Runtime threads. On Apple Silicon, using only the performance cores is
 * fastest (measured on an M4: 4 threads ~25% faster than all 10 cores).
 */
function onnxThreads(): number {
  if (process.platform === 'darwin') {
    try {
      const p = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' }).trim());
      if (Number.isInteger(p) && p > 0) return Math.min(8, p);
    } catch {
      /* fall through */
    }
  }
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

function forkWorker(): WorkerHandle {
  const child = utilityProcess.fork(join(__dirname, 'kokoroWorker.js'), [], { serviceName: 'SignFlow Kokoro voice' });
  return {
    postMessage: (msg) => child.postMessage(msg),
    on: ((event: 'message' | 'exit', cb: (arg: never) => void) => {
      if (event === 'message') child.on('message', cb as (msg: FromWorker) => void);
      else child.on('exit', cb as (code: number) => void);
    }) as WorkerHandle['on'],
    kill: () => child.kill(),
  };
}

function broadcast(status: KokoroStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.kokoroStatusChanged, status);
  }
}

type Handle = <T>(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;

/** Create the service and register its IPC handlers (each validates sender and payload). */
export function registerKokoro(handle: Handle): KokoroService {
  const service = new KokoroService({
    modelRoot: kokoroModelRoot(),
    fork: forkWorker,
    checkModel: (dir) =>
      checkModelFiles(dir, (p) => {
        try {
          const s = statSync(p);
          return s.isFile() ? { size: s.size } : null;
        } catch {
          return null;
        }
      }),
    threads: onnxThreads(),
    onStatus: broadcast,
  });

  handle<KokoroStatus>(IpcChannels.kokoroStatus, () => service.status());
  handle<KokoroStatus>(IpcChannels.kokoroPrepare, () => service.prepare());
  handle<KokoroSynthesizeResult>(IpcChannels.kokoroSynthesize, (_event, request) => service.synthesize(validateKokoroSynthesize(request)));
  handle<void>(IpcChannels.kokoroCancel, (_event, ids) => {
    if (ids === undefined) service.cancel();
    else if (Array.isArray(ids) && ids.length <= 64) service.cancel(ids.map(validateKokoroRequestId));
    else throw new TypeError('Invalid Kokoro cancel request');
  });

  app.on('will-quit', () => service.dispose());
  return service;
}
