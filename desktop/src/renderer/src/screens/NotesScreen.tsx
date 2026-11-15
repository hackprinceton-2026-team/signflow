import { useSignFlow } from '../app/useSignFlow';
import { NotesPanel } from '../components/NotesPanel';
import { ConnectedDraft } from '../live/ConnectedDraft';
import { Switch } from '../ui';

export function NotesScreen() {
  const { notes, captureToNotes, setCaptureToNotes } = useSignFlow();
  return (
    <div className="notes-screen">
      <NotesPanel
        notes={notes}
        toolbar={
          <Switch
            checked={captureToNotes}
            onChange={setCaptureToNotes}
            label="Capture from Live"
            description="Confirmed sentences are added to the open note"
          />
        }
      />
      <div className="dock">
        <ConnectedDraft variant="dock" />
      </div>
    </div>
  );
}
