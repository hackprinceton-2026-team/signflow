import { newId } from '../emitter';
import type { EnglishDraft, RecognizedSign, Translator } from '../types';
import { BackendError, type BackendClient } from './backendClient';
import type { TranslationMode } from './guards';

/** The backend accepts at most this many glosses per request (TranslationRequest.raw_signs). */
export const MAX_SIGNS_PER_REQUEST = 64;

/** Translation by the SignFlow backend (Gemini). Produces a draft; never audio. */
export class RemoteTranslator implements Translator {
  readonly name = 'SignFlow AI (Gemini)';
  readonly source = 'ai' as const;

  constructor(
    private readonly client: BackendClient,
    private readonly mode: TranslationMode = 'chat',
    /** Told about backend failures (not cancellations), e.g. to refresh the connection status. */
    private readonly onFailure?: (error: BackendError) => void,
  ) {}

  async translate(signs: readonly RecognizedSign[], { signal }: { signal?: AbortSignal } = {}): Promise<EnglishDraft> {
    const glosses = signs.map((s) => s.gloss);
    // Unusually long runs (no pause) are translated in order, in chunks the backend accepts.
    const parts: string[] = [];
    try {
      for (let i = 0; i < glosses.length; i += MAX_SIGNS_PER_REQUEST) {
        const res = await this.client.translate({ raw_signs: glosses.slice(i, i + MAX_SIGNS_PER_REQUEST), mode: this.mode }, { signal });
        parts.push(res.translated_text);
      }
    } catch (err) {
      if (err instanceof BackendError && err.kind !== 'aborted') this.onFailure?.(err);
      throw err;
    }
    const confidence = signs.length ? signs.reduce((sum, s) => sum + s.confidence, 0) / signs.length : 0;
    return {
      id: newId(),
      text: parts.join(' '),
      signIds: signs.map((s) => s.id),
      glosses,
      // The backend reports no confidence; the draft shows how sure recognition was.
      confidence: Math.round(confidence * 100) / 100,
      createdAt: Date.now(),
      source: this.source,
    };
  }
}
