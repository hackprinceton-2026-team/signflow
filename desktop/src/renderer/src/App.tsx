import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import { createAdapters } from './adapters';
import type { Adapters } from './adapters/types';
import { useCamera } from './hooks/useCamera';
import { useFrameSampler } from './hooks/useFrameSampler';
import { useSignSession } from './hooks/useSignSession';
import type { SessionSettings } from './state/session';
import { CameraPanel } from './components/CameraPanel';
import { LiveSignsPanel } from './components/LiveSignsPanel';

interface AppProps {
  /** Injected in tests; defaults to the mock adapter set. */
  adapters?: Adapters;
  initialSettings?: Partial<SessionSettings>;
}

export function App({ adapters: injected, initialSettings }: AppProps) {
  const [adapters] = useState<Adapters>(() => injected ?? createAdapters('mock'));
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mirrored, setMirrored] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const camera = useCamera();
  const cameraOn = camera.status === 'on';
  const session = useSignSession(adapters, { active: cameraOn, initialSettings });
  useFrameSampler(videoRef, adapters.recognizer, cameraOn);

  useEffect(() => {
    let alive = true;
    window.signflow
      .getAppInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);

  const { state } = session;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✋
          </span>
          <h1>SignFlow</h1>
        </div>
      </header>

      <main className="app-main">
        <div className="column">
          <CameraPanel
            camera={camera}
            videoRef={videoRef}
            recognizerStatus={session.recognizerStatus}
            recognizerName={session.recognizerName}
            latestSign={state.liveSigns[0]}
            mirrored={mirrored}
            onToggleMirror={() => setMirrored((m) => !m)}
          />
          <LiveSignsPanel
            liveSigns={state.liveSigns}
            buffer={state.buffer}
            settings={state.settings}
            translating={state.draftStatus === 'translating'}
            onThresholdChange={(minConfidence) => session.updateSettings({ minConfidence })}
            onClearBuffer={session.clearBuffer}
            onTranslateNow={session.translateNow}
          />
        </div>
        <div className="column">
          <section className="panel" aria-label="Conversation">
            <h2 className="panel-title">English draft</h2>
            <p className="muted" data-testid="draft-preview">
              {state.draft ? state.draft.text : 'Drafts appear here after a pause in signing.'}
            </p>
          </section>
        </div>
      </main>

      <footer className="app-footer muted" data-testid="app-info">
        {info ? `${info.name} v${info.version} · Electron ${info.electron} · ${info.platform}` : 'Loading…'}
      </footer>
    </div>
  );
}
