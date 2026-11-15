import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  initialSessionState,
  isSessionSettings,
  LIVE_FEED_LIMIT,
  sessionReducer,
  type SessionState,
} from './session';
import type { EnglishDraft, RecognizedSign } from '../adapters/types';

const sign = (id: string, gloss: string, confidence = 0.9, final = true): RecognizedSign => ({
  id,
  gloss,
  confidence,
  final,
  ts: 0,
});

const draft = (id: string, text: string, signIds: string[], confidence = 0.9, source: EnglishDraft['source'] = 'demo'): EnglishDraft => ({
  id,
  text,
  signIds,
  glosses: signIds.map((s) => s.toUpperCase()),
  confidence,
  createdAt: 0,
  source,
});

function run(state: SessionState, ...actions: Parameters<typeof sessionReducer>[1][]): SessionState {
  return actions.reduce(sessionReducer, state);
}

describe('sessionReducer: signs', () => {
  it('shows provisional signs live but only buffers accepted finals', () => {
    const s = run(initialSessionState(), { type: 'sign/received', sign: sign('a', 'HI', 0.6, false) });
    expect(s.liveSigns).toHaveLength(1);
    expect(s.buffer).toHaveLength(0);

    const s2 = sessionReducer(s, { type: 'sign/received', sign: sign('a', 'HELLO', 0.92) });
    expect(s2.liveSigns).toHaveLength(1);
    expect(s2.liveSigns[0]?.gloss).toBe('HELLO');
    expect(s2.buffer.map((b) => b.gloss)).toEqual(['HELLO']);
  });

  it('rejects finals below the confidence threshold', () => {
    const s = run(initialSessionState({ minConfidence: 0.7 }), { type: 'sign/received', sign: sign('n', 'UM', 0.4) });
    expect(s.liveSigns).toHaveLength(1);
    expect(s.buffer).toHaveLength(0);
  });

  it('removes a buffered sign if a refinement drops it below threshold', () => {
    const s = run(
      initialSessionState(),
      { type: 'sign/received', sign: sign('a', 'HELLO', 0.9) },
      { type: 'sign/received', sign: sign('a', 'HELLO', 0.3) },
    );
    expect(s.buffer).toHaveLength(0);
  });

  it('caps the live feed', () => {
    let s = initialSessionState();
    for (let i = 0; i < LIVE_FEED_LIMIT + 10; i++) s = sessionReducer(s, { type: 'sign/received', sign: sign(`s${i}`, 'X') });
    expect(s.liveSigns).toHaveLength(LIVE_FEED_LIMIT);
    expect(s.liveSigns[0]?.id).toBe(`s${LIVE_FEED_LIMIT + 9}`);
  });
});

describe('sessionReducer: drafts', () => {
  const withBuffer = run(
    initialSessionState(),
    { type: 'sign/received', sign: sign('a', 'HOW') },
    { type: 'sign/received', sign: sign('b', 'YOU') },
  );

  it('translation moves signs out of the buffer and produces a draft', () => {
    const s = run(
      withBuffer,
      { type: 'translation/started', signIds: ['a', 'b'] },
      { type: 'translation/succeeded', draft: draft('d1', 'How are you?', ['a', 'b']) },
    );
    expect(s.buffer).toHaveLength(0);
    expect(s.draftStatus).toBe('idle');
    expect(s.draft?.text).toBe('How are you?');
    expect(s.draft?.edited).toBe(false);
  });

  it('marks translating while in flight', () => {
    const s = sessionReducer(withBuffer, { type: 'translation/started', signIds: ['a'] });
    expect(s.draftStatus).toBe('translating');
    expect(s.buffer.map((b) => b.id)).toEqual(['b']);
  });

  it('on failure, returns signs to the buffer and records the error', () => {
    const started = sessionReducer(withBuffer, { type: 'translation/started', signIds: ['a', 'b'] });
    const s = sessionReducer(started, {
      type: 'translation/failed',
      error: 'backend down',
      signs: withBuffer.buffer,
    });
    expect(s.buffer.map((b) => b.id)).toEqual(['a', 'b']);
    expect(s.draftStatus).toBe('error');
    expect(s.draftError).toBe('backend down');
  });

  it('clearing an error keeps the signs so they can be translated again', () => {
    const failed = run(
      withBuffer,
      { type: 'translation/started', signIds: ['a', 'b'] },
      { type: 'translation/failed', error: 'offline', signs: withBuffer.buffer },
    );
    const s = sessionReducer(failed, { type: 'translation/errorCleared' });
    expect(s.draftStatus).toBe('idle');
    expect(s.draftError).toBeNull();
    expect(s.buffer.map((b) => b.id)).toEqual(['a', 'b']);
    expect(sessionReducer(withBuffer, { type: 'translation/errorCleared' })).toBe(withBuffer);
  });

  it('appends a new translation to a pending draft, keeping user edits', () => {
    const s = run(
      initialSessionState(),
      { type: 'translation/succeeded', draft: draft('d1', 'Hello.', ['a'], 0.8) },
      { type: 'draft/edited', text: 'Hello everyone.' },
      { type: 'translation/succeeded', draft: draft('d2', 'How are you?', ['b', 'c'], 0.95) },
    );
    expect(s.draft?.text).toBe('Hello everyone. How are you?');
    expect(s.draft?.edited).toBe(true);
    expect(s.draft?.draft.signIds).toEqual(['a', 'b', 'c']);
    expect(s.draft?.draft.confidence).toBe(0.9);
  });

  it('ignores empty translations', () => {
    const s = sessionReducer(initialSessionState(), { type: 'translation/succeeded', draft: draft('d', '  ', []) });
    expect(s.draft).toBeNull();
  });

  it('editing back to the original clears the edited flag', () => {
    const s = run(
      initialSessionState(),
      { type: 'translation/succeeded', draft: draft('d1', 'Hi.', ['a']) },
      { type: 'draft/edited', text: 'Hi!' },
      { type: 'draft/edited', text: 'Hi.' },
    );
    expect(s.draft?.edited).toBe(false);
  });
});

describe('sessionReducer: confirm / discard', () => {
  const pending = run(
    initialSessionState(),
    { type: 'translation/succeeded', draft: draft('d1', 'Thank you.', ['a']) },
  );

  it('confirming moves the (edited) text to the transcript', () => {
    const s = run(pending, { type: 'draft/edited', text: '  Thank you so much!  ' }, { type: 'draft/confirmed', at: 42 });
    expect(s.draft).toBeNull();
    expect(s.transcript).toEqual([
      { id: 'd1', text: 'Thank you so much!', glosses: ['A'], confidence: 0.9, confirmedAt: 42, edited: true },
    ]);
  });

  it('confirming an emptied draft just drops it', () => {
    const s = run(pending, { type: 'draft/edited', text: '   ' }, { type: 'draft/confirmed', at: 1 });
    expect(s.draft).toBeNull();
    expect(s.transcript).toHaveLength(0);
  });

  it('discarding drops the draft without a transcript entry', () => {
    const s = sessionReducer(pending, { type: 'draft/discarded' });
    expect(s.draft).toBeNull();
    expect(s.transcript).toHaveLength(0);
  });

  it('reset keeps transcript and settings but clears live state', () => {
    const confirmed = run(
      pending,
      { type: 'draft/confirmed', at: 1 },
      { type: 'settings/updated', settings: { autoSpeak: false } },
      { type: 'sign/received', sign: sign('z', 'HELLO') },
    );
    const s = sessionReducer(confirmed, { type: 'session/reset' });
    expect(s.transcript).toHaveLength(1);
    expect(s.settings.autoSpeak).toBe(false);
    expect(s.liveSigns).toHaveLength(0);
    expect(s.buffer).toHaveLength(0);
  });
});

describe('session settings', () => {
  it('defaults to not speaking on plain confirm (speech needs explicit intent)', () => {
    expect(DEFAULT_SETTINGS.autoSpeak).toBe(false);
  });

  it('validates persisted settings', () => {
    expect(isSessionSettings(DEFAULT_SETTINGS)).toBe(true);
    expect(isSessionSettings({ ...DEFAULT_SETTINGS, minConfidence: 2 })).toBe(false);
    expect(isSessionSettings({ ...DEFAULT_SETTINGS, pauseMs: 100 })).toBe(false);
    expect(isSessionSettings({ ...DEFAULT_SETTINGS, autoSpeak: 'yes' })).toBe(false);
    expect(isSessionSettings(null)).toBe(false);
  });
});

describe('stale translations', () => {
  it('translation/cancelled gives the signs back (in order, no duplicates) and keeps the draft', () => {
    const a = sign('a', 'HOW', 0.9);
    const b = sign('b', 'YOU', 0.9);
    const c = sign('c', 'NEXT', 0.9);
    const withDraft = run(initialSessionState(), { type: 'translation/succeeded', draft: draft('d0', 'Hi.', ['x']) });
    const started = run(
      withDraft,
      { type: 'sign/received', sign: a },
      { type: 'sign/received', sign: b },
      { type: 'translation/started', signIds: ['a', 'b'] },
      { type: 'sign/received', sign: c },
      { type: 'sign/received', sign: b }, // re-emitted while in flight
    );
    const after = sessionReducer(started, { type: 'translation/cancelled', signs: [a, b] });
    expect(after.buffer.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(after.draftStatus).toBe('idle');
    expect(after.draft?.text).toBe('Hi.');
  });

  it('a draft merged from different translators is labeled mixed', () => {
    const s1 = run(
      initialSessionState(),
      { type: 'translation/succeeded', draft: draft('d1', 'Hello.', ['a'], 0.9, 'demo') },
      { type: 'translation/succeeded', draft: draft('d2', 'How are you?', ['b'], 0.9, 'ai') },
    );
    expect(s1.draft?.draft.source).toBe('mixed');
    const s2 = run(
      initialSessionState(),
      { type: 'translation/succeeded', draft: draft('d1', 'Hello.', ['a'], 0.9, 'ai') },
      { type: 'translation/succeeded', draft: draft('d2', 'Bye.', ['b'], 0.9, 'ai') },
    );
    expect(s2.draft?.draft.source).toBe('ai');
  });
});

