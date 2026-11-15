# Recording plan: the 20 weakest signs

Weakest = lowest top-1 on held-out signers for `v5_keyword_tf_f3_32.joblib` (`reports/v5_eval.md`). Your own clips help most where WLASL has few, inconsistent examples, and they also teach the model how *you* sign in *your* room.

| # | sign | top-1 | top-5 | WLASL videos |
|---|---|---|---|---|
| 1 | TELL | 0% | 29% | 7 |
| 2 | PIZZA | 8% | 50% | 12 |
| 3 | COOL | 19% | 81% | 16 |
| 4 | HEARING | 33% | 83% | 6 |
| 5 | CANDY | 36% | 73% | 11 |
| 6 | SAME | 38% | 100% | 8 |
| 7 | STOP | 40% | 60% | 5 |
| 8 | THIN | 42% | 58% | 12 |
| 9 | COMPUTER | 43% | 50% | 14 |
| 10 | NOW | 44% | 100% | 9 |
| 11 | LAST | 50% | 58% | 12 |
| 12 | WHAT | 50% | 58% | 12 |
| 13 | CHEAT | 50% | 60% | 10 |
| 14 | AGAIN | 50% | 75% | 8 |
| 15 | ALL | 50% | 88% | 8 |
| 16 | WOMAN | 50% | 90% | 10 |
| 17 | LATER | 50% | 100% | 12 |
| 18 | TODAY | 56% | 78% | 9 |
| 19 | WANT | 56% | 89% | 9 |
| 20 | SCHOOL | 56% | 100% | 9 |

## 1. Record (about 25 minutes)

Training session: 8 repetitions of each sign, in random order. Raise your hands, sign, lower your hands; R = redo, S = skip, Q = quit (what you recorded is kept).
```bash
python src/record_session.py --signs "TELL,PIZZA,COOL,HEARING,CANDY,SAME,STOP,THIN,COMPUTER,NOW,LAST,WHAT,CHEAT,AGAIN,ALL,WOMAN,LATER,TODAY,WANT,SCHOOL" --reps 8 --session s1
```

Personal test set (never trained on). Best recorded on another day or in other light:
```bash
python src/record_session.py --signs "TELL,PIZZA,COOL,HEARING,CANDY,SAME,STOP,THIN,COMPUTER,NOW,LAST,WHAT,CHEAT,AGAIN,ALL,WOMAN,LATER,TODAY,WANT,SCHOOL" --reps 3 --session t1 --test
```

Optional, non-sign movements (scratch your nose, touch your hair, adjust glasses, wave). These train the NOTHING class, which is never sent:
```bash
python src/record_session.py --signs NOTHING --reps 15 --session s1
```

Clips go to `data/me/<SIGN>/<session>_<n>.mp4` (git-ignored). Each clip is cut by the same hands-down segmenter as `live.py`.

## 2. Retrain (one command)
```bash
python src/train_keyword.py retrain --version v6
```
This extracts the new clips (cached), re-runs the same held-out-signer CV for the chosen configuration (5 seeds, about 47 min on this laptop), then writes `reports/v6_eval.md` and the final model. It reports your test session's top-1/top-5 and applies the promotion rule before replacing `models/keyword_model.joblib`. Your clips get 3x weight and are only added to the training part of each fold; the WLASL folds stay identical, so the numbers stay comparable with v4/v5.

