import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RecognizedSign, SpeechEngine, Translator } from '../adapters/types';
import {
  checkFidelity,
  composeLocally,
  SENTENCE_FALLBACK_MS,
  SENTENCE_SLOW_MS,
  WORDS_QUEUE_MAX,
  type FidelityFlag,
} from '../state/realtime';

// ---------------------------------------------------------------- speech queue

export interface SpeechItem {
  id: string;
  text: string;
  kind: 'word' | 'sentence';
  /** When the sign (or sentence) ended, ms epoch: the start of the latency measurement. */
  t0: number;
}

export interface SpokenRecord extends SpeechItem {
  /** Every queued item spoken in this utterance (words that piled up go together). */
  ids: string[];
  /** When audio actually started. */
  startedAt?: number;
  /** startedAt - t0. */
  latencyMs?: number;
}

/** After an utterance ends, wait this long before the next (a fallback voice may still be taking over). */
const NEXT_DELAY_MS = 60;
/** Never wait longer than this for an utterance to finish (an engine that never reports idle). */
const STUCK_MS = 30_000;

/**
 * An ordered, bounded queue in front of the speech engine. Words that pile up while
 * one is being spoken are spoken together next, so the queue never falls far behind;
 * beyond WORDS_QUEUE_MAX waiting words the oldest are dropped (and counted).
 * `stop()` empties it and stops the voice at once.
 */
export function useSpeechQueue(opts: {
  engine: SpeechEngine;
  speak: (text: string) => void;
  stopSpeech: () => void;
  available: boolean;
  /** Called when an item starts being spoken (transcript, captions, notes). */
  onStart?: (item: SpokenRecord) => void;
}) {
  const { engine, speak, stopSpeech, available } = opts;
  const queueRef = useRef<SpeechItem[]>([]);
  const currentRef = useRef<SpokenRecord | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStartRef = useRef(opts.onStart);
  useLayoutEffect(() => {
    onStartRef.current = opts.onStart;
  });
  const [current, setCurrent] = useState<SpokenRecord | null>(null);
  const [last, setLast] = useState<SpokenRecord | null>(null);
  const [queued, setQueued] = useState<SpeechItem[]>([]);
  const [dropped, setDropped] = useState(0);
  /** `next`, for timers scheduled from inside it. */
  const nextRef = useRef<() => void>(() => undefined);

  const clearTimers = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (stuckRef.current) clearTimeout(stuckRef.current);
    timerRef.current = stuckRef.current = null;
  };

  const next = useCallback(() => {
    clearTimers();
    if (currentRef.current) return;
    const queue = queueRef.current;
    if (queue.length === 0 || !available) {
      setQueued([...queue]);
      return;
    }
    // Words that piled up go out together, in order; a sentence always goes alone.
    let take = 1;
    if (queue[0]!.kind === 'word') while (take < queue.length && queue[take]!.kind === 'word') take++;
    const batch = queue.splice(0, take);
    const item: SpokenRecord = {
      ids: batch.map((b) => b.id),
      id: batch[0]!.id,
      kind: batch[0]!.kind,
      text: batch.map((b) => b.text).join(' '),
      t0: Math.min(...batch.map((b) => b.t0)),
    };
    currentRef.current = item;
    setCurrent(item);
    setQueued([...queue]);
    onStartRef.current?.(item);
    speak(item.text);
    stuckRef.current = setTimeout(() => {
      currentRef.current = null;
      setCurrent(null);
      nextRef.current();
    }, STUCK_MS);
  }, [available, speak]);
  useLayoutEffect(() => {
    nextRef.current = next;
  });

  // Audio really started: measure latency. Utterance finished: speak the next one.
  useEffect(() => {
    const offVoice = engine.onVoiceInUse?.(() => {
      const cur = currentRef.current;
      if (!cur || cur.startedAt !== undefined) return;
      cur.startedAt = Date.now();
      cur.latencyMs = cur.startedAt - cur.t0;
      const rec = { ...cur };
      setCurrent(rec);
      setLast(rec);
      console.info(`[realtime] ${rec.kind} "${rec.text}" audio started ${rec.latencyMs} ms after the ${rec.kind === 'word' ? 'sign' : 'sentence'} ended`);
    });
    const offState = engine.onState((state) => {
      if (state === 'idle') {
        if (!currentRef.current) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          currentRef.current = null;
          setCurrent(null);
          next();
        }, NEXT_DELAY_MS);
      } else if (timerRef.current) {
        // Speaking again (e.g. the fallback voice took over): not finished yet.
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    });
    return () => {
      offVoice?.();
      offState();
    };
  }, [engine, next]);

  const enqueue = useCallback(
    (items: SpeechItem[]) => {
      if (items.length === 0) return;
      const queue = queueRef.current;
      queue.push(...items);
      const words = queue.filter((q) => q.kind === 'word');
      if (words.length > WORDS_QUEUE_MAX) {
        const drop = new Set(words.slice(0, words.length - WORDS_QUEUE_MAX));
        queueRef.current = queue.filter((q) => !drop.has(q));
        setDropped((d) => d + drop.size);
      }
      setQueued([...queueRef.current]);
      if (!currentRef.current) next();
    },
    [next],
  );

  const stop = useCallback(() => {
    clearTimers();
    queueRef.current = [];
    currentRef.current = null;
    setQueued([]);
    setCurrent(null);
    stopSpeech();
  }, [stopSpeech]);

  useEffect(() => () => clearTimers(), []);

  return { enqueue, stop, current, last, queued, dropped };
}

export type SpeechQueue = ReturnType<typeof useSpeechQueue>;

// ---------------------------------------------------------------- sentence composer

export type SentenceStatus = 'composing' | 'spoken' | 'review' | 'stopped' | 'discarded';
export type SentenceSource = 'gemini' | 'local' | 'local-fallback';

export interface SentenceItem {
  id: string;
  glosses: string[];
  confidence: number;
  /** When the sentence ended (ms epoch). */
  endedAt: number;
  status: SentenceStatus;
  /** Plain local composition: what "Speak now" and the fallback say. */
  localText: string;
  /** Gemini's sentence, once it answered. */
  geminiText?: string;
  /** What was (or will be) spoken. */
  text?: string;
  source?: SentenceSource;
  /** Why the fallback was used, or why review is needed. */
  reason?: string;
  flags: FidelityFlag[];
  /** Gemini is taking longer than SENTENCE_SLOW_MS. */
  slow: boolean;
  /** How long Gemini took (when it answered in time). */
  geminiMs?: number;
}

const HISTORY = 6;
let seq = 0;

/**
 * Sentence mode: Gemini (through `translator`) composes each finished sentence, which
 * is spoken automatically when it passes the fidelity checks, or held for review when
 * it changes a negation, number or medical term. "Speak now" or an error/long wait
 * speaks the local composition instead; any Gemini answer that arrives after that,
 * after Stop, or after `reset()` (mode switch, recognition restart) is discarded.
 * Sentences are composed one at a time, in order.
 */
export function useSentenceComposer(opts: {
  translator: Translator;
  /** Speak a sentence (through the speech queue) and record it. */
  deliver: (item: SentenceItem, text: string) => void;
  onGeminiError?: (err: unknown) => void;
  now?: () => number;
}) {
  const { translator } = opts;
  const deliverRef = useRef(opts.deliver);
  const onErrorRef = useRef(opts.onGeminiError);
  const [items, setItems] = useState<SentenceItem[]>([]);
  const pendingRef = useRef<{ signs: RecognizedSign[]; endedAt: number }[]>([]);
  const activeRef = useRef<{ id: string; ctrl: AbortController; timers: ReturnType<typeof setTimeout>[] } | null>(null);
  const translatorRef = useRef(translator);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    deliverRef.current = opts.deliver;
    onErrorRef.current = opts.onGeminiError;
    translatorRef.current = translator;
    itemsRef.current = items;
  });

  const update = useCallback((id: string, patch: Partial<SentenceItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const finishActive = useCallback((id: string): boolean => {
    const active = activeRef.current;
    if (!active || active.id !== id) return false; // stale: already stopped, replaced or fell back
    active.timers.forEach(clearTimeout);
    activeRef.current = null;
    return true;
  }, []);

  const startNextRef = useRef<() => void>(() => undefined);
  const startNext = useCallback(() => {
    if (activeRef.current) return;
    const nextSentence = pendingRef.current.shift();
    if (!nextSentence) return;
    const { signs, endedAt } = nextSentence;
    const glosses = signs.map((s) => s.gloss);
    const id = `sentence-${++seq}`;
    const item: SentenceItem = {
      id,
      glosses,
      confidence: signs.reduce((a, s) => a + s.confidence, 0) / signs.length,
      endedAt,
      status: 'composing',
      localText: composeLocally(glosses),
      flags: [],
      slow: false,
    };
    setItems((list) => [item, ...list].slice(0, HISTORY));
    const ctrl = new AbortController();
    const started = Date.now();
    const timers = [
      setTimeout(() => update(id, { slow: true }), SENTENCE_SLOW_MS),
      setTimeout(() => {
        if (!finishActive(id)) return;
        ctrl.abort();
        const reason = `Gemini didn't answer within ${SENTENCE_FALLBACK_MS / 1000} s.`;
        update(id, { status: 'spoken', source: 'local-fallback', text: item.localText, reason });
        deliverRef.current({ ...item, source: 'local-fallback', reason }, item.localText);
        startNextRef.current();
      }, SENTENCE_FALLBACK_MS),
    ];
    activeRef.current = { id, ctrl, timers };

    translatorRef.current.translate(signs, { signal: ctrl.signal }).then(
      (draft) => {
        if (!finishActive(id)) return; // late answer: never spoken
        const text = draft.text.trim();
        const flags = checkFidelity(glosses, text);
        const geminiMs = Date.now() - started;
        if (flags.length > 0) {
          update(id, { status: 'review', source: 'gemini', geminiText: text, text, flags, geminiMs, reason: 'Check before speaking.' });
        } else {
          update(id, { status: 'spoken', source: 'gemini', geminiText: text, text, flags, geminiMs });
          deliverRef.current({ ...item, source: 'gemini', geminiText: text, geminiMs }, text);
        }
        startNextRef.current();
      },
      (err: unknown) => {
        if (!finishActive(id)) return;
        onErrorRef.current?.(err);
        const reason = `Gemini unavailable: ${err instanceof Error ? err.message : String(err)}`;
        update(id, { status: 'spoken', source: 'local-fallback', text: item.localText, reason });
        deliverRef.current({ ...item, source: 'local-fallback', reason }, item.localText);
        startNextRef.current();
      },
    );
  }, [finishActive, update]);
  useLayoutEffect(() => {
    startNextRef.current = startNext;
  });

  /** A sentence is complete: compose it (after any sentence still being composed). */
  const submit = useCallback(
    (signs: RecognizedSign[]) => {
      if (signs.length === 0) return;
      pendingRef.current.push({ signs, endedAt: Date.now() });
      startNext();
    },
    [startNext],
  );

  /** Don't wait for Gemini: speak the local composition of the sentence being composed. */
  const speakNow = useCallback(
    (id: string) => {
      const active = activeRef.current;
      const item = itemsRef.current.find((it) => it.id === id);
      if (!active || active.id !== id || !item) return;
      finishActive(id);
      active.ctrl.abort(); // a Gemini answer for this sentence will never be spoken
      update(id, { status: 'spoken', source: 'local', text: item.localText, reason: 'Spoken without waiting for Gemini.' });
      deliverRef.current({ ...item, source: 'local' }, item.localText);
      startNext();
    },
    [finishActive, startNext, update],
  );

  /** A sentence held for review: speak Gemini's version, the local one, or drop it. */
  const resolveReview = useCallback(
    (id: string, choice: 'gemini' | 'local' | 'discard') => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (!item || item.status !== 'review') return;
      if (choice === 'discard') {
        update(id, { status: 'discarded' });
        return;
      }
      const text = choice === 'gemini' ? (item.geminiText ?? item.localText) : item.localText;
      update(id, { status: 'spoken', source: choice === 'gemini' ? 'gemini' : 'local', text });
      deliverRef.current({ ...item, source: choice === 'gemini' ? 'gemini' : 'local' }, text);
    },
    [update],
  );

  /**
   * Stop, mode switch, recognition restart: abandon the sentence being composed and
   * everything waiting. A Gemini answer that still arrives is discarded.
   */
  const reset = useCallback(() => {
    pendingRef.current = [];
    const active = activeRef.current;
    if (active) {
      active.timers.forEach(clearTimeout);
      active.ctrl.abort();
      activeRef.current = null;
      update(active.id, { status: 'stopped', reason: 'Stopped before it was spoken.' });
    }
  }, [update]);

  useEffect(() => () => reset(), [reset]);

  return { items, submit, speakNow, resolveReview, reset, composing: items.some((it) => it.status === 'composing') };
}

export type SentenceComposer = ReturnType<typeof useSentenceComposer>;
