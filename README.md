# SignFlow: live ASL sign recognition (hackathon build)

The webcam goes through MediaPipe landmarks and a small classifier, producing 14 isolated ASL signs, which are sent as JSON over a WebSocket. Read the [MODEL_CARD.md](MODEL_CARD.md) for the vocabulary, the numbers and the limitations. CPU only, Python 3.11, macOS tested.

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

Settings (threshold 0.5, segmentation timings, mirrored preview) are in [src/config.py](src/config.py).

## What the frontend receives
One JSON text message per event, on `ws://localhost:8765`. The same lines are printed to stdout; logs go to stderr.
```json
{"type": "sign", "sign": "HELP", "confidence": 0.91, "ts": 1794708452.9}
{"type": "end_of_sentence", "signs": ["HELP", "DOCTOR"], "ts": 1794708458.59}
```
- `sign`: one of BATHROOM, DOCTOR, DRINK, FOOD, HELP, HUNGRY, NO, PLEASE, READY, SORRY, STOP, THANKYOU, THIRSTY, YES. `ts` is a Unix time in seconds.
- Predictions below 0.5 are **not sent**; the live window shows "?" instead.
- The same sign isn't sent twice in a row unless the hands went down in between.
- `end_of_sentence` comes after 1.5 s with the hands down, provided at least one sign was sent.
- `predict_video.py` uses the same threshold: `{"sign": "?", "confidence": 0.43, "best_guess": "HELP"}`.

## Project map
| | |
|---|---|
| `src/features.py` | Shared landmark and feature code (feature sets feat1, feat2, feat2dom) |
| `src/live.py`, `src/live_test.py`, `src/ws_client_demo.py` | Live app, guided test, WebSocket demo client |
| `src/wlasl_select.py`, `wlasl_download.py`, `extract.py` | Data: pick WLASL glosses, download, extract landmarks |
| `src/train_select.py`, `approve_model.py` | Train and compare candidates (never overwrites), promote one to `sign_model.joblib` |
| `src/record_webcam.py`, `eval_webcam.py` | Record your own test clips; evaluate the live model on them |
| `models/` | `sign_model.joblib` (live), versioned models + metrics `.json`, `RELEASE.json` |
| `src/augment.py`, `train.py`, `predict_webcam.py` | Earlier 12-clip beta and the first webcam script (kept for reference) |
