"""v5 keyword model (116 signs): Phases 2-5. Never touches sign_model.joblib or the v4 files.

    python src/train_keyword.py cv --config cnn_f3_32 [--seed 0]      # 5-fold CV of one candidate
    python src/train_keyword.py report                                # compare v4 + all candidates
    python src/train_keyword.py final --version v5                    # final model of the chosen candidate
    python src/train_keyword.py retrain --version v6                  # ONE command: CV (5 seeds) + report + final

Protocol (identical for v4_cnn and every candidate): the 1,106 WLASL videos and the 5 GroupKFold
folds of v4 (by signer, seed 0); test = held-out signers; inside each training fold a fixed 15% of
the signers is the validation set (early stopping, temperature scaling, specialist keep/drop).
Your own clips (data/me) only ever join the training part; the webcam clips and your personal test
session are test-only. Candidates are ranked on macro top-1 (mean over the 116 signs), then macro top-5.

Data (Phase 2): per video its original + 10 augmented copies (20 for signs with <= 6 videos):
rotation/scale/shift/jitter, time stretch, segmentation jitter (start/end moved up to 25% of the
live-rule segment, early or late), mirror + hand swap for two-handed-ish clips; class-balanced
sampling (cap 3x); your clips 3x weight. NOTHING class only if data/me/NOTHING has clips.
Outputs: reports/oof/<version>/<config>_s<seed>.npz, reports/<version>_eval.md (+ _choice.json,
_candidates.json), reports/record_next.md, models/<version>_keyword_*.joblib/.json, models/keyword_model.*
"""
import argparse
import json
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from multiprocessing import get_context
from pathlib import Path

import numpy as np

import keyword_data as KD
from augment import NORMAL, augment_one
from features import FRAME_DIMS, prepare, to_feature
from keyword_model import apply_pairs, spec_summary

CACHE, OOF = Path("data/cache/v5"), Path("reports/oof")
OOF_DIR = [OOF / "v5"]            # candidates' out-of-fold logits (retrain --version vN uses reports/oof/vN)


def oof_dir():
    OOF_DIR[0].mkdir(parents=True, exist_ok=True)
    return OOF_DIR[0]


def tag():
    """Version tag of this run (v5, or the --version of `retrain`): names the report/choice files."""
    return OOF_DIR[0].name


def choice_path():
    return Path(f"reports/{tag()}_choice.json")
CONFIGS = {   # name: arch, feature set, frames, phase-2 data (balanced sampling + segmentation jitter + mirror)
    "cnn_f2_16_nobal": dict(arch="cnn", fs="feat2dom", frames=16, phase2=False),
    "cnn_f2_16": dict(arch="cnn", fs="feat2dom", frames=16, phase2=True),
    "cnn_f3_16": dict(arch="cnn", fs="feat3", frames=16, phase2=True),
    "cnn_f3_32": dict(arch="cnn", fs="feat3", frames=32, phase2=True),
    "tf_f3_16": dict(arch="transformer", fs="feat3", frames=16, phase2=True),
    "tf_f3_32": dict(arch="transformer", fs="feat3", frames=32, phase2=True),
}
THRESHOLDS = (0.25, 0.35, 0.5)
THRESHOLD = 0.35
N_SPECIALISTS = 10
LATENCY_BUDGET_MS = 150


def log(*a):
    print(*a, flush=True)


# =================================================================== data / inputs
def load_all():
    labels, videos, oov, usable = KD.load_wlasl("wlasl_v5")
    v4_labels, v4_videos, _, _ = KD.load_wlasl("wlasl_vocab")
    assert labels == v4_labels and [v["video"] for v in videos] == [v["video"] for v in v4_videos], \
        "v5 video list differs from v4"
    me_train, me_test = KD.load_me()
    nothing = [v for v in me_train if v["label"] == KD.NOTHING]
    if nothing:
        labels = sorted(labels + [KD.NOTHING])
    web = []
    for f in sorted(Path("data/landmarks/webcam_v5").glob("*/*.npy")):
        web.append(dict(video=f.stem, label=f.parent.name, signer="webcam", raw=np.load(f)))
    return labels, videos, oov, usable, me_train, me_test, web


def pool_paths(cfg, n_me_train=0, n_me_test=0):
    """Cache files; the tags include the number of own clips, so new recordings rebuild them."""
    me = f"_me{n_me_train}" if n_me_train else ""
    tag = f"{cfg['fs']}_{cfg['frames']}_{'p2' if cfg['phase2'] else 'base'}{me}"
    etag = f"{cfg['fs']}_{cfg['frames']}" + (f"_met{n_me_test}" if n_me_test else "")
    return CACHE / f"pool_{tag}.npy", CACHE / f"pool_{tag}_meta.npz", CACHE / f"eval_{etag}.npy"


def build_inputs(cfg, labels, videos, oov, usable, me_train, me_test, web):
    """Training pool (+ meta) and evaluation views (all clips x TTA views), cached on disk."""
    CACHE.mkdir(parents=True, exist_ok=True)
    pool, meta, evalp = pool_paths(cfg, len(me_train), len(me_test))
    train_videos = videos + me_train
    if not pool.exists() or not meta.exists():
        t = time.time()
        if cfg["phase2"]:
            row_video, row_orig = KD.build_pool(train_videos, usable, cfg["fs"], cfg["frames"], pool, log=log)
        else:                                            # v4-style: 10 copies, augment_one (trim + time stretch)
            row_video, row_orig = build_pool_v4style(train_videos, cfg, pool)
        np.savez(meta, row_video=row_video, row_orig=row_orig, n_train_videos=len(train_videos))
        log(f"  pool {pool.name}: {len(row_video)} rows in {time.time() - t:.0f}s")
    live_path = evalp.with_name(evalp.stem + "_live.npy")
    if not evalp.exists() or not live_path.exists():
        t = time.time()
        clips = videos + oov + web + me_test
        first = KD.clip_inputs(clips[0]["raw"], cfg["fs"], cfg["frames"])
        E = np.lib.format.open_memmap(evalp.with_suffix(".tmp.npy"), "w+", np.float32, (len(clips),) + first.shape)
        Lv = np.lib.format.open_memmap(live_path.with_suffix(".tmp.npy"), "w+", np.float32, (len(videos),) + first.shape)
        live_ok = np.zeros(len(videos), bool)
        for i, c in enumerate(clips):
            E[i] = KD.clip_inputs(c["raw"], cfg["fs"], cfg["frames"])
            if i < len(videos):
                span = KD.live_span(c["raw"])
                try:
                    Lv[i] = KD.clip_inputs(c["raw"][span[0]:span[1] + 1], cfg["fs"], cfg["frames"]) if span else E[i]
                    live_ok[i] = span is not None
                except ValueError:
                    Lv[i] = E[i]
        E.flush(), Lv.flush()
        del E, Lv
        evalp.with_suffix(".tmp.npy").replace(evalp)
        live_path.with_suffix(".tmp.npy").replace(live_path)
        np.save(evalp.with_name(evalp.stem + "_liveok.npy"), live_ok)
        log(f"  eval views {evalp.name}: {len(clips)} clips x {first.shape[0]} views in {time.time() - t:.0f}s")
    return pool, meta, evalp, live_path


def build_pool_v4style(train_videos, cfg, path):
    rng = np.random.default_rng(KD.SEED)
    n_rows = len(train_videos) * (1 + KD.AUG_COPIES)
    D = FRAME_DIMS[cfg["fs"]] * cfg["frames"]
    X = np.lib.format.open_memmap(path.with_suffix(".tmp.npy"), "w+", np.float32, (n_rows, D))
    row_video, row_orig = np.repeat(np.arange(len(train_videos)), 1 + KD.AUG_COPIES).astype(np.int32), np.zeros(n_rows, bool)
    for i, v in enumerate(train_videos):
        points, presence = prepare(v["raw"], cfg["fs"])
        r = i * (1 + KD.AUG_COPIES)
        X[r] = to_feature(points, presence, fs=cfg["fs"], n_frames=cfg["frames"])
        X[r + 1:r + 1 + KD.AUG_COPIES] = [augment_one(points, presence, rng, NORMAL, cfg["fs"]) for _ in range(KD.AUG_COPIES)]
        row_orig[r] = True
    X.flush()
    del X
    path.with_suffix(".tmp.npy").replace(path)
    return row_video, row_orig


# =================================================================== cross-validation
def fold_worker(job):
    import torch
    torch.set_num_threads(job["threads"])
    from seqmodels import SeqClassifier
    t = time.time()
    X = np.load(job["pool"], mmap_mode="r")
    E = np.load(job["eval"], mmap_mode="r")
    Lv = np.load(job["live"], mmap_mode="r")
    m = SeqClassifier(job["arch"], job["frames"], seed=job["seed"], balanced=job["phase2"])
    m.fit(X, job["y_rows"], rows=job["rows"], sample_weight=job["w_rows"], X_val=np.asarray(E[job["val_idx"], 0]),
          y_val=job["y_val"], labels=job["labels"])
    K, D = E.shape[1], E.shape[2]

    def logits(arr, idx):
        idx = np.asarray(idx, int)
        if not len(idx):
            return np.zeros((0, K, len(job["labels"])), np.float32)
        return m.logits(np.asarray(arr[idx]).reshape(-1, D)).reshape(len(idx), K, -1).astype(np.float32)

    out = dict(test_idx=job["test_idx"], L_test=logits(E, job["test_idx"]), L_live=logits(Lv, job["test_idx"]),
               val_idx=job["val_idx"], L_val=logits(E, job["val_idx"]), L_other=logits(E, job["other_idx"]),
               best_epoch=m.best_epoch, history=np.array(m.history), seconds=time.time() - t)
    np.savez(job["out"], **out)
    return job["k"], m.best_epoch, out["seconds"]


def run_cv(name, seed, workers, threads):
    cfg = CONFIGS[name]
    labels, videos, oov, usable, me_train, me_test, web = load_all()
    log(f"CV {name} seed {seed}: {cfg} | {len(videos)} WLASL videos, {len(labels)} classes, "
        f"{len(me_train)} own training clips, {len(me_test)} own test clips")
    pool, meta, evalp, live_path = build_inputs(cfg, labels, videos, oov, usable, me_train, me_test, web)
    M = np.load(meta)
    row_video, n_vid = M["row_video"], len(videos)
    train_videos = videos + me_train
    y_rows_all = np.array([train_videos[i]["label"] for i in row_video])
    w_rows_all = np.array([train_videos[i]["weight"] for i in row_video], dtype=float)
    folds = KD.wlasl_folds(videos)
    other_idx = np.arange(n_vid, n_vid + len(oov) + len(web) + len(me_test))
    out_dir = CACHE / "cv" / f"{name}_s{seed}_me{len(me_train)}_{len(me_test)}"
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = []
    for k, (tr, te) in enumerate(folds):
        fit_idx, val_idx = KD.val_split(tr, videos, k)
        keep = np.isin(row_video, fit_idx) | (row_video >= n_vid)          # own clips: always training
        rows = np.flatnonzero(keep)
        jobs.append(dict(k=k, arch=cfg["arch"], frames=cfg["frames"], phase2=cfg["phase2"], seed=seed, threads=threads,
                         pool=str(pool), eval=str(evalp), live=str(live_path), rows=rows, y_rows=y_rows_all[rows],
                         w_rows=w_rows_all[rows], val_idx=val_idx, y_val=np.array([videos[i]["label"] for i in val_idx]),
                         test_idx=te, other_idx=other_idx, labels=labels, out=str(out_dir / f"fold{k}.npz")))
    todo = [j for j in jobs if not Path(j["out"]).exists()]
    t = time.time()
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[var] = str(threads)                  # inherited by the spawned fold workers
    if todo:
        with get_context("spawn").Pool(min(workers, len(todo))) as p:
            for k, ep, sec in p.imap_unordered(fold_worker, todo):
                log(f"  fold {k} done: best epoch {ep}, {sec:.0f}s  [{time.time() - t:.0f}s]")
    assemble(name, seed, cfg, labels, videos, oov, web, me_test, folds, out_dir, live_path)
    log(f"CV {name} seed {seed} finished in {time.time() - t:.0f}s")


def assemble(name, seed, cfg, labels, videos, oov, web, me_test, folds, out_dir, live_path):
    n, C = len(videos), len(labels)
    parts = [dict(np.load(out_dir / f"fold{k}.npz")) for k in range(len(folds))]
    K = parts[0]["L_test"].shape[1]
    L_full, L_live = np.zeros((n, K, C), np.float32), np.zeros((n, K, C), np.float32)
    fold = np.zeros(n, int)
    for k, p in enumerate(parts):
        L_full[p["test_idx"]], L_live[p["test_idx"]], fold[p["test_idx"]] = p["L_test"], p["L_live"], k
    n_oov, n_web = len(oov), len(web)
    others = np.stack([p["L_other"] for p in parts])                       # (5, n_other, K, C)
    te_signers = [set(videos[i]["signer"] for i in te) for _, te in folds]
    L_oov = np.zeros((n_oov, K, C), np.float32)
    for j, v in enumerate(oov):
        ks = [k for k in range(len(folds)) if v["signer"] in te_signers[k]]
        L_oov[j] = others[ks[0], j] if ks else others[:, j].mean(axis=0)
    y = np.array([labels.index(v["label"]) for v in videos])
    np.savez(oof_dir() / f"{name}_s{seed}.npz", labels=np.array(labels), y=y, fold=fold, L_full=L_full, L_live=L_live,
             live_ok=np.load(live_path.with_name(live_path.stem + "ok.npy")),
             val_fold=np.concatenate([np.full(len(p["val_idx"]), k) for k, p in enumerate(parts)]),
             val_idx=np.concatenate([p["val_idx"] for p in parts]), L_val=np.concatenate([p["L_val"] for p in parts]),
             L_oov=L_oov, L_web=others[:, n_oov:n_oov + n_web], web_y=np.array([labels.index(w["label"]) for w in web]),
             L_me=others[:, n_oov + n_web:], me_y=np.array([labels.index(v["label"]) if v["label"] in labels else -1 for v in me_test]),
             best_epochs=np.array([int(p["best_epoch"]) for p in parts]),
             seconds=np.array([float(p["seconds"]) for p in parts]), config=json.dumps(cfg))


# =================================================================== evaluation
from seqmodels import ece, fit_temperature, softmax  # noqa: E402  (light imports, after the worker code)


def topk(P, y, k):
    return np.array([t in r for t, r in zip(y, np.argsort(-P, axis=1)[:, :k])])


class Run:
    """Out-of-fold logits of one candidate (or an ensemble of seeds), with views (plain / TTA)."""

    def __init__(self, name, files):
        d = [np.load(f, allow_pickle=False) for f in files]
        self.name, self.n_seeds = name, len(d)
        self.labels = list(d[0]["labels"])
        self.y, self.fold = d[0]["y"], d[0]["fold"]
        avg = lambda key: np.mean([x[key] for x in d], axis=0)
        self.L_full, self.L_live, self.L_val = avg("L_full"), avg("L_live"), avg("L_val")
        self.L_oov, self.L_web, self.L_me = avg("L_oov"), avg("L_web"), avg("L_me")
        self.live_ok, self.val_fold, self.val_idx = d[0]["live_ok"], d[0]["val_fold"], d[0]["val_idx"]
        self.web_y, self.me_y = d[0]["web_y"], d[0]["me_y"]
        self.best_epochs = np.stack([x["best_epochs"] for x in d])
        self.seconds = float(sum(x["seconds"].sum() for x in d))
        self.config = json.loads(str(d[0]["config"]))

    def view(self, L, tta):
        return L.mean(axis=-2) if tta else L[..., 0, :]

    def temperatures(self, tta):
        return np.array([fit_temperature(self.view(self.L_val[self.val_fold == k], tta),
                                         self.y[self.val_idx[self.val_fold == k]]) for k in range(5)])


class V4Run:
    """v4_cnn baseline from reports/oof/v4_cnn.npz (probabilities -> log-probabilities; no TTA, T = 1)."""

    def __init__(self, path=OOF / "v4_cnn.npz"):
        d = np.load(path)
        self.name, self.n_seeds, self.labels = "v4_cnn (baseline)", 1, list(d["labels"])
        self.y, self.fold, self.live_ok = d["y"], d["fold"], d["live_ok"]
        lg = lambda P: np.log(np.clip(P, 1e-12, 1))[..., None, :]
        self.L_full, self.L_live, self.L_oov = lg(d["P_full"]), lg(d["P_live"]), lg(d["P_oov"])
        self.L_web, self.web_y = lg(d["P_web"])[None], d["web_y"]
        self.L_me, self.me_y = np.zeros((1, 0, 1, len(self.labels))), np.zeros(0, int)
        self.config, self.best_epochs, self.seconds = dict(arch="cnn", fs="feat2dom", frames=16), None, None

    def view(self, L, tta):
        return L[..., 0, :]

    def temperatures(self, tta):
        return np.ones(5)


def metrics(run, tta=False, calibrate=True, specialists=None):
    """All Phase-5 numbers for one run/view. specialists: optional fn(P_cal, fold) -> P_cal reordered."""
    labels, y = run.labels, run.y
    C = len(labels)
    T = run.temperatures(tta) if calibrate else np.ones(5)
    raw = softmax(run.view(run.L_full, tta))
    P = softmax(run.view(run.L_full, tta) / T[run.fold][:, None])
    if specialists:
        P = specialists(P, run.fold)
    real = [i for i, lab in enumerate(labels) if lab != KD.NOTHING]
    t1, t3, t5 = topk(P, y, 1), topk(P, y, 3), topk(P, y, 5)
    per = {labels[i]: (float(t1[y == i].mean()), float(t5[y == i].mean()), int((y == i).sum())) for i in real if (y == i).any()}
    acc1 = np.array([a for a, _, _ in per.values()])
    pred, conf = P.argmax(1), P.max(1)
    directed = Counter((labels[a], labels[b]) for a, b in zip(y, pred) if a != b)
    pairs = Counter()
    for (a, b), c in directed.items():
        pairs[tuple(sorted((a, b)))] += c
    worst = sorted(per, key=lambda g: (per[g][0], per[g][1], g))[:10]
    thr = {}
    for th in THRESHOLDS:
        shown = conf >= th
        thr[th] = dict(shown=float(shown.mean()), wrong_of_shown=float((pred[shown] != y[shown]).mean()) if shown.any() else 0.0,
                       per_sign_shown={g: float(shown[y == labels.index(g)].mean()) for g in labels if g != KD.NOTHING and (y == labels.index(g)).any()})
    # live-rule segments (clips the rule misses count as wrong: live would never see them)
    PL = softmax(run.view(run.L_live, tta) / T[run.fold][:, None])
    if specialists:
        PL = specialists(PL, run.fold, "live")
    live1, live5 = topk(PL, y, 1) & run.live_ok, topk(PL, y, 5) & run.live_ok
    # out-of-vocabulary clips (dropped glosses): false keywords at the threshold
    Po = softmax(run.view(run.L_oov, tta) / np.median(T))
    # webcam: mean of the 5 fold models (v4: its final model)
    Pw = softmax(run.view(run.L_web, tta).mean(axis=0) / np.median(T))
    Pm = softmax(run.view(run.L_me, tta).mean(axis=0) / np.median(T)) if len(run.me_y) else None
    return dict(
        top1=float(t1.mean()), top3=float(t3.mean()), top5=float(t5.mean()),
        top1_folds=[float(t1[run.fold == k].mean()) for k in range(5)],
        macro1=float(acc1.mean()), macro5=float(np.mean([b for _, b, _ in per.values()])),
        ge50=int((acc1 >= 0.5).sum()), ge80=int((acc1 >= 0.8).sum()), zero=int((acc1 == 0).sum()),
        per_sign=per, worst10=worst, pairs=[(a, b, c, directed[(a, b)], directed[(b, a)]) for (a, b), c in pairs.most_common(20)],
        ece_raw=ece(raw, y), ece_cal=ece(P, y), temperatures=[round(float(t), 3) for t in T], thresholds=thr,
        live_top1=float(live1.mean()), live_top5=float(live5.mean()), live_cut=float(run.live_ok.mean()),
        oov_n=len(Po), oov_false_kw={th: float((Po.max(1) >= th).mean()) for th in THRESHOLDS} if len(Po) else {},
        web_top1=int(topk(Pw, run.web_y, 1).sum()), web_top5=int(topk(Pw, run.web_y, 5).sum()), web_n=len(run.web_y),
        me_top1=(int(topk(Pm, run.me_y, 1).sum()) if Pm is not None else None),
        me_top5=(int(topk(Pm, run.me_y, 5).sum()) if Pm is not None else None), me_n=len(run.me_y),
        v4_margin_rule=None)


def v4_margin_rule(run):
    """The v4 rule (top-1 - top-2 >= 0.4 on raw probabilities), for the threshold comparison."""
    P = softmax(run.view(run.L_full, False))
    s = np.sort(P, axis=1)
    shown = s[:, -1] - s[:, -2] >= 0.4
    pred = P.argmax(1)
    return dict(shown=float(shown.mean()), wrong_of_shown=float((pred[shown] != run.y[shown]).mean()))


def better(a, b):
    """Selection rule between two metric dicts: higher macro top-1, then higher macro top-5."""
    return (a["macro1"], a["macro5"]) > (b["macro1"], b["macro5"])


# =================================================================== pair specialists
def train_specialist(Xa, Xb):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    X = np.concatenate([Xa, Xb])
    y = np.r_[np.ones(len(Xa)), np.zeros(len(Xb))]
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.05, class_weight="balanced", max_iter=2000)).fit(X, y)


def specialists_cv(run, tta, v4):
    """Per fold: pick the 10 most confused pairs (v4 errors on this fold's TRAINING signers + the
    candidate's errors on this fold's validation signers), train a specialist on the fold's
    training rows, keep it only if it beats the main model on that pair's validation clips.
    Returns (fn for metrics(), per-fold report, pair -> folds kept)."""
    cfg = run.config
    _, videos, _, _, me_train, me_test, _ = load_all()
    pool, meta, evalp = pool_paths(cfg, len(me_train), len(me_test))
    X, M = np.load(pool, mmap_mode="r"), np.load(meta)
    E = np.load(evalp, mmap_mode="r")
    E_live = np.load(evalp.with_name(evalp.stem + "_live.npy"), mmap_mode="r")
    labels, y = run.labels, run.y
    n_vid = len(videos)
    row_video = M["row_video"]
    train_videos = videos + me_train
    row_label = np.array([train_videos[i]["label"] for i in row_video])
    folds = KD.wlasl_folds(videos)
    T = run.temperatures(tta)
    v4_pred = np.exp(v4.L_full[:, 0]).argmax(1)
    fold_specs, report, kept_in = {}, [], defaultdict(list)
    feats = dict(full=spec_summary(np.asarray(E[:n_vid, 0]), cfg["fs"], cfg["frames"]),
                 live=spec_summary(np.asarray(E_live[:, 0]), cfg["fs"], cfg["frames"]))
    feats_test = feats["full"]
    for k, (tr, te) in enumerate(folds):
        fit_idx, val_idx = KD.val_split(tr, videos, k)
        counts = Counter()
        for i in tr:                                                 # v4 errors on this fold's training signers
            if v4_pred[i] != y[i]:
                counts[tuple(sorted((labels[y[i]], labels[v4_pred[i]])))] += 1
        Pv = softmax(run.view(run.L_val[run.val_fold == k], tta) / T[k])
        yv = y[run.val_idx[run.val_fold == k]]
        for a, b in zip(yv, Pv.argmax(1)):
            if a != b:
                counts[tuple(sorted((labels[a], labels[b])))] += 1
        specs = {}
        for (la, lb), c in counts.most_common(N_SPECIALISTS):
            ia, ib = labels.index(la), labels.index(lb)
            in_fit = np.isin(row_video, fit_idx) | (row_video >= n_vid)
            ra, rb = np.flatnonzero(in_fit & (row_label == la)), np.flatnonzero(in_fit & (row_label == lb))
            if not len(ra) or not len(rb):
                continue
            s = train_specialist(spec_summary(np.asarray(X[ra]), cfg["fs"], cfg["frames"]),
                                 spec_summary(np.asarray(X[rb]), cfg["fs"], cfg["frames"]))
            vm = np.isin(yv, [ia, ib])
            if not vm.any():
                report.append((k, la, lb, c, 0, None, None, False))
                continue
            fv = feats_test[run.val_idx[run.val_fold == k][vm]]
            spec_ok = ((s.predict_proba(fv)[:, 1] >= 0.5) == (yv[vm] == ia)).sum()
            main_ok = ((Pv[vm][:, ia] >= Pv[vm][:, ib]) == (yv[vm] == ia)).sum()
            keep = spec_ok > main_ok
            report.append((k, la, lb, c, int(vm.sum()), int(spec_ok), int(main_ok), bool(keep)))
            if keep:
                specs[(la, lb)] = s
                kept_in[(la, lb)].append(k)
        fold_specs[k] = specs

    def fn(P, fold, which="full"):
        out = P.copy()
        for k in range(5):
            m = fold == k
            if fold_specs[k] and m.any():
                out[m] = apply_pairs(P[m], feats[which][m], fold_specs[k], labels)
        return out
    return fn, report, kept_in


# =================================================================== report
def write_eval_report(results, decisions, extra):
    v4m = results["v4_cnn (baseline)"]
    L = [f"# {tag()} keyword model: evaluation (held-out signers)", "",
         f"Generated {datetime.now():%Y-%m-%d %H:%M} by `src/train_keyword.py report`. Identical protocol for every row: "
         "the 1,106 WLASL videos, the 5 signer folds of v4 (GroupKFold, seed 0), test = held-out signers. "
         "Probabilities are temperature-scaled per fold on that fold's validation signers (v4: uncalibrated). "
         "Webcam = 17 test clips, scored with the mean of the 5 fold models (v4: its final model); never used for any choice.", "",
         "## Candidates", "",
         "| candidate | macro top-1 | macro top-5 | overall top-1 / top-3 / top-5 | signs >= 50% / >= 80% | live-rule segments top-1 / top-5 | webcam top-1 / top-5 | ECE raw -> calibrated | CV train time |",
         "|---|---|---|---|---|---|---|---|---|"]
    for name, m in results.items():
        L.append(f"| {name} | {m['macro1']:.1%} | {m['macro5']:.1%} | {m['top1']:.1%} / {m['top3']:.1%} / {m['top5']:.1%} | "
                 f"{m['ge50']} / {m['ge80']} | {m['live_top1']:.1%} / {m['live_top5']:.1%} | {m['web_top1']}/{m['web_n']} / {m['web_top5']}/{m['web_n']} | "
                 f"{m['ece_raw']:.3f} -> {m['ece_cal']:.3f} | {m.get('train_min', '-')} |")
    L += ["", "## Decisions (in order)", ""] + [f"{i}. {d}" for i, d in enumerate(decisions, 1)]
    best = results[extra["best"]]
    L += ["", f"## Worst 10 signs: v4 vs {extra['best']}", "",
          "| v4 worst 10 | v4 top-1 / top-5 | -> v5 top-1 / top-5 | v5 worst 10 | v5 top-1 / top-5 | v5 shown at 0.35 |", "|---|---|---|---|---|---|"]
    for a, b in zip(v4m["worst10"], best["worst10"]):
        pa, pb = v4m["per_sign"][a], best["per_sign"][b]
        L.append(f"| {a} | {pa[0]:.0%} / {pa[1]:.0%} | {best['per_sign'][a][0]:.0%} / {best['per_sign'][a][1]:.0%} | {b} | "
                 f"{pb[0]:.0%} / {pb[1]:.0%} | {best['thresholds'][0.35]['per_sign_shown'][b]:.0%} |")
    L += ["", f"## Top 20 confused pairs: v4 vs {extra['best']}", "", "| # | v4 pair | errors (A->B / B->A) | v5 pair | errors (A->B / B->A) |", "|---|---|---|---|---|"]
    for i, (p, q) in enumerate(zip(v4m["pairs"], best["pairs"]), 1):
        L.append(f"| {i} | {p[0]} / {p[1]} | {p[2]} ({p[3]} / {p[4]}) | {q[0]} / {q[1]} | {q[2]} ({q[3]} / {q[4]}) |")
    L += ["", f"## Confidence threshold on the calibrated top-1 probability ({extra['best']})", "",
          "| rule | shown | wrong among shown |", "|---|---|---|"]
    for th in THRESHOLDS:
        t = best["thresholds"][th]
        L.append(f"| top-1 >= {th}{' (default)' if th == THRESHOLD else ''} | {t['shown']:.1%} | {t['wrong_of_shown']:.1%} |")
    vm = extra["v4_margin"]
    L.append(f"| v4 rule (v4 model: top-1 - top-2 >= 0.4) | {vm['shown']:.1%} | {vm['wrong_of_shown']:.1%} |")
    for th in THRESHOLDS:
        t = v4m["thresholds"][th]
        L.append(f"| v4 model, raw top-1 >= {th} | {t['shown']:.1%} | {t['wrong_of_shown']:.1%} |")
    L += ["", "Candidates are always sent to the backend; the threshold only sets `confident` and the on-screen label.", "",
          "## NOTHING / false keywords", "", extra["nothing_text"], "",
          "| model | out-of-vocabulary clips confident at 0.25 / 0.35 / 0.5 |", "|---|---|"]
    for name, m in results.items():
        if m["oov_false_kw"]:
            L.append(f"| {name} | " + " / ".join(f"{m['oov_false_kw'][th]:.0%}" for th in THRESHOLDS) + f" (n = {m['oov_n']}) |")
    if extra.get("spec_report"):
        L += ["", f"## Pair specialists ({extra['best_base']})", "",
              "| fold | pair | confusions used to pick it | val clips | specialist right | main model right | kept |", "|---|---|---|---|---|---|---|"]
        for k, a, b, c, n, s, mm, keep in extra["spec_report"]:
            L.append(f"| {k} | {a} / {b} | {c} | {n} | {s if s is not None else '-'} | {mm if mm is not None else '-'} | {'yes' if keep else 'no'} |")
    L += ["", f"## All signs ({extra['best']}), worst first", "", "| sign | videos | v4 top-1 / top-5 | v5 top-1 / top-5 |", "|---|---|---|---|"]
    for g in sorted(best["per_sign"], key=lambda g: (best["per_sign"][g][0], best["per_sign"][g][1])):
        a, b = v4m["per_sign"][g], best["per_sign"][g]
        L.append(f"| {g} | {b[2]} | {a[0]:.0%} / {a[1]:.0%} | {b[0]:.0%} / {b[1]:.0%} |")
    Path(f"reports/{tag()}_eval.md").write_text("\n".join(L) + "\n")


def run_report(final_choice_path=None):
    """Evaluate v4 + every candidate found in reports/oof, apply the selection rules, write
    reports/<version>_eval.md and the chosen pipeline to reports/<version>_choice.json (read by `final`)."""
    v4 = V4Run()
    results, decisions = {"v4_cnn (baseline)": metrics(v4, calibrate=False)}, []
    singles = {}
    for name in CONFIGS:
        f = oof_dir() / f"{name}_s0.npz"
        if f.exists():
            r = Run(name, [f])
            m = metrics(r, tta=False)
            m["train_min"] = f"{r.seconds / 60:.0f} CPU-min"
            results[name] = m
            singles[name] = (r, m)
    if not singles:
        sys.exit("no candidate CV results in reports/oof - run `cv` first")
    v4m = results["v4_cnn (baseline)"]
    pairs = [("cnn_f2_16_nobal", "cnn_f2_16", "Phase 2 data (balanced sampling, segmentation jitter, mirror, extra copies)"),
             ("cnn_f2_16", "cnn_f3_16", "features v3 (angles, fingertip and face distances, acceleration)"),
             ("cnn_f3_16", "cnn_f3_32", "32 frames instead of 16 (CNN)"),
             ("tf_f3_16", "tf_f3_32", "32 frames instead of 16 (transformer)"),
             ("cnn_f3_16", "tf_f3_16", "transformer instead of 1D-CNN (16 frames)"),
             ("cnn_f3_32", "tf_f3_32", "transformer instead of 1D-CNN (32 frames)")]
    if "cnn_f2_16_nobal" in results:
        a = results["cnn_f2_16_nobal"]
        decisions.append(f"New trainer without Phase 2 (`cnn_f2_16_nobal`, same features/augmentation as v4) vs v4: macro top-1 "
                         f"{v4m['macro1']:.1%} -> {a['macro1']:.1%}, macro top-5 {v4m['macro5']:.1%} -> {a['macro5']:.1%} "
                         "(trainer differences only: fixed validation signers per fold, early stopping on (top-1 + top-5) / 2).")
    for a, b, what in pairs:
        if a in results and b in results:
            ma, mb = results[a], results[b]
            decisions.append(f"{what}: `{a}` -> `{b}`: macro top-1 {ma['macro1']:.1%} -> {mb['macro1']:.1%}, macro top-5 "
                             f"{ma['macro5']:.1%} -> {mb['macro5']:.1%} -> {'helped' if better(mb, ma) else 'did not help'}.")
    best_name = max(singles, key=lambda n: (singles[n][1]["macro1"], singles[n][1]["macro5"]))
    decisions.append(f"Best single model (macro top-1, then macro top-5): `{best_name}`.")
    for d in sorted((CACHE / "cv").glob("*_s0_*")):               # runs stopped before all 5 folds finished
        name = d.name.split("_s0_")[0]
        done = sorted(int(f.stem[4:]) for f in d.glob("fold*.npz"))
        if name in singles or not done or len(done) == 5:
            continue
        ref = next((r for r in (CACHE / "cv").glob(f"{best_name}_s0_*")), None)
        parts = []
        for k in done:
            a = np.load(d / f"fold{k}.npz")
            b = np.load(ref / f"fold{k}.npz") if ref else None
            yk = singles[best_name][0].y[a["test_idx"]]
            acc = lambda z: (float(np.mean(z["L_test"][:, 0].argmax(1) == yk)),
                             float(np.mean(topk(z["L_test"][:, 0], yk, 5))))
            (a1, a5), (b1, b5) = acc(a), acc(b) if b is not None else (np.nan, np.nan)
            parts.append(f"fold {k} (n = {len(yk)}): top-1 {a1:.1%} / top-5 {a5:.1%} vs `{best_name}` {b1:.1%} / {b5:.1%}, "
                         f"{float(a['seconds']) / 60:.0f} min for this fold")
        decisions.append(f"`{name}` was stopped after {len(done)} of 5 folds to stay within the 2 h training budget "
                         f"(one thread per fold; projected > 1 h for the run, and the 5-seed ensemble would have been ~5x more): "
                         + "; ".join(parts) + ". Promising but not a complete result, so it was not selected. It is the first "
                         "thing to try with more CPU time.")
    choice = dict(config=best_name, seeds=[0], tta=False, specialists=False)
    best_key, best_m, best_run = best_name, singles[best_name][1], singles[best_name][0]
    seed_files = sorted(oof_dir().glob(f"{best_name}_s*.npz"))
    if len(seed_files) > 1:
        ens = Run(f"{best_name} x{len(seed_files)} seeds", seed_files)
        me = metrics(ens, tta=False)
        me["train_min"] = f"{ens.seconds / 60:.0f} CPU-min"
        key = ens.name
        results[key] = me
        helped = better(me, best_m)
        decisions.append(f"Ensemble of {len(seed_files)} seeds (logits averaged): macro top-1 {best_m['macro1']:.1%} -> {me['macro1']:.1%}, "
                         f"macro top-5 {best_m['macro5']:.1%} -> {me['macro5']:.1%} -> {'helped, kept' if helped else 'did not help, single seed kept'}.")
        if helped:
            best_key, best_m, best_run = key, me, ens
            choice["seeds"] = [int(f.stem.split("_s")[-1]) for f in seed_files]
    mt = metrics(best_run, tta=True)
    key = best_key + " + TTA"
    mt["train_min"] = best_m.get("train_min")
    results[key] = mt
    helped = better(mt, best_m) and mt["macro5"] >= best_m["macro5"]
    decisions.append(f"Test-time augmentation ({len(KD.TTA_VIEWS)} views: segment start/end +-10%, scale 0.95/1.05): macro top-1 "
                     f"{best_m['macro1']:.1%} -> {mt['macro1']:.1%}, macro top-5 {best_m['macro5']:.1%} -> {mt['macro5']:.1%} -> "
                     f"{'helped' if helped else 'did not help'} (latency checked in `final`, budget {LATENCY_BUDGET_MS} ms).")
    if helped:
        best_key, best_m, choice["tta"] = key, mt, True
    fn, spec_report, kept_in = specialists_cv(best_run, choice["tta"], v4)
    ms = metrics(best_run, tta=choice["tta"], specialists=fn)
    key = best_key + " + specialists"
    ms["train_min"] = best_m.get("train_min")
    results[key] = ms
    helped = better(ms, best_m) and ms["macro5"] >= best_m["macro5"]
    n_kept = sum(r[-1] for r in spec_report)
    decisions.append(f"Pair specialists (10 pairs per fold, kept if better on that fold's validation signers: {n_kept} of "
                     f"{len(spec_report)} kept): macro top-1 {best_m['macro1']:.1%} -> {ms['macro1']:.1%}, macro top-5 "
                     f"{best_m['macro5']:.1%} -> {ms['macro5']:.1%} -> {'helped, kept' if helped else 'did not help, not used'}.")
    best_base = best_key
    if helped:
        best_key, best_m, choice["specialists"] = key, ms, True
        choice["specialist_pairs"] = [list(p) for p, ks in kept_in.items() if len(ks) >= 3]
    # temperature scaling: fitted per fold on the validation signers; kept only if it lowers the ECE
    # on held-out signers for the chosen pipeline (it never changes the ranking, so top-k is unaffected)
    use_T = best_m["ece_cal"] < best_m["ece_raw"]
    decisions.append(f"Temperature scaling (fitted per fold on the validation signers, fold temperatures {best_m['temperatures']}): "
                     f"ECE on held-out signers {best_m['ece_raw']:.3f} -> {best_m['ece_cal']:.3f} -> "
                     + ("helped, kept (final model: median temperature)." if use_T else
                        "did not help (the validation sets are small: ~35-160 clips per fold), not used: T = 1.")
                     + " Ranking is unchanged, so top-k is unaffected.")
    if not use_T:
        best_m = metrics(best_run, tta=choice["tta"], calibrate=False, specialists=fn if choice["specialists"] else None)
        best_m["train_min"] = results[best_key].get("train_min")
        results[best_key] = best_m
    choice["best_key"] = best_key
    choice["median_temperature"] = float(np.median(best_m["temperatures"])) if use_T else 1.0
    choice["epochs"] = {str(s): int(np.median(np.load(oof_dir() / f"{best_name}_s{s}.npz")["best_epochs"])) for s in choice["seeds"]}
    rule = (best_m["macro1"] > v4m["macro1"], best_m["macro5"] >= v4m["macro5"])
    decisions.append(f"Promotion rule vs v4_cnn on held-out signers: macro top-1 {v4m['macro1']:.1%} -> {best_m['macro1']:.1%} "
                     f"({'higher' if rule[0] else 'NOT higher'}), macro top-5 {v4m['macro5']:.1%} -> {best_m['macro5']:.1%} "
                     f"({'not lower' if rule[1] else 'LOWER'}); the webcam top-5 part is checked on the final model.")
    choice["cv_pass"] = bool(all(rule))
    choice["cv_metrics"] = {k: best_m[k] for k in ("macro1", "macro5", "top1", "top3", "top5", "ge50", "ge80", "worst10",
                                                   "ece_raw", "ece_cal", "live_top1", "live_top5", "oov_false_kw")}
    choice["cv_metrics"]["threshold_035"] = {k: v for k, v in best_m["thresholds"][0.35].items() if k != "per_sign_shown"}
    choice["v4_metrics"] = {k: v4m[k] for k in ("macro1", "macro5", "top1", "top3", "top5", "ge50", "ge80", "worst10",
                                               "ece_raw", "live_top1", "live_top5", "web_top1", "web_top5")}
    choice["per_sign"] = best_m["per_sign"]
    choice["v4_per_sign"] = v4m["per_sign"]
    me_train, me_test = KD.load_me()
    nothing_text = ("No NOTHING class was trained: the WLASL clips in this dataset are pre-cut (every manifest entry has "
                    "frame_start 1 / frame_end -1, and only 2 of WLASL's 2,131 frame-bounded instances exist in the Kaggle "
                    "mirror), and data/me/NOTHING does not exist. Real idle measurement: your 3 complete live tests each ran a "
                    "20 s idle check: 0 segments, 0 keywords (the hands-down segmenter never fires while the hands rest). "
                    "Proxy for non-vocabulary movement: the kept clips of the 4 dropped glosses (CLOTHES, EAT, PURPLE, TABLE), "
                    "predicted by the fold model of their signer; a clip counts as a false keyword when its calibrated top-1 is "
                    "above the threshold.") if not any(v["label"] == KD.NOTHING for v in me_train) else \
        "NOTHING class trained from data/me/NOTHING."
    extra = dict(best=best_key, best_base=best_base, v4_margin=v4_margin_rule(v4), spec_report=spec_report, nothing_text=nothing_text)
    write_eval_report(results, decisions, extra)
    choice["decisions"] = decisions
    choice_path().write_text(json.dumps(choice, indent=2, default=str))
    json.dump({k: {kk: vv for kk, vv in m.items() if kk not in ("per_sign", "thresholds")} | {"thresholds": {str(t): {kk: vv for kk, vv in m["thresholds"][t].items() if kk != "per_sign_shown"} for t in THRESHOLDS}}
               for k, m in results.items()}, open(f"reports/{tag()}_candidates.json", "w"), indent=2, default=str)
    for d in decisions:
        log(" -", d)
    log(f"best: {best_key}; reports/{tag()}_eval.md written")
    return choice


# =================================================================== final model
def run_final(version, threads):
    import joblib
    import torch
    torch.set_num_threads(threads)
    from keyword_model import KeywordModel
    from seqmodels import SeqClassifier
    choice = json.loads(choice_path().read_text())
    cfg = CONFIGS[choice["config"]]
    labels, videos, oov, usable, me_train, me_test, web = load_all()
    pool, meta, evalp, _ = build_inputs(cfg, labels, videos, oov, usable, me_train, me_test, web)
    X, M = np.load(pool, mmap_mode="r"), np.load(meta)
    train_videos = videos + me_train
    y_rows = np.array([train_videos[i]["label"] for i in M["row_video"]])
    w_rows = np.array([train_videos[i]["weight"] for i in M["row_video"]], dtype=float)
    out = Path("models") / f"{version}_keyword_{choice['config']}.joblib"
    if out.exists():
        sys.exit(f"{out} exists - refusing to overwrite. Use a new --version.")
    members, t0 = [], time.time()
    for s in choice["seeds"]:
        ep = choice["epochs"][str(s)]
        t = time.time()
        members.append(SeqClassifier(cfg["arch"], cfg["frames"], seed=s, balanced=cfg["phase2"]).fit(
            X, y_rows, sample_weight=w_rows, fixed_epochs=ep, labels=labels))
        log(f"  final member seed {s}: {ep} epochs on all {len(train_videos)} videos ({len(y_rows)} rows) [{time.time() - t:.0f}s]")
    specs = {}
    if choice.get("specialists"):
        for la, lb in choice.get("specialist_pairs", []):
            ra, rb = np.flatnonzero(y_rows == la), np.flatnonzero(y_rows == lb)
            specs[(la, lb)] = train_specialist(spec_summary(np.asarray(X[ra]), cfg["fs"], cfg["frames"]),
                                               spec_summary(np.asarray(X[rb]), cfg["fs"], cfg["frames"]))
    km = KeywordModel(members, labels, cfg["fs"], cfg["frames"], choice["median_temperature"], choice["tta"], specs)
    # webcam + personal test (test-only) and latency
    web_P = np.array([km.clip_proba(w["raw"]) for w in web])
    web_y = np.array([labels.index(w["label"]) for w in web])
    me_P = np.array([km.clip_proba(v["raw"]) for v in me_test]) if me_test else np.zeros((0, len(labels)))
    me_y = np.array([labels.index(v["label"]) if v["label"] in labels else -1 for v in me_test])
    lat = latency(km, web)
    lat_no_tta = latency(KeywordModel(members, labels, cfg["fs"], cfg["frames"], choice["median_temperature"], False, specs), web)
    if km.tta and lat["p95_ms"] > LATENCY_BUDGET_MS:
        log(f"  TTA latency {lat['p95_ms']:.0f} ms > {LATENCY_BUDGET_MS} ms: TTA switched off")
        km.tta, lat = False, lat_no_tta
        web_P = np.array([km.clip_proba(w["raw"]) for w in web])
    v4 = choice["v4_metrics"]
    web_top1, web_top5 = int(topk(web_P, web_y, 1).sum()), int(topk(web_P, web_y, 5).sum())
    promote = choice["cv_pass"] and web_top5 >= v4["web_top5"]
    why = []
    if choice["cv_metrics"]["macro1"] <= v4["macro1"]:
        why.append("macro top-1 is not higher")
    if choice["cv_metrics"]["macro5"] < v4["macro5"]:
        why.append("macro top-5 is lower")
    if web_top5 < v4["web_top5"]:
        why.append(f"webcam top-5 {web_top5}/17 < v4 {v4['web_top5']}/17")
    metrics_out = dict(version=version, config=choice["config"], cfg=cfg, seeds=choice["seeds"], epochs=choice["epochs"],
                       tta=km.tta, specialists=sorted("/".join(p) for p in specs), temperature=km.temperature,
                       threshold=THRESHOLD, date=datetime.now().isoformat(timespec="seconds"),
                       cv=choice["cv_metrics"], v4=v4, per_sign=choice["per_sign"],
                       webcam=dict(n=len(web), top1=web_top1, top5=web_top5,
                                   clips=[dict(video=w["video"], true=w["label"], top5=[[labels[i], round(float(p[i]), 3)] for i in np.argsort(-p)[:5]])
                                          for w, p in zip(web, web_P)]),
                       personal_test=dict(n=len(me_test), top1=int(topk(me_P, me_y, 1).sum()) if len(me_test) else None,
                                          top5=int(topk(me_P, me_y, 5).sum()) if len(me_test) else None),
                       latency_ms=lat, latency_ms_without_tta=lat_no_tta, train_seconds=round(time.time() - t0, 1),
                       promoted=bool(promote), not_promoted_because=why, decisions=choice["decisions"],
                       data=dict(wlasl_videos=len(videos), own_train_clips=len(me_train), own_test_clips=len(me_test),
                                 labels=labels, nothing_class=KD.NOTHING in labels))
    joblib.dump(dict(model=km, scaler=None, labels=labels, model_name=f"keyword_{choice['config']}", features=cfg["fs"],
                     n_frames=cfg["frames"], version=version, keyword=True, threshold=THRESHOLD, temperature=km.temperature,
                     trained_on=f"WLASL {len(videos)} videos + {len(me_train)} own clips, {len(labels)} classes",
                     metrics_file=out.with_suffix(".json").name), out)
    out.with_suffix(".json").write_text(json.dumps(metrics_out, indent=2))
    log(f"saved {out} ({out.stat().st_size / 1e6:.1f} MB); webcam top-1 {web_top1}/17, top-5 {web_top5}/17; "
        f"latency p95 {lat['p95_ms']:.0f} ms")
    cv_min = sum(float(np.load(oof_dir() / f"{choice['config']}_s{s}.npz")["seconds"].max()) for s in choice["seeds"]) / 60
    write_record_next(choice["per_sign"] if promote else choice.get("v4_per_sign", choice["per_sign"]),
                      cv_min + (time.time() - t0) / 60, len(choice["seeds"]), out.name if promote else "v4_cnn_vocab116")
    target = Path("models/keyword_model.joblib")
    if promote:
        shutil.copy2(out, target)
        shutil.copy2(out.with_suffix(".json"), target.with_suffix(".json"))
        log(f"PROMOTED: {out.name} -> {target}")
    else:
        src = Path("models/v4_cnn_vocab116.joblib")
        shutil.copy2(src, target)
        target.with_suffix(".json").write_text(json.dumps(dict(source=src.name, reason="v5 not promoted: " + "; ".join(why),
                                                               candidate=out.name, threshold=THRESHOLD), indent=2))
        log(f"NOT promoted ({'; '.join(why)}): {target} = copy of {src.name}")
    return metrics_out


def write_record_next(per_sign, cv_minutes, n_seeds, model_name):
    """Phase 7: the 20 weakest signs (held-out-signer top-1 of the chosen model) + exact commands."""
    worst = sorted(per_sign, key=lambda g: (per_sign[g][0], per_sign[g][1], g))[:20]
    signs = ",".join(worst)
    L = ["# Recording plan: the 20 weakest signs", "",
         f"Weakest = lowest top-1 on held-out signers for `{model_name}` (`reports/{tag()}_eval.md`). Your own clips "
         "help most where WLASL has few, inconsistent examples, and they also teach the model how *you* sign in *your* room.", "",
         "| # | sign | top-1 | top-5 | WLASL videos |", "|---|---|---|---|---|"]
    for i, g in enumerate(worst, 1):
        a1, a5, n = per_sign[g]
        L.append(f"| {i} | {g} | {a1:.0%} | {a5:.0%} | {n} |")
    L += ["", "## 1. Record (about 25 minutes)", "",
          "Training session: 8 repetitions of each sign, in random order. Raise your hands, sign, lower your hands; "
          "R = redo, S = skip, Q = quit (what you recorded is kept).", "```bash",
          f'python src/record_session.py --signs "{signs}" --reps 8 --session s1', "```", "",
          "Personal test set (never trained on). Best recorded on another day or in other light:", "```bash",
          f'python src/record_session.py --signs "{signs}" --reps 3 --session t1 --test', "```", "",
          "Optional, non-sign movements (scratch your nose, touch your hair, adjust glasses, wave). These train the "
          "NOTHING class, which is never sent:", "```bash",
          "python src/record_session.py --signs NOTHING --reps 15 --session s1", "```", "",
          "Clips go to `data/me/<SIGN>/<session>_<n>.mp4` (git-ignored). Each clip is cut by the same hands-down "
          "segmenter as `live.py`.", "",
          "## 2. Retrain (one command)", "```bash", "python src/train_keyword.py retrain --version v6", "```",
          f"This extracts the new clips (cached), re-runs the same held-out-signer CV for the chosen configuration "
          f"({n_seeds} seed{'s' if n_seeds > 1 else ''}, about {cv_minutes:.0f} min on this laptop), then writes "
          "`reports/<version>_eval.md` and the final model. It reports your test session's top-1/top-5 and applies the "
          "promotion rule before replacing `models/keyword_model.joblib`. Your clips get 3x weight and are only added "
          "to the training part of each fold; the WLASL folds stay identical, so the numbers stay comparable with v4/v5.", ""]
    Path("reports/record_next.md").write_text("\n".join(L) + "\n")


def latency(km, web, n=3):
    times = []
    for _ in range(n):
        for w in web:
            t = time.perf_counter()
            km.clip_proba(w["raw"])
            times.append((time.perf_counter() - t) * 1000)
    return dict(mean_ms=round(float(np.mean(times)), 1), p95_ms=round(float(np.percentile(times, 95)), 1), n=len(times))


# =================================================================== main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["cv", "report", "final", "retrain"])
    ap.add_argument("--config", choices=list(CONFIGS))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--version", default="v5")
    ap.add_argument("--workers", type=int, default=5, help="parallel fold processes")
    ap.add_argument("--threads", type=int, default=1, help="torch threads per fold process")
    args = ap.parse_args()
    if args.command == "cv":
        run_cv(args.config, args.seed, args.workers, args.threads)
    elif args.command == "report":
        run_report()
    elif args.command == "final":
        run_final(args.version, threads=max(1, (os.cpu_count() or 2) - 1))
    elif args.command == "retrain":
        done = sorted(Path("reports").glob("v*_choice.json"), key=lambda f: f.stat().st_mtime)
        prev = json.loads(done[-1].read_text()) if done else {}     # the latest chosen configuration
        config = args.config or prev.get("config") or "cnn_f3_32"
        seeds = prev.get("seeds") or [0]
        OOF_DIR[0] = OOF / args.version
        log(f"retrain {args.version}: config {config}, seeds {seeds} -> CV, report, final (uses data/me if present)")
        for s in seeds:
            run_cv(config, s, args.workers, args.threads)
        run_report()
        run_final(args.version, threads=max(1, (os.cpu_count() or 2) - 1))


if __name__ == "__main__":
    main()
