import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

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
        <section className="panel" aria-label="Camera">
          <h2 className="panel-title">Camera</h2>
          <p className="muted">Webcam preview arrives in the next milestone.</p>
        </section>
        <section className="panel" aria-label="Conversation">
          <h2 className="panel-title">Conversation</h2>
          <p className="muted">Recognized signs and the English draft will appear here.</p>
        </section>
      </main>

      <footer className="app-footer muted" data-testid="app-info">
        {info ? `${info.name} v${info.version} · Electron ${info.electron} · ${info.platform}` : 'Loading…'}
      </footer>
    </div>
  );
}
