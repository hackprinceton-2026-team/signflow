import type { EnglishDraft, RecognizedSign } from '../adapters/types';

/** A sentence the user confirmed. It goes to TTS, captions, and notes. */
export interface Utterance {
  id: string;
  text: string;
  glosses: string[];
  confidence: number;
  confirmedAt: number;
  /** True if the user changed the generated text before confirming. */
  edited: boolean;
}

export interface SessionSettings {
  /** Final signs below this confidence are shown but not used for the draft. */
  minConfidence: number;
  /** Silence (ms) after the last accepted sign before a draft is generated. */
  pauseMs: number;
  /**
   * Also speak on plain Confirm. Off by default: the explicit Speak action is
   * the normal way to speak, and nothing unconfirmed is ever spoken.
   */
  autoSpeak: boolean;
}

export interface ActiveDraft {
  draft: EnglishDraft;
  /** Current text in the editor (may differ from draft.text). */
  text: string;
  edited: boolean;
}

export type DraftStatus = 'idle' | 'translating' | 'error';

export interface SessionState {
  /** Recent recognizer output for the live feed (newest first, incl. low-confidence). */
  liveSigns: RecognizedSign[];
  /** Accepted final signs waiting to be translated. */
  buffer: RecognizedSign[];
  draft: ActiveDraft | null;
  draftStatus: DraftStatus;
  draftError: string | null;
  transcript: Utterance[];
  settings: SessionSettings;
}

export const LIVE_FEED_LIMIT = 24;

export const DEFAULT_SETTINGS: SessionSettings = {
  minConfidence: 0.6,
  pauseMs: 1600,
  autoSpeak: false,
};

export const SETTINGS_LIMITS = {
  minConfidence: [0.3, 0.95],
  pauseMs: [600, 3000],
} as const;

/** Validate persisted settings (localStorage) so stale or corrupt values can't break the session. */
export function isSessionSettings(value: unknown): value is SessionSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const inRange = (x: unknown, [min, max]: readonly [number, number]) =>
    typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
  return (
    inRange(v['minConfidence'], SETTINGS_LIMITS.minConfidence) &&
    inRange(v['pauseMs'], SETTINGS_LIMITS.pauseMs) &&
    typeof v['autoSpeak'] === 'boolean'
  );
}

export function initialSessionState(settings: Partial<SessionSettings> = {}): SessionState {
  return {
    liveSigns: [],
    buffer: [],
    draft: null,
    draftStatus: 'idle',
    draftError: null,
    transcript: [],
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export type SessionAction =
  | { type: 'sign/received'; sign: RecognizedSign }
  | { type: 'translation/started'; signIds: string[] }
  | { type: 'translation/succeeded'; draft: EnglishDraft }
  | { type: 'translation/failed'; error: string; signs: RecognizedSign[] }
  /** An in-flight translation was abandoned (e.g. Demo/Live or context switch): its signs go back to the buffer. */
  | { type: 'translation/cancelled'; signs: RecognizedSign[] }
  /** Clear a failure but keep the signs, so the next pause translates them again. */
  | { type: 'translation/errorCleared' }
  | { type: 'draft/edited'; text: string }
  | { type: 'draft/confirmed'; at: number }
  | { type: 'draft/discarded' }
  | { type: 'buffer/cleared' }
  /** Words/Sentence mode: these signs were taken for speaking or composing. */
  | { type: 'buffer/taken'; signIds: string[] }
  /** Words/Sentence mode: text spoken without a draft. */
  | { type: 'utterance/added'; utterance: Utterance }
  | { type: 'transcript/cleared' }
  | { type: 'session/reset' }
  | { type: 'settings/updated'; settings: Partial<SessionSettings> };

export function isAccepted(sign: RecognizedSign, settings: SessionSettings): boolean {
  return sign.final && !sign.uncertain && sign.confidence >= settings.minConfidence;
}

function upsertById<T extends { id: string }>(list: T[], item: T): { list: T[]; replaced: boolean } {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return { list, replaced: false };
  const next = list.slice();
  next[idx] = item;
  return { list: next, replaced: true };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'sign/received': {
      const { sign } = action;
      const live = upsertById(state.liveSigns, sign);
      const liveSigns = live.replaced ? live.list : [sign, ...state.liveSigns].slice(0, LIVE_FEED_LIMIT);

      let buffer = state.buffer;
      if (isAccepted(sign, state.settings)) {
        const b = upsertById(buffer, sign);
        buffer = b.replaced ? b.list : [...buffer, sign];
      } else if (buffer.some((s) => s.id === sign.id)) {
        // A refinement dropped this sign below threshold: un-accept it.
        buffer = buffer.filter((s) => s.id !== sign.id);
      }
      return { ...state, liveSigns, buffer };
    }

    case 'translation/started': {
      const ids = new Set(action.signIds);
      return {
        ...state,
        buffer: state.buffer.filter((s) => !ids.has(s.id)),
        draftStatus: 'translating',
        draftError: null,
      };
    }

    case 'translation/succeeded': {
      const incoming = action.draft;
      if (!incoming.text.trim()) return { ...state, draftStatus: 'idle' };
      if (!state.draft) {
        return {
          ...state,
          draft: { draft: incoming, text: incoming.text, edited: false },
          draftStatus: 'idle',
          draftError: null,
        };
      }
      // A draft is already waiting: append, keeping any edits the user made.
      const prev = state.draft;
      const n = prev.draft.signIds.length + incoming.signIds.length || 1;
      const merged: EnglishDraft = {
        ...prev.draft,
        text: `${prev.draft.text} ${incoming.text}`,
        signIds: [...prev.draft.signIds, ...incoming.signIds],
        glosses: [...prev.draft.glosses, ...incoming.glosses],
        source: prev.draft.source === incoming.source ? prev.draft.source : 'mixed',
        confidence:
          Math.round(
            ((prev.draft.confidence * prev.draft.signIds.length + incoming.confidence * incoming.signIds.length) / n) *
              100,
          ) / 100,
      };
      return {
        ...state,
        draft: { draft: merged, text: `${prev.text.trimEnd()} ${incoming.text}`, edited: prev.edited },
        draftStatus: 'idle',
        draftError: null,
      };
    }

    case 'translation/failed':
      return {
        ...state,
        // Put the signs back so a retry can pick them up.
        buffer: [...action.signs, ...state.buffer],
        draftStatus: 'error',
        draftError: action.error,
      };

    case 'translation/cancelled': {
      // Back to the front of the buffer, in order, without duplicating a sign that was re-emitted meanwhile.
      const queued = new Set(state.buffer.map((s) => s.id));
      return {
        ...state,
        buffer: [...action.signs.filter((s) => !queued.has(s.id)), ...state.buffer],
        draftStatus: state.draftStatus === 'translating' ? 'idle' : state.draftStatus,
      };
    }

    case 'translation/errorCleared':
      if (state.draftStatus !== 'error') return state;
      return { ...state, draftStatus: 'idle', draftError: null };

    case 'draft/edited':
      if (!state.draft) return state;
      return {
        ...state,
        draft: { ...state.draft, text: action.text, edited: action.text !== state.draft.draft.text },
      };

    case 'draft/confirmed': {
      if (!state.draft) return state;
      const text = state.draft.text.trim();
      if (!text) return { ...state, draft: null };
      const utterance: Utterance = {
        id: state.draft.draft.id,
        text,
        glosses: state.draft.draft.glosses,
        confidence: state.draft.draft.confidence,
        confirmedAt: action.at,
        edited: state.draft.edited,
      };
      return { ...state, draft: null, transcript: [...state.transcript, utterance] };
    }

    case 'draft/discarded':
      return { ...state, draft: null, draftError: null, draftStatus: state.draftStatus === 'error' ? 'idle' : state.draftStatus };

    case 'buffer/cleared':
      return { ...state, buffer: [], draftStatus: state.draftStatus === 'error' ? 'idle' : state.draftStatus, draftError: null };

    case 'buffer/taken': {
      const ids = new Set(action.signIds);
      return { ...state, buffer: state.buffer.filter((s) => !ids.has(s.id)) };
    }

    case 'utterance/added':
      return { ...state, transcript: [...state.transcript, action.utterance] };

    case 'transcript/cleared':
      return { ...state, transcript: [] };

    case 'session/reset':
      return { ...initialSessionState(state.settings), transcript: state.transcript };

    case 'settings/updated': {
      const settings = { ...state.settings, ...action.settings };
      return { ...state, settings };
    }

    default:
      return state;
  }
}

/** The most recent confirmed utterance, if any. */
export function lastUtterance(state: SessionState): Utterance | undefined {
  return state.transcript[state.transcript.length - 1];
}
