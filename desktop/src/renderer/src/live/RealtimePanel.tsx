import type { SentenceComposer, SentenceItem, SpeechQueue } from '../hooks/useRealtime';
import type { CommMode } from '../state/realtime';
import { Button, Icon, Segmented, StatusPill } from '../ui';

const MODE_OPTIONS: { value: CommMode; label: string }[] = [
  { value: 'words', label: 'Words' },
  { value: 'sentence', label: 'Sentence (Gemini)' },
  { value: 'review', label: 'Review' },
];

const MODE_HINT: Record<CommMode, string> = {
  words: 'Each recognized sign is spoken right away as a word. No AI.',
  sentence: 'Gemini turns each signed sentence into English and speaks it.',
  review: 'You edit and confirm each sentence before anything is spoken.',
};

/** The mode switch, Stop, and the safety notice (always visible on Live). */
export function ModeBar({
  mode,
  onModeChange,
  busy,
  onStop,
}: {
  mode: CommMode;
  onModeChange: (mode: CommMode) => void;
  /** Speech is playing or queued, or a sentence is being composed. */
  busy: boolean;
  onStop: () => void;
}) {
  return (
    <div className="mode-bar" data-testid="mode-bar">
      <Segmented label="Mode" value={mode} options={MODE_OPTIONS} onChange={onModeChange} />
      <p className="mode-hint subtle">{MODE_HINT[mode]}</p>
      {mode !== 'review' && (
        <Button variant={busy ? 'primary' : 'secondary'} icon="stop" onClick={onStop} disabled={!busy} data-testid="realtime-stop">
          Stop speaking
        </Button>
      )}
      {mode !== 'review' && (
        <p className="mode-safety" role="note" data-testid="mode-safety">
          <Icon name="shield" size={14} /> Speaks automatically. Sign recognition isn&apos;t validated for medical or emergency use:
          use Review for anything important.
        </p>
      )}
    </div>
  );
}

const ms = (v: number | undefined) => (v === undefined ? '' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

/** Words mode: what is being said now, how fast, and what's waiting. */
export function WordsPanel({ queue }: { queue: SpeechQueue }) {
  const { current, last, queued, dropped } = queue;
  const shown = current ?? last;
  return (
    <div className="realtime-card" data-testid="words-panel" aria-live="polite">
      <span className="eyebrow">{current ? 'Speaking' : 'Last spoken'}</span>
      <p className="realtime-text" data-testid="words-text">
        {shown ? shown.text : 'Sign a word: it is spoken as soon as it is recognized.'}
      </p>
      <div className="realtime-meta">
        {shown?.latencyMs !== undefined && (
          <StatusPill tone="success" data-testid="words-latency" title="From the end of the sign to the start of the audio">
            {ms(shown.latencyMs)} sign → speech
          </StatusPill>
        )}
        {queued.length > 0 && (
          <span className="subtle" data-testid="words-queued">
            Next: {queued.map((q) => q.text).join(' ')}
          </span>
        )}
        {dropped > 0 && <span className="subtle">{dropped} skipped to keep up</span>}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<NonNullable<SentenceItem['source']>, { label: string; tone: 'accent' | 'neutral' | 'warning' }> = {
  gemini: { label: 'Gemini', tone: 'accent' },
  local: { label: 'Local (not AI)', tone: 'neutral' },
  'local-fallback': { label: 'Local fallback', tone: 'warning' },
};

/** Sentence mode: the signs being collected, the sentence being composed, and recent ones. */
export function SentencePanel({
  composer,
  pendingGlosses,
  onFinish,
}: {
  composer: SentenceComposer;
  /** Accepted signs waiting for the end of the sentence. */
  pendingGlosses: string[];
  onFinish: () => void;
}) {
  const [latest, ...older] = composer.items;
  return (
    <div className="realtime-card" data-testid="sentence-panel">
      <div className="realtime-row">
        <span className="eyebrow">Signing</span>
        <span className="realtime-glosses mono" data-testid="sentence-pending">
          {pendingGlosses.length ? pendingGlosses.join(' ') : '…'}
        </span>
        <Button size="sm" icon="check" onClick={onFinish} disabled={pendingGlosses.length === 0}>
          Finish sentence
        </Button>
      </div>
      {latest && <SentenceView item={latest} composer={composer} />}
      {older.length > 0 && (
        <ol className="realtime-history" aria-label="Earlier sentences">
          {older.slice(0, 3).map((it) => (
            <li key={it.id} className="subtle">
              {it.text ?? it.localText} <span className="mono">({it.glosses.join(' ')})</span>
              {it.source ? ` · ${SOURCE_LABEL[it.source].label}` : ''}
              {it.status === 'stopped' || it.status === 'discarded' ? ` · ${it.status}` : ''}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SentenceView({ item, composer }: { item: SentenceItem; composer: SentenceComposer }) {
  const source = item.source ? SOURCE_LABEL[item.source] : null;
  return (
    <div className={`realtime-sentence is-${item.status}`} data-testid="sentence-latest" data-status={item.status}>
      <div className="realtime-row">
        <span className="realtime-glosses mono" title="Signed glosses">
          {item.glosses.join(' ')}
        </span>
        <span aria-hidden="true">→</span>
        {source && (
          <StatusPill tone={source.tone} data-testid="sentence-source">
            {source.label}
            {item.source === 'gemini' && item.geminiMs !== undefined ? ` · ${ms(item.geminiMs)}` : ''}
          </StatusPill>
        )}
      </div>
      {item.status === 'composing' ? (
        <div className="realtime-row" role="status">
          <span className="ui-spinner" aria-hidden="true" />
          <span data-testid="sentence-status">{item.slow ? 'Gemini is taking longer than usual…' : 'Gemini is composing…'}</span>
          <Button size="sm" variant={item.slow ? 'primary' : 'secondary'} icon="speaker" onClick={() => composer.speakNow(item.id)}>
            Speak now: “{item.localText}”
          </Button>
        </div>
      ) : (
        <p className="realtime-text" data-testid="sentence-text">
          {item.text ?? item.localText}
        </p>
      )}
      {item.reason && item.status !== 'composing' && (
        <p className="subtle" data-testid="sentence-reason">
          {item.reason}
        </p>
      )}
      {item.status === 'review' && (
        <div className="realtime-review" role="alert" data-testid="sentence-review">
          <ul>
            {item.flags.map((f) => (
              <li key={f.code + f.message}>{f.message}</li>
            ))}
          </ul>
          <div className="realtime-row">
            <Button size="sm" variant="primary" icon="speaker" onClick={() => composer.resolveReview(item.id, 'gemini')}>
              Speak Gemini&apos;s sentence
            </Button>
            <Button size="sm" icon="speaker" onClick={() => composer.resolveReview(item.id, 'local')}>
              Speak “{item.localText}”
            </Button>
            <Button size="sm" variant="ghost" onClick={() => composer.resolveReview(item.id, 'discard')}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
