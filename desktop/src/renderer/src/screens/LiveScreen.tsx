import { useSignFlow } from '../app/useSignFlow';
import { CameraStage } from '../live/CameraStage';
import { ConnectedDraft } from '../live/ConnectedDraft';
import { SignTicker } from '../live/SignTicker';

/** Camera-first: the stage fills the screen; the phrase and draft float over it. */
export function LiveScreen() {
  const { camera, mirrored, setMirrored, session, feedback, recognition, updateRecognizerSettings } = useSignFlow();
  const { state } = session;
  return (
    <div className="live">
      <CameraStage
        camera={camera}
        mirrored={mirrored}
        onToggleMirror={() => setMirrored((m) => !m)}
        recognizerStatus={session.recognizerStatus}
        recognizerName={session.recognizerName}
        recognizerSimulated={session.recognizerSimulated}
        recognizerTakesVideo={session.recognizerTakesVideo}
        keepOverlays={state.draft !== null || state.draftStatus !== 'idle'}
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
          showRejected={recognition.external}
        />
        {/* The confirmation toast takes the hint's place while it's showing. */}
        <ConnectedDraft variant="stage" showHint={!feedback} />
      </CameraStage>
    </div>
  );
}
