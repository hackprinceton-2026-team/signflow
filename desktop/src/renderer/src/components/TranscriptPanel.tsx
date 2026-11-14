import { useEffect, useRef } from 'react';
import type { Utterance } from '../state/session';

interface Props {
  transcript: Utterance[];
  onSpeak: (text: string) => void;
  onClear: () => void;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function TranscriptPanel({ transcript, onSpeak, onClear }: Props) {
  const listRef = useRef<HTMLOListElement>(null);

  // Keep the newest sentence in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  return (
    <section className="panel transcript-panel" aria-labelledby="transcript-title">
      <div className="panel-head">
        <h2 id="transcript-title" className="panel-title">
          Conversation
        </h2>
        <button type="button" className="btn btn-sm" onClick={onClear} disabled={transcript.length === 0}>
          Clear
        </button>
      </div>
      {transcript.length === 0 ? (
        <p className="muted empty">Confirmed sentences appear here.</p>
      ) : (
        <ol ref={listRef} className="transcript" aria-live="polite" aria-label="Confirmed sentences">
          {transcript.map((u) => (
            <li key={u.id} className="utterance" data-testid="utterance">
              <div className="utterance-text">{u.text}</div>
              <div className="utterance-meta">
                <time dateTime={new Date(u.confirmedAt).toISOString()}>{formatTime(u.confirmedAt)}</time>
                {u.edited && <span className="pill pill-xs">edited</span>}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onSpeak(u.text)}
                  aria-label={`Speak: ${u.text}`}
                >
                  ▶
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
