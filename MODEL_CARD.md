# SignFlow sign classifier: model card

**Release:** `v2_rf_feat2dom`, frozen 2026-11-14 (`models/sign_model.joblib`, sha256 `a638badd…`, see `models/RELEASE.json`).

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
