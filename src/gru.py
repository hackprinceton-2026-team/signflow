"""Small GRU over the 16-frame sequences, wrapped to look like an sklearn classifier
(fit / predict_proba / predict / classes_) so train and predict code treat all models alike.
Input is the same flat feature vector as KNN/RF/SVM; it is reshaped to (16 frames, values per frame)."""
import numpy as np
import torch
from torch import nn

from features import N_FRAMES

torch.set_num_threads(4)


class GRUNet(nn.Module):
    def __init__(self, n_classes, frame_dim, hidden=64):
        super().__init__()
        self.gru = nn.GRU(frame_dim, hidden, batch_first=True)
        self.drop = nn.Dropout(0.3)
        self.out = nn.Linear(hidden, n_classes)

    def forward(self, x):                      # x: (batch, 16, 137)
        _, h = self.gru(x)                     # last hidden state summarizes the sequence
        return self.out(self.drop(h[-1]))


class GRUClassifier:
    def __init__(self, hidden=64, epochs=40, lr=1e-3, batch_size=32, seed=0):
        self.hidden, self.epochs, self.lr, self.batch_size, self.seed = hidden, epochs, lr, batch_size, seed

    @staticmethod
    def _seq(X):
        X = np.asarray(X, dtype=np.float32)
        return torch.tensor(X.reshape(len(X), N_FRAMES, -1))      # (N, 16 frames, values per frame)

    def fit(self, X, y):
        torch.manual_seed(self.seed)
        self.classes_ = np.unique(y)
        X, Y = self._seq(X), torch.tensor(np.searchsorted(self.classes_, y))
        self.net = GRUNet(len(self.classes_), X.shape[2], self.hidden)
        opt = torch.optim.Adam(self.net.parameters(), lr=self.lr, weight_decay=1e-4)
        gen = torch.Generator().manual_seed(self.seed)
        self.net.train()
        for _ in range(self.epochs):
            order = torch.randperm(len(X), generator=gen)
            for i in range(0, len(X), self.batch_size):
                batch = order[i:i + self.batch_size]
                opt.zero_grad()
                nn.functional.cross_entropy(self.net(X[batch]), Y[batch]).backward()
                opt.step()
        self.net.eval()
        return self

    def predict_proba(self, X):
        with torch.no_grad():
            return torch.softmax(self.net(self._seq(X)), dim=1).numpy()

    def predict(self, X):
        return self.classes_[self.predict_proba(X).argmax(axis=1)]
