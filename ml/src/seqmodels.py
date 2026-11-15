"""v5 sequence classifiers (1D-CNN, small transformer encoder) over per-frame feature sequences.

Sklearn-like: fit / predict_proba / classes_, so live.py, predict_video.py and the trainers can use
them like the earlier models. The feature scaling (mean/std of the training rows) is stored inside.

Training (fit):
  - class-balanced sampling: every epoch draws len(train) rows, a class is drawn with probability
    proportional to min(n_max / n_class, CAP) * n_class (CAP = 3: no class is oversampled more than
    3x its natural share); per-row sample weights (e.g. 3x for your own clips) multiply in
  - label smoothing 0.1, AdamW, early stopping on a validation set of held-out SIGNERS
    (score = (top-1 + top-5) / 2 on the validation clips, patience 8)
  - temperature scaling: fit_temperature() on validation logits (NLL), used by predict_proba
Without a validation set it trains a fixed number of epochs (the median best epoch from CV).
"""
import numpy as np
import torch
from torch import nn

CAP = 3.0


class CNNNet(nn.Module):
    def __init__(self, frame_dim, n_classes, width=128, dropout=0.3):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv1d(frame_dim, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU(),
            nn.Conv1d(width, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU(),
            nn.Conv1d(width, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU())
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(2 * width, n_classes))

    def forward(self, x):                                  # x: (batch, frames, values)
        h = self.body(x.transpose(1, 2))
        return self.head(torch.cat([h.mean(dim=2), h.amax(dim=2)], dim=1))


class TransformerNet(nn.Module):
    def __init__(self, frame_dim, n_classes, n_frames, d=128, heads=4, layers=2, dropout=0.2):
        super().__init__()
        self.inp = nn.Sequential(nn.Linear(frame_dim, d), nn.LayerNorm(d), nn.Dropout(dropout))
        self.pos = nn.Parameter(torch.randn(1, n_frames, d) * 0.02)
        layer = nn.TransformerEncoderLayer(d, heads, dim_feedforward=2 * d, dropout=dropout,
                                           batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.head = nn.Sequential(nn.LayerNorm(2 * d), nn.Dropout(dropout), nn.Linear(2 * d, n_classes))

    def forward(self, x):
        h = self.enc(self.inp(x) + self.pos)
        return self.head(torch.cat([h.mean(dim=1), h.amax(dim=1)], dim=1))


def balanced_probs(y_idx, n_classes, sample_weight=None, cap=CAP):
    """Per-row sampling probabilities for class-balanced sampling with a cap (see module doc)."""
    counts = np.bincount(y_idx, minlength=n_classes).astype(float)
    factor = np.minimum(counts.max() / np.maximum(counts, 1), cap)
    w = factor[y_idx]
    if sample_weight is not None:
        w = w * sample_weight
    return w / w.sum()


def topk_hits(logits, y, k):
    return np.mean([t in r for t, r in zip(y, np.argsort(-logits, axis=1)[:, :k])])


class SeqClassifier:
    def __init__(self, arch="cnn", n_frames=16, epochs=60, patience=8, lr=1e-3, batch_size=64, seed=0,
                 label_smoothing=0.1, balanced=True):
        self.arch, self.n_frames, self.epochs, self.patience, self.lr = arch, n_frames, epochs, patience, lr
        self.batch_size, self.seed, self.label_smoothing, self.balanced = batch_size, seed, label_smoothing, balanced
        self.temperature = 1.0

    # ---- helpers
    def _net(self, frame_dim, n_classes):
        if self.arch == "cnn":
            return CNNNet(frame_dim, n_classes)
        if self.arch == "transformer":
            return TransformerNet(frame_dim, n_classes, self.n_frames)
        raise ValueError(self.arch)

    def _seq(self, X):
        X = (np.asarray(X, dtype=np.float32) - self.mean_) / self.std_
        return torch.from_numpy(X.reshape(len(X), self.n_frames, -1))

    def fit(self, X, y, rows=None, sample_weight=None, X_val=None, y_val=None, fixed_epochs=None, labels=None):
        """X: (N, n_frames * frame_dim) float32, may be a memory-mapped pool; rows: the training row
        indices into X (default all). y / sample_weight: one entry per training row.
        labels: full class list (keeps the class order fixed across folds)."""
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        rows = np.arange(len(X)) if rows is None else np.asarray(rows)
        self.classes_ = np.array(sorted(set(y)) if labels is None else labels)
        Y = np.searchsorted(self.classes_, y)
        s, s2 = np.zeros(X.shape[1]), np.zeros(X.shape[1])
        for i in range(0, len(rows), 2000):                    # mean / std in chunks (memmap friendly)
            chunk = np.asarray(X[np.sort(rows[i:i + 2000])], dtype=np.float64)
            s, s2 = s + chunk.sum(0), s2 + (chunk ** 2).sum(0)
        self.mean_ = (s / len(rows)).astype(np.float32)
        self.std_ = (np.sqrt(np.maximum(s2 / len(rows) - (s / len(rows)) ** 2, 0)) + 1e-6).astype(np.float32)
        frame_dim = X.shape[1] // self.n_frames
        self.net = self._net(frame_dim, len(self.classes_))
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=1e-3)
        probs = balanced_probs(Y, len(self.classes_), sample_weight) if self.balanced else (
            None if sample_weight is None else sample_weight / sample_weight.sum())
        Yt = torch.from_numpy(Y)
        has_val = X_val is not None and fixed_epochs is None
        if has_val:
            Xv, Yv = self._seq(X_val), np.searchsorted(self.classes_, y_val)
        n_epochs = fixed_epochs or self.epochs
        best, best_state, best_epoch, bad = -1.0, None, n_epochs, 0
        self.history = []
        for epoch in range(1, n_epochs + 1):
            self.net.train()
            order = rng.choice(len(rows), size=len(rows), p=probs) if probs is not None else rng.permutation(len(rows))
            for i in range(0, len(order), self.batch_size):
                b = np.sort(order[i:i + self.batch_size])
                if len(b) < 2:
                    continue                                   # BatchNorm needs > 1 sample
                xb = torch.from_numpy(((np.asarray(X[rows[b]]) - self.mean_) / self.std_).reshape(len(b), self.n_frames, -1))
                opt.zero_grad()
                nn.functional.cross_entropy(self.net(xb), Yt[b], label_smoothing=self.label_smoothing).backward()
                opt.step()
            if not has_val:
                continue
            lv = self._logits_t(Xv)
            score = (topk_hits(lv, Yv, 1) + topk_hits(lv, Yv, 5)) / 2
            self.history.append(round(float(score), 4))
            if score > best:
                best, best_epoch, bad = score, epoch, 0
                best_state = {k: v.clone() for k, v in self.net.state_dict().items()}
            else:
                bad += 1
                if bad >= self.patience:
                    break
        if best_state is not None:
            self.net.load_state_dict(best_state)
        self.best_epoch, self.best_val = best_epoch, best
        self.net.eval()
        return self

    def _logits_t(self, Xt):
        self.net.eval()
        with torch.no_grad():
            return np.concatenate([self.net(Xt[i:i + 512]).numpy() for i in range(0, len(Xt), 512)])

    def logits(self, X):
        return self._logits_t(self._seq(X))

    def fit_temperature(self, X_val, y_val):
        self.temperature = fit_temperature(self.logits(X_val), np.searchsorted(self.classes_, y_val))
        return self.temperature

    def predict_proba(self, X):
        return softmax(self.logits(X) / self.temperature)

    def predict(self, X):
        return self.classes_[self.logits(X).argmax(axis=1)]

    def __getstate__(self):                                # smaller pickles: no optimizer, CPU tensors
        d = dict(self.__dict__)
        d["net_state"] = {k: v.cpu() for k, v in self.net.state_dict().items()}
        d["frame_dim"] = self.mean_.shape[0] // self.n_frames
        d.pop("net", None)
        return d

    def __setstate__(self, d):
        state, frame_dim = d.pop("net_state"), d.pop("frame_dim")
        self.__dict__.update(d)
        self.net = self._net(frame_dim, len(self.classes_))
        self.net.load_state_dict(state)
        self.net.eval()


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def nll(logits, y, T):
    p = softmax(logits / T)
    return -np.mean(np.log(p[np.arange(len(y)), y] + 1e-12))


def fit_temperature(logits, y):
    """Scalar temperature minimizing validation NLL (grid in log space, then refine)."""
    grid = np.exp(np.linspace(np.log(0.2), np.log(5), 81))
    T = grid[np.argmin([nll(logits, y, t) for t in grid])]
    fine = T * np.exp(np.linspace(-0.05, 0.05, 21))
    return float(fine[np.argmin([nll(logits, y, t) for t in fine])])


def ece(probs, y, bins=15):
    """Expected calibration error of the top-1 probability (equal-width bins)."""
    conf, pred = probs.max(axis=1), probs.argmax(axis=1)
    correct = pred == y
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            total += m.mean() * abs(correct[m].mean() - conf[m].mean())
    return float(total)


class Ensemble:
    """Average of the members' logits, then one temperature. Same interface as SeqClassifier."""

    def __init__(self, members, temperature=1.0):
        self.members, self.temperature = members, temperature
        self.classes_ = members[0].classes_
        self.n_frames = members[0].n_frames

    def logits(self, X):
        return np.mean([m.logits(X) for m in self.members], axis=0)

    def predict_proba(self, X):
        return softmax(self.logits(X) / self.temperature)

    def predict(self, X):
        return self.classes_[self.logits(X).argmax(axis=1)]
