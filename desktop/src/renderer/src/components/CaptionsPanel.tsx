import { CAPTION_LIMITS } from '@shared/captions';
import type { CaptionsController } from '../hooks/useCaptions';

export function CaptionsPanel({ captions }: { captions: CaptionsController }) {
  const { settings, visible } = captions;
  return (
    <section className="panel captions-panel" aria-labelledby="captions-title">
      <div className="panel-head">
        <h2 id="captions-title" className="panel-title">
          Floating captions
        </h2>
        <button
          type="button"
          className={`btn btn-sm ${visible ? 'btn-primary' : ''}`}
          onClick={() => void captions.toggle()}
          aria-pressed={visible}
        >
          {visible ? 'Hide captions' : 'Show captions'}
        </button>
      </div>
      <div className="captions-grid">
        <label className="field">
          <span>
            Text size <span className="field-value">{settings.fontSize}px</span>
          </span>
          <input
            type="range"
            min={CAPTION_LIMITS.fontSize[0]}
            max={CAPTION_LIMITS.fontSize[1]}
            step={2}
            value={settings.fontSize}
            onChange={(e) => captions.update({ fontSize: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            Background <span className="field-value">{Math.round(settings.opacity * 100)}%</span>
          </span>
          <input
            type="range"
            min={CAPTION_LIMITS.opacity[0]}
            max={CAPTION_LIMITS.opacity[1]}
            step={0.05}
            value={settings.opacity}
            onChange={(e) => captions.update({ opacity: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Lines</span>
          <select value={settings.maxLines} onChange={(e) => captions.update({ maxLines: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle toggle-sm">
          <input
            type="checkbox"
            checked={settings.showLive}
            onChange={(e) => captions.update({ showLive: e.target.checked })}
          />
          <span>Show in-progress text</span>
        </label>
      </div>
      <p className="muted hint">Stays on top of other apps, including full-screen calls. Drag it anywhere.</p>
    </section>
  );
}
