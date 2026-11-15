# SignFlow: live ASL sign recognition (hackathon build)

The webcam goes through MediaPipe landmarks and a small classifier, producing isolated ASL signs, which are sent as JSON over a WebSocket. There are two models: the 14-sign demo model (default) and a 116-sign keyword model (`--keyword`) that sends the top-5 candidates per sign to a backend agent. Read the [MODEL_CARD.md](MODEL_CARD.md) for the vocabulary, the numbers and the limitations. CPU only, Python 3.11, macOS tested.

## Setup
```bash
python3.11 -m venv slenv && source slenv/bin/activate
pip install -r requirements.txt
```
On the first camera run, macOS will ask for camera permission for your terminal or VS Code. Allow it, then restart that app.

## Run
```bash
python src/live.py                     # live recognition window + ws://localhost:8765
python src/live.py --spacebar          # fallback: press SPACE, then sign (1 s countdown, 2.5 s recording)
python src/ws_client_demo.py           # 2nd terminal: prints what the frontend receives
python src/live.py --headless --video data/webcam/HELP-20261114-200819.mp4   # no camera: replay a clip
python src/live_test.py                # guided test: 14 signs x 3 + 20 s idle check -> logs/
python src/predict_video.py some_clip.mp4                                      # one file -> one JSON
```

**How to sign:** keep your upper body and both hands in view. Raise your hands above mid-chest, make the sign, then lower your hands. Lowering them ends the sign, and keeping them down for 1.5 s ends the sentence.

Useful flags for `live.py` and `live_test.py`:
- `--dominant auto|right|left`: `auto` is the default and matches how the model was trained. With `right`/`left`, the hand you name is always treated as dominant (see the model card).
- `--spacebar`: SPACE-triggered recording instead of automatic segmentation.
- `--camera N`: use a different camera.

Settings (demo threshold 0.5, keyword threshold 0.35, segmentation timings, mirrored preview) are in [src/config.py](src/config.py).

## Keyword mode (116 signs, for the backend agent)
The demo model (14 signs, above) stays the default. Keyword mode uses `models/keyword_model.joblib`: 116 ASL signs, one message **per segmented sign with its top-5 candidates**, so the backend can build the sentence from context. On signers it never saw, the right sign is first 75% of the time and in the top 5 91% of the time (macro over the 116 signs). On our 17 webcam clips: 13/17 first, 17/17 in the top 5. Details, weak signs and limitations: [MODEL_CARD.md](MODEL_CARD.md), `reports/v5_eval.md`.
```bash
python src/live.py --keyword                          # live window + ws://localhost:8765, keyword JSON
python src/live.py --keyword --threshold 0.25         # "confident" at a lower calibrated top-1 probability
python src/live_test.py --keyword --signs "HELP,WATER,MOTHER,SICK,MEDICINE,HEADACHE" --reps 3
python src/predict_video.py clip.mp4 --keyword        # one file -> one keyword JSON
```
- `--threshold` (default 0.35, `KEYWORD_THRESHOLD` in `src/config.py`) applies to the **calibrated** top-1 probability. It only sets `confident` and the on-screen label (top-1 when confident, otherwise "?" plus the top-3). The candidates are always sent.
- [models/vocab_116.json](models/vocab_116.json): for every sign, the English word(s), simple synonyms and a category (health, people, time, food, feelings, actions, questions, other) for the backend.
- `--model` also works with the older expanded models (e.g. `models/v4_cnn_vocab116.joblib`); every expanded model runs in keyword mode.

**Teach it your signing:** record the weakest signs, then retrain with one command. Details and the sign list are in `reports/record_next.md`.
```bash
python src/record_session.py --signs "AGAIN,TELL,SAME" --reps 8 --session s1          # training clips -> data/me/
python src/record_session.py --signs "AGAIN,TELL,SAME" --reps 3 --session t1 --test   # personal test set
python src/train_keyword.py retrain --version v6                                    # CV + report + final model
```
Your clips are weighted 3x and only ever used for training (the `--test` session is test-only), and `data/me/` is git-ignored. Recording `--signs NOTHING` (scratching your nose, touching your hair, waving) trains a non-sign class that is never sent.

## What the frontend receives
One JSON text message per event, on `ws://localhost:8765`. The same lines are printed to stdout; logs go to stderr.

**Keyword mode** (`--keyword`): one `sign` message for every segmented sign, even when it is not confident:
```json
{"type": "sign", "candidates": [["HEADACHE", 0.62], ["HOT", 0.14], ["SICK", 0.07], ["COLD", 0.05], ["MEDICINE", 0.04]], "top1": "HEADACHE", "confident": true, "ts": 1794708452.9}
{"type": "end_of_sentence", "signs": ["HEADACHE", "MEDICINE"], "confident": [true, false], "ts": 1794708458.59}
```
- `candidates`: the top 5 signs with their calibrated probabilities. `top1` is the first of them, and `confident` is true when its probability is at least `--threshold` (0.35).
- NOTHING (the non-sign class, only present if you recorded it) is never sent. The same `top1` isn't sent twice in a row unless the hands went down in between.

**Demo model** (default, 14 signs):
```json
{"type": "sign", "sign": "HELP", "confidence": 0.91, "candidates": [["HELP", 0.91], ["STOP", 0.05], ["DOCTOR", 0.02]], "ts": 1794708452.9}
{"type": "end_of_sentence", "signs": ["HELP", "DOCTOR"], "ts": 1794708458.59}
```
- `sign`: one of BATHROOM, DOCTOR, DRINK, FOOD, HELP, HUNGRY, NO, PLEASE, READY, SORRY, STOP, THANKYOU, THIRSTY, YES. `ts` is a Unix time in seconds.
- `candidates`: the top 3 signs with their probabilities, for the backend to choose using the sentence context.
- Predictions below 0.5 are **not sent** (demo model); the live window shows "?" instead.
- The same sign isn't sent twice in a row unless the hands went down in between.
- `end_of_sentence` comes after 1.5 s with the hands down, provided at least one sign was sent.
- `predict_video.py` uses the same rule, and also takes `--model`: `{"sign": "?", "confidence": 0.43, "best_guess": "HELP", "candidates": [...]}`.

## Project map
| | |
|---|---|
| `src/features.py` | Shared landmark and feature code (feature sets feat1, feat2, feat2dom, feat3) |
| `src/live.py`, `src/live_test.py`, `src/ws_client_demo.py` | Live app, guided test, WebSocket demo client |
| `src/wlasl_select.py`, `wlasl_download.py`, `extract.py` | Data: pick WLASL glosses, download, extract landmarks |
| `src/train_select.py`, `approve_model.py` | Train and compare candidates (never overwrites), promote one to `sign_model.joblib` |
| `src/vocab_report.py`, `train_vocab.py`, `cnn.py` | Vocabulary coverage report; train and evaluate the v4 expanded models (`reports/`) |
| `src/diagnose_v4.py`, `train_keyword.py`, `keyword_data.py`, `seqmodels.py`, `keyword_model.py` | v5 keyword model: baseline diagnosis, training/evaluation, data and augmentation, CNN/transformer, the saved model object |
| `src/record_session.py` | Record your own clips for the keyword model (`data/me/`) |
| `src/record_webcam.py`, `eval_webcam.py` | Record your own test clips; evaluate the live model on them |
| `models/` | `sign_model.joblib` (demo), `keyword_model.joblib` (keyword mode), `vocab_116.json`, versioned models + metrics `.json`, `RELEASE.json` |
| `src/augment.py`, `train.py`, `predict_webcam.py` | Earlier 12-clip beta and the first webcam script (kept for reference) |
