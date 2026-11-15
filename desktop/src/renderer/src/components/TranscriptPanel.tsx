import { useEffect, useRef } from 'react';
import type { Utterance } from '../state/session';
import { Button, Card, IconButton } from '../ui';

interface Props {
  transcript: Utterance[];
  onSpeak: (text: string) => void;
  onClear: () => void;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Confirmed sentences, oldest first. Only confirmed text can be replayed. */
export function TranscriptPanel({ transcript, onSpeak, onClear }: Props) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  return (
    <Card
      title="Conversation"
      className="transcript-card"
      actions={
        <Button size="sm" variant="ghost" onClick={onClear} disabled={transcript.length === 0}>
          Clear
        </Button>
      }
    >
      {transcript.length === 0 ? (
        <p className="empty-state">Confirmed sentences appear here.</p>
      ) : (
        <ol ref={listRef} className="transcript" aria-live="polite" aria-label="Confirmed sentences">
          {transcript.map((u) => (
            <li key={u.id} className="utterance" data-testid="utterance">
              <p className="utterance-text">{u.text}</p>
              <div className="utterance-meta">
                <time className="tabular" dateTime={new Date(u.confirmedAt).toISOString()}>
                  {formatTime(u.confirmedAt)}
                </time>
                {u.edited && <span className="tag">edited</span>}
                <IconButton icon="play" size="sm" label={`Speak: ${u.text}`} onClick={() => onSpeak(u.text)} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
