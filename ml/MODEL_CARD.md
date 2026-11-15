# SignFlow sign classifiers: model card

Two models:
- **Demo model** `v2_rf_feat2dom` (14 signs), frozen 2026-11-14 (`models/sign_model.joblib`, sha256 `a638badd…`, see `models/RELEASE.json`). Default for `live.py`. Described first.
- **Keyword model** `v5_keyword_tf_f3_32` (116 signs), 2026-11-15 (`models/keyword_model.joblib`). Used with `--keyword`; it sends the top-5 candidates to the backend agent. Described in [the keyword model section](#keyword-model-116-signs-v5_keyword_tf_f3_32).

## What it does
It recognizes **one isolated ASL sign at a time** from a short webcam clip and returns the sign plus a confidence. If the confidence is below 0.5, the app shows "?" and sends nothing.

**Vocabulary (14 signs):** BATHROOM, DOCTOR, DRINK, FOOD, HELP, HUNGRY, NO, PLEASE, READY, SORRY, STOP, THANK YOU, THIRSTY, YES.

## Data
- **Training:** 120 videos from **WLASL** (Li et al., WACV 2020, via the Kaggle "WLASL processed" mirror), 33 different signers, 5–14 videos per sign.
  - The WLASL authors release it for **academic, non-commercial computational use only**. We don't redistribute the videos.
  - A video was used only if a hand was detected in at least 80% of the frames between the first and last frame with a hand.
- **Test only (never used for training or model selection):**
  - 17 webcam clips recorded by one team member: HELP ×5, and STOP, NO, YES, THANK YOU ×3 each.
  - 11 phone recordings of a dictionary signer shown on a laptop screen.

## How it works
- **Landmarks:** MediaPipe Holistic gives 21 points per hand plus the nose and shoulders, frame by frame.
- **Preprocessing:** the hands are positioned relative to the shoulder midpoint and scaled by shoulder width. Each clip is cut to the frames with a visible hand and resampled to 16 frames.
- **Features:**
  - shoulder-relative positions;
  - **hand shape**: each hand's points relative to its own wrist, scaled by hand size;
  - wrist velocity.
- **Handedness:** the clip is mirrored when the left wrist moves more, so the hand that moves more always ends up in the same position.
- **Classifier:** a RandomForest (300 trees). It was picked from 13 candidates (kNN, RBF-SVM, RandomForest and a small GRU, across 4 feature variants).

## Results
| Test | Result |
|---|---|
| **Held-out signers** (5-fold, grouped by signer: no signer in both train and test) | **top-1 94.0% ± 3.9**, top-3 100% (n = 120 videos) |
| Same test, previous model (no hand-shape features) | top-1 79.5% ± 8.7 |
| Weakest signs (held-out signers) | STOP 80% (4/5), FOOD 86%, THANK YOU 86%, DOCTOR 90%, READY 90%, NO 91% |
| **Our webcam clips** (17) | **14/17**: NO 3/3, STOP 3/3, THANK YOU 3/3, HELP 4/5 (1× STOP), YES 1/3 (DRINK, BATHROOM; all 3 YES clips were below 0.5 and would show "?") |
| Phone clips of a dictionary signer (11) | 9/11 top-1, 11/11 top-3 |
| Confidence threshold 0.5 (held-out signers) | 78% of predictions shown, 97.8% of the shown ones correct |

**Why these numbers are optimistic:**
- The 94% was used to pick the model out of 13 candidates.
- Each sign has only 5–14 videos, so one video moves the per-sign numbers a lot.
- The webcam test covers only 5 of the 14 signs, from one person, in one room.

## Limitations
- **Isolated signs only.** It doesn't understand continuous signing, grammar, facial expressions or fingerspelling. Signs are cut out of the video with a simple hands-up/hands-down rule.
- **Small vocabulary:** 14 signs. Anything else gets mapped to the closest of the 14, or to "?".
- **Mostly unseen users:** most of the 14 signs have never been tested on a real webcam user. YES works poorly for our tester.
- **Handedness rule:** "the hand that moves more" can pick the wrong hand on two-handed signs. That caused the one HELP→STOP miss. Forcing a fixed dominant hand (`--dominant right`) fixes that clip, but breaks STOP (12/17), because the model learned STOP with the automatic rule.
- **Conditions:** it needs good light, with the upper body and both hands in frame.
- **Not a replacement for interpreters.** Don't use it for medical, legal, emergency or other high-stakes communication, even though signs like HELP and DOCTOR are in the vocabulary.

## Keyword model (116 signs): `v5_keyword_tf_f3_32`
`models/keyword_model.joblib` (copy of `models/v5_keyword_tf_f3_32.joblib`, metrics in its `.json`). Full evaluation: `reports/v5_eval.md`; baseline diagnosis: `reports/v5_diagnosis.md`.

### What it does
For every sign that the hands-down segmenter cuts from the webcam stream, it returns **the 5 most likely of 116 ASL signs with calibrated probabilities**. The backend agent picks the word from the sentence context. `confident` is true when the top-1 probability is at least 0.35 (`--threshold`). The candidates are sent either way. The English words, synonyms and categories of the 116 signs are in `models/vocab_116.json`.

### Data
- **1,106 WLASL videos** (Li et al., WACV 2020, via the Kaggle "WLASL processed" mirror), **64 signers**, 116 glosses, 5-16 videos per sign (median 9).
  - Glosses: WLASL100 + care-list words with >= 8 videos + the 14 demo signs; glosses with < 6 usable videos dropped (CLOTHES, EAT, PURPLE, TABLE).
  - A video is used only if a hand is detected in >= 80% of the frames between the first and last hand frame.
  - **License:** the WLASL authors release it for **academic, non-commercial computational use only**. We don't redistribute the videos; derived landmarks and models inherit that restriction.
- **No NOTHING (non-sign) class:** the downloaded clips are pre-cut to the sign (no frames outside the sign), and no idle recordings of ours exist yet. `record_session.py --signs NOTHING` adds them.
- **Test only:** the 17 webcam clips of one team member (HELP x5, STOP / NO / YES / THANK YOU x3). They were never used for training or for any choice.

### How it works
- **Landmarks:** MediaPipe Holistic: 21 points per hand, nose, shoulders, plus 7 face points (nose tip, chin, mouth corners, cheeks, forehead).
- **Features (feat3), 32 frames per sign:**
  - shoulder-relative positions and hand shape;
  - finger joint and spread angles, fingertip-to-fingertip distances;
  - distances of the wrist and fingertips to the face points;
  - wrist velocity and acceleration, two-hand distances.
  - Clips are mirrored so the hand that moves more is always in the same position, as in the demo model.
- **Training data:** each video plus 10 augmented copies (20 for signs with <= 6 videos):
  - rotation, scale, shift, jitter, time stretch;
  - segmentation jitter (start and end moved up to 25%, like live segments);
  - mirroring for two-handed-ish clips;
  - class-balanced sampling.
- **Model:** **ensemble of 5 small transformer encoders** (2 layers, width 128, 5 seeds, logits averaged), label smoothing 0.1, temperature scaling (T = 0.834). Picked by macro top-1 on held-out signers from 5 complete candidate configurations (a 6th, a 32-frame CNN, was stopped to stay within the 2-hour budget). Then an ensemble, test-time augmentation and pair specialists were tested; only the ensemble helped.

### Results
Held-out signers: 5-fold cross-validation grouped by signer (no signer in both train and test), the same 5 folds for v4 and v5.

| | v4_cnn_vocab116 (previous) | **v5 keyword model** |
|---|---|---|
| macro top-1 / top-5 (mean over the 116 signs) | 61.2% / 83.3% | **75.6% / 90.9%** |
| overall top-1 / top-3 / top-5 (all 1,106 videos) | 60.5% / 77.8% / 82.9% | **74.8% / 87.7% / 90.3%** |
| signs with top-1 >= 50% / >= 80% | 84 / 34 | **106 / 56** |
| signs with top-5 >= 80% | 78 | **97** |
| worst 10 signs, mean top-1 / top-5 | 17.2% / 51.3% | 30.3% / 68.4% |
| on the segment the live rule cuts (missed clips count as wrong) top-1 / top-5 | 58.6% / 79.6% | 72.1% / 86.8% |
| the 14 demo signs (mean top-1, all 116 classes competing) | 72.5% | 83.4% |
| **our webcam clips** (17), top-1 / top-5 | 10/17 / 17/17 | **13/17 / 17/17** |
| time per sign (features + model; MediaPipe runs per frame either way) | 0.6 ms | 3.1 ms |

- **Webcam per sign (v5):** HELP 5/5, NO 3/3, YES 3/3, STOP 1/3 (2x COOK), THANK YOU 1/3 (2x GIVE). The right sign is first or second in all 17.
- **Weakest signs (top-1 / top-5):** TELL 0% / 29%, PIZZA 8% / 50%, COOL 19% / 81%, HEARING 33% / 83%, CANDY 36% / 73%, SAME 38% / 100%, STOP 40% / 60%, THIN 42% / 58%, COMPUTER 43% / 50%, NOW 44% / 100%.
- 79 signs improved over v4, 24 stayed the same and 13 got worse (the biggest drops: HEARING 67 -> 33%, NOW 67 -> 44%, PIZZA 25 -> 8%, DRINK 83 -> 67%).

**Confidence threshold** (calibrated top-1 probability, held-out signers):

| threshold | signs marked confident | wrong among the confident ones |
|---|---|---|
| 0.25 | 95.2% | 22.8% |
| **0.35 (default)** | **90.7%** | **20.6%** |
| 0.5 | 82.5% | 17.4% |
| v4's old rule (top-1 - top-2 >= 0.4) | 41.5% | 12.0% |

Calibration error (ECE) is 0.075 before and 0.065 after temperature scaling.

**False keywords:**
- **Idle:** in your 3 complete live tests (3 x 20 s idle), the segmenter cut 0 segments, so nothing was sent.
- **Signs outside the vocabulary:** 19 clips of the 4 dropped glosses. **53% come out as a confident keyword at 0.35**: the model maps unknown signs to the closest known one.

**Why these numbers are optimistic:**
- The configuration was chosen on the same cross-validation folds (about 9 options compared).
- The validation sets used for early stopping and calibration are small (35-160 clips per fold).
- The webcam test covers only 5 signs from one person in one room.
- In your live tests with v4, SICK and MEDICINE failed much more often than on WLASL. Live signing differs from the dictionary videos.

### Limitations
- **Isolated signs only.** No grammar, facial expressions, fingerspelling or continuous signing. Each sign needs hands up, then down.
- **Unknown signs and gestures are not rejected.** They come out as one of the 116 signs, often confident. The backend should treat `confident` as a hint, not a guarantee.
- **Similar signs get confused.** Examples: STOP / COOK, THANK YOU / GIVE, LIKE / SAME, NOW / TODAY. Expect them as candidates 1 and 2.
- **Signed low on the body?** In 49 of the 1,106 WLASL clips (4.4%) no wrist rises above mid-chest, so live segmentation would miss the sign. NOW, BOWLING, WHAT, FISH and TODAY are affected most.
- **Few examples per sign** (5-16), mostly dictionary-style signers. Recording your own clips (`reports/record_next.md`) is the most direct way to improve the weak signs.
- **Not a replacement for interpreters.** Don't use it for medical, legal or emergency communication.
