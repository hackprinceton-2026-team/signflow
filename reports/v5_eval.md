# v5 keyword model: evaluation (held-out signers)

Generated 2026-11-15 03:11 by `src/train_keyword.py report`. Identical protocol for every row: the 1,106 WLASL videos, the 5 signer folds of v4 (GroupKFold, seed 0), test = held-out signers. Probabilities are temperature-scaled per fold on that fold's validation signers (v4: uncalibrated). Webcam = 17 test clips, scored with the mean of the 5 fold models (v4: its final model); never used for any choice.

## Candidates

| candidate | macro top-1 | macro top-5 | overall top-1 / top-3 / top-5 | signs >= 50% / >= 80% | live-rule segments top-1 / top-5 | webcam top-1 / top-5 | ECE raw -> calibrated | CV train time |
|---|---|---|---|---|---|---|---|---|
| v4_cnn (baseline) | 61.2% | 83.3% | 60.5% / 77.8% / 82.9% | 84 / 34 | 58.6% / 79.6% | 10/17 / 17/17 | 0.140 -> 0.140 | - |
| cnn_f2_16_nobal | 61.2% | 83.9% | 60.8% / 77.6% / 83.5% | 81 / 27 | 58.6% / 80.1% | 15/17 / 17/17 | 0.174 -> 0.065 | 44 CPU-min |
| cnn_f2_16 | 63.1% | 85.1% | 61.8% / 79.7% / 84.3% | 85 / 33 | 59.9% / 80.7% | 13/17 / 17/17 | 0.142 -> 0.053 | 31 CPU-min |
| cnn_f3_16 | 67.8% | 88.9% | 67.4% / 84.4% / 88.3% | 91 / 45 | 65.8% / 85.2% | 15/17 / 17/17 | 0.149 -> 0.069 | 46 CPU-min |
| tf_f3_16 | 69.7% | 88.0% | 68.9% / 82.7% / 87.3% | 94 / 48 | 66.3% / 83.2% | 16/17 / 17/17 | 0.053 -> 0.059 | 11 CPU-min |
| tf_f3_32 | 70.8% | 87.6% | 70.1% / 83.9% / 87.0% | 99 / 45 | 67.5% / 84.0% | 16/17 / 17/17 | 0.046 -> 0.041 | 41 CPU-min |
| tf_f3_32 x5 seeds | 75.6% | 90.9% | 74.8% / 87.7% / 90.3% | 106 / 56 | 72.1% / 86.8% | 16/17 / 17/17 | 0.075 -> 0.065 | 165 CPU-min |
| tf_f3_32 x5 seeds + TTA | 75.5% | 90.9% | 74.9% / 87.5% / 90.2% | 105 / 59 | 72.3% / 87.1% | 16/17 / 17/17 | 0.066 -> 0.063 | 165 CPU-min |
| tf_f3_32 x5 seeds + specialists | 75.4% | 90.9% | 74.6% / 87.6% / 90.3% | 105 / 56 | 71.9% / 86.8% | 16/17 / 17/17 | 0.075 -> 0.066 | 165 CPU-min |

## Decisions (in order)

1. New trainer without Phase 2 (`cnn_f2_16_nobal`, same features/augmentation as v4) vs v4: macro top-1 61.2% -> 61.2%, macro top-5 83.3% -> 83.9% (trainer differences only: fixed validation signers per fold, early stopping on (top-1 + top-5) / 2).
2. Phase 2 data (balanced sampling, segmentation jitter, mirror, extra copies): `cnn_f2_16_nobal` -> `cnn_f2_16`: macro top-1 61.2% -> 63.1%, macro top-5 83.9% -> 85.1% -> helped.
3. features v3 (angles, fingertip and face distances, acceleration): `cnn_f2_16` -> `cnn_f3_16`: macro top-1 63.1% -> 67.8%, macro top-5 85.1% -> 88.9% -> helped.
4. 32 frames instead of 16 (transformer): `tf_f3_16` -> `tf_f3_32`: macro top-1 69.7% -> 70.8%, macro top-5 88.0% -> 87.6% -> helped.
5. transformer instead of 1D-CNN (16 frames): `cnn_f3_16` -> `tf_f3_16`: macro top-1 67.8% -> 69.7%, macro top-5 88.9% -> 88.0% -> helped.
6. Best single model (macro top-1, then macro top-5): `tf_f3_32`.
7. `cnn_f3_32` was stopped after 1 of 5 folds to stay within the 2 h training budget (one thread per fold; projected > 1 h for the run, and the 5-seed ensemble would have been ~5x more): fold 1 (n = 146): top-1 76.0% / top-5 89.7% vs `tf_f3_32` 73.3% / 89.0%, 28 min for this fold. Promising but not a complete result, so it was not selected. It is the first thing to try with more CPU time.
8. Ensemble of 5 seeds (logits averaged): macro top-1 70.8% -> 75.6%, macro top-5 87.6% -> 90.9% -> helped, kept.
9. Test-time augmentation (7 views: segment start/end +-10%, scale 0.95/1.05): macro top-1 75.6% -> 75.5%, macro top-5 90.9% -> 90.9% -> did not help (latency checked in `final`, budget 150 ms).
10. Pair specialists (10 pairs per fold, kept if better on that fold's validation signers: 7 of 50 kept): macro top-1 75.6% -> 75.4%, macro top-5 90.9% -> 90.9% -> did not help, not used.
11. Temperature scaling (fitted per fold on the validation signers, fold temperatures [0.847, 0.851, 0.751, 0.834, 0.74]): ECE on held-out signers 0.075 -> 0.065 -> helped, kept (final model: median temperature). Ranking is unchanged, so top-k is unaffected.
12. Promotion rule vs v4_cnn on held-out signers: macro top-1 61.2% -> 75.6% (higher), macro top-5 83.3% -> 90.9% (not lower); the webcam top-5 part is checked on the final model.

## Worst 10 signs: v4 vs tf_f3_32 x5 seeds

| v4 worst 10 | v4 top-1 / top-5 | -> v5 top-1 / top-5 | v5 worst 10 | v5 top-1 / top-5 | v5 shown at 0.35 |
|---|---|---|---|---|---|
| STOP | 0% / 0% | 40% / 60% | TELL | 0% / 29% | 86% |
| AGAIN | 12% / 50% | 50% / 75% | PIZZA | 8% / 50% | 83% |
| TELL | 14% / 14% | 0% / 29% | COOL | 19% / 81% | 81% |
| CANDY | 18% / 45% | 36% / 73% | HEARING | 33% / 83% | 83% |
| LETTER | 18% / 64% | 64% / 91% | CANDY | 36% / 73% | 100% |
| COOL | 19% / 69% | 19% / 81% | SAME | 38% / 100% | 75% |
| WOMAN | 20% / 80% | 50% / 90% | STOP | 40% / 60% | 60% |
| PULL | 22% / 56% | 100% / 100% | THIN | 42% / 58% | 92% |
| SHORT | 23% / 77% | 77% / 85% | COMPUTER | 43% / 50% | 86% |
| PIZZA | 25% / 58% | 8% / 50% | NOW | 44% / 100% | 89% |

## Top 20 confused pairs: v4 vs tf_f3_32 x5 seeds

| # | v4 pair | errors (A->B / B->A) | v5 pair | errors (A->B / B->A) |
|---|---|---|---|---|
| 1 | LIKE / SAME | 7 (4 / 3) | NOW / TODAY | 7 (4 / 3) |
| 2 | NEED / YES | 6 (2 / 4) | NO / PIZZA | 6 (1 / 5) |
| 3 | NOW / TODAY | 6 (1 / 5) | APPLE / COOL | 5 (1 / 4) |
| 4 | BEFORE / GO | 5 (2 / 3) | LIKE / SAME | 4 (3 / 1) |
| 5 | NO / PIZZA | 5 (2 / 3) | ACCIDENT / WRONG | 4 (3 / 1) |
| 6 | APPLE / COOL | 5 (3 / 2) | TELL / THIRSTY | 4 (4 / 0) |
| 7 | CANDY / PINK | 4 (2 / 2) | GOOD / THANKYOU | 4 (3 / 1) |
| 8 | HELP / PULL | 4 (2 / 2) | COMPUTER / COUSIN | 3 (2 / 1) |
| 9 | MANY / WANT | 4 (4 / 0) | CANDY / PINK | 3 (2 / 1) |
| 10 | WANT / WHAT | 4 (2 / 2) | FINE / WOMAN | 3 (1 / 2) |
| 11 | CORN / HEARING | 4 (2 / 2) | NO / RIGHT | 3 (1 / 2) |
| 12 | LATER / TALL | 4 (3 / 1) | BAD / HOT | 3 (2 / 1) |
| 13 | ACCIDENT / WRONG | 4 (4 / 0) | MANY / WANT | 3 (2 / 1) |
| 14 | COW / YESTERDAY | 4 (3 / 1) | MOTHER / WOMAN | 3 (1 / 2) |
| 15 | AGAIN / DANCE | 4 (2 / 2) | WANT / WHAT | 3 (1 / 2) |
| 16 | COMPUTER / HAT | 3 (2 / 1) | GRADUATE / MEET | 3 (2 / 1) |
| 17 | BEFORE / LAST | 3 (1 / 2) | HAT / LATER | 3 (2 / 1) |
| 18 | CHANGE / GO | 3 (0 / 3) | CORN / HEARING | 3 (1 / 2) |
| 19 | CANDY / WHO | 3 (2 / 1) | LATER / TALL | 3 (3 / 0) |
| 20 | CANDY / DOG | 3 (1 / 2) | AFRICA / APPLE | 3 (2 / 1) |

## Confidence threshold on the calibrated top-1 probability (tf_f3_32 x5 seeds)

| rule | shown | wrong among shown |
|---|---|---|
| top-1 >= 0.25 | 95.2% | 22.8% |
| top-1 >= 0.35 (default) | 90.7% | 20.6% |
| top-1 >= 0.5 | 82.5% | 17.4% |
| v4 rule (v4 model: top-1 - top-2 >= 0.4) | 41.5% | 12.0% |
| v4 model, raw top-1 >= 0.25 | 71.2% | 27.6% |
| v4 model, raw top-1 >= 0.35 | 57.4% | 21.1% |
| v4 model, raw top-1 >= 0.5 | 41.1% | 14.1% |

Candidates are always sent to the backend; the threshold only sets `confident` and the on-screen label.

## NOTHING / false keywords

No NOTHING class was trained: the WLASL clips in this dataset are pre-cut (every manifest entry has frame_start 1 / frame_end -1, and only 2 of WLASL's 2,131 frame-bounded instances exist in the Kaggle mirror), and data/me/NOTHING does not exist. Real idle measurement: your 3 complete live tests each ran a 20 s idle check: 0 segments, 0 keywords (the hands-down segmenter never fires while the hands rest). Proxy for non-vocabulary movement: the kept clips of the 4 dropped glosses (CLOTHES, EAT, PURPLE, TABLE), predicted by the fold model of their signer; a clip counts as a false keyword when its calibrated top-1 is above the threshold.

| model | out-of-vocabulary clips confident at 0.25 / 0.35 / 0.5 |
|---|---|
| v4_cnn (baseline) | 84% / 58% / 37% (n = 19) |
| cnn_f2_16_nobal | 100% / 79% / 58% (n = 19) |
| cnn_f2_16 | 95% / 89% / 68% (n = 19) |
| cnn_f3_16 | 89% / 84% / 68% (n = 19) |
| tf_f3_16 | 100% / 95% / 74% (n = 19) |
| tf_f3_32 | 84% / 68% / 47% (n = 19) |
| tf_f3_32 x5 seeds | 79% / 53% / 53% (n = 19) |
| tf_f3_32 x5 seeds + TTA | 79% / 53% / 53% (n = 19) |
| tf_f3_32 x5 seeds + specialists | 79% / 53% / 53% (n = 19) |

## Pair specialists (tf_f3_32 x5 seeds)

| fold | pair | confusions used to pick it | val clips | specialist right | main model right | kept |
|---|---|---|---|---|---|---|
| 0 | APPLE / COOL | 8 | 7 | 5 | 3 | yes |
| 0 | NEED / YES | 6 | 5 | 4 | 5 | no |
| 0 | LIKE / SAME | 6 | 3 | 2 | 2 | no |
| 0 | MANY / WANT | 6 | 5 | 4 | 3 | yes |
| 0 | NOW / TODAY | 6 | 3 | 1 | 2 | no |
| 0 | BEFORE / GO | 5 | 3 | 3 | 3 | no |
| 0 | CANDY / PINK | 5 | 7 | 2 | 3 | no |
| 0 | GRADUATE / HELP | 4 | 1 | 0 | 0 | no |
| 0 | NO / PIZZA | 4 | 5 | 2 | 4 | no |
| 0 | CORN / HEARING | 4 | 4 | 2 | 3 | no |
| 1 | LIKE / SAME | 7 | 0 | - | - | no |
| 1 | NOW / TODAY | 6 | 0 | - | - | no |
| 1 | BEFORE / GO | 5 | 0 | - | - | no |
| 1 | NEED / YES | 5 | 0 | - | - | no |
| 1 | APPLE / COOL | 5 | 0 | - | - | no |
| 1 | WANT / WHAT | 5 | 1 | 0 | 0 | no |
| 1 | NO / PIZZA | 4 | 1 | 1 | 1 | no |
| 1 | MANY / WANT | 4 | 0 | - | - | no |
| 1 | CORN / HEARING | 4 | 2 | 2 | 2 | no |
| 1 | LATER / TALL | 4 | 0 | - | - | no |
| 2 | NEED / YES | 6 | 2 | 2 | 2 | no |
| 2 | APPLE / COOL | 6 | 3 | 2 | 2 | no |
| 2 | LIKE / SAME | 6 | 0 | - | - | no |
| 2 | BEFORE / GO | 5 | 2 | 2 | 2 | no |
| 2 | NO / PIZZA | 5 | 0 | - | - | no |
| 2 | CANDY / PINK | 4 | 1 | 1 | 1 | no |
| 2 | HELP / PULL | 4 | 1 | 1 | 1 | no |
| 2 | NOW / TODAY | 4 | 0 | - | - | no |
| 2 | WANT / WHAT | 4 | 2 | 1 | 0 | yes |
| 2 | ACCIDENT / WRONG | 4 | 1 | 1 | 1 | no |
| 3 | ACCIDENT / WRONG | 7 | 6 | 3 | 3 | no |
| 3 | LIKE / SAME | 6 | 4 | 4 | 3 | yes |
| 3 | CORN / HEARING | 5 | 1 | 1 | 0 | yes |
| 3 | TELL / WHO | 5 | 5 | 5 | 2 | yes |
| 3 | NOW / TODAY | 5 | 2 | 2 | 2 | no |
| 3 | BEFORE / LAST | 4 | 6 | 5 | 3 | yes |
| 3 | NO / PIZZA | 4 | 0 | - | - | no |
| 3 | APPLE / COOL | 4 | 5 | 3 | 4 | no |
| 3 | COMPUTER / HAT | 3 | 2 | 2 | 2 | no |
| 3 | CANDY / WHO | 3 | 4 | 4 | 4 | no |
| 4 | NO / PIZZA | 6 | 4 | 1 | 2 | no |
| 4 | NOW / TODAY | 6 | 2 | 0 | 0 | no |
| 4 | NEED / YES | 5 | 1 | 1 | 1 | no |
| 4 | CANDY / PINK | 4 | 1 | 1 | 1 | no |
| 4 | LIKE / SAME | 4 | 1 | 1 | 1 | no |
| 4 | WANT / WHAT | 4 | 2 | 1 | 2 | no |
| 4 | COW / YESTERDAY | 4 | 2 | 2 | 2 | no |
| 4 | COMPUTER / WORK | 3 | 2 | 1 | 1 | no |
| 4 | CHANGE / GO | 3 | 1 | 1 | 1 | no |
| 4 | BEFORE / GO | 3 | 3 | 2 | 3 | no |

## All signs (tf_f3_32 x5 seeds), worst first

| sign | videos | v4 top-1 / top-5 | v5 top-1 / top-5 |
|---|---|---|---|
| TELL | 7 | 14% / 14% | 0% / 29% |
| PIZZA | 12 | 25% / 58% | 8% / 50% |
| COOL | 16 | 19% / 69% | 19% / 81% |
| HEARING | 6 | 67% / 100% | 33% / 83% |
| CANDY | 11 | 18% / 45% | 36% / 73% |
| SAME | 8 | 25% / 88% | 38% / 100% |
| STOP | 5 | 0% / 0% | 40% / 60% |
| THIN | 12 | 33% / 50% | 42% / 58% |
| COMPUTER | 14 | 50% / 64% | 43% / 50% |
| NOW | 9 | 67% / 100% | 44% / 100% |
| LAST | 12 | 33% / 67% | 50% / 58% |
| WHAT | 12 | 42% / 58% | 50% / 58% |
| CHEAT | 10 | 50% / 50% | 50% / 60% |
| AGAIN | 8 | 12% / 50% | 50% / 75% |
| ALL | 8 | 62% / 88% | 50% / 88% |
| WOMAN | 10 | 20% / 80% | 50% / 90% |
| LATER | 12 | 42% / 50% | 50% / 100% |
| TODAY | 9 | 33% / 89% | 56% / 78% |
| WANT | 9 | 44% / 78% | 56% / 89% |
| SCHOOL | 9 | 44% / 78% | 56% / 100% |
| HAT | 7 | 43% / 71% | 57% / 71% |
| PAINT | 7 | 71% / 71% | 57% / 100% |
| GRADUATE | 10 | 40% / 60% | 60% / 70% |
| WHITE | 10 | 60% / 70% | 60% / 70% |
| LIKE | 10 | 50% / 80% | 60% / 90% |
| FISH | 10 | 50% / 90% | 60% / 100% |
| BAD | 8 | 25% / 62% | 62% / 88% |
| COOK | 8 | 25% / 75% | 62% / 100% |
| DOG | 11 | 55% / 82% | 64% / 73% |
| LETTER | 11 | 18% / 64% | 64% / 91% |
| GO | 15 | 40% / 40% | 67% / 73% |
| AFRICA | 9 | 56% / 67% | 67% / 78% |
| RIGHT | 9 | 33% / 78% | 67% / 78% |
| BOWLING | 12 | 75% / 83% | 67% / 92% |
| CORN | 12 | 42% / 83% | 67% / 92% |
| DRINK | 12 | 83% / 92% | 67% / 92% |
| BEFORE | 16 | 50% / 81% | 69% / 81% |
| ACCIDENT | 13 | 62% / 85% | 69% / 92% |
| GOOD | 10 | 60% / 100% | 70% / 90% |
| HOT | 10 | 70% / 80% | 70% / 100% |
| WAIT | 10 | 50% / 70% | 70% / 100% |
| BLACK | 7 | 29% / 57% | 71% / 86% |
| BUT | 7 | 43% / 86% | 71% / 86% |
| JACKET | 7 | 57% / 100% | 71% / 100% |
| NO | 11 | 73% / 100% | 73% / 100% |
| WHO | 11 | 55% / 82% | 73% / 100% |
| DARK | 12 | 75% / 75% | 75% / 75% |
| PINK | 8 | 50% / 88% | 75% / 88% |
| YES | 12 | 42% / 92% | 75% / 92% |
| BED | 12 | 67% / 100% | 75% / 100% |
| MEDICINE | 8 | 50% / 62% | 75% / 100% |
| TIME | 8 | 88% / 88% | 75% / 100% |
| WHEN | 8 | 88% / 100% | 75% / 100% |
| SHORT | 13 | 23% / 77% | 77% / 85% |
| THANKSGIVING | 13 | 69% / 85% | 77% / 92% |
| APPLE | 9 | 44% / 89% | 78% / 89% |
| KISS | 9 | 67% / 78% | 78% / 89% |
| COW | 9 | 67% / 100% | 78% / 100% |
| DECIDE | 9 | 78% / 100% | 78% / 100% |
| FINE | 9 | 33% / 89% | 78% / 100% |
| DOCTOR | 10 | 60% / 70% | 80% / 90% |
| MANY | 10 | 50% / 100% | 80% / 100% |
| YEAR | 10 | 90% / 100% | 80% / 100% |
| THURSDAY | 11 | 82% / 91% | 82% / 91% |
| BIRTHDAY | 6 | 67% / 83% | 83% / 83% |
| BLUE | 6 | 67% / 83% | 83% / 100% |
| CHANGE | 12 | 75% / 100% | 83% / 100% |
| FORGET | 6 | 83% / 100% | 83% / 100% |
| THIRSTY | 6 | 67% / 100% | 83% / 100% |
| BATHROOM | 7 | 100% / 100% | 86% / 100% |
| DANCE | 7 | 57% / 71% | 86% / 100% |
| FOOD | 7 | 86% / 100% | 86% / 100% |
| PAPER | 7 | 71% / 100% | 86% / 100% |
| THANKYOU | 7 | 71% / 100% | 86% / 100% |
| CITY | 8 | 50% / 75% | 88% / 88% |
| COLOR | 8 | 62% / 88% | 88% / 88% |
| SICK | 8 | 88% / 88% | 88% / 88% |
| WRONG | 8 | 88% / 100% | 88% / 100% |
| FINISH | 9 | 44% / 67% | 89% / 89% |
| GIVE | 9 | 67% / 78% | 89% / 89% |
| MEET | 9 | 89% / 89% | 89% / 89% |
| FULL | 10 | 60% / 80% | 90% / 90% |
| MOTHER | 10 | 90% / 90% | 90% / 90% |
| SECRETARY | 10 | 30% / 80% | 90% / 100% |
| YESTERDAY | 10 | 90% / 100% | 90% / 100% |
| MAN | 11 | 91% / 91% | 91% / 91% |
| FAMILY | 11 | 82% / 100% | 91% / 100% |
| PLAY | 11 | 82% / 100% | 91% / 100% |
| WALK | 11 | 91% / 100% | 91% / 100% |
| BASKETBALL | 12 | 92% / 92% | 92% / 100% |
| COLD | 12 | 92% / 92% | 92% / 100% |
| SHIRT | 12 | 83% / 100% | 92% / 100% |
| COUSIN | 13 | 62% / 100% | 92% / 100% |
| HELP | 14 | 50% / 93% | 93% / 100% |
| BIRD | 10 | 100% / 100% | 100% / 100% |
| BOOK | 6 | 67% / 100% | 100% / 100% |
| BROWN | 8 | 88% / 100% | 100% / 100% |
| CAN | 9 | 89% / 100% | 100% / 100% |
| CHAIR | 7 | 86% / 100% | 100% / 100% |
| DEAF | 11 | 82% / 100% | 100% / 100% |
| ENJOY | 8 | 75% / 75% | 100% / 100% |
| HEADACHE | 9 | 100% / 100% | 100% / 100% |
| HOW | 9 | 78% / 100% | 100% / 100% |
| HUNGRY | 6 | 83% / 100% | 100% / 100% |
| LANGUAGE | 10 | 50% / 90% | 100% / 100% |
| NEED | 6 | 50% / 83% | 100% / 100% |
| ORANGE | 7 | 86% / 100% | 100% / 100% |
| PLEASE | 7 | 100% / 100% | 100% / 100% |
| PULL | 9 | 22% / 56% | 100% / 100% |
| READY | 10 | 100% / 100% | 100% / 100% |
| SON | 10 | 90% / 100% | 100% / 100% |
| SORRY | 6 | 100% / 100% | 100% / 100% |
| STUDY | 10 | 80% / 100% | 100% / 100% |
| TALL | 12 | 58% / 58% | 100% / 100% |
| WATER | 7 | 86% / 100% | 100% / 100% |
| WORK | 10 | 70% / 100% | 100% / 100% |
