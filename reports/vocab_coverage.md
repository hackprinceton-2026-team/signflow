# WLASL vocabulary coverage

Generated 2026-11-14 22:16 by `src/vocab_report.py`. Full per-gloss table: `reports/wlasl_gloss_stats.csv`.

## 1. Current demo model (v2_rf_feat2dom, frozen)

| sign | WLASL gloss | training videos (kept) | available in WLASL |
|---|---|---|---|
| BATHROOM | bathroom | 7 | 7 |
| DOCTOR | doctor | 10 | 10 |
| DRINK | drink | 12 | 15 |
| FOOD | food | 7 | 7 |
| HELP | help | 14 | 14 |
| HUNGRY | hungry | 6 | 6 |
| NO | no | 11 | 11 |
| PLEASE | please | 7 | 7 |
| READY | ready | 10 | 10 |
| SORRY | sorry | 6 | 7 |
| STOP | stop | 5 | 5 |
| THANKYOU | thank you | 7 | 7 |
| THIRSTY | thirsty | 6 | 8 |
| YES | yes | 12 | 12 |
| **total** | | **120** | |

## 2. WLASL overall

2000 glosses, 21083 instances, 11980 available (not in missing.txt), 5.38 GB of available video.

| set | glosses | >= 5 available | >= 8 | >= 12 | available videos | median per gloss | median signers |
|---|---|---|---|---|---|---|---|
| all WLASL | 2000 | 1575 | 355 | 30 | 11980 | 6 | 5 |
| nslt_100 (WLASL100) | 100 | 100 | 88 | 27 | 1013 | 10 | 8 |
| nslt_300 (WLASL300) | 300 | 300 | 218 | 30 | 2660 | 9 | 7 |

Note: per-gloss availability is ~50% of the original instances (the rest are in missing.txt).

## 3. Care list

| word | status | available | signers |
|---|---|---|---|
| hello | in WLASL (4 videos) | 4 | 4 |
| help | in our model | 14 | 9 |
| doctor | in our model | 10 | 7 |
| pain | in WLASL (5 videos) | 5 | 4 |
| hurt | in WLASL (5 videos) | 5 | 4 |
| sick | in WLASL (8 videos) | 8 | 8 |
| medicine | in WLASL (8 videos) | 8 | 8 |
| hospital | in WLASL (7 videos) | 7 | 7 |
| nurse | in WLASL (6 videos) | 6 | 6 |
| emergency | in WLASL (4 videos) | 4 | 4 |
| headache | in WLASL (9 videos) | 9 | 7 |
| yes | in our model | 12 | 10 |
| no | in our model | 11 | 10 |
| please | in our model | 7 | 7 |
| thank you | in our model | 7 | 7 |
| sorry | in our model | 7 | 6 |
| water | in WLASL (9 videos) | 9 | 8 |
| eat | in WLASL (7 videos) | 7 | 7 |
| drink | in our model | 15 | 10 |
| bathroom | in our model | 7 | 7 |
| hungry | in our model | 6 | 6 |
| thirsty | in our model | 8 | 8 |
| tired | in WLASL (7 videos) | 7 | 7 |
| cold | in WLASL (12 videos) | 12 | 11 |
| hot | in WLASL (10 videos) | 10 | 9 |
| need | in WLASL (6 videos) | 6 | 6 |
| want | in WLASL (9 videos) | 9 | 8 |
| where | in WLASL (7 videos) | 7 | 7 |
| what | in WLASL (12 videos) | 12 | 11 |
| when | in WLASL (8 videos) | 8 | 8 |
| today | in WLASL (9 videos) | 9 | 6 |
| tomorrow | in WLASL (7 videos) | 7 | 7 |
| yesterday | in WLASL (10 videos) | 10 | 8 |
| family | in WLASL (11 videos) | 11 | 10 |
| mother | in WLASL (11 videos) | 11 | 10 |
| father | in WLASL (7 videos) | 7 | 7 |
| friend | in WLASL (7 videos) | 7 | 7 |
| deaf | in WLASL (11 videos) | 11 | 8 |
| understand | in WLASL (7 videos) | 7 | 7 |
| again | in WLASL (8 videos) | 8 | 8 |
| stop | in our model | 5 | 5 |
| wait | in WLASL (10 videos) | 10 | 9 |
| fine | in WLASL (9 videos) | 9 | 8 |
| good | in WLASL (10 videos) | 10 | 9 |
| bad | in WLASL (10 videos) | 10 | 9 |

45/45 care-list words are WLASL glosses; 25 have >= 8 available videos.

## 4. Measured speed on this machine

- Download (Kaggle CLI, one file per call, 4 in parallel): 10 files (6.54 MB) in 6.5 s = **1.539 files/s** (0 failed). Per-call overhead dominates, so time scales with the number of files more than with MB.
- Extraction (MediaPipe Holistic): 10 videos / 618 frames; 1 worker: 2.64 s/video (23.4 frames/s); 7 workers: **1.231 s/video** (8 CPU cores). Measured 2026-11-14 22:16.

## 5. Size and time estimates (from exact Kaggle file sizes and the measured speeds)

| option | glosses | videos | GB | new videos to fetch | download | extraction | total |
|---|---|---|---|---|---|---|---|
| WLASL100 + care-list (>= 8) + 14 demo signs (default) | 120 | 1180 | 0.58 | 1044 | 11 min | 21 min | **33 min** |
| top-200 by available + all care-list words in WLASL + 14 demo signs | 226 | 2196 | 1.01 | 2061 | 22 min | 42 min | **65 min** |
| WLASL300 (+ 14 demo signs) | 307 | 2710 | 1.29 | 2574 | 28 min | 53 min | **81 min** |

Already-downloaded videos are skipped. Estimates assume the measured rates hold for the whole run.

## 6. Decision (Phase 2 rule)

- Rule: default = WLASL100 + care-list words with >= 8 videos; expand to ~200 glosses if the full pipeline is estimated under 60 min.
- Estimate for the ~200 option: 65 min -> **keep the default**.
- Chosen: **WLASL100 + care-list (>= 8) + 14 demo signs (default)** = 120 glosses, 1180 available videos. The 14 demo signs are always included so the expanded model can be compared with v2 on them.
- After extraction, glosses with fewer than 6 usable videos (>= 80% in-sign hand rule) are dropped.
- Manifest: `data/wlasl/manifest_vocab.csv`

## 7. What actually happened (added after the run)

- **Download:** the measured 1.54 files/s held for only ~80 files. Kaggle then rate-limited the per-file API (`429 Too Many Requests` on 865 of 1,044 calls), so section 5's download estimates are wrong. Instead we downloaded the dataset archive **once** (4.82 GB at ~1.2 MB/s = **74 min**), unpacked only the 967 selected videos, and deleted the archive. With a bulk download, time depends on bandwidth: about 74 min for any vocabulary size on this connection.
- **Extraction:** 967 new videos in 13.6 min (0.84 s/video, 7 workers), faster than the 1.23 s/video measured on 10 videos. 1,125 of 1,180 videos passed the >= 80% in-sign hand rule.
- **The Phase 2 decision stands as made:** the rule was applied to the estimate available at the time (65 min for ~200 glosses vs a 60 min budget). The real pipeline for the 120-gloss default took ~88 min, dominated by the archive download.
