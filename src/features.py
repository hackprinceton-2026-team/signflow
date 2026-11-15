"""Shared feature code. Every script (extract, augment, train, predict) uses this file.

Two stages:
  1. video_to_raw(path)      -> raw per-frame landmarks, shape (T, RAW_DIM), pixel units
  2. features_from_raw(raw)  -> one fixed-length feature vector, shape (FEATURE_DIM,)

Raw frame layout (RAW_DIM = 138):
  [0:63]    left hand, 21 points x (x, y, z)
  [63:126]  right hand, 21 points x (x, y, z)
  [126:135] pose: nose, left shoulder, right shoulder x (x, y, z)
  [135]     left hand present (0/1)
  [136]     right hand present (0/1)
  [137]     pose present (0/1)
x, y, z are in pixels (x * width, y * height, z * width) so the image aspect ratio
(portrait phone vs landscape webcam) doesn't distort the shapes.
"""
import os

os.environ.setdefault("GLOG_minloglevel", "2")       # quiet MediaPipe C++ logs
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import cv2
import mediapipe as mp
import numpy as np

N_FRAMES = 16                      # every clip is resampled to this many frames
N_POINTS = 21 + 21 + 3             # left hand, right hand, nose + 2 shoulders
RAW_DIM = N_POINTS * 3 + 3
FRAME_DIM = N_POINTS * 3 + 2       # normalized points + 2 hand-present flags
FEATURE_DIM = N_FRAMES * FRAME_DIM

POSE_IDS = [0, 11, 12]             # MediaPipe pose: nose, left shoulder, right shoulder
LH, RH, POSE = slice(0, 21), slice(21, 42), slice(42, 45)

_ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def read_frames(path, frame_start=1, frame_end=-1):
    """Yield upright RGB frames. Phone videos store rotation as metadata, which this
    OpenCV build does not apply automatically, so we rotate ourselves.
    frame_start/frame_end follow WLASL: 1-based, end inclusive, frame_end=-1 = until the end."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise IOError(f"Cannot open video: {path}")
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)          # make sure we never rotate twice
    rotation = int(cap.get(cv2.CAP_PROP_ORIENTATION_META)) % 360
    number = 0                                         # 1-based number of the frame just read
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        number += 1
        if number < frame_start:
            continue
        if frame_end != -1 and number > frame_end:
            break
        if rotation in _ROTATE:
            frame = cv2.rotate(frame, _ROTATE[rotation])
        yield cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    cap.release()


def _points(landmarks, ids, w, h):
    return np.array([[landmarks[i].x * w, landmarks[i].y * h, landmarks[i].z * w] for i in ids])


def video_to_raw(path, frame_start=1, frame_end=-1):
    """Run MediaPipe Holistic on every frame of a video file. Returns (T, RAW_DIM)."""
    return frames_to_raw(read_frames(path, frame_start, frame_end))


def results_to_row(res, w, h):
    """One MediaPipe Holistic result -> one raw row (RAW_DIM), see the layout at the top."""
    row = np.zeros(RAW_DIM, dtype=np.float32)
    if res.left_hand_landmarks:
        row[0:63] = _points(res.left_hand_landmarks.landmark, range(21), w, h).ravel()
        row[135] = 1
    if res.right_hand_landmarks:
        row[63:126] = _points(res.right_hand_landmarks.landmark, range(21), w, h).ravel()
        row[136] = 1
    if res.pose_landmarks:
        row[126:135] = _points(res.pose_landmarks.landmark, POSE_IDS, w, h).ravel()
        row[137] = 1
    return row


class LandmarkTracker:
    """Frame-by-frame MediaPipe Holistic (video mode), for live streams.
    process(rgb) -> (raw row, MediaPipe results for drawing). Same settings as frames_to_raw."""

    def __init__(self):
        self.holistic = mp.solutions.holistic.Holistic(static_image_mode=False, model_complexity=1)

    def process(self, rgb):
        res = self.holistic.process(rgb)
        return results_to_row(res, rgb.shape[1], rgb.shape[0]), res

    def close(self):
        self.holistic.close()


def frames_to_raw(frames):
    """Run MediaPipe Holistic on upright RGB frames (any iterable, e.g. webcam frames).
    Returns float32 array (T, RAW_DIM)."""
    tracker = LandmarkTracker()
    try:
        rows = [tracker.process(frame)[0] for frame in frames]
    finally:
        tracker.close()
    return np.array(rows, dtype=np.float32).reshape(-1, RAW_DIM)


def normalize(raw):
    """Keep only frames with at least one hand, then center on the shoulder midpoint and
    scale by shoulder width. Returns points (T', 45, 3) and presence (T', 2).
    Center/width are the clip median over frames with a pose (the body barely moves,
    and the median ignores single-frame pose glitches)."""
    raw = np.asarray(raw, dtype=np.float32)
    has_hand = (raw[:, 135] + raw[:, 136]) > 0
    if not has_hand.any():
        raise ValueError("No hands detected in any frame")
    has_pose = raw[:, 137] > 0
    if not has_pose.any():
        raise ValueError("No body pose (shoulders) detected in any frame")

    pose = raw[has_pose, 126:135].reshape(-1, 3, 3)
    l_sh, r_sh = np.median(pose[:, 1], axis=0), np.median(pose[:, 2], axis=0)
    center = (l_sh[:2] + r_sh[:2]) / 2
    width = np.linalg.norm(l_sh[:2] - r_sh[:2])
    if width < 1e-6:
        raise ValueError("Shoulder width is zero")

    raw = raw[has_hand]
    points = raw[:, :N_POINTS * 3].reshape(-1, N_POINTS, 3).copy()
    points[:, :, :2] -= center
    points /= width
    presence = raw[:, 135:137].copy()
    points[presence[:, 0] == 0, LH] = 0            # missing hand = zeros
    points[presence[:, 1] == 0, RH] = 0
    return points, presence


# ---------------------------------------------------------------------------------------------
# Feature sets
#   feat1     v1: shoulder-relative points + hand-present flags            137 values / frame
#   feat2     feat1 + hand shape + wrist velocity                          267 values / frame
#               hand shape: each hand's 21 points relative to its own wrist, divided by hand
#               size (wrist -> middle-finger knuckle, landmark 9), 2 x 63 values
#               wrist velocity: x/y change of each wrist vs the previous (resampled) frame, 4 values
#   feat2dom  feat2 after making the dominant hand (the one whose wrist moves more) the RIGHT
#             hand: if the left hand moves more, the whole clip is mirrored (x -> -x, left/right
#             hand slots and shoulders swapped), so a left-handed signer looks right-handed.
# (Mirroring as *training augmentation* is done in train_select.py, with feat2 features.)
# ---------------------------------------------------------------------------------------------
FEATURE_SETS = ("feat1", "feat2", "feat2dom")
FRAME_DIMS = {"feat1": FRAME_DIM, "feat2": FRAME_DIM + 126 + 4, "feat2dom": FRAME_DIM + 126 + 4}
WRIST, MIDDLE_MCP = 0, 9
_MIRROR_ORDER = list(range(21, 42)) + list(range(0, 21)) + [42, 44, 43]   # swap hands + shoulders


def mirror(points, presence):
    """Horizontal flip of a normalized clip: x -> -x, left <-> right hand, left <-> right shoulder."""
    p = points[:, _MIRROR_ORDER].copy()
    p[:, :, 0] *= -1
    return p, presence[:, ::-1].copy()


def wrist_movement(points, presence):
    """Total x/y path length of each wrist over frames where that hand is present in both
    consecutive frames. Returns (left, right)."""
    moves = []
    for h, wrist in ((0, WRIST), (1, 21 + WRIST)):
        both = (presence[1:, h] > 0) & (presence[:-1, h] > 0)
        steps = np.linalg.norm(np.diff(points[:, wrist, :2], axis=0), axis=1)
        moves.append(float(steps[both].sum()))
    return tuple(moves)


def left_dominant(points, presence):
    left, right = wrist_movement(points, presence)
    return left > right


def prepare(raw, fs="feat1", dominant=None):
    """normalize(), plus dominant-hand mirroring for feat2dom.
    dominant: None = guess per clip (the hand whose wrist moves more; used in training/eval),
              "right" = never mirror, "left" = always mirror (live mode: the user says which)."""
    points, presence = normalize(raw)
    if fs == "feat2dom":
        flip = left_dominant(points, presence) if dominant is None else dominant == "left"
        if flip:
            points, presence = mirror(points, presence)
    return points, presence


def _hand_shape(p, present):
    """(16, 21, 3) shoulder-normalized hand -> wrist-relative, hand-size-scaled (16, 63)."""
    size = np.linalg.norm(p[:, MIDDLE_MCP, :2] - p[:, WRIST, :2], axis=1)
    ok = (present > 0) & (size > 1e-6)
    local = np.zeros_like(p)
    local[ok] = (p[ok] - p[ok, WRIST][:, None, :]) / size[ok][:, None, None]
    return local.reshape(len(p), -1)


def _wrist_velocity(wrist_xy, present):
    """Frame-to-frame x/y change of one wrist; 0 when the hand is missing in either frame."""
    v = np.zeros_like(wrist_xy)
    both = (present[1:] > 0) & (present[:-1] > 0)
    v[1:][both] = np.diff(wrist_xy, axis=0)[both]
    return v


def to_feature(points, presence, times=None, fs="feat1"):
    """Resample to N_FRAMES and flatten. `times` are positions in [0, 1] along the clip
    (default: evenly spaced). Nearest-frame sampling, so a missing hand's zeros never get
    blended with real coordinates. fs = feature set (see above)."""
    if times is None:
        times = np.linspace(0, 1, N_FRAMES)
    idx = np.clip(np.round(np.asarray(times) * (len(points) - 1)).astype(int), 0, len(points) - 1)
    p, pr = points[idx], presence[idx]
    parts = [p.reshape(N_FRAMES, -1), pr]
    if fs != "feat1":
        parts += [_hand_shape(p[:, LH], pr[:, 0]), _hand_shape(p[:, RH], pr[:, 1]),
                  _wrist_velocity(p[:, WRIST, :2], pr[:, 0]), _wrist_velocity(p[:, 21 + WRIST, :2], pr[:, 1])]
    return np.concatenate(parts, axis=1).ravel().astype(np.float32)


def features_from_raw(raw, fs="feat1", dominant=None):
    """THE shared feature function: raw landmarks -> feature vector for feature set `fs`."""
    return to_feature(*prepare(raw, fs, dominant), fs=fs)


def features_from_video(path, fs="feat1"):
    return features_from_raw(video_to_raw(path), fs)
