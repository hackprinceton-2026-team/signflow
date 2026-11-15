import { useState } from 'react';
import { createAdapters, isE2eRun } from './adapters';
import type { BackendClient } from './adapters/remote/backendClient';
import type { Adapters } from './adapters/types';
import { AppShell } from './app/AppShell';
import { SignFlowProvider, useSignFlowController } from './app/useSignFlow';
import type { SessionSettings } from './state/session';

interface AppProps {
  /** Injected in tests; defaults to the mock adapter set. */
  adapters?: Adapters;
  /** Overrides persisted session settings (tests). */
  initialSettings?: Partial<SessionSettings>;
  /** Backend client for live mode (tests inject a fake). */
  backendClient?: BackendClient;
}

export function App({ adapters: injected, initialSettings, backendClient }: AppProps) {
  const [silentSpeech] = useState(isE2eRun);
  const [adapters] = useState<Adapters>(() => injected ?? createAdapters('mock', { silentSpeech }));
  const flow = useSignFlowController({ adapters, initialSettings, backendClient, silentSpeech });
  return (
    <SignFlowProvider value={flow}>
      <AppShell />
    </SignFlowProvider>
  );
}
