import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import type { SignflowApi } from '@shared/api';
import { encodeKokoroError } from '@shared/kokoro';

// jsdom under a parallel full-suite run can be slow; 1s (the default) is tight.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => cleanup());

// The cloud voice turns audio into blob: URLs. jsdom has none, and Node's version
// rejects jsdom Blobs, so tests always use this stub.
Object.assign(URL, { createObjectURL: () => 'blob:signflow-test', revokeObjectURL: () => undefined });

/** A fake preload bridge so components can render outside Electron. */
export function installFakeBridge(overrides: Partial<SignflowApi> = {}): SignflowApi {
  const api: SignflowApi = {
    getAppInfo: vi.fn(async () => ({
      name: 'SignFlow',
      version: '0.1.0-test',
      platform: 'darwin',
      electron: '45.0.0',
      chrome: '140.0.0',
    })),
    camera: {
      accessStatus: vi.fn(async () => 'granted' as const),
      requestAccess: vi.fn(async () => 'granted' as const),
    },
    clipboard: { writeText: vi.fn(async () => undefined) },
    notes: { exportMarkdown: vi.fn(async () => ({ saved: true, fileName: 'notes.md' })) },
    captions: {
      setVisible: vi.fn(async (v: boolean) => v),
      update: vi.fn(),
      onVisibilityChange: vi.fn(() => () => undefined),
      getState: vi.fn(async () => ({
        lines: [],
        live: '',
        settings: { fontSize: 30, opacity: 0.75, showLive: true, maxLines: 2 },
      })),
      onRender: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    // Default: Kokoro isn't installed (tests that need it pass a FakeKokoro bridge).
    kokoro: {
      status: vi.fn(async () => ({ state: 'missing' as const, message: 'The Kokoro voice model is not installed.' })),
      prepare: vi.fn(async () => ({ state: 'missing' as const, message: 'The Kokoro voice model is not installed.' })),
      synthesize: vi.fn(async () => {
        throw new Error(encodeKokoroError('missing', 'The Kokoro voice model is not installed.'));
      }),
      cancel: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      onStatus: vi.fn(() => () => undefined),
    },
    view: {
      setFullScreen: vi.fn(async (v: boolean) => v),
      onFullScreenChange: vi.fn(() => () => undefined),
    },
    ...overrides,
  };
  Object.defineProperty(window, 'signflow', { value: api, configurable: true, writable: true });
  return api;
}
