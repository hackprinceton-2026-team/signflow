"""Augment the (~1 per sign) landmark clips into a training set.

    python src/augment.py          -> data/augmented_train.npz

Augmentations are applied to the *normalized* landmarks (after shoulder centering/scaling),
otherwise the normalization would undo scale and shift:
  - rotation in the image plane, scale, shift, per-coordinate jitter
  - time stretch: a non-uniform speed change (u ** gamma, gamma in [0.8, 1.2]) plus a small
    random trim at the start/end. A *uniform* 0.8-1.2x stretch would be a no-op, because
    every clip is resampled to N_FRAMES anyway.
Missing hands stay zero (they are not rotated/shifted/jittered).
"""
from pathlib import Path

import numpy as np

from features import LH, N_FRAMES, RH, normalize, to_feature

LANDMARK_DIR = Path("data/landmarks/clips")
TRAIN_FILE = Path("data/augmented_train.npz")
COPIES_PER_VIDEO = 30
TRAIN_SEED = 0
SKIP_LABELS = {"THIRSTY"}         # excluded for now (hand not detected during the sign itself)

NORMAL = dict(rot_deg=10, scale=0.10, shift=0.05, jitter=0.01, gamma=0.2, trim=0.05)
STRONG = dict(rot_deg=15, scale=0.15, shift=0.10, jitter=0.02, gamma=0.3, trim=0.10)


def load_landmarks(landmark_dir=LANDMARK_DIR):
    """Returns list of (label, video_name, raw_array)."""
    items = []
    for f in sorted(Path(landmark_dir).glob("*/*.npy")):
        if f.parent.name in SKIP_LABELS:
            continue
        items.append((f.parent.name, f.stem, np.load(f)))
    if not items:
        raise SystemExit(f"No landmarks in {landmark_dir}/ - run src/extract.py first")
    return items


def augment_one(points, presence, rng, s, fs="feat1"):
    """One random augmented copy of a normalized clip -> feature vector (feature set fs)."""
    p = points.copy()

    a = np.deg2rad(rng.uniform(-s["rot_deg"], s["rot_deg"]))
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    p[:, :, :2] = p[:, :, :2] @ rot.T
    p *= rng.uniform(1 - s["scale"], 1 + s["scale"])
    p[:, :, :2] += rng.uniform(-s["shift"], s["shift"], size=2)
    p += rng.normal(0, s["jitter"], size=p.shape)

    p[presence[:, 0] == 0, LH] = 0                 # keep missing hands at exactly zero
    p[presence[:, 1] == 0, RH] = 0

    gamma = rng.uniform(1 - s["gamma"], 1 + s["gamma"])
    start, end = rng.uniform(0, s["trim"]), 1 - rng.uniform(0, s["trim"])
    times = start + (end - start) * np.linspace(0, 1, N_FRAMES) ** gamma
    return to_feature(p, presence, times, fs)


def make_dataset(items, copies, seed, settings):
    """Augmented features for every clip. Returns X, y (labels), names (source video)."""
    rng = np.random.default_rng(seed)
    X, y, names = [], [], []
    for label, name, raw in items:
        points, presence = normalize(raw)
        for _ in range(copies):
            X.append(augment_one(points, presence, rng, settings))
            y.append(label)
            names.append(name)
    return np.array(X), np.array(y), np.array(names)


def main():
    items = load_landmarks()
    X, y, names = make_dataset(items, COPIES_PER_VIDEO, TRAIN_SEED, NORMAL)
    TRAIN_FILE.parent.mkdir(parents=True, exist_ok=True)
    np.savez(TRAIN_FILE, X=X, y=y, names=names)
    print(f"{len(items)} videos x {COPIES_PER_VIDEO} augmented copies = {len(X)} training samples")
    print(f"Feature size: {X.shape[1]}   Labels: {', '.join(sorted(set(y)))}")
    print(f"Settings: {NORMAL}   seed={TRAIN_SEED}")
    print(f"Saved to {TRAIN_FILE}  (original, unaugmented clips are NOT included)")


if __name__ == "__main__":
    main()
