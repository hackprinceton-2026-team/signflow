import { useState } from 'react';
import { CameraView } from '../live/CameraView';
import { ConfirmToast } from '../live/ConfirmToast';
import { LiveScreen } from '../screens/LiveScreen';
import { NotesScreen } from '../screens/NotesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { WorkspaceScreen } from '../screens/WorkspaceScreen';
import { NavRail } from './NavRail';
import type { ScreenId } from './screens';
import { TopBar } from './TopBar';
import { useSignFlow } from './useSignFlow';

/** Rail + top bar + the active screen. */
export function AppShell() {
  const flow = useSignFlow();
  const [screen, setScreen] = useState<ScreenId>('live');

  return (
    <div className="shell" data-screen={screen}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <NavRail screen={screen} onSelect={setScreen} />
      <div className="shell-main">
        <TopBar screen={screen} />
        <main id="main" className="screen" aria-labelledby="screen-title" tabIndex={-1}>
          {screen === 'live' && <LiveScreen />}
          {screen === 'workspace' && <WorkspaceScreen />}
          {screen === 'notes' && <NotesScreen />}
          {screen === 'settings' && <SettingsScreen />}
        </main>
      </div>

      <ConfirmToast feedback={flow.feedback} onDone={flow.clearFeedback} />

      {/* Always-mounted, invisible source for the frame sampler, so recognition keeps
          running whichever screen is open. */}
      <CameraView stream={flow.camera.stream} videoRef={flow.samplerRef} className="sampler-video" hidden />
    </div>
  );
}
