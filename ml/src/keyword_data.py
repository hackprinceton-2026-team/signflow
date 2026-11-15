"""v5 keyword model: shared data code (videos, folds, live-rule segments, augmentation, feature pools).

Same videos and the same folds as v4 (src/train_vocab.py): kept WLASL videos of glosses with >= 6
usable videos (the 14 demo signs exempt), in index.csv order, GroupKFold(5, shuffle, seed 0) by
signer_id. Your own clips (data/me/<SIGN>/*.mp4, see record_session.py) are added to the TRAINING
part of every fold (sample weight 3x) and never change the WLASL folds; the most recent session
(or every session recorded with --test) is a personal test set that is never trained on.
"""
import csv
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupKFold, GroupShuffleSplit

import config as C
from augment import NORMAL
from features import LH, RH, mirror, normalize, prepare, to_feature, video_to_raw, wrist_movement

DEMO = ["BATHROOM", "DOCTOR", "DRINK", "FOOD", "HELP", "HUNGRY", "NO", "PLEASE", "READY", "SORRY", "STOP",
        "THANKYOU", "THIRSTY", "YES"]
MIN_VIDEOS, SEED, N_FOLDS, VAL_SIGNERS = 6, 0, 5, 0.15
NOTHING = "NOTHING"                  # non-sign class: trained only if data/me/NOTHING has clips; never sent
ME_DIR, ME_CACHE = Path("data/me"), Path("data/landmarks/me")
ME_WEIGHT = 3.0
AUG_COPIES, SMALL_CLASS, SMALL_COPIES = 10, 6, 20     # <= 6 usable videos -> 20 copies instead of 10
SEG_JITTER = 0.25                    # segment start/end shifted up to 25% of its length, early or late
MIRROR_RATIO, MIRROR_P = 0.6, 0.5    # two-handed-ish clips (wrist movement ratio > 0.6): mirror half the copies


# ------------------------------------------------------------------ videos + folds
def load_wlasl(source):
    """labels, videos (same selection/order as train_vocab.py), oov (kept videos of dropped glosses)."""
    root = Path("data/landmarks") / source
    rows = list(csv.DictReader(open(root / "index.csv")))
    usable = defaultdict(int)
    for r in rows:
        usable[r["label"]] += r["kept"] == "1"
    keep = lambda lab, n: n >= MIN_VIDEOS or (lab in DEMO and n > 0)
    labels = sorted(lab for lab, n in usable.items() if keep(lab, n))
    make = lambda r: dict(video=r["video"], label=r["label"], signer=r["signer_id"], src="wlasl", weight=1.0,
                          raw=np.load(root / r["label"] / f"{r['video']}.npy"))
    videos = [make(r) for r in rows if r["kept"] == "1" and r["label"] in labels]
    oov = [make(r) for r in rows if r["kept"] == "1" and r["label"] not in labels]
    return labels, videos, oov, dict(usable)


def wlasl_folds(videos):
    signers = np.array([v["signer"] for v in videos])
    folds = list(GroupKFold(n_splits=N_FOLDS, shuffle=True, random_state=SEED).split(
        np.zeros(len(videos)), np.zeros(len(videos)), groups=signers))
    for tr, te in folds:
        assert not set(signers[tr]) & set(signers[te]), "signer leak"
    return folds


def val_split(train_idx, videos, k):
    """Hold out ~15% of the fold's training SIGNERS for early stopping / temperature / specialists.
    Fixed per fold (seed = fold number), the same for every model and seed."""
    groups = np.array([videos[i]["signer"] for i in train_idx])
    fit, val = next(GroupShuffleSplit(n_splits=1, test_size=VAL_SIGNERS, random_state=k).split(
        np.zeros(len(train_idx)), groups=groups))
    return np.asarray(train_idx)[fit], np.asarray(train_idx)[val]


def _session(path):
    return path.stem.split("_")[0]


def load_me(fs_check=True):
    """Your own clips: data/me/<SIGN>/<session>_<rep>.mp4 -> (train, test) video dicts.
    Test = every session whose name starts with 'test', or (if there is none) the most recent session."""
    if not ME_DIR.exists():
        return [], []
    clips = sorted(p for p in ME_DIR.glob("*/*") if p.suffix.lower() in {".mp4", ".mov", ".m4v"})
    if not clips:
        return [], []
    sessions = defaultdict(list)
    for p in clips:
        sessions[_session(p)].append(p)
    test_sessions = {s for s in sessions if s.startswith("test")}
    if not test_sessions:
        test_sessions = {max(sessions, key=lambda s: max(p.stat().st_mtime for p in sessions[s]))}
    train, test = [], []
    for p in clips:
        label = re.sub(r"[^A-Z0-9]", "", p.parent.name.upper())
        cache = ME_CACHE / label / f"{p.stem}.npy"
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.save(cache, video_to_raw(p))
        raw = np.load(cache)
        if ((raw[:, 135] + raw[:, 136]) > 0).sum() < 8 or not raw[:, 137].any():
            continue
        v = dict(video=f"me/{label}/{p.stem}", label=label, signer="me", src="me", weight=ME_WEIGHT,
                 raw=raw, session=_session(p))
        (test if v["session"] in test_sessions else train).append(v)
    return train, test


# ------------------------------------------------------------------ live-rule segments
def live_span(raw):
    """Raw frame range [a, b] that live.py's hands-down segmenter would cut from this clip (the
    longest segment if there are several), or None if no wrist ever rises above HAND_UP_Y long
    enough. Same rule as LiveEngine: up = a wrist above HAND_UP_Y shoulder widths below the
    shoulder line; a segment starts PREROLL-1 frames before the first up frame and ends END_FRAMES
    after the last one; >= END_FRAMES down frames split segments; < MIN_SEGMENT_FRAMES is ignored.
    (Live uses the last seen shoulders; here the clip median - practically the same.)"""
    pose = raw[:, 137] > 0
    if not pose.any():
        return None
    ls, rs = raw[pose, 129:132], raw[pose, 132:135]
    width = float(np.median(np.hypot(*(ls[:, :2] - rs[:, :2]).T)))
    cy = float(np.median((ls[:, 1] + rs[:, 1]) / 2))
    ly = np.where(raw[:, 135] > 0, (raw[:, 1] - cy) / width, np.inf)
    ry = np.where(raw[:, 136] > 0, (raw[:, 64] - cy) / width, np.inf)
    up = np.flatnonzero(np.minimum(ly, ry) < C.HAND_UP_Y)
    if not len(up):
        return None
    segments, start = [], up[0]
    for prev, cur in zip(up[:-1], up[1:]):
        if cur - prev - 1 >= C.END_FRAMES:
            segments.append((start, prev))
            start = cur
    segments.append((start, up[-1]))
    segments = [(s, e) for s, e in segments if e - s + 1 >= C.MIN_SEGMENT_FRAMES]
    if not segments:
        return None
    s, e = max(segments, key=lambda g: g[1] - g[0])
    a, b = max(0, s - (C.PREROLL_FRAMES - 1)), min(len(raw) - 1, e + C.END_FRAMES)
    return a, min(b, a + C.MAX_SEGMENT_FRAMES - 1)


def hand_span(raw, span):
    """Raw-frame span -> (i0, i1) in the hand-frames-only index space used after normalize()."""
    if span is None:
        return None
    hand = np.flatnonzero((raw[:, 135] + raw[:, 136]) > 0)
    i0, i1 = np.searchsorted(hand, span[0]), np.searchsorted(hand, span[1], side="right") - 1
    return (int(i0), int(i1)) if i1 - i0 >= 1 else None


# ------------------------------------------------------------------ augmentation + TTA
def spatial(points, presence, rng, s=NORMAL):
    """Rotation, scale, shift, jitter of a normalized clip (as augment.augment_one); missing hands stay 0."""
    p = points.copy()
    a = np.deg2rad(rng.uniform(-s["rot_deg"], s["rot_deg"]))
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    p[:, :, :2] = p[:, :, :2] @ rot.T
    p *= rng.uniform(1 - s["scale"], 1 + s["scale"])
    p[:, :, :2] += rng.uniform(-s["shift"], s["shift"], size=2)
    p += rng.normal(0, s["jitter"], size=p.shape)
    p[presence[:, 0] == 0, LH] = 0
    p[presence[:, 1] == 0, RH] = 0
    return p


def window_times(T, span, start_shift, end_shift, gamma, n_frames):
    """Sample times in [0, 1] for a window whose start/end are moved by *_shift x span length
    (negative = earlier), clamped to the clip, with a u**gamma speed change."""
    i0, i1 = span if span is not None else (0, T - 1)
    L = i1 - i0 + 1
    start, end = np.clip(i0 + start_shift * L, 0, T - 1), np.clip(i1 + end_shift * L, 0, T - 1)
    if end - start < 0.3 * L:
        start, end = i0, i1
    u = np.linspace(0, 1, n_frames) ** gamma
    return (start + (end - start) * u) / max(T - 1, 1)


def mirror_ok(points, presence):
    left, right = wrist_movement(points, presence)
    return max(left, right) > 0 and min(left, right) / max(left, right) > MIRROR_RATIO


def augment(points, presence, span, rng, fs, n_frames, allow_mirror, s=NORMAL):
    p, pr = spatial(points, presence, rng, s), presence
    if allow_mirror and rng.random() < MIRROR_P:
        p, pr = mirror(p, pr)
    times = window_times(len(p), span, rng.uniform(-SEG_JITTER, SEG_JITTER), rng.uniform(-SEG_JITTER, SEG_JITTER),
                         rng.uniform(1 - s["gamma"], 1 + s["gamma"]), n_frames)
    return to_feature(p, pr, times, fs, n_frames)


TTA_VIEWS = [  # (start shift, end shift, scale): deterministic test-time views of a segment
    (0, 0, 1.0), (0.1, 0, 1.0), (0, -0.1, 1.0), (0.1, -0.1, 1.0), (-0.1, 0.1, 1.0), (0, 0, 0.95), (0, 0, 1.05)]


def tta_features(points, presence, fs, n_frames):
    out = []
    for s0, s1, scale in TTA_VIEWS:
        p = points * scale
        out.append(to_feature(p, presence, window_times(len(p), None, s0, s1, 1.0, n_frames), fs, n_frames))
    return np.stack(out)


def clip_inputs(raw, fs, n_frames, dominant=None):
    """Features of a whole segment exactly as live.py / predict_video.py compute them (view 0)
    plus the TTA views. Returns (TTA_VIEWS, D); row 0 = plain features."""
    points, presence = prepare(raw, fs, dominant)
    return tta_features(points, presence, fs, n_frames)


# ------------------------------------------------------------------ feature pools (cached on disk)
def copies_for(label, usable):
    return SMALL_COPIES if usable.get(label, 99) <= SMALL_CLASS else AUG_COPIES


def build_pool(videos, usable, fs, n_frames, path, seed=SEED, log=print):
    """Training pool: per video its original (full clip) + augmented copies, written to `path`
    (.npy, memory-mapped by the fold workers). Returns row -> video index and is_original arrays."""
    rng = np.random.default_rng(seed)
    n_rows = sum(1 + copies_for(v["label"], usable) for v in videos)
    D = None
    row_video, row_orig = np.zeros(n_rows, np.int32), np.zeros(n_rows, bool)
    X = None
    r = 0
    for i, v in enumerate(videos):
        points, presence = prepare(v["raw"], fs)
        span = hand_span(v["raw"], live_span(v["raw"]))
        allow = mirror_ok(points, presence)
        rows = [to_feature(points, presence, fs=fs, n_frames=n_frames)]
        rows += [augment(points, presence, span, rng, fs, n_frames, allow) for _ in range(copies_for(v["label"], usable))]
        if X is None:
            D = len(rows[0])
            X = np.lib.format.open_memmap(path.with_suffix(".tmp.npy"), mode="w+", dtype=np.float32, shape=(n_rows, D))
        X[r:r + len(rows)] = np.stack(rows)
        row_video[r:r + len(rows)] = i
        row_orig[r] = True
        r += len(rows)
        if (i + 1) % 250 == 0:
            log(f"    pool {path.name}: {i + 1}/{len(videos)} videos")
    X.flush()
    del X
    path.with_suffix(".tmp.npy").replace(path)
    return row_video, row_orig
