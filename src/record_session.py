"""Record your own training / test clips for the keyword model, one prompted sign at a time.

    python src/record_session.py --signs "AGAIN,TELL,SAME" --reps 8 --session s1     # training session
    python src/record_session.py --signs "AGAIN,TELL,SAME" --reps 3 --session t1 --test   # personal test set
    python src/record_session.py --signs NOTHING --reps 10 --session s1             # non-sign movements
    then:  python src/train_keyword.py retrain --version v6                         # one command

Each prompt: raise your hands, sign, lower your hands (exactly like live.py: the same hands-down
segmenter cuts the clip, so your clips look like live segments). The clip is saved from ~0.5 s
before the hands rose until the segment ended:
    data/me/<SIGN>/<session>_<rep>.mp4          (training; --test: data/me/<SIGN>/test-<session>_<rep>.mp4)
Keys: R = redo the last clip, S = skip this prompt, Q / ESC = quit (what is recorded is kept).
--spacebar: SPACE starts a fixed 2.5 s recording instead (if auto segmentation does not trigger).
NOTHING clips: scratch your nose, touch your hair, adjust glasses, wave - anything that is NOT a
sign - then lower your hands. They train the NOTHING class, which is never sent as a keyword.
Videos of you stay local (data/me is git-ignored). Files are saved unmirrored, like WLASL.
"""
import argparse
import random
import sys
import time
from collections import deque
from pathlib import Path

import cv2

import config as C
from live import LiveEngine, draw, log
from predict_video import MODEL_FILE

ME_DIR = Path("data/me")
LEAD_FRAMES = 15                     # frames kept from before the hands rose (~0.5 s)


def next_path(sign, session):
    folder = ME_DIR / sign
    folder.mkdir(parents=True, exist_ok=True)
    n = 1
    while (folder / f"{session}_{n}.mp4").exists():
        n += 1
    return folder / f"{session}_{n}.mp4"


def save(frames, fps, path):
    h, w = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for f in frames:
        writer.write(f)
    writer.release()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--signs", required=True, help='comma list, e.g. "AGAIN,TELL" (NOTHING = non-sign movements)')
    ap.add_argument("--reps", type=int, default=8)
    ap.add_argument("--session", required=True, help="session name, e.g. s1 (one sitting / one day)")
    ap.add_argument("--test", action="store_true", help="personal TEST session: never trained on")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--spacebar", action="store_true", help="SPACE + fixed 2.5 s recording instead of auto segmentation")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    if "_" in args.session:
        ap.error("--session must not contain '_'")
    session = f"test-{args.session}" if args.test else args.session
    signs = [s.strip().upper().replace(" ", "") for s in args.signs.split(",") if s.strip()]
    prompts = signs * args.reps
    random.Random(args.seed).shuffle(prompts)

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        sys.exit("Cannot open camera. On macOS allow camera access for your terminal / VS Code "
                 "(System Settings > Privacy & Security > Camera) and restart it.")
    engine = LiveEngine(MODEL_FILE, spacebar=args.spacebar)        # only its segmentation is used
    ring = deque(maxlen=LEAD_FRAMES + C.MAX_SEGMENT_FRAMES + 30)
    saved, i, last = [], 0, None
    log(f"{len(prompts)} prompts, session '{session}' -> {ME_DIR}/<SIGN>/{session}_<n>.mp4")
    t_start, n_frames = time.time(), 0
    try:
        while i < len(prompts):
            sign = prompts[i]
            ok, frame = cap.read()
            if not ok:
                break
            n_frames += 1
            ring.append(frame)
            hint = "SPACE, then sign" if args.spacebar else (
                "move (not a sign), lower hands" if sign == "NOTHING" else "sign, then lower your hands")
            cv2.imshow("SignFlow recorder", draw(engine, frame, [f"{'TEST ' if args.test else ''}{sign}",
                                                                 f"{i + 1}/{len(prompts)}  {hint}",
                                                                 "R redo  S skip  Q quit"]))
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("s"):
                log(f"skipped {sign}")
                i += 1
                continue
            if key == ord("r") and last:
                last.unlink(missing_ok=True)
                log(f"deleted {last} - redo")
                saved.remove(last)
                i, last = i - 1, None
                continue
            events = engine.step(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), time.time(), space=key == ord(" "))
            if any(e["kind"] == "prediction" for e in events):
                e = next(e for e in events if e["kind"] == "prediction")
                n = e["frames"] + LEAD_FRAMES
                frames = list(ring)[-n:]
                fps = max(10.0, min(60.0, n_frames / max(time.time() - t_start, 1e-6)))
                last = next_path(sign, session)
                save(frames, fps, last)
                saved.append(last)
                log(f"[{i + 1}/{len(prompts)}] saved {last} ({len(frames)} frames)")
                i += 1
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        engine.close()
        cv2.destroyAllWindows()
    log(f"{len(saved)} clips saved. Retrain (includes data/me automatically): python src/train_keyword.py retrain --version v6")


if __name__ == "__main__":
    main()
