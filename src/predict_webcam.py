"""Try the model live with your webcam.

    python src/predict_webcam.py [camera_index]     (default camera 0)

SPACE = 3-2-1 countdown, then record ~2.5 s of one sign -> prediction on screen + JSON in terminal
Q / ESC = quit

Below CONF_THRESHOLD (src/config.py) the screen shows "?" plus the raw confidence in small text.
The preview is mirrored if MIRROR_PREVIEW (src/config.py); the model always gets the unmirrored
frames, like the training videos.
"""
import json
import sys
import time

import cv2
import joblib
import numpy as np

from config import CONF_THRESHOLD, MIRROR_PREVIEW
from features import features_from_raw, frames_to_raw
from predict_video import MODEL_FILE, decide

RECORD_SECONDS = 2.5
COUNTDOWN_SECONDS = 3


def put_text(img, text, y, scale=1.0, color=(255, 255, 255)):
    cv2.putText(img, text, (20, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(img, text, (20, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def predict_frames(bundle, frames):
    """Same path as predict_video.py: frames -> raw landmarks -> shared features -> model."""
    raw = frames_to_raw(cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in frames)
    hand_rate = float(((raw[:, 135] + raw[:, 136]) > 0).mean()) if len(raw) else 0.0
    proba = bundle["model"].predict_proba(bundle["scaler"].transform([features_from_raw(raw, bundle.get("features", "feat1"))]))[0]
    order = np.argsort(proba)[::-1][:3]
    top3 = [(str(bundle["model"].classes_[i]), float(proba[i])) for i in order]
    return decide(proba, bundle["model"].classes_), top3, hand_rate


def main():
    bundle = joblib.load(MODEL_FILE)
    cam = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    cap = cv2.VideoCapture(cam)
    if not cap.isOpened():
        sys.exit(f"Cannot open camera {cam}. On macOS, allow camera access for your terminal / VS Code "
                 "in System Settings > Privacy & Security > Camera, then restart it.")
    print(f"Model: {bundle['model_name']}  Signs: {', '.join(bundle['labels'])}")
    print("SPACE = record a sign, Q = quit")

    state, t0, frames, result = "idle", 0.0, [], None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        now = time.time()
        view = cv2.flip(frame, 1) if MIRROR_PREVIEW else frame.copy()   # preview only

        if state == "countdown":
            left = COUNTDOWN_SECONDS - (now - t0)
            if left <= 0:
                state, t0, frames = "recording", now, []
            else:
                put_text(view, f"Get ready... {int(left) + 1}", 60, 1.5, (0, 255, 255))
        if state == "recording":
            frames.append(frame)                        # unmirrored frame goes to the model
            put_text(view, f"RECORDING {RECORD_SECONDS - (now - t0):.1f}s", 60, 1.5, (0, 0, 255))
            if now - t0 >= RECORD_SECONDS:
                put_text(view, "Thinking...", 120, 1.2)
                cv2.imshow("SignFlow", view)
                cv2.waitKey(1)
                try:
                    decision, top3, hand_rate = predict_frames(bundle, frames)
                    print(json.dumps(decision), f"  hands in {hand_rate:.0%} of {len(frames)} frames,",
                          "top 3:", ", ".join(f"{s} {p:.2f}" for s, p in top3))
                    result = dict(decision, lines=[f"{s}  {p:.2f}" for s, p in top3]
                                  + [f"hands seen in {hand_rate:.0%} of frames"])
                except ValueError as e:                 # e.g. no hands / no shoulders found
                    print(json.dumps({"sign": None, "confidence": 0.0, "error": str(e)}))
                    result = {"sign": "?", "confidence": 0.0, "error": True, "lines": [str(e)]}
                state = "idle"
        if state == "idle":
            if result and result["sign"] == "?":
                put_text(view, "?", 70, 2.4, (0, 200, 255))                     # below threshold
                small = (f"conf {result['confidence']:.2f} < {CONF_THRESHOLD} (best guess {result['best_guess']})"
                         if "best_guess" in result else "no prediction")
                put_text(view, small, 110, 0.6)
                for i, line in enumerate(result["lines"]):
                    put_text(view, line, 145 + 30 * i, 0.6)
            elif result:
                put_text(view, f"{result['sign']}  ({result['confidence']:.2f})", 60, 1.6, (0, 255, 0))
                for i, line in enumerate(result["lines"]):
                    put_text(view, line, 110 + 35 * i, 0.8)
            put_text(view, "SPACE = record sign   Q = quit", view.shape[0] - 20, 0.8)

        cv2.imshow("SignFlow", view)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord(" ") and state == "idle":
            state, t0 = "countdown", now

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
