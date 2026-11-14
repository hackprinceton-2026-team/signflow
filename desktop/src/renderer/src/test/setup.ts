import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { SignflowApi } from '@shared/api';

afterEach(() => cleanup());

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
    ...overrides,
  };
  Object.defineProperty(window, 'signflow', { value: api, configurable: true, writable: true });
  return api;
}
