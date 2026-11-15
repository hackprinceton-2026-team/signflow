"""SignFlow launcher for Umar's ASL recognizer, with a camera preview for SignFlow.

    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml            # 14-sign model
    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml --keyword  # 116-sign keyword model
    python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml --window   # also open his OpenCV window

Runs the recognizer from Umar's checkout (branch keyword-model-v5, tested at d911607)
WITHOUT modifying it: his LiveEngine (MediaPipe, segmentation, model, send rules), his
drawing and his message format are used as is. It only adds one thing: throttled,
low-resolution JPEG preview frames, sent over the same loopback WebSocket so SignFlow
can show the camera without opening it a second time:

    {"type": "preview", "jpeg": "<base64>", "width": 640, "height": 360, "ts": 1794708452.9}

The camera is opened only here. Frames go only to 127.0.0.1 (never a public interface).
Run it with the Python environment from Umar's README (Python 3.11, his requirements.txt).
"""
import argparse
import base64
import json
import sys
import threading
import time
from types import SimpleNamespace
from pathlib import Path


def camera_frames(cv2, resolve, log):
    """Yields (bgr, t) from the camera, like live.frame_source, with two differences:
    - which camera is decided by `resolve()` (camera_select.choose_camera: the built-in
      MacBook camera first, never just "index 0"), again at every (re)open, so if that
      camera disappears another one is used, and the log says which;
    - a failed read doesn't end the run: the camera is released and reopened.
    Only one capture session exists at a time: the previous one is released first."""
    failures = 0
    while True:
        choice = resolve()
        cap = cv2.VideoCapture(choice.index)
        if not cap.isOpened():
            failures += 1
            if failures == 1 or failures % 10 == 0:
                log(f"camera {choice.index} unavailable (attempt {failures}); retrying. On macOS, allow camera access "
                    "for this terminal (System Settings > Privacy & Security > Camera).")
            cap.release()
            time.sleep(1.0)
            continue
        failures = 0
        name = choice.camera.name if choice.camera else "unidentified camera"
        log(f"camera: {name} (index {choice.index}; {choice.note})")
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    log(f"camera {name} stopped delivering frames; reopening")
                    break
                yield frame, time.time()
        finally:
            cap.release()
        time.sleep(0.5)


class PreviewPublisher:
    """Draws, scales, encodes and sends preview frames on a background thread, so the
    recognizer loop only hands over a frame reference (it never waits for JPEG encoding
    or the socket). It keeps only the NEWEST frame: if encoding falls behind, older frames
    are dropped, never queued. If a frame takes longer than its time budget for a while,
    the width steps down (640 -> 480 -> 320) and back up when there is headroom.
    The camera image and the model's input are untouched: this only reads them."""

    WIDTHS = (320, 480, 640, 800, 960, 1280)

    def __init__(self, cv2, live, ws, width, quality, fps):
        self.cv2, self.live, self.ws, self.quality = cv2, live, ws, quality
        self.interval = 1.0 / fps
        self.max_width = width
        self.width = width
        self.slot = None
        self.cond = threading.Condition()
        self.closed = False
        self.last_offer = 0.0
        self.sent = self.dropped = self.bytes = 0
        self.busy = 0.0  # seconds spent encoding+sending since the last stats read
        self.slow_streak = self.fast_streak = 0
        threading.Thread(target=self._run, name="preview", daemon=True).start()

    def offer(self, engine, bgr, now):
        """Called from the recognizer loop: O(1), never blocks on encoding."""
        if now - self.last_offer < self.interval:
            return
        self.last_offer = now
        # A snapshot of what live.draw() reads, so the overlay matches this frame.
        snap = SimpleNamespace(results=engine.results, state=engine.state, spacebar=engine.spacebar,
                               last=engine.last, keyword=engine.keyword, sentence=list(engine.sentence))
        with self.cond:
            if self.slot is not None:
                self.dropped += 1  # the previous frame was never encoded: replace it
            self.slot = (snap, bgr, now)
            self.cond.notify()

    def _run(self):
        while True:
            with self.cond:
                while self.slot is None and not self.closed:
                    self.cond.wait()
                if self.closed:
                    return
                snap, bgr, ts = self.slot
                self.slot = None
            t0 = time.perf_counter()
            try:
                self._send(snap, bgr, ts)
            except Exception as e:  # a preview problem must never affect recognition
                self.live.log(f"preview frame skipped: {e}")
            spent = time.perf_counter() - t0
            self.busy += spent
            self._adapt(spent)

    def _send(self, snap, bgr, ts):
        cv2 = self.cv2
        view = self.live.draw(snap, bgr)  # his overlay (landmarks, state, last sign), mirrored like his window
        h, w = view.shape[:2]
        width = min(self.width, w)
        size = (width, max(16, round(h * width / w)))  # keeps the camera's aspect ratio
        small = cv2.resize(view, size, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        if not ok or not self.ws.clients:
            return
        msg = json.dumps({
            "type": "preview",
            "jpeg": base64.b64encode(buf.tobytes()).decode("ascii"),
            "width": small.shape[1],
            "height": small.shape[0],
            "ts": round(ts, 3),
        })
        self.ws.send(msg)
        self.sent += 1
        self.bytes += len(msg)

    def _adapt(self, spent):
        budget = self.interval * 0.6
        if spent > budget:
            self.slow_streak, self.fast_streak = self.slow_streak + 1, 0
        elif spent < budget * 0.4:
            self.fast_streak, self.slow_streak = self.fast_streak + 1, 0
        smaller = [x for x in self.WIDTHS if x < self.width]
        larger = [x for x in self.WIDTHS if self.width < x <= self.max_width]
        if self.slow_streak >= 15 and smaller:
            self.width, self.slow_streak = smaller[-1], 0
            self.live.log(f"preview: encoding is slow, width -> {self.width}px")
        elif self.fast_streak >= 150 and larger:
            self.width, self.fast_streak = larger[0], 0
            self.live.log(f"preview: headroom, width -> {self.width}px")

    def read_stats(self):
        out = (self.sent, self.dropped, self.bytes, self.busy, self.width)
        self.sent = self.dropped = self.bytes = 0
        self.busy = 0.0
        return out

    def close(self):
        with self.cond:
            self.closed = True
            self.cond.notify()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ml", required=True, help="path to Umar's checkout (the folder with src/live.py)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--preview-fps", type=float, default=15.0, help="preview frames per second (0 = none)")
    ap.add_argument("--preview-width", type=int, default=640, help="preview width; height keeps the camera's aspect ratio")
    ap.add_argument("--preview-quality", type=int, default=80, help="JPEG quality 1-100")
    ap.add_argument("--window", action="store_true", help="also show the recognizer's own OpenCV window")
    ap.add_argument("--camera-name", help="use the first camera whose name contains this (e.g. 'MacBook', 'iPhone')")
    ap.add_argument("--stats", action="store_true", help="log loop FPS, inference and preview timings every 5 s")
    ap.add_argument("--list-cameras", action="store_true", help="print the cameras (OpenCV index and name) and exit")
    pre, rest = ap.parse_known_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from camera_select import choose_camera, describe, list_cameras, locate_index  # noqa: E402
    if pre.list_cameras:
        cams = list_cameras()
        print(describe(cams) if cams is not None else "can't list cameras: pip install pyobjc-framework-AVFoundation")
        return

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
    explicit_index = args.camera if any(a == "--camera" or a.startswith("--camera=") for a in rest) else None
    args.headless = not pre.window
    if args.spacebar and args.headless:
        sys.exit("--spacebar needs --window (keyboard)")

    engine = live.LiveEngine(live.resolve_model(args), args.dominant, args.spacebar, args.threshold, True if args.keyword else None)
    live.log(f"model {args.model} ({len(engine.bundle['labels'])} signs) | {engine.rule_text()} | "
             f"preview {pre.preview_fps:g} fps, {pre.preview_width} px")
    ws = live.Broadcaster("127.0.0.1", pre.port)

    # Which camera: decided (and re-decided at every reopen) by camera_select, with
    # OpenCV's index verified physically (locate_index), cached while the devices don't change.
    camera_info = {}
    verified_cache = {}

    def probe(index, size):
        cap = cv2.VideoCapture(index)
        try:
            if not cap.isOpened():
                return None
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, size[0])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, size[1])
            frame = None
            for _ in range(5):
                ok, frame = cap.read()
            return (frame.shape[1], frame.shape[0]) if frame is not None else None
        finally:
            cap.release()  # one camera open at a time

    def resolve():
        cams = list_cameras()
        try:
            choice = choose_camera(cams, explicit_index, pre.camera_name)
        except ValueError as e:
            sys.exit(f"camera: {e}")
        index, verified = choice.index, choice.how == "explicit-index"
        if choice.camera is not None:
            key = (choice.camera.name, tuple(c.name for c in cams))
            if key not in verified_cache:
                verified_cache[key] = locate_index(choice.camera, cams, probe)
            located = verified_cache[key]
            if located is not None:
                index, verified = located, True
            else:
                live.log(f"WARNING: can't verify which OpenCV index is {choice.camera.name!r}; trying index "
                         f"{index} (unverified). Pass --camera N to choose. Cameras: {describe(cams)}")
        name = choice.camera.name if choice.camera else f"camera {index}"
        camera_info.clear()
        camera_info.update({
            "type": "camera",
            "active": name,
            "index": index,
            "selection": choice.how,
            "verified": verified,
            "note": choice.note,
            "available": [{"name": c.name, "kind": c.kind} for c in cams or []],
        })
        return choice.__class__(index, choice.camera, choice.how, choice.note + ("" if verified else " (unverified)"))

    def emit(events):
        for e in events:
            if e["kind"] == "send":
                text = json.dumps(e["msg"])
                print(text, flush=True)
                ws.send(text)

    preview = (PreviewPublisher(cv2, live, ws, pre.preview_width, pre.preview_quality, pre.preview_fps)
               if pre.preview_fps > 0 else None)
    t = 0.0
    try:
        frames = live.frame_source(args) if args.video else camera_frames(cv2, resolve, live.log)
        last_camera_msg = 0.0
        stats = {"t0": time.time(), "frames": 0, "step": 0.0, "pv_ms": 0.0}
        for bgr, t in frames:
            key = -1
            if args.headless is False:
                cv2.imshow("SignFlow live", live.draw(engine, bgr))
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
            t_step = time.perf_counter()
            emit(engine.step(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, space=key == ord(" ")))
            stats["step"] += time.perf_counter() - t_step
            stats["frames"] += 1
            now = time.time()
            if pre.stats and now - stats["t0"] >= 5:
                n, el = stats["frames"], now - stats["t0"]
                sent, dropped, size, busy, width = preview.read_stats() if preview else (0, 0, 0, 0.0, 0)
                live.log(f"STATS loop {n / el:.1f} fps ({bgr.shape[1]}x{bgr.shape[0]}), inference {1000 * stats['step'] / max(1, n):.0f} ms/frame, "
                         f"preview {sent / el:.1f} fps at {width}px, {1000 * stats['pv_ms'] / max(1, n):.2f} ms/frame in loop, "
                         f"{1000 * busy / max(1, sent):.1f} ms/frame in its thread, {size / max(1, sent) / 1024:.0f} KB/frame, {dropped} dropped")
                stats.update(t0=now, frames=0, step=0.0, pv_ms=0.0)
            if camera_info and ws.clients and now - last_camera_msg >= 3:
                last_camera_msg = now
                ws.send(json.dumps(camera_info))  # which camera is in use, for SignFlow's Settings
            if preview and ws.clients:
                t_pv = time.perf_counter()
                preview.offer(engine, bgr, now)  # O(1): encoding happens on the preview thread
                stats["pv_ms"] += time.perf_counter() - t_pv
        if args.video:
            emit(engine.flush(t))
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        if preview:
            preview.close()
        engine.close()
        ws.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
