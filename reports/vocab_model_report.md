# Expanded vocabulary: 116 glosses (experiment, not the demo model)

Generated 2026-11-15 00:08 by `src/train_vocab.py` in 17.2 min. Held-out signers = 5-fold GroupKFold by signer (seed 0); the 17 webcam clips were never used for any choice.

Dropped glosses (< 6 usable videos): CLOTHES (5), EAT (5), PURPLE (5), TABLE (4)

Kept although < 6 because they are demo signs (same videos as v2): STOP (5)

## Held-out-signer accuracy

| model | top-1 | top-3 | top-5 | demo 14 signs: top-1 (all classes) | demo 14: top-1 (only 14 classes) | webcam 17 clips top-1 / top-5 |
|---|---|---|---|---|---|---|
| v4_rf_vocab116 | 56.8% ± 4.4% | 73.4% | 80.3% | 67.5% | 92.5% | 71% / 94% |
| v4_cnn_vocab116 | 61.9% ± 5.9% | 78.7% | 83.7% | 71.7% | 93.3% | 59% / 100% |
| v2_rf_feat2dom (demo, 14 classes) | 94.0% ± 3.9% (14-class task) | 100.0% | - | 94.0% | 94.0% | 82% (14/17) |

## rf: best 10 / worst 10 glosses (held-out signers)

| best | acc (n) | worst | acc (n) |
|---|---|---|---|
| BIRD | 100% (10) | SAME | 0% (8) |
| SON | 100% (10) | COOK | 0% (8) |
| STUDY | 100% (10) | BAD | 0% (8) |
| YESTERDAY | 100% (10) | AGAIN | 0% (8) |
| HEADACHE | 100% (9) | RIGHT | 0% (9) |
| ORANGE | 100% (7) | TELL | 14% (7) |
| PLEASE | 100% (7) | PAPER | 14% (7) |
| WATER | 100% (7) | PIZZA | 17% (12) |
| SORRY | 100% (6) | CANDY | 18% (11) |
| THIRSTY | 100% (6) | STOP | 20% (5) |

### rf: the 14 demo signs (held-out signers; v2 = demo model, 14-class task)

| sign | expanded | v2 | most confused with |
|---|---|---|---|
| BATHROOM | 86% | 100% | PIZZA 1 |
| DOCTOR | 40% | 90% | WOMAN 1, BOWLING 1, WORK 1 |
| DRINK | 33% | 100% | COUSIN 2, ORANGE 1, BIRD 1 |
| FOOD | 86% | 86% | COLOR 1 |
| HELP | 71% | 100% | GRADUATE 1, SCHOOL 1, SECRETARY 1 |
| HUNGRY | 67% | 100% | WHITE 2 |
| NO | 45% | 91% | PIZZA 3, NEED 1, BATHROOM 1 |
| PLEASE | 100% | 100% | - |
| READY | 90% | 90% | BUT 1 |
| SORRY | 100% | 100% | - |
| STOP | 20% | 80% | ALL 1, GRADUATE 1, SCHOOL 1 |
| THANKYOU | 86% | 86% | GOOD 1 |
| THIRSTY | 100% | 100% | - |
| YES | 58% | 100% | LIKE 1, NEED 1, SHORT 1 |

### rf: confidence rule (held-out signers, many classes)

Chosen: show a prediction only if **top-1 >= 0.3** and **top-1 - top-2 >= 0.15** -> 35% shown, 86.9% of shown correct, 4.6% of all predictions shown-and-wrong (budget 5%).

| min top-1 | min margin | shown | accuracy of shown | shown & wrong |
|---|---|---|---|---|
| 0.0 | 0.0 | 100% | 55.7% | 44.3% |
| 0.0 | 0.1 | 50% | 77.3% | 11.4% |
| 0.0 | 0.2 | 33% | 87.8% | 4.1% |
| 0.2 | 0.0 | 59% | 73.8% | 15.5% |
| 0.2 | 0.1 | 48% | 78.9% | 10.1% |
| 0.2 | 0.2 | 33% | 87.8% | 4.1% |
| 0.3 | 0.0 | 39% | 82.2% | 7.0% |
| 0.3 | 0.1 | 38% | 83.4% | 6.2% |
| 0.3 | 0.2 | 33% | 88.6% | 3.7% |
| 0.4 | 0.0 | 24% | 90.6% | 2.3% |
| 0.4 | 0.1 | 24% | 90.6% | 2.3% |
| 0.4 | 0.2 | 23% | 92.6% | 1.7% |
| 0.5 | 0.0 | 15% | 93.5% | 1.0% |
| 0.5 | 0.1 | 15% | 93.5% | 1.0% |
| 0.5 | 0.2 | 15% | 93.5% | 1.0% |

### rf: 17 webcam clips vs v2 (test-only)

| clip | true | expanded: pred (conf, margin) | true rank | shown by rule | v2: pred (conf) |
|---|---|---|---|---|---|
| HELP-20261114-200810 | HELP | STOP (0.15, 0.07) | 8 | no (?) | STOP (0.77) |
| HELP-20261114-200819 | HELP | HELP (0.22, 0.14) | 1 | no (?) | HELP (0.56) |
| HELP-20261114-200832 | HELP | HELP (0.29, 0.20) | 1 | no (?) | HELP (0.60) |
| HELP-20261114-200841 | HELP | HELP (0.30, 0.21) | 1 | no (?) | HELP (0.57) |
| HELP-20261114-200848 | HELP | HELP (0.31, 0.23) | 1 | yes | HELP (0.59) |
| NO-20261114-204612 | NO | NO (0.27, 0.10) | 1 | no (?) | NO (0.71) |
| NO-20261114-204621 | NO | NO (0.17, 0.05) | 1 | no (?) | NO (0.60) |
| NO-20261114-204630 | NO | LATER (0.19, 0.04) | 2 | no (?) | NO (0.55) |
| STOP-20261114-204508 | STOP | STOP (0.26, 0.09) | 1 | no (?) | STOP (0.77) |
| STOP-20261114-204517 | STOP | STOP (0.30, 0.22) | 1 | no (?) | STOP (0.56) |
| STOP-20261114-204526 | STOP | STOP (0.24, 0.09) | 1 | no (?) | STOP (0.70) |
| THANKYOU-20261114-204822 | THANKYOU | THANKYOU (0.47, 0.31) | 1 | yes | THANKYOU (0.96) |
| THANKYOU-20261114-204830 | THANKYOU | THANKYOU (0.28, 0.12) | 1 | no (?) | THANKYOU (0.72) |
| THANKYOU-20261114-204838 | THANKYOU | THANKYOU (0.41, 0.27) | 1 | yes | THANKYOU (0.90) |
| YES-20261114-204726 | YES | YESTERDAY (0.23, 0.07) | 4 | no (?) | DRINK (0.34) |
| YES-20261114-204734 | YES | YESTERDAY (0.24, 0.11) | 4 | no (?) | YES (0.41) |
| YES-20261114-204742 | YES | YESTERDAY (0.16, 0.02) | 2 | no (?) | BATHROOM (0.34) |

## cnn: best 10 / worst 10 glosses (held-out signers)

| best | acc (n) | worst | acc (n) |
|---|---|---|---|
| BIRD | 100% (10) | STOP | 0% (5) |
| READY | 100% (10) | AGAIN | 12% (8) |
| HEADACHE | 100% (9) | TELL | 14% (7) |
| BATHROOM | 100% (7) | LETTER | 18% (11) |
| PLEASE | 100% (7) | CANDY | 18% (11) |
| SORRY | 100% (6) | COOL | 19% (16) |
| BASKETBALL | 92% (12) | WOMAN | 20% (10) |
| COLD | 92% (12) | PULL | 22% (9) |
| MAN | 91% (11) | SHORT | 23% (13) |
| WALK | 91% (11) | SAME | 25% (8) |

### cnn: the 14 demo signs (held-out signers; v2 = demo model, 14-class task)

| sign | expanded | v2 | most confused with |
|---|---|---|---|
| BATHROOM | 100% | 100% | - |
| DOCTOR | 60% | 90% | DANCE 1, MEDICINE 1, PAPER 1 |
| DRINK | 83% | 100% | YESTERDAY 1, WHO 1 |
| FOOD | 86% | 86% | TELL 1 |
| HELP | 50% | 100% | GRADUATE 3, PULL 2, DANCE 1 |
| HUNGRY | 83% | 100% | WHITE 1 |
| NO | 73% | 91% | PIZZA 2, DEAF 1 |
| PLEASE | 100% | 100% | - |
| READY | 100% | 90% | - |
| SORRY | 100% | 100% | - |
| STOP | 0% | 80% | COOK 2, HELP 1, GRADUATE 1 |
| THANKYOU | 71% | 86% | GOOD 1, FISH 1 |
| THIRSTY | 67% | 100% | WHITE 1, TELL 1 |
| YES | 42% | 100% | NEED 4, BIRD 1, PIZZA 1 |

### cnn: confidence rule (held-out signers, many classes)

Chosen: show a prediction only if **top-1 >= 0.0** and **top-1 - top-2 >= 0.4** -> 42% shown, 88.0% of shown correct, 5.0% of all predictions shown-and-wrong (budget 5%).

| min top-1 | min margin | shown | accuracy of shown | shown & wrong |
|---|---|---|---|---|
| 0.0 | 0.0 | 100% | 60.5% | 39.5% |
| 0.0 | 0.1 | 74% | 71.6% | 21.1% |
| 0.0 | 0.2 | 60% | 79.8% | 12.0% |
| 0.2 | 0.0 | 79% | 69.2% | 24.4% |
| 0.2 | 0.1 | 73% | 72.2% | 20.3% |
| 0.2 | 0.2 | 60% | 79.8% | 12.0% |
| 0.3 | 0.0 | 65% | 75.8% | 15.7% |
| 0.3 | 0.1 | 63% | 76.6% | 14.8% |
| 0.3 | 0.2 | 59% | 79.9% | 11.8% |
| 0.4 | 0.0 | 51% | 81.6% | 9.4% |
| 0.4 | 0.1 | 51% | 81.7% | 9.3% |
| 0.4 | 0.2 | 50% | 83.1% | 8.4% |
| 0.5 | 0.0 | 41% | 85.9% | 5.8% |
| 0.5 | 0.1 | 41% | 85.9% | 5.8% |
| 0.5 | 0.2 | 41% | 86.3% | 5.6% |

### cnn: 17 webcam clips vs v2 (test-only)

| clip | true | expanded: pred (conf, margin) | true rank | shown by rule | v2: pred (conf) |
|---|---|---|---|---|---|
| HELP-20261114-200810 | HELP | STOP (0.33, 0.20) | 2 | no (?) | STOP (0.77) |
| HELP-20261114-200819 | HELP | HELP (0.80, 0.73) | 1 | yes | HELP (0.56) |
| HELP-20261114-200832 | HELP | HELP (0.84, 0.78) | 1 | yes | HELP (0.60) |
| HELP-20261114-200841 | HELP | HELP (0.82, 0.76) | 1 | yes | HELP (0.57) |
| HELP-20261114-200848 | HELP | HELP (0.84, 0.79) | 1 | yes | HELP (0.59) |
| NO-20261114-204612 | NO | RIGHT (0.33, 0.13) | 2 | no (?) | NO (0.71) |
| NO-20261114-204621 | NO | DEAF (0.20, 0.04) | 4 | no (?) | NO (0.60) |
| NO-20261114-204630 | NO | RIGHT (0.35, 0.21) | 2 | no (?) | NO (0.55) |
| STOP-20261114-204508 | STOP | STOP (0.60, 0.51) | 1 | yes | STOP (0.77) |
| STOP-20261114-204517 | STOP | STOP (0.42, 0.29) | 1 | no (?) | STOP (0.56) |
| STOP-20261114-204526 | STOP | STOP (0.40, 0.20) | 1 | no (?) | STOP (0.70) |
| THANKYOU-20261114-204822 | THANKYOU | THANKYOU (0.42, 0.29) | 1 | no (?) | THANKYOU (0.96) |
| THANKYOU-20261114-204830 | THANKYOU | THANKYOU (0.52, 0.33) | 1 | no (?) | THANKYOU (0.72) |
| THANKYOU-20261114-204838 | THANKYOU | GIVE (0.23, 0.00) | 2 | no (?) | THANKYOU (0.90) |
| YES-20261114-204726 | YES | YESTERDAY (0.17, 0.07) | 2 | no (?) | DRINK (0.34) |
| YES-20261114-204734 | YES | BATHROOM (0.19, 0.03) | 2 | no (?) | YES (0.41) |
| YES-20261114-204742 | YES | YES (0.30, 0.22) | 1 | no (?) | BATHROOM (0.34) |
