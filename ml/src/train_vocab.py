"""Phase 4: train the expanded-vocabulary models (separate experiment; never touches sign_model.joblib).

    python src/train_vocab.py [--source wlasl_vocab] [--version v4]

Data: data/landmarks/<source>/ kept videos (>= 80% in-sign hand rule); glosses with < 6 usable
videos are dropped. Features: feat2dom (same as the demo model).
Protocol (same as train_select.py): 5-fold GroupKFold by signer_id, shuffled with seed 0, same folds
for every model; augmentation only inside the training fold, per source video; scaler fit on the
training fold only. The CNN early-stops on a signer-held-out split of the TRAINING fold.
The 17 webcam clips (data/webcam) are test-only: reported, never used for any choice.
Outputs: models/<version>_<model>_vocab<N>.joblib + .json, reports/vocab_model_report.md
"""
import argparse
import csv
import json
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from augment import NORMAL, augment_one
from cnn import CNNClassifier
from features import N_FRAMES, features_from_raw, prepare, to_feature, video_to_raw

FS = "feat2dom"
SEED, N_FOLDS, AUG_COPIES, MIN_VIDEOS = 0, 5, 10, 6
DEMO = ["BATHROOM", "DOCTOR", "DRINK", "FOOD", "HELP", "HUNGRY", "NO", "PLEASE", "READY", "SORRY", "STOP",
        "THANKYOU", "THIRSTY", "YES"]
WRONG_BUDGET = 0.05     # calibration: max share of ALL predictions that may be shown AND wrong
P1_GRID = [0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7]
MARGIN_GRID = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]


def log(*a):
    print(*a, flush=True)


def training_set(videos, seed):
    """Originals + AUG_COPIES augmented copies per video. Returns X, y, signer per row, is_original."""
    rng = np.random.default_rng(seed)
    X, y, g, orig = [], [], [], []
    for v in videos:
        points, presence = prepare(v["raw"], FS)
        X += [to_feature(points, presence, fs=FS)] + [augment_one(points, presence, rng, NORMAL, FS)
                                                      for _ in range(AUG_COPIES)]
        y += [v["label"]] * (AUG_COPIES + 1)
        g += [v["signer"]] * (AUG_COPIES + 1)
        orig += [True] + [False] * AUG_COPIES
    return np.array(X, dtype=np.float32), np.array(y), np.array(g), np.array(orig)


def fit(name, data, epochs=None):
    X, y, g, orig = data
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)
    if name == "rf":
        return scaler, RandomForestClassifier(n_estimators=300, random_state=0, n_jobs=-1).fit(Xs, y)
    if epochs is None:                                   # CV fold: signer-held-out early stopping
        return scaler, CNNClassifier(seed=SEED).fit(Xs, y, groups=g, val_mask=orig)
    return scaler, CNNClassifier(epochs=epochs, seed=SEED).fit(Xs, y)   # final: fixed epochs


def proba(scaler, model, X, labels):
    p = model.predict_proba(scaler.transform(X))
    full = np.zeros((len(X), len(labels)))
    full[:, [labels.index(c) for c in model.classes_]] = p
    return full


def topk(P, y_idx, k):
    return float(np.mean([t in r for t, r in zip(y_idx, np.argsort(-P, axis=1)[:, :k])])) if len(y_idx) else float("nan")


def calibrate(P, y_idx):
    """Grid over (min top-1 prob, min margin top1-top2). Pick the rule with the most predictions
    shown such that shown-and-wrong <= WRONG_BUDGET of all predictions."""
    s = np.sort(P, axis=1)
    p1, margin, correct = s[:, -1], s[:, -1] - s[:, -2], P.argmax(1) == y_idx
    grid = []
    for a in P1_GRID:
        for m in MARGIN_GRID:
            shown = (p1 >= a) & (margin >= m)
            grid.append(dict(min_conf=a, min_margin=m, shown=float(shown.mean()),
                             acc_shown=float(correct[shown].mean()) if shown.any() else float("nan"),
                             wrong_shown=float((shown & ~correct).mean())))
    ok = [r for r in grid if r["wrong_shown"] <= WRONG_BUDGET]
    best = max(ok, key=lambda r: (r["shown"], -r["min_conf"], -r["min_margin"])) if ok else None
    return grid, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="wlasl_vocab")
    ap.add_argument("--version", default="v4")
    args = ap.parse_args()
    t_start = time.time()
    root = Path("data/landmarks") / args.source

    # ---------------- data ----------------
    rows = list(csv.DictReader(open(root / "index.csv")))
    usable = defaultdict(int)
    for r in rows:
        usable[r["label"]] += r["kept"] == "1"
    # glosses with < MIN_VIDEOS usable videos are dropped, EXCEPT the 14 demo signs: they are the exact
    # videos the frozen v2 model was trained on (STOP has 5), and are needed for a like-for-like comparison
    keep = lambda lab, n: n >= MIN_VIDEOS or (lab in DEMO and n > 0)
    dropped = sorted((lab, n) for lab, n in usable.items() if not keep(lab, n))
    exempt = sorted((lab, n) for lab, n in usable.items() if lab in DEMO and 0 < n < MIN_VIDEOS)
    labels = sorted(lab for lab, n in usable.items() if keep(lab, n))
    videos = [dict(video=r["video"], label=r["label"], signer=r["signer_id"], split=r["split"],
                   raw=np.load(root / r["label"] / f"{r['video']}.npy"))
              for r in rows if r["kept"] == "1" and r["label"] in labels]
    y_idx = np.array([labels.index(v["label"]) for v in videos])
    signers = np.array([v["signer"] for v in videos])
    log(f"DATA {len(rows)} extracted videos, {sum(r['kept'] == '1' for r in rows)} usable; "
        f"{len(labels)} glosses kept (>= {MIN_VIDEOS} usable videos), {len(dropped)} dropped; "
        f"{len(videos)} videos, {len(set(signers))} signers")
    log(f"     dropped: {', '.join(f'{lab} ({n})' for lab, n in dropped) or 'none'}")
    log(f"     kept although < {MIN_VIDEOS} (demo signs): {', '.join(f'{lab} ({n})' for lab, n in exempt) or 'none'}")
    missing_demo = [d for d in DEMO if d not in labels]
    if missing_demo:
        log(f"     NOTE: demo signs not in the expanded vocabulary: {missing_demo}")

    X_all = np.array([features_from_raw(v["raw"], FS) for v in videos], dtype=np.float32)
    folds = list(GroupKFold(n_splits=N_FOLDS, shuffle=True, random_state=SEED).split(X_all, y_idx, groups=signers))
    for tr, te in folds:
        assert not set(signers[tr]) & set(signers[te]), "signer leak"
    log(f"FOLDS GroupKFold(5, shuffle, seed {SEED}) by signer; test videos per fold {[len(te) for _, te in folds]}; "
        "no signer overlap (asserted)")

    log("Building augmented training sets per fold ...")
    t = time.time()
    train_sets = [training_set([videos[i] for i in tr], seed=k) for k, (tr, _) in enumerate(folds)]
    log(f"  done in {time.time() - t:.0f}s ({len(train_sets[0][0])} rows in fold 0)")

    # ---------------- webcam test clips (test-only) ----------------
    clips = sorted(Path("data/webcam").glob("*.mp4"))
    webcam = [dict(video=c.stem, label=c.stem.split("-")[0].upper(), raw=video_to_raw(c)) for c in clips]
    v2 = joblib.load("models/sign_model.joblib")
    v2_preds = {}
    for w in webcam:
        p = v2["model"].predict_proba(v2["scaler"].transform([features_from_raw(w["raw"], v2["features"])]))[0]
        v2_preds[w["video"]] = (str(v2["model"].classes_[p.argmax()]), float(p.max()))
    X_web = np.array([features_from_raw(w["raw"], FS) for w in webcam], dtype=np.float32)
    log(f"WEBCAM {len(webcam)} test clips loaded (never trained on)")

    demo_idx = [labels.index(d) for d in DEMO if d in labels]
    is_demo = np.isin(y_idx, demo_idx)
    results = {}
    for name in ["rf", "cnn"]:
        t0 = time.time()
        out_path = Path("models") / f"{args.version}_{name}_vocab{len(labels)}.joblib"
        if out_path.exists():
            raise SystemExit(f"{out_path} exists - refusing to overwrite. Use a new --version.")
        P = np.zeros((len(videos), len(labels)))
        f1, f3, f5, epochs = [], [], [], []
        for k, (tr, te) in enumerate(folds):
            s, m = fit(name, train_sets[k])
            P[te] = proba(s, m, X_all[te], labels)
            f1.append(topk(P[te], y_idx[te], 1)), f3.append(topk(P[te], y_idx[te], 3)), f5.append(topk(P[te], y_idx[te], 5))
            if name == "cnn":
                epochs.append(m.best_epoch)
            log(f"  {name} fold {k}: top-1 {f1[-1]:.1%}  top-5 {f5[-1]:.1%}"
                + (f"  (best epoch {m.best_epoch})" if name == "cnn" else "") + f"  [{time.time() - t0:.0f}s]")
        final_epochs = int(np.median(epochs)) if epochs else None
        scaler, model = fit(name, training_set(videos, seed=SEED), epochs=final_epochs)

        pred = P.argmax(1)
        per_class = {lab: float((pred[y_idx == i] == i).mean()) for i, lab in enumerate(labels)}
        n_class = {lab: int((y_idx == i).sum()) for i, lab in enumerate(labels)}
        P14 = P[is_demo][:, demo_idx]                    # predictions restricted to the 14 demo classes
        y14 = np.array([demo_idx.index(i) for i in y_idx[is_demo]])
        demo = dict(n=int(is_demo.sum()),
                    top1_full_vocab=float((pred[is_demo] == y_idx[is_demo]).mean()),
                    top5_full_vocab=topk(P[is_demo], y_idx[is_demo], 5),
                    top1_restricted_to_14=float((P14.argmax(1) == y14).mean()),
                    per_sign={labels[i]: per_class[labels[i]] for i in demo_idx},
                    confused_with={labels[i]: dict(sorted(((labels[j], int(((pred == j) & (y_idx == i)).sum()))
                                                          for j in set(pred[y_idx == i]) if j != i), key=lambda kv: -kv[1]))
                                   for i in demo_idx})
        grid, rule = calibrate(P, y_idx)

        Pw = proba(scaler, model, X_web, labels)
        web = []
        for w, p in zip(webcam, Pw):
            order = np.argsort(-p)
            true_rank = (list(order).index(labels.index(w["label"])) + 1) if w["label"] in labels else None
            sp = np.sort(p)
            shown = rule is not None and sp[-1] >= rule["min_conf"] and sp[-1] - sp[-2] >= rule["min_margin"]
            web.append(dict(video=w["video"], true=w["label"], pred=labels[order[0]], conf=round(float(sp[-1]), 3),
                            margin=round(float(sp[-1] - sp[-2]), 3), true_rank=true_rank, shown_by_rule=bool(shown),
                            top3=[[labels[i], round(float(p[i]), 3)] for i in order[:3]],
                            v2_pred=v2_preds[w["video"]][0], v2_conf=round(v2_preds[w["video"]][1], 3)))
        metrics = dict(version=args.version, model=name, features=FS, date=datetime.now().isoformat(timespec="seconds"),
                       data=dict(source=args.source, n_videos=len(videos), n_signers=len(set(signers)),
                                 labels=labels, dropped_glosses=dict(dropped), min_videos=MIN_VIDEOS,
                                 demo_signs_exempt_from_min=dict(exempt)),
                       protocol=dict(cv=f"GroupKFold({N_FOLDS}, shuffle=True, random_state={SEED}) by signer_id",
                                     aug_copies=AUG_COPIES, cnn_final_epochs=final_epochs, cnn_fold_best_epochs=epochs),
                       cv=dict(top1_mean=float(np.mean(f1)), top1_std=float(np.std(f1)), top3_mean=float(np.mean(f3)),
                               top3_std=float(np.std(f3)), top5_mean=float(np.mean(f5)), top5_std=float(np.std(f5)),
                               top1_folds=f1, per_class=per_class, n_per_class=n_class, demo14=demo,
                               calibration_grid=grid, calibration_rule=rule),
                       webcam=dict(n=len(web), top1=float(np.mean([r["pred"] == r["true"] for r in web])),
                                   top3=float(np.mean([r["true_rank"] is not None and r["true_rank"] <= 3 for r in web])),
                                   top5=float(np.mean([r["true_rank"] is not None and r["true_rank"] <= 5 for r in web])),
                                   v2_top1=float(np.mean([r["v2_pred"] == r["true"] for r in web])), clips=web),
                       train_seconds=round(time.time() - t0, 1))
        joblib.dump(dict(model=model, scaler=scaler, labels=labels, model_name=name, features=FS, feature_set=FS,
                         version=args.version, n_frames=N_FRAMES, trained_on=f"WLASL {len(videos)} videos, {len(labels)} glosses",
                         decision_rule=rule, metrics_file=out_path.with_suffix(".json").name), out_path)
        out_path.with_suffix(".json").write_text(json.dumps(metrics, indent=2))
        results[name] = metrics
        log(f"{name}: top-1 {np.mean(f1):.1%} ± {np.std(f1):.1%}, top-3 {np.mean(f3):.1%}, top-5 {np.mean(f5):.1%}; "
            f"demo-14 {demo['top1_full_vocab']:.1%} (restricted {demo['top1_restricted_to_14']:.1%}); "
            f"webcam {metrics['webcam']['top1']:.0%}; saved {out_path} [{time.time() - t0:.0f}s]")

    write_report(results, labels, dropped, time.time() - t_start, exempt)
    log(f"Total {(time.time() - t_start) / 60:.1f} min. models/sign_model.joblib untouched.")


def write_report(results, labels, dropped, seconds, exempt):
    v2 = json.load(open("models/v2_rf_feat2dom.json"))
    L = [f"# Expanded vocabulary: {len(labels)} glosses (experiment, not the demo model)", "",
         f"Generated {datetime.now():%Y-%m-%d %H:%M} by `src/train_vocab.py` in {seconds / 60:.1f} min. "
         "Held-out signers = 5-fold GroupKFold by signer (seed 0); the 17 webcam clips were never used for any choice.", "",
         f"Dropped glosses (< {MIN_VIDEOS} usable videos): {', '.join(f'{a} ({n})' for a, n in dropped) or 'none'}", "",
         f"Kept although < {MIN_VIDEOS} because they are demo signs (same videos as v2): "
         f"{', '.join(f'{a} ({n})' for a, n in exempt) or 'none'}", "",
         "## Held-out-signer accuracy", "",
         "| model | top-1 | top-3 | top-5 | demo 14 signs: top-1 (all classes) | demo 14: top-1 (only 14 classes) | webcam 17 clips top-1 / top-5 |",
         "|---|---|---|---|---|---|---|"]
    for name, m in results.items():
        cv, d, w = m["cv"], m["cv"]["demo14"], m["webcam"]
        L.append(f"| {m['version']}_{name}_vocab{len(labels)} | {cv['top1_mean']:.1%} ± {cv['top1_std']:.1%} | "
                 f"{cv['top3_mean']:.1%} | {cv['top5_mean']:.1%} | {d['top1_full_vocab']:.1%} | "
                 f"{d['top1_restricted_to_14']:.1%} | {w['top1']:.0%} / {w['top5']:.0%} |")
    L.append(f"| v2_rf_feat2dom (demo, 14 classes) | {v2['cv']['top1_mean']:.1%} ± {v2['cv']['top1_std']:.1%} "
             f"(14-class task) | {v2['cv']['top3_mean']:.1%} | - | {v2['cv']['top1_mean']:.1%} | {v2['cv']['top1_mean']:.1%} | 82% (14/17) |")
    for name, m in results.items():
        pc, n = m["cv"]["per_class"], m["cv"]["n_per_class"]
        ranked = sorted(pc, key=lambda g: (-pc[g], -n[g], g))
        L += ["", f"## {name}: best 10 / worst 10 glosses (held-out signers)", "",
              "| best | acc (n) | worst | acc (n) |", "|---|---|---|---|"]
        for a, b in zip(ranked[:10], ranked[::-1][:10]):
            L.append(f"| {a} | {pc[a]:.0%} ({n[a]}) | {b} | {pc[b]:.0%} ({n[b]}) |")
        d = m["cv"]["demo14"]
        L += ["", f"### {name}: the 14 demo signs (held-out signers; v2 = demo model, 14-class task)", "",
              "| sign | expanded | v2 | most confused with |", "|---|---|---|---|"]
        for s, acc in d["per_sign"].items():
            conf = ", ".join(f"{k} {v}" for k, v in list(d["confused_with"][s].items())[:3]) or "-"
            L.append(f"| {s} | {acc:.0%} | {v2['cv']['per_class'][s]:.0%} | {conf} |")
        r = m["cv"]["calibration_rule"]
        L += ["", f"### {name}: confidence rule (held-out signers, many classes)", ""]
        if r:
            L.append(f"Chosen: show a prediction only if **top-1 >= {r['min_conf']}** and **top-1 - top-2 >= "
                     f"{r['min_margin']}** -> {r['shown']:.0%} shown, {r['acc_shown']:.1%} of shown correct, "
                     f"{r['wrong_shown']:.1%} of all predictions shown-and-wrong (budget {WRONG_BUDGET:.0%}).")
        else:
            L.append(f"No rule in the grid keeps shown-and-wrong <= {WRONG_BUDGET:.0%}.")
        L += ["", "| min top-1 | min margin | shown | accuracy of shown | shown & wrong |", "|---|---|---|---|---|"]
        for g in m["cv"]["calibration_grid"]:
            if g["min_margin"] in (0.0, 0.1, 0.2) and g["min_conf"] in (0.0, 0.2, 0.3, 0.4, 0.5):
                L.append(f"| {g['min_conf']} | {g['min_margin']} | {g['shown']:.0%} | {g['acc_shown']:.1%} | {g['wrong_shown']:.1%} |")
        L += ["", f"### {name}: 17 webcam clips vs v2 (test-only)", "",
              "| clip | true | expanded: pred (conf, margin) | true rank | shown by rule | v2: pred (conf) |",
              "|---|---|---|---|---|---|"]
        for c in m["webcam"]["clips"]:
            L.append(f"| {c['video']} | {c['true']} | {c['pred']} ({c['conf']:.2f}, {c['margin']:.2f}) | {c['true_rank']} | "
                     f"{'yes' if c['shown_by_rule'] else 'no (?)'} | {c['v2_pred']} ({c['v2_conf']:.2f}) |")
    Path("reports/vocab_model_report.md").write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
