"""Train all candidate models with ONE fixed protocol, save each one versioned, compare.

    python src/train_select.py [--version v2] [--gru]

Data (frozen): data/landmarks/wlasl/ kept videos (in-sign >= 80% rule).
Protocol, identical for every candidate:
  - 5-fold GroupKFold by signer_id, shuffled with a fixed seed, computed ONCE and reused.
    No signer is ever in both train and test (asserted).
  - Augmentation only inside the training fold, per source video, after the split.
  - Scaler fit on the training fold only.
  - External test sets (never trained on, never tuned on): phone clips, webcam clips.
Every model is saved as models/<version>_<model>_<features>.joblib + .json (metrics) and never
overwritten. Nothing here touches models/sign_model.joblib: use approve_model.py for that.
Baseline "v1" = features v1 + RandomForest + seed 0, i.e. the model currently in sign_model.joblib;
it is retrained and checked to be identical.
"""
import argparse
import csv
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix
from sklearn.model_selection import GroupKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from augment import NORMAL, augment_one
from features import N_FRAMES, features_from_raw, mirror, prepare, to_feature
from gru import GRUClassifier

LANDMARK_ROOT = Path("data/landmarks")
MODELS_DIR = Path("models")
SEED, N_FOLDS, AUG_COPIES = 0, 5, 10
FEATURES = ["feat1", "feat2", "feat2dom", "feat2mirror"]   # feat2mirror = feat2 + mirrored training copies
MODELS = {
    "knn": lambda: KNeighborsClassifier(n_neighbors=3),
    "rf": lambda: RandomForestClassifier(n_estimators=300, random_state=0),
    # RBF SVM with sklearn defaults (C=1, gamma='scale'); probabilities via Platt scaling
    "svm": lambda: CalibratedClassifierCV(SVC(kernel="rbf", random_state=0), ensemble=False),
    "gru": lambda: GRUClassifier(),
}
EXTERNAL = {"phone": "clips", "webcam": "webcam"}
EXTERNAL_VIDEO_DIRS = {"clips": Path("videos"), "webcam": Path("data/webcam")}
THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def base_fs(fs):
    """Feature set used at prediction time (mirroring is a training-only augmentation)."""
    return "feat2" if fs == "feat2mirror" else fs


def load_source(source):
    index = LANDMARK_ROOT / source / "index.csv"
    if not index.exists():
        return []
    return [dict(video=r["video"], label=r["label"], signer=r["signer_id"],
                 raw=np.load(LANDMARK_ROOT / source / r["label"] / f"{r['video']}.npy"))
            for r in csv.DictReader(open(index)) if r["kept"] == "1"]


def training_set(videos, fs, seed):
    """Originals + AUG_COPIES augmented copies per video. The RNG is consumed in the same order
    as the v1 model, so feat1 reproduces it exactly. feat2mirror adds mirrored copies after."""
    rng = np.random.default_rng(seed)
    base = base_fs(fs)
    X, y = [], []
    passes = [False, True] if fs == "feat2mirror" else [False]
    for flip in passes:
        for v in videos:
            points, presence = prepare(v["raw"], base)
            if flip:
                points, presence = mirror(points, presence)
            X += [to_feature(points, presence, fs=base)]
            X += [augment_one(points, presence, rng, NORMAL, base) for _ in range(AUG_COPIES)]
            y += [v["label"]] * (AUG_COPIES + 1)
    return np.array(X), np.array(y)


def fit(model_name, X, y):
    scaler = StandardScaler().fit(X)
    return scaler, MODELS[model_name]().fit(scaler.transform(X), y)


def proba(scaler, model, X, labels):
    """Probabilities with one column per label (a training fold may lack a class)."""
    p = model.predict_proba(scaler.transform(X))
    full = np.zeros((len(X), len(labels)))
    full[:, [labels.index(c) for c in model.classes_]] = p
    return full


def topk(P, y_idx, k):
    if len(y_idx) == 0:
        return float("nan")
    ranks = np.argsort(-P, axis=1)[:, :k]
    return float(np.mean([t in r for t, r in zip(y_idx, ranks)]))


def threshold_table(P, y_idx):
    """For each threshold: share of predictions shown (conf >= t) and their accuracy."""
    conf, pred = P.max(axis=1), P.argmax(axis=1)
    rows = []
    for t in THRESHOLDS:
        shown = conf >= t
        acc = float((pred[shown] == y_idx[shown]).mean()) if shown.any() else float("nan")
        rows.append(dict(threshold=t, shown=float(shown.mean()), accuracy_when_shown=acc))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="v2", help="version tag for this run's candidates")
    ap.add_argument("--gru", action="store_true", help="also train the GRU on the best sklearn feature set")
    args = ap.parse_args()
    t_start = time.time()

    # ---------------- data + checks ----------------
    wlasl = load_source("wlasl")
    labels = sorted({v["label"] for v in wlasl})
    y_idx = np.array([labels.index(v["label"]) for v in wlasl])
    signers = np.array([v["signer"] for v in wlasl])
    data_info = dict(
        source="data/landmarks/wlasl (kept = in-sign hand rate >= 80%)",
        manifest_sha256=sha256("data/wlasl/manifest.csv"),
        index_sha256=sha256(LANDMARK_ROOT / "wlasl" / "index.csv"),
        n_videos=len(wlasl), n_signers=len(set(signers)), labels=labels)
    print(f"DATA  {len(wlasl)} WLASL videos, {len(labels)} signs, {len(set(signers))} signers")
    print(f"      manifest sha256 {data_info['manifest_sha256'][:16]}...  index sha256 {data_info['index_sha256'][:16]}...")

    external = {name: [v for v in load_source(src) if v["label"] in labels] for name, src in EXTERNAL.items()}
    train_hashes = {sha256(f"data/wlasl/videos/{v['video']}.mp4") for v in wlasl}
    for name, src in EXTERNAL.items():
        ext_hashes = {sha256(next(EXTERNAL_VIDEO_DIRS[src].glob(f"{v['video']}.*"))) for v in external[name]}
        overlap = ext_hashes & train_hashes
        assert not overlap, f"{name} videos found in training data!"
        signs = sorted({v["label"] for v in external[name]})
        print(f"      external '{name}': {len(external[name])} videos ({', '.join(signs)}); "
              f"file-hash overlap with training videos: {len(overlap)}")

    gkf = GroupKFold(n_splits=N_FOLDS, shuffle=True, random_state=SEED)
    folds = list(gkf.split(np.zeros(len(wlasl)), y_idx, groups=signers))
    for tr, te in folds:
        assert not set(signers[tr]) & set(signers[te]), "signer leak"
    print(f"FOLDS GroupKFold(5, shuffle, seed {SEED}) by signer; test videos per fold: "
          f"{[len(te) for _, te in folds]}; signer overlap train/test: none (asserted)")

    # cached training sets: (fs, fold) -> X, y ; and test features per base fs
    cache = {}

    def train_data(fs, fold):
        key = (fs, fold)
        if key not in cache:
            vids = wlasl if fold == "all" else [wlasl[i] for i in folds[fold][0]]
            cache[key] = training_set(vids, fs, SEED if fold == "all" else fold)
        return cache[key]

    test_X = {}

    def features(fs, videos, name):
        key = (base_fs(fs), name)
        if key not in test_X:
            test_X[key] = np.array([features_from_raw(v["raw"], base_fs(fs)) for v in videos])
        return test_X[key]

    # ---------------- evaluate one candidate ----------------
    def evaluate(version, model_name, fs):
        t0 = time.time()
        out_path = MODELS_DIR / f"{version}_{model_name}_{fs}.joblib"
        if out_path.exists():
            raise SystemExit(f"{out_path} exists - refusing to overwrite. Use a new --version.")
        X_all = features(fs, wlasl, "wlasl")
        P = np.zeros((len(wlasl), len(labels)))
        fold_top1, fold_top3 = [], []
        for k, (tr, te) in enumerate(folds):
            s, m = fit(model_name, *train_data(fs, k))
            P[te] = proba(s, m, X_all[te], labels)
            fold_top1.append(topk(P[te], y_idx[te], 1))
            fold_top3.append(topk(P[te], y_idx[te], 3))
        pred = P.argmax(axis=1)
        cm = confusion_matrix(y_idx, pred, labels=range(len(labels)))
        per_class = {lab: float(cm[i, i] / cm[i].sum()) for i, lab in enumerate(labels)}
        h, s_ = labels.index("HELP"), labels.index("STOP")
        help_stop = dict(help_acc=per_class["HELP"], stop_acc=per_class["STOP"],
                         help_as_stop=int(cm[h, s_]), stop_as_help=int(cm[s_, h]),
                         n_help=int(cm[h].sum()), n_stop=int(cm[s_].sum()))

        scaler, model = fit(model_name, *train_data(fs, "all"))       # final model: all WLASL videos
        ext = {}
        for name, vids in external.items():
            if not vids:
                ext[name] = dict(n=0)
                continue
            Pe = proba(scaler, model, features(fs, vids, name), labels)
            ye = np.array([labels.index(v["label"]) for v in vids])
            ext[name] = dict(n=len(vids), top1=topk(Pe, ye, 1), top3=topk(Pe, ye, 3), videos=[
                dict(video=v["video"], true=v["label"], pred=labels[p.argmax()], conf=round(float(p.max()), 3),
                     top3=[labels[i] for i in np.argsort(-p)[:3]]) for v, p in zip(vids, Pe)])

        metrics = dict(
            version=version, model=model_name, features=fs, prediction_features=base_fs(fs),
            date=datetime.now().isoformat(timespec="seconds"), data=data_info,
            protocol=dict(cv=f"GroupKFold({N_FOLDS}, shuffle=True, random_state={SEED}) by signer_id",
                          aug_copies=AUG_COPIES, aug_settings=NORMAL,
                          fold_signers=[sorted(set(signers[te])) for _, te in folds]),
            cv=dict(top1_mean=float(np.mean(fold_top1)), top1_std=float(np.std(fold_top1)),
                    top3_mean=float(np.mean(fold_top3)), top3_std=float(np.std(fold_top3)),
                    top1_folds=fold_top1, top3_folds=fold_top3,
                    top1_pooled=topk(P, y_idx, 1), top3_pooled=topk(P, y_idx, 3),
                    per_class=per_class, help_stop=help_stop,
                    confusion_matrix=dict(labels=labels, rows_true_cols_pred=cm.tolist()),
                    thresholds=threshold_table(P, y_idx)),
            external=ext, train_seconds=round(time.time() - t0, 1))
        MODELS_DIR.mkdir(exist_ok=True)
        joblib.dump(dict(model=model, scaler=scaler, labels=labels, model_name=model_name,
                         features=base_fs(fs), feature_set=fs, version=version, n_frames=N_FRAMES,
                         trained_on=f"WLASL {len(wlasl)} videos", metrics_file=out_path.with_suffix(".json").name),
                    out_path)
        out_path.with_suffix(".json").write_text(json.dumps(metrics, indent=2))

        e = lambda n: f"{ext[n]['top1']:.0%}" if ext[n].get("n") else "-"
        print(f"  {version}_{model_name}_{fs:<12} top-1 {np.mean(fold_top1):5.1%} ± {np.std(fold_top1):4.1%}  "
              f"top-3 {np.mean(fold_top3):5.1%} ± {np.std(fold_top3):4.1%}  HELP {help_stop['help_acc']:4.0%} "
              f"STOP {help_stop['stop_acc']:4.0%}  phone {e('phone'):>4}  webcam {e('webcam'):>4}  "
              f"({metrics['train_seconds']:.0f}s)", flush=True)
        return metrics, (scaler, model), P

    # ---------------- 1. baseline v1, check it reproduces sign_model.joblib ----------------
    print("\nBASELINE (features v1 + RandomForest + seed 0)")
    results = {}
    m, final, _ = evaluate("v1", "rf", "feat1")
    results["v1_rf_feat1"] = m
    current = MODELS_DIR / "sign_model.joblib"
    if current.exists():
        old = joblib.load(current)
        X_check = np.vstack([features("feat1", wlasl, "wlasl")] +
                            [features("feat1", v, n) for n, v in external.items() if v])
        diff = np.abs(proba(old["scaler"], old["model"], X_check, labels) - proba(*final, X_check, labels)).max()
        print(f"  reproduction check vs current sign_model.joblib: max probability difference "
              f"{diff:.2e} on {len(X_check)} videos -> {'IDENTICAL' if diff == 0 else 'DIFFERENT'}")

    # ---------------- 2. candidates ----------------
    print(f"\nCANDIDATES ({args.version})")
    for fs in FEATURES:
        for model_name in ["knn", "rf", "svm"]:
            if fs == "feat1" and model_name == "rf":
                continue                      # identical to the v1 baseline
            results[f"{args.version}_{model_name}_{fs}"] = evaluate(args.version, model_name, fs)[0]
    if args.gru:
        best_fs = max((r for r in results.values() if r["model"] != "gru"),
                      key=lambda r: r["cv"]["top1_mean"])["features"]
        print(f"  GRU on the best sklearn feature set ({best_fs}):")
        results[f"{args.version}_gru_{best_fs}"] = evaluate(args.version, "gru", best_fs)[0]

    # ---------------- 3. comparison ----------------
    base = results["v1_rf_feat1"]
    ranked = sorted(results.items(), key=lambda kv: -kv[1]["cv"]["top1_mean"])
    print("\n" + "=" * 112)
    print("COMPARISON  (ranked by held-out-signer top-1; mean ± std over the same 5 signer folds)")
    print("=" * 112)
    print(f"{'candidate':<24}{'top-1':>14}{'top-3':>14}{'HELP':>6}{'STOP':>6}{'H->S':>5}{'S->H':>5}"
          f"{'phone':>8}{'webcam':>8}  flags")
    for name, r in ranked:
        cv, hs, ext = r["cv"], r["cv"]["help_stop"], r["external"]
        flags = []
        for n in ("phone", "webcam"):
            if ext[n].get("n") and ext[n]["top1"] < base["external"][n]["top1"]:
                flags.append(f"worse than v1 on {n}")
        ph = f"{ext['phone']['top1']:.0%}" if ext["phone"].get("n") else "-"
        wc = f"{ext['webcam']['top1']:.0%}" if ext["webcam"].get("n") else "-"
        print(f"{name:<24}{cv['top1_mean']:>7.1%} ± {cv['top1_std']:>4.1%}{cv['top3_mean']:>7.1%} ± {cv['top3_std']:>4.1%}"
              f"{hs['help_acc']:>6.0%}{hs['stop_acc']:>6.0%}{hs['help_as_stop']:>5}{hs['stop_as_help']:>5}"
              f"{ph:>8}{wc:>8}  {'; '.join(flags)}")
    n_ph, n_wc = base["external"]["phone"].get("n", 0), base["external"]["webcam"].get("n", 0)
    print(f"HELP/STOP = held-out-signer accuracy on those signs (n={base['cv']['help_stop']['n_help']}/"
          f"{base['cv']['help_stop']['n_stop']}); H->S, S->H = confusion counts. phone n={n_ph}, webcam n={n_wc} "
          f"(webcam = HELP only).")

    for name, r in [ranked[0], ("v1_rf_feat1", base)] if ranked[0][0] != "v1_rf_feat1" else [ranked[0]]:
        cv = r["cv"]
        print(f"\n--- {name}: per-class held-out-signer accuracy ---")
        print("  " + "  ".join(f"{lab} {acc:.0%}" for lab, acc in cv["per_class"].items()))
        print("  confusion matrix (rows = true, cols = predicted):")
        print("  " + " " * 10 + "".join(f"{lab[:4]:>5}" for lab in labels))
        for lab, row in zip(labels, cv["confusion_matrix"]["rows_true_cols_pred"]):
            print(f"  {lab:<10}" + "".join(f"{(v if v else '.'):>5}" for v in row))
        print("  confidence threshold (held-out-signer predictions):")
        for t in cv["thresholds"]:
            print(f"    conf >= {t['threshold']:.1f}: shown {t['shown']:5.0%}, accuracy of shown {t['accuracy_when_shown']:5.1%}")
        for n, e in r["external"].items():
            for v in e.get("videos", []):
                mark = "ok" if v["pred"] == v["true"] else ("top-3" if v["true"] in v["top3"] else "WRONG")
                print(f"    [{n}] {v['video']:<22}{v['true']:<10}-> {v['pred']:<10}{v['conf']:.2f}  {mark}")

    print(f"\nAll models + metrics JSON saved in {MODELS_DIR}/ . sign_model.joblib was NOT changed.")
    print(f"Total run time: {(time.time() - t_start) / 60:.1f} min")


if __name__ == "__main__":
    main()
