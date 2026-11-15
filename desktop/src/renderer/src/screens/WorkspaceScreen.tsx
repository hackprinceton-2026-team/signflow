import { useSignFlow } from '../app/useSignFlow';
import { LiveSignsPanel } from '../components/LiveSignsPanel';
import { SpeechTransport } from '../components/SpeechTransport';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { CameraView } from '../live/CameraView';
import { ConnectedDraft } from '../live/ConnectedDraft';
import { Card, Icon, StatusPill } from '../ui';
import { lastUtterance } from '../state/session';

/** Recognition details, conversation history, and playback. */
export function WorkspaceScreen() {
  const { camera, cameraOn, mirrored, session, speech, updateSettings } = useSignFlow();
  const { state } = session;

  return (
    <div className="workspace">
      <div className="workspace-scroll">
        <div className="workspace-grid">
        <LiveSignsPanel
          liveSigns={state.liveSigns}
          buffer={state.buffer}
          settings={state.settings}
          translating={state.draftStatus === 'translating'}
          onThresholdChange={(minConfidence) => updateSettings({ minConfidence })}
          onClearBuffer={session.clearBuffer}
          onTranslateNow={session.translateNow}
        />
        <div className="workspace-side">
          <Card
            title="Camera"
            className="mini-camera-card"
            actions={
              <StatusPill tone={cameraOn ? 'live' : 'neutral'} pulse={cameraOn}>
                {cameraOn ? 'Live' : 'Off'}
              </StatusPill>
            }
          >
            <div className="mini-camera">
              {cameraOn ? (
                <CameraView stream={camera.stream} mirrored={mirrored} label="Camera preview (small)" />
              ) : (
                <div className="mini-camera-off">
                  <Icon name="cameraOff" size={20} />
                  <span>Start the camera from Live</span>
                </div>
              )}
            </div>
          </Card>
          <TranscriptPanel transcript={state.transcript} onSpeak={speech.speak} onClear={session.clearTranscript} />
          <SpeechTransport speech={speech} lastText={lastUtterance(state)?.text} />
        </div>
        </div>
      </div>
      <div className="dock">
        <ConnectedDraft variant="dock" />
      </div>
    </div>
  );
}
