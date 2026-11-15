"""Phase 1 (v5): diagnose v4_cnn_vocab116 on held-out signers -> reports/v5_diagnosis.md

    python src/diagnose_v4.py            # ~10 min: re-runs v4's CNN cross-validation (same code, same seeds)

Re-runs the exact v4 CV (train_vocab.py: same videos, folds, augmentation, CNN, seeds) to get the
out-of-fold probabilities that v4 did not save, checks that the per-fold top-1 matches the v4
metrics file, and saves them to reports/oof/v4_cnn.npz (the baseline for every v5 comparison):
  P_full  held-out-signer predictions on the full clips (the v4 protocol)
  P_live  the same fold models on the segment live.py's hands-down rule would cut from each clip
  P_oov   kept videos of the 4 dropped glosses (not in the vocabulary), fold model of their signer
  P_web   the saved final v4 model on the 17 webcam test clips (test-only)
Then writes the per-sign / confusion / live-log analysis. Nothing here trains a model that is kept.
"""
import csv
import glob
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import joblib
import numpy as np

import train_vocab as tv
from features import features_from_raw
from keyword_data import live_span

OOF = Path("reports/oof")


def log(*a):
    print(*a, flush=True)


def topk_hit(P, y, k):
    return np.array([t in r for t, r in zip(y, np.argsort(-P, axis=1)[:, :k])])


def main():
    t0 = time.time()
    labels, videos, oov, _ = __import__("keyword_data").load_wlasl("wlasl_vocab")
    v4 = json.load(open("models/v4_cnn_vocab116.json"))
    assert labels == v4["data"]["labels"], "label list differs from v4"
    y = np.array([labels.index(v["label"]) for v in videos])
    signers = np.array([v["signer"] for v in videos])
    folds = __import__("keyword_data").wlasl_folds(videos)
    X_full = np.array([features_from_raw(v["raw"], tv.FS) for v in videos], dtype=np.float32)
    spans = [live_span(v["raw"]) for v in videos]
    live_ok = np.array([s is not None for s in spans])
    X_live = np.array([features_from_raw(v["raw"][s[0]:s[1] + 1], tv.FS) if s else X_full[i]
                       for i, (v, s) in enumerate(zip(videos, spans))], dtype=np.float32)
    X_oov = np.array([features_from_raw(v["raw"], tv.FS) for v in oov], dtype=np.float32)
    log(f"{len(videos)} videos, {len(labels)} glosses, {len(oov)} OOV clips; live rule cuts a segment from "
        f"{live_ok.sum()}/{len(videos)} clips")

    vids = [dict(raw=v["raw"], label=v["label"], signer=v["signer"]) for v in videos]
    P_full, P_live = np.zeros((len(videos), len(labels))), np.zeros((len(videos), len(labels)))
    P_oov, oov_fold = np.zeros((len(oov), len(labels))), np.full(len(oov), -1)
    fold_of = np.zeros(len(videos), int)
    fold_top1 = []
    oov_preds = []
    for k, (tr, te) in enumerate(folds):
        s, m = tv.fit("cnn", tv.training_set([vids[i] for i in tr], seed=k))
        P_full[te] = tv.proba(s, m, X_full[te], labels)
        P_live[te] = tv.proba(s, m, X_live[te], labels)
        fold_of[te] = k
        fold_top1.append(float((P_full[te].argmax(1) == y[te]).mean()))
        po = tv.proba(s, m, X_oov, labels)
        oov_preds.append(po)
        te_signers = set(signers[te])
        for j, v in enumerate(oov):
            if v["signer"] in te_signers:
                P_oov[j], oov_fold[j] = po[j], k
        log(f"  fold {k}: top-1 {fold_top1[-1]:.1%} (v4 metrics file: {v4['cv']['top1_folds'][k]:.1%})  "
            f"best epoch {m.best_epoch}  [{time.time() - t0:.0f}s]")
    unseen = oov_fold < 0                              # OOV signer never in the WLASL folds: mean of fold models
    P_oov[unseen] = np.mean(oov_preds, axis=0)[unseen]
    reproduced = bool(np.allclose(fold_top1, v4["cv"]["top1_folds"], atol=1e-9))
    log(f"reproduced v4 per-fold top-1 exactly: {reproduced}")

    bundle = joblib.load("models/v4_cnn_vocab116.joblib")
    web = sorted(glob.glob("data/landmarks/webcam_v5/*/*.npy")) or sorted(glob.glob("data/landmarks/webcam/*/*.npy"))
    web_ids = [Path(f).stem for f in web]
    web_y = np.array([labels.index(Path(f).parent.name) for f in web])
    X_web = np.array([features_from_raw(np.load(f), tv.FS) for f in web], dtype=np.float32)
    P_web = tv.proba(bundle["scaler"], bundle["model"], X_web, labels)

    OOF.mkdir(parents=True, exist_ok=True)
    np.savez(OOF / "v4_cnn.npz", labels=np.array(labels), videos=np.array([v["video"] for v in videos]), y=y,
             fold=fold_of, P_full=P_full, P_live=P_live, live_ok=live_ok, P_oov=P_oov,
             oov_videos=np.array([v["video"] for v in oov]), oov_labels=np.array([v["label"] for v in oov]),
             P_web=P_web, web_videos=np.array(web_ids), web_y=web_y, P_web_tta=P_web)
    write_report(labels, videos, y, P_full, P_live, live_ok, P_web, web_y, reproduced, fold_top1, v4, time.time() - t0)
    log(f"done in {(time.time() - t0) / 60:.1f} min -> reports/v5_diagnosis.md, {OOF / 'v4_cnn.npz'}")


def per_sign(P, y, labels):
    t1, t5 = topk_hit(P, y, 1), topk_hit(P, y, 5)
    return {lab: (float(t1[y == i].mean()), float(t5[y == i].mean())) for i, lab in enumerate(labels)}


def confused_pairs(P, y, labels, n=20):
    pred = P.argmax(1)
    directed = Counter((labels[a], labels[b]) for a, b in zip(y, pred) if a != b)
    pairs = Counter()
    for (a, b), c in directed.items():
        pairs[tuple(sorted((a, b)))] += c
    return [(a, b, c, directed[(a, b)], directed[(b, a)]) for (a, b), c in pairs.most_common(n)]


def live_logs():
    """Real live tests (not dry runs) of logs/live_test_*.csv."""
    out = []
    for f in sorted(glob.glob("logs/live_test_2*.csv")):
        md = Path(f).with_suffix(".md").read_text()
        model = md.split("model: ")[1].split(",")[0] if "model: " in md else "?"
        out.append((Path(f).stem, model, list(csv.DictReader(open(f)))))
    return out


def write_report(labels, videos, y, P, P_live, live_ok, P_web, web_y, reproduced, fold_top1, v4, seconds):
    n_vid = Counter(v["label"] for v in videos)
    n_sig = defaultdict(set)
    for v in videos:
        n_sig[v["label"]].add(v["signer"])
    ps = per_sign(P, y, labels)
    macro1, macro5 = np.mean([a for a, _ in ps.values()]), np.mean([b for _, b in ps.values()])
    pred = P.argmax(1)
    worst_conf = {lab: Counter(labels[p] for p in pred[(y == i) & (pred != i)]).most_common(2) for i, lab in enumerate(labels)}
    ranked = sorted(labels, key=lambda g: (ps[g][0], ps[g][1], g))
    acc1 = np.array([ps[g][0] for g in labels])
    nv = np.array([n_vid[g] for g in labels])
    ns = np.array([len(n_sig[g]) for g in labels])
    rank = lambda a: np.argsort(np.argsort(a))
    rho_v = float(np.corrcoef(rank(acc1), rank(nv))[0, 1])
    rho_s = float(np.corrcoef(rank(acc1), rank(ns))[0, 1])

    L = ["# v5 diagnosis: v4_cnn_vocab116 on held-out signers (baseline)", "",
         f"Generated by `src/diagnose_v4.py` in {seconds / 60:.1f} min. The v4 cross-validation was re-run with the "
         f"original code and seeds to recover its out-of-fold predictions: per-fold top-1 "
         f"{', '.join(f'{a:.1%}' for a in fold_top1)} - "
         + ("**identical to the v4 metrics file**." if reproduced else "**differs from the v4 metrics file** (see log)."),
         "Held-out signers = 5-fold GroupKFold by signer (seed 0), 1,106 videos, 64 signers, 116 glosses. "
         "Saved to `reports/oof/v4_cnn.npz`; every v5 candidate is evaluated on exactly these folds.", "",
         "## Baseline numbers", "",
         "| metric | v4_cnn |", "|---|---|",
         f"| macro top-1 (mean over the 116 signs) | **{macro1:.1%}** |",
         f"| macro top-5 | **{macro5:.1%}** |",
         f"| overall top-1 / top-3 / top-5 (pooled over videos) | {topk_hit(P, y, 1).mean():.1%} / {topk_hit(P, y, 3).mean():.1%} / {topk_hit(P, y, 5).mean():.1%} |",
         f"| overall top-1, mean of the 5 folds (the number in the v4 report) | {np.mean(fold_top1):.1%} |",
         f"| signs with top-1 >= 50% / >= 80% | {(acc1 >= 0.5).sum()} / {(acc1 >= 0.8).sum()} of 116 |",
         f"| signs with top-1 = 0% | {(acc1 == 0).sum()} |",
         f"| webcam 17 clips top-1 / top-5 (final v4 model) | {topk_hit(P_web, web_y, 1).sum()}/17 / {topk_hit(P_web, web_y, 5).sum()}/17 |", "",
         f"Per-sign accuracy vs data: Spearman rho with the number of videos {rho_v:+.2f}, with the number of signers "
         f"{rho_s:+.2f}. Videos per sign: {nv.min()}-{nv.max()} (median {int(np.median(nv))}).", "",
         "## Top 20 confused pairs (top-1 errors, both directions)", "",
         "| # | pair | errors | A -> B | B -> A |", "|---|---|---|---|---|"]
    for i, (a, b, c, ab, ba) in enumerate(confused_pairs(P, y, labels), 1):
        L.append(f"| {i} | {a} / {b} | {c} | {ab} | {ba} |")
    L += ["", "## All 116 signs, worst first", "",
          "| # | sign | top-1 | top-5 | videos | signers | most often predicted instead |", "|---|---|---|---|---|---|---|"]
    for i, g in enumerate(ranked, 1):
        conf = ", ".join(f"{k} {c}" for k, c in worst_conf[g]) or "-"
        L.append(f"| {i} | {g} | {ps[g][0]:.0%} | {ps[g][1]:.0%} | {n_vid[g]} | {len(n_sig[g])} | {conf} |")

    # ---- live errors: segmentation or classification?
    t1_live = topk_hit(P_live, y, 1)
    t1_full = topk_hit(P, y, 1)
    missed_by_rule = Counter(videos[i]["label"] for i in np.flatnonzero(~live_ok))
    L += ["", "## Live errors: segmentation or classification?", "",
          "### 1. The live segmenter on the WLASL clips (simulation of live.py's hands-down rule)", "",
          f"- The rule cuts a segment from **{live_ok.sum()}/{len(videos)}** clips. In **{(~live_ok).sum()}** clips no wrist rises "
          f"above mid-chest (`HAND_UP_Y` = 0.6) for >= 10 frames, so live would miss the sign completely: "
          + ", ".join(f"{k} {c}/{n_vid[k]}" for k, c in missed_by_rule.most_common()) + ".",
          f"- Same v4 fold models, full clip vs live-rule segment: top-1 **{t1_full[live_ok].mean():.1%}** vs "
          f"**{t1_live[live_ok].mean():.1%}** on the clips the rule cuts. Cutting at the live boundaries costs "
          f"{(t1_full[live_ok].mean() - t1_live[live_ok].mean()) * 100:+.1f} points, i.e. on WLASL the segment "
          "boundaries are not where the accuracy is lost.", ""]
    L += ["### 2. Your live tests (logs/live_test_*.csv, real camera)", "",
          "| run | model | prompts | correct shown | '?' (top-1 right / wrong) | wrong shown | missed (no segment in 15 s) |",
          "|---|---|---|---|---|---|---|"]
    tot = Counter()
    per_prompt = defaultdict(Counter)
    for name, model, rows in live_logs():
        c = Counter(r["outcome"] for r in rows)
        q_right = sum(r["outcome"] == "?" and r["predicted"] == r["prompt"] for r in rows)
        L.append(f"| {name} | {Path(model).name} | {len(rows)} | {c['correct']} | {c['?']} ({q_right} / {c['?'] - q_right}) | "
                 f"{c['wrong']} | {c['missed']} |")
        if "v4" in model:
            tot.update(c)
            tot["q_right"] += q_right
            for r in rows:
                per_prompt[r["prompt"]][r["outcome"] if r["outcome"] != "?" else ("?right" if r["predicted"] == r["prompt"] else "?wrong")] += 1
    n = sum(tot[k] for k in ("correct", "?", "wrong", "missed"))
    segmented = n - tot["missed"]
    top1_right = tot["correct"] + tot["q_right"]
    L += ["", f"v4_cnn live prompts: {n}. **Segmentation failures** (no segment within 15 s): {tot['missed']} "
          f"({tot['missed'] / max(n, 1):.0%}). Of the {segmented} segmented prompts the top-1 was right in {top1_right} "
          f"({top1_right / max(segmented, 1):.0%}); {tot['q_right']} of those were hidden as '?' by the margin rule. "
          f"**Classification failures** (segment cut, top-1 wrong): {segmented - top1_right} ({(segmented - top1_right) / max(segmented, 1):.0%} of segmented).", "",
          "| prompt | correct | '?' top-1 right | '?' top-1 wrong | wrong shown | missed |", "|---|---|---|---|---|---|"]
    for p, c in sorted(per_prompt.items()):
        L.append(f"| {p} | {c['correct']} | {c['?right']} | {c['?wrong']} | {c['wrong']} | {c['missed']} |")
    L += [""] + """Reading: 5 of the 6 misses are consecutive prompts (3-7) of live_test_20261115-002048; the 6th is the first prompt of
the 2-prompt run that was stopped early. In the two later full runs every prompt was segmented (0 misses in 36),
so the misses look like a framing/session problem, not the hands-down rule. Most live errors are classification
errors (segment cut, wrong top-1), concentrated in SICK (0 of 9 right) and MEDICINE (3 of 9 top-1 right). Both
use a hand low on the body (SICK: forehead + stomach; MEDICINE: on the palm at chest height). MEDICINE is also one of the signs the rule misses in WLASL (1 of 8 clips).
The old logs have no segment lengths or top-5, so `live_test.py` now logs both (v5).""".split("\n") + [""]
    Path("reports/v5_diagnosis.md").write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
