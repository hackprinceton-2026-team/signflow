"""Record your own labelled sign clips with the webcam (a separate, held-out test source).

    python src/record_webcam.py HELP --n 5        -> data/webcam/HELP-<timestamp>.mp4 (x5)

SPACE = 3-2-1 countdown, then record ~2.5 s.  Q / ESC = quit.
Files are saved unmirrored (like the WLASL videos and like what predict_webcam.py feeds the
model); the preview follows MIRROR_PREVIEW in src/config.py, same as predict_webcam.py.
Then:  python src/eval_webcam.py           (runs predict_video.py 3x on every clip, live model)
"""
import argparse
import time
from pathlib import Path

import cv2

from config import MIRROR_PREVIEW
from predict_webcam import COUNTDOWN_SECONDS, RECORD_SECONDS, put_text

OUT_DIR = Path("data/webcam")


def save(frames, seconds, label):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{label}-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
    h, w = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), len(frames) / seconds, (w, h))
    for f in frames:
        writer.write(f)
    writer.release()
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label", help="sign name, e.g. HELP or THANKYOU")
    ap.add_argument("--n", type=int, default=5, help="number of clips to record")
    ap.add_argument("--camera", type=int, default=0)
    args = ap.parse_args()
    label = args.label.upper().replace(" ", "")

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit("Cannot open camera. On macOS allow camera access for your terminal / VS Code "
                         "(System Settings > Privacy & Security > Camera) and restart it.")
    state, t0, frames, saved = "idle", 0.0, [], 0
    while saved < args.n:
        ok, frame = cap.read()
        if not ok:
            break
        now = time.time()
        view = cv2.flip(frame, 1) if MIRROR_PREVIEW else frame.copy()   # preview only
        if state == "countdown":
            if now - t0 >= COUNTDOWN_SECONDS:
                state, t0, frames = "recording", now, []
            else:
                put_text(view, f"{label}: get ready... {int(COUNTDOWN_SECONDS - (now - t0)) + 1}", 60, 1.4, (0, 255, 255))
        if state == "recording":
            frames.append(frame)
            put_text(view, f"RECORDING {label}", 60, 1.4, (0, 0, 255))
            if now - t0 >= RECORD_SECONDS:
                path = save(frames, now - t0, label)
                saved += 1
                print(f"[{saved}/{args.n}] saved {path} ({len(frames)} frames)")
                state = "idle"
        if state == "idle":
            put_text(view, f"{label}: {saved}/{args.n} recorded", 60, 1.2, (0, 255, 0))
            put_text(view, "SPACE = record   Q = quit", view.shape[0] - 20, 0.8)
        cv2.imshow("SignFlow recorder", view)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord(" ") and state == "idle":
            state, t0 = "countdown", now
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
