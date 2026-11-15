import { useSignFlow } from '../app/useSignFlow';
import { CameraStage } from '../live/CameraStage';
import { ConnectedDraft } from '../live/ConnectedDraft';
import { ModeBar, SentencePanel, WordsPanel } from '../live/RealtimePanel';
import { SignTicker } from '../live/SignTicker';

/** Camera-first: the stage fills the screen; the phrase and draft (or spoken text) float over it. */
export function LiveScreen() {
  const { camera, mirrored, setMirrored, session, feedback, recognition, updateRecognizerSettings, realtime } = useSignFlow();
  const { state } = session;
  const { mode, queue, composer } = realtime;
  const busy = queue.current !== null || queue.queued.length > 0 || composer.composing;
  const realtimeOverlay = mode !== 'review' && (busy || composer.items.length > 0 || queue.last !== null);
  return (
    <div className="live">
      <ModeBar mode={mode} onModeChange={realtime.setMode} busy={busy} onStop={realtime.stop} />
      <CameraStage
        camera={camera}
        mirrored={mirrored}
        onToggleMirror={() => setMirrored((m) => !m)}
        recognizerStatus={session.recognizerStatus}
        recognizerName={session.recognizerName}
        recognizerSimulated={session.recognizerSimulated}
        recognizerTakesVideo={session.recognizerTakesVideo}
        keepOverlays={state.draft !== null || state.draftStatus !== 'idle' || realtimeOverlay}
        external={
          recognition.external
            ? {
                on: recognition.on,
                start: () => void recognition.start(),
                stop: recognition.stop,
                onUseDemo: () => updateRecognizerSettings({ source: 'demo' }),
              }
            : undefined
        }
      >
        <SignTicker
          buffer={state.buffer}
          latest={state.liveSigns[0]}
          threshold={state.settings.minConfidence}
          showRejected={recognition.external || mode !== 'review'}
        />
        {mode === 'words' ? (
          <WordsPanel queue={queue} />
        ) : mode === 'sentence' ? (
          <SentencePanel composer={composer} pendingGlosses={state.buffer.map((s) => s.gloss)} onFinish={realtime.finishSentence} />
        ) : (
          // The confirmation toast takes the hint's place while it's showing.
          <ConnectedDraft variant="stage" showHint={!feedback} />
        )}
      </CameraStage>
    </div>
  );
}
