import { useState } from 'react';
import { createAdapters, isE2eRun } from './adapters';
import type { Adapters } from './adapters/types';
import { AppShell } from './app/AppShell';
import { SignFlowProvider, useSignFlowController } from './app/useSignFlow';
import type { SessionSettings } from './state/session';

interface AppProps {
  /** Injected in tests; defaults to the mock adapter set. */
  adapters?: Adapters;
  /** Overrides persisted session settings (tests). */
  initialSettings?: Partial<SessionSettings>;
}

export function App({ adapters: injected, initialSettings }: AppProps) {
  const [adapters] = useState<Adapters>(() => injected ?? createAdapters('mock', { silentSpeech: isE2eRun() }));
  const flow = useSignFlowController({ adapters, initialSettings });
  return (
    <SignFlowProvider value={flow}>
      <AppShell />
    </SignFlowProvider>
  );
}
