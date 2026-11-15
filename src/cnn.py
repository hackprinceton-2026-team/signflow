"""Small 1D-CNN over the 16-frame landmark sequences, wrapped like an sklearn classifier
(fit / predict_proba / classes_) so live.py, predict_video.py and the trainers can use it unchanged.

Early stopping: fit(X, y, groups=signer_per_row) holds out ~15% of the SIGNERS of the training data
as validation and keeps the epoch with the best validation accuracy (patience). Without groups
(final model) it trains for a fixed number of epochs (use the median best epoch from CV)."""
import numpy as np
import torch
from sklearn.model_selection import GroupShuffleSplit
from torch import nn

from features import N_FRAMES

torch.set_num_threads(7)


class CNNNet(nn.Module):
    def __init__(self, frame_dim, n_classes, width=128, dropout=0.3):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv1d(frame_dim, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU(),
            nn.Conv1d(width, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU(),
            nn.Conv1d(width, width, kernel_size=3, padding=1), nn.BatchNorm1d(width), nn.ReLU())
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(2 * width, n_classes))

    def forward(self, x):                                  # x: (batch, 16 frames, values)
        h = self.body(x.transpose(1, 2))                   # -> (batch, width, 16)
        return self.head(torch.cat([h.mean(dim=2), h.amax(dim=2)], dim=1))


class CNNClassifier:
    def __init__(self, epochs=60, patience=8, lr=1e-3, batch_size=64, val_signers=0.15, seed=0):
        self.epochs, self.patience, self.lr = epochs, patience, lr
        self.batch_size, self.val_signers, self.seed = batch_size, val_signers, seed

    @staticmethod
    def _seq(X):
        X = np.asarray(X, dtype=np.float32)
        return torch.tensor(X.reshape(len(X), N_FRAMES, -1))

    def fit(self, X, y, groups=None, val_mask=None):
        """groups: signer per row -> signer-held-out early stopping. val_mask: rows usable for
        validation (e.g. only un-augmented originals); validation always excludes augmented copies
        of training videos because whole signers are held out."""
        torch.manual_seed(self.seed)
        self.classes_ = np.unique(y)
        Y = np.searchsorted(self.classes_, y)
        X = self._seq(X)
        tr = np.ones(len(X), bool)
        va = None
        if groups is not None:
            split = GroupShuffleSplit(n_splits=1, test_size=self.val_signers, random_state=self.seed)
            tr_idx, va_idx = next(split.split(np.zeros(len(X)), Y, groups))
            tr = np.zeros(len(X), bool)
            tr[tr_idx] = True
            va = va_idx if val_mask is None else va_idx[val_mask[va_idx]]
        self.net = CNNNet(X.shape[2], len(self.classes_))
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=1e-3)
        Xt, Yt = X[tr], torch.tensor(Y[tr])
        gen = torch.Generator().manual_seed(self.seed)
        best, best_state, best_epoch, bad = -1.0, None, self.epochs, 0
        self.history = []
        for epoch in range(1, self.epochs + 1):
            self.net.train()
            order = torch.randperm(len(Xt), generator=gen)
            for i in range(0, len(Xt), self.batch_size):
                b = order[i:i + self.batch_size]
                if len(b) < 2:
                    continue                                   # BatchNorm needs > 1 sample
                opt.zero_grad()
                nn.functional.cross_entropy(self.net(Xt[b]), Yt[b], label_smoothing=0.1).backward()
                opt.step()
            if va is None:
                continue
            self.net.eval()
            with torch.no_grad():
                acc = float((self.net(X[va]).argmax(1).numpy() == Y[va]).mean())
            self.history.append(acc)
            if acc > best:
                best, best_epoch, bad = acc, epoch, 0
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

    def predict_proba(self, X):
        with torch.no_grad():
            return torch.softmax(self.net(self._seq(X)), dim=1).numpy()

    def predict(self, X):
        return self.classes_[self.predict_proba(X).argmax(axis=1)]
