"""Predict the sign in one video.

    python src/predict_video.py path/to/video.mp4
    -> {"sign": "HELP", "confidence": 0.91}
    -> {"sign": "?", "confidence": 0.43, "best_guess": "HELP"}    (confidence < CONF_THRESHOLD)

JSON goes to stdout (MediaPipe logs go to stderr). On failure it prints
{"sign": null, "confidence": 0.0, "error": "..."} and exits with code 1.
"""
import json
import sys
from pathlib import Path

import joblib

from config import CONF_THRESHOLD
from features import features_from_video

MODEL_FILE = Path(__file__).resolve().parent.parent / "models" / "sign_model.joblib"


def decide(proba, classes):
    """The one output rule for every script: the top sign, or "?" when its confidence is
    below CONF_THRESHOLD (then the top sign is still given as best_guess)."""
    best = int(proba.argmax())
    sign, conf = str(classes[best]), round(float(proba[best]), 2)
    if proba[best] < CONF_THRESHOLD:
        return {"sign": "?", "confidence": conf, "best_guess": sign}
    return {"sign": sign, "confidence": conf}


def predict(video_path, bundle=None):
    bundle = bundle or joblib.load(MODEL_FILE)
    x = bundle["scaler"].transform([features_from_video(video_path, bundle.get("features", "feat1"))])
    return decide(bundle["model"].predict_proba(x)[0], bundle["model"].classes_)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python src/predict_video.py path/to/video.mp4")
    try:
        result = predict(sys.argv[1])
    except Exception as e:   # unreadable video, no hands, no shoulders, missing model...
        print(json.dumps({"sign": None, "confidence": 0.0, "error": str(e)}))
        sys.exit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
