import { useCallback, useEffect, useState } from 'react';
import { CameraView } from '../live/CameraView';
import { ConfirmToast } from '../live/ConfirmToast';
import { NoticeToast } from '../live/NoticeToast';
import { LiveScreen } from '../screens/LiveScreen';
import { NotesScreen } from '../screens/NotesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { WorkspaceScreen } from '../screens/WorkspaceScreen';
import { IconButton, Kbd } from '../ui';
import { shortcutLabel } from '../ui/Kbd';
import { NavRail } from './NavRail';
import type { ScreenId } from './screens';
import { TopBar } from './TopBar';
import { useHotkeys } from './useHotkeys';
import { useIdle } from './useIdle';
import { useSignFlow } from './useSignFlow';

/** Rail + top bar + the active screen, plus distraction-free Focus Mode. */
export function AppShell() {
  const flow = useSignFlow();
  const [screen, setScreen] = useState<ScreenId>('live');
  const [focus, setFocus] = useState(false);
  const [focusHint, setFocusHint] = useState(0);
  const idle = useIdle(focus);

  const enterFocus = useCallback(() => {
    setScreen('live');
    setFocus(true);
    setFocusHint((n) => n + 1);
    window.signflow.view.setFullScreen(true).catch(() => undefined);
  }, []);

  const exitFocus = useCallback(() => {
    setFocus(false);
    window.signflow.view.setFullScreen(false).catch(() => undefined);
  }, []);

  // Leaving fullscreen through the OS (green button, ⌃⌘F) also leaves Focus Mode.
  useEffect(
    () =>
      window.signflow.view.onFullScreenChange((fullScreen) => {
        if (!fullScreen) setFocus(false);
      }),
    [],
  );

  useEffect(() => {
    if (!focusHint) return;
    const t = setTimeout(() => setFocusHint(0), 2800);
    return () => clearTimeout(t);
  }, [focusHint]);

  const { session, draftTextRef, confirmDraft, speakDraft, discardDraft, captions, speech } = flow;
  const hasDraft = session.state.draft !== null;
  const hasText = Boolean(session.state.draft?.text.trim());

  useHotkeys({
    live: () => setScreen('live'),
    workspace: () => (focus ? false : setScreen('workspace')),
    notes: () => (focus ? false : setScreen('notes')),
    settings: () => (focus ? false : setScreen('settings')),
    focus: () => (focus ? exitFocus() : enterFocus()),
    exitFocus: () => (focus ? exitFocus() : false),
    confirm: () => (hasText ? confirmDraft() : false),
    speak: () => (hasText && speech.available ? speakDraft() : false),
    discard: () => (hasDraft ? discardDraft() : false),
    edit: () => {
      if (!hasDraft) return false;
      const focusText = () => {
        const el = draftTextRef.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      };
      if (draftTextRef.current) focusText();
      else {
        setScreen('live'); // Settings has no draft; bring it into view first
        requestAnimationFrame(focusText);
      }
    },
    captions: () => void captions.toggle(),
  });

  return (
    <div
      className={`shell ${focus ? 'is-focus' : ''} ${idle ? 'is-idle' : ''}`}
      data-screen={screen}
      data-focus={focus || undefined}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {!focus && <NavRail screen={screen} onSelect={setScreen} />}
      <div className="shell-main">
        {!focus && <TopBar screen={screen} onEnterFocus={enterFocus} />}
        <main id="main" className="screen" aria-labelledby={focus ? undefined : 'screen-title'} aria-label={focus ? 'Focus Mode' : undefined} tabIndex={-1}>
          {screen === 'live' && <LiveScreen />}
          {screen === 'workspace' && <WorkspaceScreen />}
          {screen === 'notes' && <NotesScreen />}
          {screen === 'settings' && <SettingsScreen />}
        </main>
      </div>

      {focus && (
        <div className="focus-exit">
          <IconButton icon="focusExit" variant="glass" size="lg" label={`Exit Focus Mode (${shortcutLabel('Escape')})`} onClick={exitFocus} data-testid="focus-exit" />
        </div>
      )}
      {focus && focusHint > 0 && (
        <div key={focusHint} className="focus-hint" role="status">
          Focus Mode · press <Kbd combo="Escape" />
          <span className="sr-only">Escape</span> to exit
        </div>
      )}

      <ConfirmToast feedback={flow.feedback} onDone={flow.clearFeedback} />
      <NoticeToast notice={flow.notice} onDone={flow.clearNotice} />

      {/* Always-mounted, invisible source for the frame sampler, so recognition keeps
          running whichever screen is open. */}
      <CameraView stream={flow.camera.stream} videoRef={flow.samplerRef} className="sampler-video" hidden />
    </div>
  );
}
