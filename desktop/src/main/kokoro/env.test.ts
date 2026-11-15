// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { workerEnv } from './env';

describe('workerEnv (Kokoro utility process)', () => {
  it('passes only the basics, never API keys or cloud credentials', () => {
    const env = workerEnv({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      TMPDIR: '/tmp/x',
      LANG: 'en_US.UTF-8',
      GOOGLE_API_KEY: 'secret',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      SIGNFLOW_E2E: '1',
    });
    expect(env).toEqual({ HOME: '/Users/me', PATH: '/usr/bin', TMPDIR: '/tmp/x', LANG: 'en_US.UTF-8' });
  });
});
