# Kokoro local neural speech

SignFlow can speak confirmed text with **Kokoro-82M**, a small open-weight neural TTS model (Apache-2.0), running entirely on the user's machine. It's a desktop-only feature (owner: desktop); it adds no backend or ML interface, so `docs/interfaces.md` is unchanged. Setup and behavior: [`desktop/README.md`](../desktop/README.md#kokoro--local-neural-voice).

## Runtime decision

| Option | Verdict |
| --- | --- |
| **`kokoro-js` in an Electron `utilityProcess` (Node, native ONNX Runtime)** | **Chosen.** No CSP, sandbox, or `webPreferences` change. Fastest option measured. Loading and synthesis run outside the main and renderer processes, so the UI never freezes. The renderer reaches it only through narrow, validated IPC. |
| `kokoro-js` in a renderer Web Worker (onnxruntime-web, WASM) | Would need `'wasm-unsafe-eval'` added to the renderer CSP, and the ~326 MB model streamed into the sandboxed renderer. WASM on CPU is ~2–3× slower than native ORT (estimate from ORT's published numbers, not measured here). |
| Python `kokoro-onnx` + ONNX Runtime | Works, but adds a managed virtualenv, a Python process, and a local server or stdio protocol for no speed gain over native ORT in Node. |

Versions: `kokoro-js` 1.2.1 (latest), `@huggingface/transformers` 4.3.2 (via an npm override; kokoro-js declares ^3.5, and 4.3.2 is faster, uses less memory, and drops the `sharp` versions with open advisories), `onnxruntime-node` 1.30.0. The CoreML execution provider failed to initialize with this model, so it runs on the CPU with ONNX Runtime threads pinned to the performance-core count (4 on an M4: ~25% faster than all 10 cores).

## Model

- Source: Hugging Face `onnx-community/Kokoro-82M-v1.0-ONNX` at commit `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (converted from `hexgrad/Kokoro-82M`).
- Files: `onnx/model.onnx` (fp32, 325,532,232 bytes), `config.json`, `tokenizer.json`, `tokenizer_config.json`. Total **325.5 MB on disk**. SHA-256 values are pinned in `desktop/src/shared/kokoro.ts` and checked by `npm run kokoro:install`. Each matched the upstream LFS hash when downloaded.
- Voices (`af_heart`, `af_bella`, `am_michael`, 510 KB each) ship inside the `kokoro-js` npm package. Their SHA-256 values match upstream `voices/*.bin`.
- Location: `~/Library/Application Support/SignFlow/models/` (outside git; `*.onnx` is also gitignored).
- Download on the hackathon network: ~1.2 MB/s, so **about 4.5 minutes** for the model. Install before the demo.

## Measurements (Apple M4, 10 cores, 16 GB, macOS 26.6)

Everything below was **measured** on this machine unless marked *estimate*. The OS file cache was warm (the model had been read before), so a first-ever cold start after a reboot will load more slowly than shown.

| Metric | Result | How |
| --- | --- | --- |
| Model load + warm-up, in the app | **1.0–1.35 s** (2.3 s on the first-ever Electron launch) | From selecting Kokoro to *Ready* (E2E and Playwright runs) |
| Model load alone (plain Node) | 378 ms, plus a 302 ms first-run warm-up | `npm run kokoro:bench` |
| Warm synthesis, per test sentence | 325–720 ms (20–45 characters) | App logs and bench, all 3 voices |
| Real-time factor | 0.22–0.30 (about 4× faster than real time) | bench |
| **Time until audio starts**, after `speak()` | **345–722 ms** | App, unmuted, 12 clips (3 voices × 4 phrases) |
| Audio duration (after trimming) | 1.17–2.80 s per test sentence | App and bench |
| Leading silence trimmed | ~0.33–0.44 s per clip (it would otherwise delay the start) | Signal analysis |
| Several short sentences | 6 sentences (95 chars): first audio ready in 257 ms, all synthesized in 1.9 s for 6.6 s of audio | bench |
| Two-sentence confirmed text, in the app | Sentence 1 plays at +464 ms. Sentence 2 is ready at +796 ms and starts when sentence 1 ends (+2.27 s) | E2E logs |
| Memory | Kokoro utility process: **590–793 MB** working set. Plain-Node peak RSS 0.7–1.0 GB | `app.getAppMetrics()`, `/usr/bin/time -l` |
| UI responsiveness during model load | Renderer round-trip max 12 ms, median 2 ms (56 probes) | Playwright probe |
| Network | 0 renderer requests in E2E. The utility process blocks http(s) | E2E and unit tests |

Variant comparison (af_heart, same four sentences, plain Node, before the threads change):

| Variant | Disk | Synthesis per sentence | RSS after load |
| --- | --- | --- | --- |
| fp32 (`model.onnx`), chosen | 326 MB | 483–765 ms | ~790 MB |
| fp16 | 163 MB | 518–798 ms | ~480 MB |
| q8 (`model_quantized.onnx`) | 92 MB | 751–1166 ms | ~370 MB |

fp16 is the fallback choice if memory ever matters more than ~5% speed.

## Pronunciation and audio checks

These checks are objective. They don't replace listening.

- Phonemes Kokoro receives (espeak-ng via kokoro-js) are correct for every test sentence: *penicillin* → `pˌɛnɪsˈɪlᵻn`, *doctor's* → `dˈɑːktɚz`, *three* → `θɹˈiː`, *smoked* → `smˈoʊkt`, *SignFlow* → `sˈaɪn flˈoʊ`. "I am" is phonemized as a quick `aɪɐm`, close to "I'm".
- No clipping (peak 0.45–0.78), no NaN samples. Internal pauses are at most 220 ms, and only at the natural phrase break in the appointment sentence.
- `kokoro-js` 1.2.1's `stream()` never finishes for plain-string input (its sentence splitter is never closed). SignFlow doesn't use it: it splits sentences itself and calls `generate()` per sentence.
- Kokoro's own quality grades: Heart **A**, Bella **A-**, Michael **C+**. Heart is the default.

## Known limits

- One synthesis runs at a time (ONNX Runtime already uses all performance cores). A sentence already inside the model can't be interrupted, but Stop drops its result and everything queued.
- Kokoro truncates input over ~510 tokens, so the app splits long sentences at commas and spaces (≤ 220 characters per chunk).
- The fp32 model costs ~0.6–0.8 GB of RAM while Kokoro is selected.
- The npm packages add ~500 MB to `desktop/node_modules` (ONNX Runtime native and web builds). The repo itself carries no weights.
