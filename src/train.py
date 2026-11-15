"""Train the sign classifier and evaluate it.

    python src/train.py     (needs data/landmarks/ and data/augmented_train.npz)

Datasets (all built from the same original clips, so all numbers are optimistic):
  train       augmented copies, seed 0, normal settings (from augment.py)
  validation  fresh augmented copies, seed 1, normal settings -> only used to pick KNN vs RF
  robustness  fresh augmented copies, seed 2, STRONGER settings -> reported, never used to choose
  originals   the unaugmented clips -> sanity check
"""
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler

from augment import NORMAL, STRONG, TRAIN_FILE, load_landmarks, make_dataset
from features import N_FRAMES, features_from_raw

MODEL_FILE = Path("models/beta_clips_model.joblib")   # the WLASL model comes from train_wlasl.py
VAL_SEED, ROBUST_SEED, EVAL_COPIES = 1, 2, 30


def header(text):
    print("\n" + "=" * 72 + f"\n{text}\n" + "=" * 72)


def main():
    if not TRAIN_FILE.exists():
        raise SystemExit(f"{TRAIN_FILE} not found - run src/augment.py first")
    data = np.load(TRAIN_FILE)
    X_train, y_train = data["X"], data["y"]
    items = load_landmarks()

    scaler = StandardScaler().fit(X_train)
    Xs_train = scaler.transform(X_train)

    # ---- pick the model on a separate validation set of fresh augmentations ----
    header("MODEL SELECTION  (accuracy on fresh augmentations, seed 1, normal settings)")
    X_val, y_val, _ = make_dataset(items, EVAL_COPIES, VAL_SEED, NORMAL)
    candidates = {
        "KNN (k=3)": KNeighborsClassifier(n_neighbors=3),
        "RandomForest": RandomForestClassifier(n_estimators=300, random_state=0),
    }
    scores = {}
    for name, clf in candidates.items():
        clf.fit(Xs_train, y_train)
        scores[name] = (clf.predict(scaler.transform(X_val)) == y_val).mean()
        print(f"  {name:<14} {scores[name]:.1%}  ({len(y_val)} samples)")
    best = max(scores, key=lambda n: (scores[n], n.startswith("KNN")))  # tie -> simpler KNN
    model = candidates[best]
    print(f"  -> keeping {best}")

    # ---- (a) sanity check on the original clips ----
    header(f"(a) SANITY CHECK: the {len(items)} ORIGINAL (unaugmented) clips\n"
           "    The training set holds only augmented copies of these clips, never the clips\n"
           "    themselves. Expected: all correct. A miss means a pipeline bug or an unusable video.")
    print(f"  {'video':<12}{'true':<10}{'predicted':<11}{'confidence':>10}")
    correct = 0
    for label, name, raw in items:
        proba = model.predict_proba(scaler.transform([features_from_raw(raw)]))[0]
        pred = model.classes_[proba.argmax()]
        correct += pred == label
        mark = "" if pred == label else "   <-- WRONG"
        print(f"  {name:<12}{label:<10}{pred:<11}{proba.max():>10.2f}{mark}")
    print(f"\n  Sanity check: {correct}/{len(items)} original clips correct")
    if best.startswith("KNN"):
        print("  (KNN k=3 confidence = share of the 3 nearest neighbours that agree: 0.33 / 0.67 / 1.00)")

    # ---- (b) robustness check on stronger, unseen augmentations ----
    header(f"(b) ROBUSTNESS CHECK: fresh augmentations, seed {ROBUST_SEED}, STRONGER settings\n"
           f"    {STRONG}\n"
           "    Shows how far each sign can be distorted before the model confuses it\n"
           f"    with another one. Still the same {len(items)} clips: NOT a test on new data.")
    X_rob, y_rob, _ = make_dataset(items, EVAL_COPIES, ROBUST_SEED, STRONG)
    pred_rob = model.predict(scaler.transform(X_rob))
    labels = list(model.classes_)
    print(f"  Overall: {(pred_rob == y_rob).mean():.1%} of {len(y_rob)} samples\n")
    print("  Per-class accuracy:")
    for lab in labels:
        m = y_rob == lab
        print(f"    {lab:<10}{(pred_rob[m] == lab).mean():>7.1%}")

    cm = confusion_matrix(y_rob, pred_rob, labels=labels)
    short = [lab[:4] for lab in labels]
    print("\n  Confusion matrix (rows = true sign, columns = predicted sign, counts):")
    print("  " + " " * 10 + "".join(f"{s:>5}" for s in short))
    for lab, row in zip(labels, cm):
        print(f"  {lab:<10}" + "".join(f"{(v if v else '.'):>5}" for v in row))

    header("These numbers do not measure accuracy on new people or webcam input.\n"
           f"All train/eval data come from the same {len(items)} clips of one signer filmed off one screen.")

    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "scaler": scaler, "labels": labels,
                 "model_name": best, "n_frames": N_FRAMES}, MODEL_FILE)
    print(f"\nSaved {best} + scaler + {len(labels)} labels to {MODEL_FILE}")


if __name__ == "__main__":
    main()
