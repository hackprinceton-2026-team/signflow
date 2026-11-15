"""Predict the sign in one video.

    python src/predict_video.py path/to/video.mp4                      # demo model (14 signs)
    -> {"sign": "HELP", "confidence": 0.91, "candidates": [["HELP", 0.91], ["STOP", 0.05], ["DOCTOR", 0.02]]}
    -> {"sign": "?", "confidence": 0.43, "best_guess": "HELP", "candidates": [...]}   (not confident enough)
    python src/predict_video.py clip.mp4 --keyword [--threshold 0.35]  # keyword model (116 signs)
    -> {"type": "sign", "candidates": [["HEADACHE", 0.62], ["HOT", 0.14], ...5], "top1": "HEADACHE", "confident": true}
    python src/predict_video.py clip.mp4 --model models/v4_cnn_vocab116.joblib      (another model)

Keyword mode is used for --keyword and for every expanded-vocabulary model (they all have their own
calibration); the demo model keeps its 0.5 rule. JSON goes to stdout (MediaPipe logs go to stderr).
On failure it prints {"sign": null, "confidence": 0.0, "error": "..."} and exits with code 1.
"""
import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np

from config import CONF_THRESHOLD, KEYWORD_THRESHOLD
from features import N_FRAMES, features_from_raw, video_to_raw

MODELS = Path(__file__).resolve().parent.parent / "models"
MODEL_FILE = MODELS / "sign_model.joblib"
KEYWORD_MODEL_FILE = MODELS / "keyword_model.joblib"
NOTHING = "NOTHING"


def is_keyword(bundle):
    """Expanded-vocabulary models (v4 with its margin rule, v5 keyword models) run in keyword mode."""
    return bool(bundle.get("keyword") or bundle.get("decision_rule") is not None)


def bundle_proba(bundle, raw, dominant=None):
    """Raw landmarks of one segment -> (probabilities, class names) for any saved model bundle.
    v5 keyword models: calibrated (temperature-scaled) probabilities, with TTA/specialists if the
    model has them. Older bundles: scaler + model on the features of their feature set."""
    model = bundle["model"]
    if hasattr(model, "clip_proba"):
        return model.clip_proba(raw, dominant), np.asarray(model.classes_)
    x = features_from_raw(raw, bundle.get("features", "feat1"), dominant, bundle.get("n_frames", N_FRAMES))
    return model.predict_proba(bundle["scaler"].transform([x]))[0], np.asarray(model.classes_)


def keyword_decision(proba, classes, threshold=KEYWORD_THRESHOLD):
    """Keyword mode: top-5 candidates are ALWAYS returned; `confident` = calibrated top-1 >= threshold.
    NOTHING (non-sign) is never a keyword: if it is top-1 the result has nothing=True (not sent)."""
    order = [int(i) for i in np.argsort(-proba)]
    top = str(classes[order[0]])
    cands = [[str(classes[i]), round(float(proba[i]), 2)] for i in order if str(classes[i]) != NOTHING][:5]
    confident = top != NOTHING and float(proba[order[0]]) >= threshold
    return {"sign": top if confident else "?", "confidence": round(float(proba[order[0]]), 2), "candidates": cands,
            "top1": cands[0][0], "confident": bool(confident), "best_guess": cands[0][0], "nothing": top == NOTHING}


def decide(proba, classes, rule=None, threshold=None):
    """Demo-model rule: the top sign, or "?" when confidence < threshold (then the top sign is
    still given as best_guess). Always includes the top-3 candidates."""
    order = np.argsort(-proba)
    best = int(order[0])
    sign, conf = str(classes[best]), round(float(proba[best]), 2)
    candidates = [[str(classes[i]), round(float(proba[i]), 2)] for i in order[:3]]
    if proba[best] < (CONF_THRESHOLD if threshold is None else threshold):
        return {"sign": "?", "confidence": conf, "best_guess": sign, "candidates": candidates}
    return {"sign": sign, "confidence": conf, "candidates": candidates}


def decision_for(bundle, proba, classes, threshold=None, keyword=None):
    """The one output rule for every script (live.py, live_test.py, predict_video.py)."""
    if keyword if keyword is not None else is_keyword(bundle):
        return keyword_decision(proba, classes, KEYWORD_THRESHOLD if threshold is None else threshold)
    return decide(proba, classes, threshold=threshold)


def predict(video_path, bundle=None, threshold=None, keyword=None, dominant=None):
    bundle = bundle or joblib.load(MODEL_FILE)
    proba, classes = bundle_proba(bundle, video_to_raw(video_path), dominant)
    d = decision_for(bundle, proba, classes, threshold, keyword)
    if "confident" in d:                                         # keyword JSON contract
        return {"type": "sign", "candidates": d["candidates"], "top1": d["top1"], "confident": d["confident"]}
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--model", help="model file (default: sign_model.joblib, or keyword_model.joblib with --keyword)")
    ap.add_argument("--keyword", action="store_true", help="keyword mode (116-sign keyword model by default)")
    ap.add_argument("--threshold", type=float, help=f"confidence threshold (keyword {KEYWORD_THRESHOLD}, demo {CONF_THRESHOLD})")
    ap.add_argument("--dominant", choices=["auto", "right", "left"], default="auto")
    args = ap.parse_args()
    path = args.model or (KEYWORD_MODEL_FILE if args.keyword else MODEL_FILE)
    try:
        result = predict(args.video, joblib.load(path), args.threshold, True if args.keyword else None,
                         None if args.dominant == "auto" else args.dominant)
    except Exception as e:   # unreadable video, no hands, no shoulders, missing model...
        print(json.dumps({"sign": None, "confidence": 0.0, "error": str(e)}))
        sys.exit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
