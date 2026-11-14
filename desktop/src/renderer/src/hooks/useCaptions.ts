import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_CAPTION_SETTINGS,
  isCaptionSettings,
  type CaptionPayload,
  type CaptionSettings,
} from '@shared/captions';
import type { SessionState } from '../state/session';
import { usePersistentState } from './usePersistentState';

/** What the overlay should show for the current session state. */
export function buildCaptionPayload(
  state: Pick<SessionState, 'transcript' | 'draft' | 'buffer'>,
  settings: CaptionSettings,
): CaptionPayload {
  const lines = state.transcript.slice(-settings.maxLines).map((u) => ({ id: u.id, text: u.text }));
  let live = '';
  if (state.draft?.text.trim()) live = state.draft.text.trim();
  else if (state.buffer.length > 0) live = `${state.buffer.map((s) => s.gloss).join(' ')} …`;
  return { lines, live, settings };
}

/** Floating captions window: visibility, persisted look, and live sync. */
export function useCaptions(session: SessionState) {
  const [visible, setVisible] = useState(false);
  const [settings, setSettings] = usePersistentState<CaptionSettings>(
    'signflow.captions',
    DEFAULT_CAPTION_SETTINGS,
    isCaptionSettings,
  );

  // Main tells us when the overlay opens/closes (including its own × button).
  useEffect(() => window.signflow.captions.onVisibilityChange(setVisible), []);

  // Stream state while the overlay is open.
  const { transcript, draft, buffer } = session;
  useEffect(() => {
    if (!visible) return;
    window.signflow.captions.update(buildCaptionPayload({ transcript, draft, buffer }, settings));
  }, [visible, transcript, draft, buffer, settings]);

  const toggle = useCallback(async () => {
    try {
      const next = await window.signflow.captions.setVisible(!visible);
      setVisible(next);
    } catch {
      setVisible(false);
    }
  }, [visible]);

  const update = useCallback(
    (patch: Partial<CaptionSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [setSettings],
  );

  return { visible, settings, toggle, update };
}

export type CaptionsController = ReturnType<typeof useCaptions>;
