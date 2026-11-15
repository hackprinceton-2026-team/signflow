import { useEffect, useState } from 'react';
import { EMPTY_CAPTIONS, type CaptionPayload } from '@shared/captions';

/** The floating, always-on-top captions overlay. Renders whatever main sends. */
export function CaptionsApp() {
  const [caption, setCaption] = useState<CaptionPayload>(EMPTY_CAPTIONS);

  useEffect(() => {
    let alive = true;
    const off = window.signflow.captions.onRender((payload) => setCaption(payload));
    window.signflow.captions
      .getState()
      .then((payload) => alive && setCaption(payload))
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const { lines, live, settings } = caption;
  const showLive = settings.showLive && live.trim().length > 0;
  const empty = lines.length === 0 && !showLive;

  return (
    <div
      className="captions"
      style={{ fontSize: `${settings.fontSize}px`, backgroundColor: `rgba(8, 10, 14, ${settings.opacity})` }}
      data-testid="captions"
    >
      <div className="captions-chrome">
        <span className="captions-grip" aria-hidden="true">
          ⋮⋮ SignFlow captions
        </span>
        <button
          type="button"
          className="captions-close"
          onClick={() => window.signflow.captions.close()}
          aria-label="Close captions"
        >
          ×
        </button>
      </div>
      <div className="captions-body" role="log" aria-live="polite" aria-label="Live captions">
        {empty && <p className="caption-line caption-idle">Waiting for signs…</p>}
        {lines.map((line) => (
          <p key={line.id} className="caption-line" data-testid="caption-line">
            {line.text}
          </p>
        ))}
        {showLive && (
          <p className="caption-line caption-live" data-testid="caption-live">
            {live}
          </p>
        )}
      </div>
    </div>
  );
}
