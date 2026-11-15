"""The v5 keyword model object stored in models/*keyword*.joblib (bundle["model"]).

KeywordModel = ensemble of SeqClassifiers (logits averaged) + one temperature (calibration)
+ optional test-time augmentation (TTA views of the segment) + optional pair specialists
(binary classifiers that reorder top-1/top-2 when those are a known confused pair).
live.py / live_test.py / predict_video.py call clip_proba(raw) through predict_video.bundle_proba().
"""
import numpy as np

from features import prepare, to_feature
from keyword_data import tta_features
from seqmodels import softmax


def spec_columns(fs):
    """Per-frame columns the pair specialists use: presence + hand shape of both hands, and for
    feat3 the angles, fingertip / face distances, acceleration and two-hand distances."""
    cols = list(range(135, 263))
    if fs == "feat3":
        cols += list(range(267, 416))
    return np.array(cols)


def spec_summary(X, fs, frames):
    """(rows, frames * dim) -> mean over time + the values at 4 time points of the specialist columns."""
    F = np.asarray(X).reshape(len(X), frames, -1)[:, :, spec_columns(fs)]
    pick = np.linspace(0, frames - 1, 4).round().astype(int)
    return np.concatenate([F.mean(axis=1)] + [F[:, t] for t in pick], axis=1)


def apply_pairs(P, feats, specs, labels):
    """Reorder top-1 / top-2 when they are a specialist pair; their total probability is kept."""
    P = P.copy()
    for i, (a, b) in enumerate(np.argsort(-P, axis=1)[:, :2]):
        key = tuple(sorted((labels[a], labels[b])))
        if key in specs:
            ia, ib = labels.index(key[0]), labels.index(key[1])
            pa = float(specs[key].predict_proba(feats[i:i + 1])[0, 1])
            tot = P[i, ia] + P[i, ib]
            P[i, ia], P[i, ib] = tot * pa, tot * (1 - pa)
    return P


class KeywordModel:
    def __init__(self, members, labels, fs, n_frames, temperature=1.0, tta=False, specialists=None):
        self.members, self.labels, self.fs, self.n_frames = members, list(labels), fs, n_frames
        self.temperature, self.tta, self.specialists = float(temperature), bool(tta), dict(specialists or {})
        self.classes_ = np.array(self.labels)

    def logits(self, X):
        return np.mean([m.logits(X) for m in self.members], axis=0)

    def predict_proba(self, X):
        """Plain feature rows (no TTA, no specialists) -> calibrated probabilities."""
        return softmax(self.logits(X) / self.temperature)

    def clip_proba(self, raw, dominant=None):
        """Raw landmarks of one segment -> calibrated probabilities (C,)."""
        points, presence = prepare(raw, self.fs, dominant)
        if self.tta:
            X = tta_features(points, presence, self.fs, self.n_frames)
        else:
            X = to_feature(points, presence, fs=self.fs, n_frames=self.n_frames)[None]
        P = softmax(self.logits(X).mean(axis=0, keepdims=True) / self.temperature)
        if self.specialists:
            P = apply_pairs(P, spec_summary(X[:1], self.fs, self.n_frames), self.specialists, self.labels)
        return P[0]
