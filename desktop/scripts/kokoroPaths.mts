import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The folder that holds `Kokoro-82M-v1.0-ONNX`. Must match `kokoroModelRoot()`
 * in src/main/kokoro/index.ts: SIGNFLOW_KOKORO_MODELS, else the per-OS
 * app-data folder (Electron's app.getPath('appData')) + SignFlow/models.
 */
export function defaultModelsRoot(): string {
  const override = process.env['SIGNFLOW_KOKORO_MODELS'];
  if (override) return override;
  const appData =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming')
        : process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(appData, 'SignFlow', 'models');
}

/** `--name value` from argv. */
export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
