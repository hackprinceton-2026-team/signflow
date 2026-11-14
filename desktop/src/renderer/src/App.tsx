import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import { createAdapters, isE2eRun } from './adapters';
import type { Adapters } from './adapters/types';
import { useCamera } from './hooks/useCamera';
import { useFrameSampler } from './hooks/useFrameSampler';
import { useSignSession } from './hooks/useSignSession';
import { useSpeech } from './hooks/useSpeech';
import { useNotes } from './hooks/useNotes';
import { usePersistentState } from './hooks/usePersistentState';
import { useCaptions } from './hooks/useCaptions';
import { lastUtterance, type SessionSettings, type Utterance } from './state/session';
import { CameraPanel } from './components/CameraPanel';
import { LiveSignsPanel } from './components/LiveSignsPanel';
import { DraftPanel } from './components/DraftPanel';
import { SpeechControls } from './components/SpeechControls';
import { TranscriptPanel } from './components/TranscriptPanel';
import { NotesPanel } from './components/NotesPanel';
import { isAppMode, ModeTabs, type AppMode } from './components/ModeTabs';
import { CaptionsPanel } from './components/CaptionsPanel';

interface AppProps {
  /** Injected in tests; defaults to the mock adapter set. */
  adapters?: Adapters;
  initialSettings?: Partial<SessionSettings>;
}

export function App({ adapters: injected, initialSettings }: AppProps) {
  const [adapters] = useState<Adapters>(() => injected ?? createAdapters('mock', { silentSpeech: isE2eRun() }));
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mirrored, setMirrored] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const camera = useCamera();
  const cameraOn = camera.status === 'on';
  const [mode, setMode] = usePersistentState<AppMode>('signflow.mode', 'conversation', isAppMode);
  const speech = useSpeech(adapters.speech);
  const notes = useNotes();
  const { speak } = speech;
  const { append: appendToNotes } = notes;
  const handleConfirm = useCallback(
    (utterance: Utterance, settings: SessionSettings) => {
      // Notes mode is silent note-taking; conversation mode speaks.
      if (mode === 'notes') appendToNotes(utterance.text, utterance.confirmedAt);
      else if (settings.autoSpeak) speak(utterance.text);
    },
    [appendToNotes, mode, speak],
  );
  const session = useSignSession(adapters, { active: cameraOn, initialSettings, onConfirm: handleConfirm });
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
  const captions = useCaptions(state);
  const confirmLabel = mode === 'notes' ? 'Add to notes' : state.settings.autoSpeak ? 'Confirm & speak' : 'Confirm';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✋
          </span>
          <h1>SignFlow</h1>
        </div>
        <div className="header-actions">
          <ModeTabs mode={mode} onChange={setMode} />
          <button
            type="button"
            className={`btn btn-sm ${captions.visible ? 'btn-primary' : ''}`}
            onClick={() => void captions.toggle()}
            aria-pressed={captions.visible}
            title="Floating captions window"
            data-testid="captions-toggle"
          >
            CC
          </button>
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
          <CaptionsPanel captions={captions} />
        </div>
        <div className="column">
          <DraftPanel
            draft={state.draft}
            status={state.draftStatus}
            error={state.draftError}
            threshold={state.settings.minConfidence}
            confirmLabel={confirmLabel}
            canRetry={state.buffer.length > 0}
            onEdit={session.editDraft}
            onConfirm={session.confirm}
            onDiscard={session.discardDraft}
            onPreview={speak}
            onRetry={session.translateNow}
            onDismissError={session.clearBuffer}
          />
          {mode === 'notes' ? (
            <NotesPanel notes={notes} />
          ) : (
            <>
              <SpeechControls
                speech={speech}
                autoSpeak={state.settings.autoSpeak}
                onAutoSpeakChange={(autoSpeak) => session.updateSettings({ autoSpeak })}
                lastText={lastUtterance(state)?.text}
              />
              <TranscriptPanel transcript={state.transcript} onSpeak={speak} onClear={session.clearTranscript} />
            </>
          )}
        </div>
      </main>

      <footer className="app-footer muted" data-testid="app-info">
        {info ? `${info.name} v${info.version} · Electron ${info.electron} · ${info.platform}` : 'Loading…'}
      </footer>
    </div>
  );
}
