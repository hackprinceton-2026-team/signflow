"""SignFlow launcher for Umar's ASL recognizer, with a camera preview for SignFlow.

    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml            # 14-sign model
    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml --keyword  # 116-sign keyword model
    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml --window   # also open his OpenCV window

Runs the recognizer from Umar's checkout (branch keyword-model-v5, tested at d911607)
WITHOUT modifying it: his LiveEngine (MediaPipe, segmentation, model, send rules), his
drawing and his message format are used as is. It only adds one thing: throttled,
low-resolution JPEG preview frames, sent over the same loopback WebSocket so SignFlow
can show the camera without opening it a second time:

    {"type": "preview", "jpeg": "<base64>", "width": 320, "height": 240, "ts": 1794708452.9}

The camera is opened only here. Frames go only to 127.0.0.1 (never a public interface).
Run it with the Python environment from Umar's README (Python 3.11, his requirements.txt).
"""
import argparse
import base64
import json
import sys
import time
from pathlib import Path


def camera_frames(cv2, index, log):
    """Yields (bgr, t) from the camera, like live.frame_source, but a failed read doesn't end
    the run: the camera is reopened (a USB hiccup, or macOS briefly handing the camera
    to another app), so the recognizer never silently exits mid-demo."""
    failures = 0
    while True:
        cap = cv2.VideoCapture(index)
        if not cap.isOpened():
            failures += 1
            if failures == 1 or failures % 10 == 0:
                log(f"camera {index} unavailable (attempt {failures}); retrying. On macOS, allow camera access "
                    "for this terminal (System Settings > Privacy & Security > Camera).")
            time.sleep(1.0)
            continue
        if failures:
            log(f"camera {index} open again")
        failures = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    log(f"camera {index} stopped delivering frames; reopening")
                    break
                yield frame, time.time()
        finally:
            cap.release()
        time.sleep(0.5)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ml", required=True, help="path to Umar's checkout (the folder with src/live.py)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--preview-fps", type=float, default=10.0, help="preview frames per second (0 = none)")
    ap.add_argument("--preview-width", type=int, default=320)
    ap.add_argument("--preview-quality", type=int, default=60, help="JPEG quality 1-100")
    ap.add_argument("--window", action="store_true", help="also show the recognizer's own OpenCV window")
    pre, rest = ap.parse_known_args()

    ml_src = Path(pre.ml).expanduser().resolve() / "src"
    if not (ml_src / "live.py").is_file():
        sys.exit(f"{ml_src / 'live.py'} not found: point --ml at Umar's checkout (git worktree of keyword-model-v5)")
    sys.path.insert(0, str(ml_src))
    import cv2  # noqa: E402  (from his environment)
    import live  # noqa: E402  (his module, unchanged)

    # His own flags (--keyword, --threshold, --camera, --dominant, --video, ...), parsed by his code.
    his = argparse.ArgumentParser()
    live.add_common_args(his)
    args = his.parse_args(rest)
    args.headless = not pre.window
    if args.spacebar and args.headless:
        sys.exit("--spacebar needs --window (keyboard)")

    engine = live.LiveEngine(live.resolve_model(args), args.dominant, args.spacebar, args.threshold, True if args.keyword else None)
    live.log(f"model {args.model} ({len(engine.bundle['labels'])} signs) | {engine.rule_text()} | "
             f"preview {pre.preview_fps:g} fps, {pre.preview_width} px")
    ws = live.Broadcaster("127.0.0.1", pre.port)

    def emit(events):
        for e in events:
            if e["kind"] == "send":
                text = json.dumps(e["msg"])
                print(text, flush=True)
                ws.send(text)

    interval = 1.0 / pre.preview_fps if pre.preview_fps > 0 else None
    last_preview = 0.0
    t = 0.0
    try:
        frames = live.frame_source(args) if args.video else camera_frames(cv2, args.camera, live.log)
        for bgr, t in frames:
            key = -1
            if args.headless is False:
                cv2.imshow("SignFlow live", live.draw(engine, bgr))
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
            emit(engine.step(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, space=key == ord(" ")))
            now = time.time()
            if interval and now - last_preview >= interval and ws.clients:
                last_preview = now
                view = live.draw(engine, bgr)  # his overlay: landmarks, state, last sign (mirrored like his window)
                h, w = view.shape[:2]
                small = cv2.resize(view, (pre.preview_width, max(16, round(h * pre.preview_width / w))), interpolation=cv2.INTER_AREA)
                ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, pre.preview_quality])
                if ok:
                    ws.send(json.dumps({
                        "type": "preview",
                        "jpeg": base64.b64encode(buf.tobytes()).decode("ascii"),
                        "width": small.shape[1],
                        "height": small.shape[0],
                        "ts": round(now, 3),
                    }))
        if args.video:
            emit(engine.flush(t))
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        engine.close()
        ws.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
