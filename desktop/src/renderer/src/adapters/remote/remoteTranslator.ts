import { newId } from '../emitter';
import type { EnglishDraft, RecognizedSign, Translator } from '../types';
import type { BackendClient } from './backendClient';
import type { TranslationMode } from './guards';

/** The backend accepts at most this many glosses per request (TranslationRequest.raw_signs). */
export const MAX_SIGNS_PER_REQUEST = 64;

/** Translation by the SignFlow backend (Gemini). Produces a draft; never audio. */
export class RemoteTranslator implements Translator {
  readonly name = 'SignFlow AI';

  constructor(
    private readonly client: BackendClient,
    private readonly mode: TranslationMode = 'chat',
  ) {}

  async translate(signs: readonly RecognizedSign[], { signal }: { signal?: AbortSignal } = {}): Promise<EnglishDraft> {
    const glosses = signs.map((s) => s.gloss);
    // Unusually long runs (no pause) are translated in order, in chunks the backend accepts.
    const parts: string[] = [];
    for (let i = 0; i < glosses.length; i += MAX_SIGNS_PER_REQUEST) {
      const res = await this.client.translate({ raw_signs: glosses.slice(i, i + MAX_SIGNS_PER_REQUEST), mode: this.mode }, { signal });
      parts.push(res.translated_text);
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
    };
  }
}
