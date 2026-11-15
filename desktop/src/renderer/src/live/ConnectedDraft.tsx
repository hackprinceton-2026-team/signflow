import { useSignFlow } from '../app/useSignFlow';
import { DraftOverlay } from './DraftOverlay';

/** The draft overlay bound to the app controller. */
export function ConnectedDraft({ variant, showHint = false }: { variant: 'stage' | 'dock'; showHint?: boolean }) {
  const { session, speech, confirmDraft, speakDraft, discardDraft, draftTextRef } = useSignFlow();
  const { state } = session;
  return (
    <DraftOverlay
      variant={variant}
      draft={state.draft}
      status={state.draftStatus}
      error={state.draftError}
      threshold={state.settings.minConfidence}
      showHint={showHint}
      canRetry={state.buffer.length > 0}
      canSpeak={speech.available}
      onEdit={session.editDraft}
      onConfirm={confirmDraft}
      onSpeak={speakDraft}
      onDiscard={discardDraft}
      onRetry={session.translateNow}
      onDismissError={session.clearBuffer}
      textRef={draftTextRef}
    />
  );
}
