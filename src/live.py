"""Live sign recognition from the webcam, with output over WebSocket + stdout.

    python src/live.py                      # webcam 0, automatic segmentation (hands-down rule)
    python src/live.py --spacebar           # fallback: SPACE starts a 2.5 s recording
    python src/live.py --dominant right     # fixed dominant hand instead of the training rule
    python src/live.py --video a.mp4 --video b.mp4 --headless    # dry run without a camera

Events (one JSON per line on stdout, and to every client of ws://localhost:8765):
    {"type": "sign", "sign": "HELP", "confidence": 0.91, "ts": 1731612345.123}
    {"type": "end_of_sentence", "signs": ["HELP", "DOCTOR"], "ts": 1731612349.456}
Logs go to stderr, so stdout stays pure JSON.

Rules (settings in src/config.py):
  - a sign starts when a wrist rises above mid-chest (HAND_UP_Y) and ends when no hand is up for
    END_FRAMES frames; segments shorter than MIN_SEGMENT_FRAMES are ignored
  - confidence < CONF_THRESHOLD -> "?" on screen, nothing sent
  - the same sign is not sent twice in a row unless the hands were down (END_FRAMES frames) in between
  - no hand up for SENTENCE_PAUSE_S after at least one sign -> end_of_sentence
--dominant (the released model v2_rf_feat2dom was trained with the per-clip rule):
  auto  (default) same rule as training: the hand whose wrist moves more is treated as dominant
  right / left    fixed hand. NOTE: on the 17 webcam test clips this fixes HELP-...810 but turns
                  all 3 STOP clips into HELP (12/17 vs 14/17 for auto), because the model learned
                  STOP with that per-clip rule. See MODEL_CARD.md.
"""
import argparse
import json
import sys
import threading
import time
from collections import deque

import cv2
import joblib
import mediapipe as mp
import numpy as np

import config as C
from features import LandmarkTracker, features_from_raw, read_frames
from predict_video import MODEL_FILE, decide

_draw = mp.solutions.drawing_utils
_holistic = mp.solutions.holistic


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ segmentation + prediction
class LiveEngine:
    """Feed it one frame at a time (step). It tracks landmarks, cuts signs out of the stream,
    predicts them and decides what gets sent. Shared by live.py and live_test.py."""

    def __init__(self, model_path=MODEL_FILE, dominant="auto", spacebar=False):
        self.bundle = joblib.load(model_path)
        self.fs = self.bundle.get("features", "feat1")
        self.dominant = None if dominant == "auto" else dominant
        self.spacebar = spacebar
        self.tracker = LandmarkTracker()
        self.shoulders = None                       # last seen (center_y, width) in pixels
        self.preroll = deque(maxlen=C.PREROLL_FRAMES)
        self.buffer, self.state = [], "waiting"     # waiting / countdown / signing / predicting
        self.down_run = 0                           # consecutive frames with no hand up
        self.last_up_t = None
        self.rest_after_send = True                 # hands were down since the last sent sign
        self.rested_at_start = True                 # ...as of the moment the current sign started
        self.last_sent = None
        self.sentence = []
        self.last = None                            # last prediction (for the screen)
        self.results = None                         # MediaPipe results (for drawing)
        self.t0 = 0.0

    def hand_up(self, row):
        if row[137]:                                # pose present: update shoulders
            ls, rs = row[129:132], row[132:135]
            width = float(np.hypot(*(ls[:2] - rs[:2])))
            if width > 1e-6:
                self.shoulders = ((ls[1] + rs[1]) / 2, width)
        if self.shoulders is None:
            return False
        cy, width = self.shoulders
        wrists = [row[1]] * int(row[135]) + [row[64]] * int(row[136])   # y of each present wrist
        return any((y - cy) / width < C.HAND_UP_Y for y in wrists)

    def predict(self, rows):
        """rows -> (decision dict from decide(), top3 list) or (None, error message)."""
        try:
            x = features_from_raw(np.array(rows), self.fs, self.dominant)
        except ValueError as e:                     # no hands / no shoulders in the segment
            return None, str(e)
        proba = self.bundle["model"].predict_proba(self.bundle["scaler"].transform([x]))[0]
        classes = self.bundle["model"].classes_
        top3 = [(str(classes[i]), float(proba[i])) for i in np.argsort(-proba)[:3]]
        return decide(proba, classes), top3

    def step(self, rgb, t, space=False):
        """Process one RGB frame at time t (seconds). Returns a list of events:
        {"kind": "prediction", ...} for every segment, {"kind": "send", "msg": {...}} for every
        message to send (sign / end_of_sentence)."""
        row, self.results = self.tracker.process(rgb)
        up = self.hand_up(row)
        events = []
        if up:
            self.down_run, self.last_up_t = 0, t
        else:
            self.down_run += 1
        if not self.rest_after_send and self.down_run >= C.END_FRAMES:
            self.rest_after_send = True

        segment = None
        if self.spacebar:
            if self.state == "waiting" and space:
                self.state, self.t0, self.rested_at_start = "countdown", t, self.rest_after_send
            elif self.state == "countdown" and t - self.t0 >= C.COUNTDOWN_SECONDS:
                self.state, self.t0, self.buffer = "signing", t, []
            elif self.state == "signing":
                self.buffer.append(row)
                if t - self.t0 >= C.RECORD_SECONDS:
                    segment, self.buffer = self.buffer, []
        else:
            if self.state == "waiting":
                self.preroll.append(row)
                if up:
                    self.state, self.buffer, self.up_frames = "signing", list(self.preroll), [len(self.preroll) - 1]
                    self.rested_at_start = self.rest_after_send     # rest must happen BEFORE the sign
            elif self.state == "signing":
                self.buffer.append(row)
                if up:
                    self.up_frames.append(len(self.buffer) - 1)
                if self.down_run >= C.END_FRAMES or len(self.buffer) >= C.MAX_SEGMENT_FRAMES:
                    active = self.up_frames[-1] - self.up_frames[0] + 1
                    segment = self.buffer if active >= C.MIN_SEGMENT_FRAMES else None
                    if segment is None:
                        events.append({"kind": "ignored", "frames": active})
                    self.buffer, self.state = [], "waiting"
                    self.preroll.clear()

        if segment is not None:
            self.state = "predicting"
            decision, top3 = self.predict(segment)
            event = {"kind": "prediction", "decision": decision, "top3": top3, "frames": len(segment), "t": t}
            if decision is None:
                event["error"] = top3
                self.last = {"sign": "?", "confidence": 0.0, "note": top3}
            elif decision["sign"] == "?":
                self.last = dict(decision, note=f"below {C.CONF_THRESHOLD}: not sent")
            elif decision["sign"] == self.last_sent and not self.rested_at_start:
                event["debounced"] = True
                self.last = dict(decision, note="repeat without hands down: not sent")
            else:
                msg = {"type": "sign", "sign": decision["sign"], "confidence": decision["confidence"],
                       "ts": round(time.time(), 3)}
                events.append({"kind": "send", "msg": msg})
                self.sentence.append(decision["sign"])
                self.last_sent, self.rest_after_send = decision["sign"], False
                self.down_run = 0                   # count the rest from now on
                self.last = dict(decision, note="sent")
            events.insert(0, event)
            self.state = "waiting"

        if (self.sentence and self.state == "waiting" and self.last_up_t is not None
                and t - self.last_up_t >= C.SENTENCE_PAUSE_S and not up):
            events.append({"kind": "send", "msg": {"type": "end_of_sentence", "signs": self.sentence,
                                                   "ts": round(time.time(), 3)}})
            self.sentence = []
        return events

    def flush(self, t):
        """End of input: close an open segment and sentence by feeding 'no hand' time."""
        events = []
        if self.state == "signing" and not self.spacebar:
            self.down_run = C.END_FRAMES - 1
        blank = np.zeros((240, 320, 3), np.uint8)
        for i in range(int(C.SENTENCE_PAUSE_S * 30) + C.END_FRAMES + 2):
            events += self.step(blank, t + (i + 1) / 30)
        return events

    def close(self):
        self.tracker.close()


# ------------------------------------------------------------------ drawing
def put(img, text, org, scale, color=(255, 255, 255), thick=2):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thick + 4, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)


def draw(engine, bgr, extra=None):
    """Landmarks + state + last prediction + sentence. Returns the frame to show."""
    view = bgr.copy()
    r = engine.results
    if r is not None:
        for hand in (r.left_hand_landmarks, r.right_hand_landmarks):
            if hand:
                _draw.draw_landmarks(view, hand, _holistic.HAND_CONNECTIONS)
        if r.pose_landmarks:
            _draw.draw_landmarks(view, r.pose_landmarks, _holistic.POSE_CONNECTIONS)
    if C.MIRROR_PREVIEW:
        view = cv2.flip(view, 1)
    h, w = view.shape[:2]
    colors = {"waiting": (200, 200, 200), "countdown": (0, 255, 255), "signing": (0, 0, 255), "predicting": (255, 200, 0)}
    state = engine.state
    if engine.spacebar and state == "waiting":
        state = "waiting (SPACE to sign)"
    put(view, state.upper(), (20, 40), 1.0, colors.get(engine.state, (255, 255, 255)))
    if engine.last:
        good = engine.last["sign"] != "?"
        put(view, f"{engine.last['sign']}  {engine.last['confidence']:.2f}", (20, 120), 2.2,
            (0, 255, 0) if good else (0, 200, 255), 4)
        note = engine.last.get("note", "")
        if engine.last.get("best_guess"):
            note = f"best guess {engine.last['best_guess']}, {note}"
        put(view, note, (20, 160), 0.6)
    put(view, "Sentence: " + " ".join(engine.sentence), (20, h - 50), 0.9, (255, 255, 0))
    put(view, "Q = quit" + ("   SPACE = sign" if engine.spacebar else ""), (20, h - 15), 0.6)
    for i, line in enumerate(extra or []):
        put(view, line, (w // 2 - 200, 60 + 50 * i), 1.3, (0, 255, 255), 3)
    return view


# ------------------------------------------------------------------ input + output
def frame_source(args):
    """Yields (bgr, t). Camera: real time. --video: the files' frames with simulated time,
    plus --gap seconds of empty frames between and after files (= hands down)."""
    if args.video:
        t, fps = 0.0, 30.0
        for path in args.video:
            for rgb in read_frames(path):
                t += 1 / fps
                yield cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), t
            blank = np.zeros((480, 640, 3), np.uint8)
            for _ in range(int(args.gap * fps)):
                t += 1 / fps
                yield blank, t
        return
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        sys.exit(f"Cannot open camera {args.camera}. On macOS allow camera access for your terminal / "
                 "VS Code (System Settings > Privacy & Security > Camera) and restart it.")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            yield frame, time.time()
    finally:
        cap.release()


class Broadcaster:
    """Tiny WebSocket server: every message goes to every connected client."""

    def __init__(self, host, port):
        from websockets.sync.server import serve
        self.clients, self.lock = set(), threading.Lock()
        self.server = serve(self._handler, host, port)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        log(f"WebSocket server on ws://{host}:{port}")

    def _handler(self, ws):
        with self.lock:
            self.clients.add(ws)
        log("client connected")
        try:
            for _ in ws:                            # we don't expect messages; wait for close
                pass
        finally:
            with self.lock:
                self.clients.discard(ws)
            log("client disconnected")

    def send(self, text):
        with self.lock:
            clients = list(self.clients)
        for ws in clients:
            try:
                ws.send(text)
            except Exception:
                pass

    def close(self):
        self.server.shutdown()


def add_common_args(ap):
    ap.add_argument("--dominant", choices=["auto", "right", "left"], default="auto",
                    help="auto = same rule as training (default); right/left = fixed dominant hand")
    ap.add_argument("--spacebar", action="store_true", help="SPACE-triggered recording instead of auto segmentation")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--video", action="append", help="dry run: read these video files instead of the camera")
    ap.add_argument("--gap", type=float, default=2.0, help="seconds of empty frames after each --video file")
    ap.add_argument("--headless", action="store_true", help="no window (for dry runs)")
    ap.add_argument("--model", default=str(MODEL_FILE))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap)
    ap.add_argument("--no-ws", action="store_true", help="stdout only, no WebSocket server")
    ap.add_argument("--linger", type=float, default=1.0, help="seconds to keep the server up after a --video run")
    args = ap.parse_args()
    if args.spacebar and args.headless:
        ap.error("--spacebar needs the window (keyboard)")

    engine = LiveEngine(args.model, args.dominant, args.spacebar)
    log(f"model {engine.bundle.get('version', '?')}_{engine.bundle['model_name']}_{engine.bundle.get('feature_set', engine.fs)}"
        f" | dominant {args.dominant} | {'spacebar' if args.spacebar else 'auto segmentation'} | "
        f"threshold {C.CONF_THRESHOLD}")
    ws = None if args.no_ws else Broadcaster(C.WS_HOST, C.WS_PORT)

    def emit(events):
        for e in events:
            if e["kind"] == "send":
                text = json.dumps(e["msg"])
                print(text, flush=True)
                if ws:
                    ws.send(text)
            elif e["kind"] == "prediction":
                d = e["decision"]
                status = e.get("error") or (f"{d['sign']} {d['confidence']:.2f}" + (" (debounced)" if e.get("debounced") else ""))
                log(f"segment {e['frames']} frames -> {status}   top3: " + ", ".join(f"{s} {p:.2f}" for s, p in e["top3"])
                    if not e.get("error") else f"segment {e['frames']} frames -> no prediction: {status}")
            elif e["kind"] == "ignored":
                log(f"ignored short movement ({e['frames']} frames)")

    t = 0.0
    try:
        for bgr, t in frame_source(args):
            key = -1
            if not args.headless:
                cv2.imshow("SignFlow live", draw(engine, bgr))
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
            emit(engine.step(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, space=key == ord(" ")))
        if args.video:
            emit(engine.flush(t))
            time.sleep(args.linger)                 # give WebSocket clients time to receive
    except KeyboardInterrupt:
        pass
    finally:
        engine.close()
        if ws:
            ws.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
