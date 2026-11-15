/**
 * Real-time communication modes (pure logic, no React):
 *
 * - Words:    every accepted sign is spoken right away as a word. No AI, no confirmation.
 * - Sentence: accepted signs are collected until the sentence ends; Gemini (through the
 *             SignFlow backend) composes the English sentence, which is spoken
 *             automatically when it passes the fidelity checks below.
 * - Review:   the original flow: an editable draft the user confirms before anything is spoken.
 */
import { glossesToEnglish } from '../adapters/mock/mockTranslator';

export type CommMode = 'words' | 'sentence' | 'review';

export const COMM_MODES: readonly CommMode[] = ['words', 'sentence', 'review'];
export const DEFAULT_COMM_MODE: CommMode = 'review';

export const isCommMode = (v: unknown): v is CommMode => COMM_MODES.includes(v as CommMode);

/** Sentence mode: after this long, waiting for Gemini is shown as slow (Speak now stays available throughout). */
export const SENTENCE_SLOW_MS = 3000;
/**
 * Sentence mode: after this long, the local composition is spoken instead and a late
 * Gemini answer is discarded. Long enough for a normal Gemini reply (the backend's
 * own budget is 3 s, its timeout 20 s); short enough not to strand the user.
 */
export const SENTENCE_FALLBACK_MS = 12_000;
/** Words mode: words waiting behind the one being spoken. Older ones are dropped beyond this. */
export const WORDS_QUEUE_MAX = 6;

// ---------- Words ----------

/** Glosses whose spoken form isn't just the lowercased gloss. */
const SPOKEN_FORMS: Readonly<Record<string, string>> = {
  'THANK-YOU': 'thank you',
  THANKYOU: 'thank you',
  'IX-1': 'I',
  I: 'I',
  ME: 'me',
  'IX-2': 'you',
  'IX-3': 'they',
  'NOT-YET': 'not yet',
};

/** One accepted gloss → the word(s) spoken in Words mode. Never adds meaning. */
export function glossToWords(gloss: string): string {
  const g = gloss.trim().toUpperCase();
  if (SPOKEN_FORMS[g]) return SPOKEN_FORMS[g];
  // Fingerspelling (R-A-I) keeps its letters; otherwise hyphens join words.
  if (/^([A-Z]-)+[A-Z]$/.test(g)) return g.replace(/-/g, ' ');
  return g.replace(/^#/, '').replace(/[-_]+/g, ' ').toLowerCase();
}

// ---------- Sentence: local composition ----------

/**
 * The local (non-AI) sentence: the glosses as plain English words, in signed order,
 * using the same deterministic rules as the demo translator. It never adds facts:
 * it is the fallback when Gemini is slow or unavailable.
 */
export function composeLocally(glosses: readonly string[]): string {
  return glossesToEnglish(glosses);
}

// ---------- Sentence: fidelity checks before auto-speaking ----------

export interface FidelityFlag {
  code: 'negation_dropped' | 'negation_added' | 'number_missing' | 'number_added' | 'term_missing' | 'term_added' | 'empty';
  message: string;
}

/** Same as the backend eval harness (backend/evals/lexicon.py NEGATION_PATTERN). */
const NEGATION_PATTERN =
  /(?<![\w])(not|no|never|none|nobody|nothing|nowhere|neither|nor|cannot|without|no one|no-one)(?![\w])|n't(?![\w])/i;
const NEGATION_GLOSSES = new Set(['NO', 'NOT', 'NEVER', 'NONE', 'NOTHING', 'NOBODY', "DON'T", 'DONT', "CAN'T", 'CANT', "WON'T", 'NOT-YET', 'REFUSE']);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
};

/** Numbers mentioned in a text: digits ("3", "3:00" → 3, "12.5") and number words. */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const lowered = text.toLowerCase();
  for (const m of lowered.matchAll(/\d+(?:\.\d+)?(?::\d\d)?/g)) {
    const [whole, minutes] = m[0].split(':');
    const n = Number(whole);
    if (Number.isFinite(n)) out.push(minutes && minutes !== '00' ? n + Number(minutes) / 60 : n);
  }
  for (const word of lowered.split(/[^a-z]+/)) {
    if (word in NUMBER_WORDS) out.push(NUMBER_WORDS[word]!);
  }
  return out;
}

/**
 * Medical / safety terms: if one is signed it must appear in the sentence, and the
 * sentence must not introduce one that wasn't signed. Keys are glosses, values match
 * the English.
 */
const HIGH_RISK_TERMS: readonly { glosses: readonly string[]; english: RegExp; label: string }[] = [
  { glosses: ['ALLERGY', 'ALLERGIC'], english: /allerg/i, label: 'allergy' },
  { glosses: ['PENICILLIN'], english: /penicillin/i, label: 'penicillin' },
  { glosses: ['ASPIRIN'], english: /aspirin/i, label: 'aspirin' },
  { glosses: ['IBUPROFEN'], english: /ibuprofen/i, label: 'ibuprofen' },
  { glosses: ['INSULIN'], english: /insulin/i, label: 'insulin' },
  { glosses: ['MEDICINE', 'MEDICATION', 'PILL', 'PILLS'], english: /medic(ine|ation)|pill|tablet|drug/i, label: 'medicine' },
  { glosses: ['DIABETES', 'DIABETIC'], english: /diabet/i, label: 'diabetes' },
  { glosses: ['PREGNANT'], english: /pregnan/i, label: 'pregnant' },
  { glosses: ['BLEED', 'BLOOD'], english: /bl(ee|oo)d/i, label: 'bleeding' },
  { glosses: ['HEART-ATTACK', 'HEART'], english: /heart/i, label: 'heart' },
  { glosses: ['SMOKE', 'SMOKING'], english: /smok/i, label: 'smoking' },
  { glosses: ['EMERGENCY', '911', 'AMBULANCE'], english: /emergenc|911|ambulance/i, label: 'emergency' },
];

/**
 * Deterministic checks of a generated sentence against its glosses (a TypeScript port
 * of the backend eval harness's negation, number and medical-term checks). Any flag
 * means "don't auto-speak: let the user review it".
 */
export function checkFidelity(glosses: readonly string[], sentence: string): FidelityFlag[] {
  const flags: FidelityFlag[] = [];
  const text = sentence.trim();
  if (!text) return [{ code: 'empty', message: 'Gemini returned no sentence.' }];
  const upper = glosses.map((g) => g.toUpperCase());

  const signedNegation = upper.some((g) => NEGATION_GLOSSES.has(g));
  const textNegation = NEGATION_PATTERN.test(text);
  if (signedNegation && !textNegation) flags.push({ code: 'negation_dropped', message: 'The signs are negated, but the sentence is not.' });
  if (!signedNegation && textNegation) flags.push({ code: 'negation_added', message: 'The sentence is negated, but no negation was signed.' });

  const signedNumbers = new Set(extractNumbers(upper.join(' ').replace(/-/g, ' ')));
  const textNumbers = new Set(extractNumbers(text));
  // "ONE" as an article ("one moment") is too common to treat as a quantity on its own.
  const missing = [...signedNumbers].filter((n) => !textNumbers.has(n));
  const added = [...textNumbers].filter((n) => !signedNumbers.has(n) && !(n === 1 && /\bone\b/i.test(text) && !/\b1\b/.test(text)));
  if (missing.length) flags.push({ code: 'number_missing', message: `Signed number missing: ${missing.join(', ')}.` });
  if (added.length) flags.push({ code: 'number_added', message: `Number not signed: ${added.join(', ')}.` });

  for (const term of HIGH_RISK_TERMS) {
    const signed = term.glosses.some((g) => upper.includes(g));
    const said = term.english.test(text);
    if (signed && !said) flags.push({ code: 'term_missing', message: `Signed “${term.label}” is missing from the sentence.` });
    if (!signed && said) flags.push({ code: 'term_added', message: `The sentence mentions “${term.label}”, which wasn't signed.` });
  }
  return flags;
}
