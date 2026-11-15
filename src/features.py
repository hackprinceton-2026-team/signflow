"""Shared feature code. Every script (extract, augment, train, predict) uses this file.

Two stages:
  1. video_to_raw(path)      -> raw per-frame landmarks, shape (T, RAW_DIM), pixel units
  2. features_from_raw(raw)  -> one fixed-length feature vector, shape (FEATURE_DIM,)

Raw frame layout (RAW_DIM = 160; files extracted before v5 have only the first 138 columns,
and every feature set except feat3 reads only those, so old and new files give identical features):
  [0:63]    left hand, 21 points x (x, y, z)
  [63:126]  right hand, 21 points x (x, y, z)
  [126:135] pose: nose, left shoulder, right shoulder x (x, y, z)
  [135]     left hand present (0/1)
  [136]     right hand present (0/1)
  [137]     pose present (0/1)
  [138:159] face mesh (v5): nose tip, chin, mouth corner x2, cheek x2, forehead x (x, y, z)
  [159]     face present (0/1)
x, y, z are in pixels (x * width, y * height, z * width) so the image aspect ratio
(portrait phone vs landscape webcam) doesn't distort the shapes.
"""
import os

os.environ.setdefault("GLOG_minloglevel", "2")       # quiet MediaPipe C++ logs
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import cv2
import mediapipe as mp
import numpy as np

N_FRAMES = 16                      # every clip is resampled to this many frames (feat3 can use 32)
N_POINTS = 21 + 21 + 3             # left hand, right hand, nose + 2 shoulders
RAW_DIM_V4 = N_POINTS * 3 + 3      # 138: the layout up to v4
FACE_IDS = [1, 152, 61, 291, 50, 280, 10]   # face mesh: nose tip, chin, mouth corners, cheeks, forehead
N_FACE = len(FACE_IDS)
RAW_DIM = RAW_DIM_V4 + N_FACE * 3 + 1        # 160
FRAME_DIM = N_POINTS * 3 + 2       # normalized points + 2 hand-present flags
FEATURE_DIM = N_FRAMES * FRAME_DIM

POSE_IDS = [0, 11, 12]             # MediaPipe pose: nose, left shoulder, right shoulder
LH, RH, POSE = slice(0, 21), slice(21, 42), slice(42, 45)
FACE = slice(45, 45 + N_FACE)      # feat3 only: face points appended after the 45 body points

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
    if res.face_landmarks:
        row[138:159] = _points(res.face_landmarks.landmark, FACE_IDS, w, h).ravel()
        row[159] = 1
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


def body_frame(raw):
    """(center xy, shoulder width) in pixels: clip median over frames with a pose."""
    has_pose = raw[:, 137] > 0
    if not has_pose.any():
        raise ValueError("No body pose (shoulders) detected in any frame")
    pose = raw[has_pose, 126:135].reshape(-1, 3, 3)
    l_sh, r_sh = np.median(pose[:, 1], axis=0), np.median(pose[:, 2], axis=0)
    width = np.linalg.norm(l_sh[:2] - r_sh[:2])
    if width < 1e-6:
        raise ValueError("Shoulder width is zero")
    return (l_sh[:2] + r_sh[:2]) / 2, width


def normalize(raw):
    """Keep only frames with at least one hand, then center on the shoulder midpoint and
    scale by shoulder width. Returns points (T', 45, 3) and presence (T', 2).
    Center/width are the clip median over frames with a pose (the body barely moves,
    and the median ignores single-frame pose glitches)."""
    raw = np.asarray(raw, dtype=np.float32)
    has_hand = (raw[:, 135] + raw[:, 136]) > 0
    if not has_hand.any():
        raise ValueError("No hands detected in any frame")
    center, width = body_frame(raw)

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
FEATURE_SETS = ("feat1", "feat2", "feat2dom", "feat3")
WRIST, MIDDLE_MCP = 0, 9
_MIRROR_ORDER = list(range(21, 42)) + list(range(0, 21)) + [42, 44, 43]   # swap hands + shoulders
_MIRROR_ORDER_FACE = _MIRROR_ORDER + [45, 46, 48, 47, 50, 49, 51]         # + swap mouth corners, cheeks

# feat3 (v5) = feat2dom (267 values / frame) plus, per frame:
#   per hand (2 x 71): 15 finger joint angles + 4 finger spread angles (3D, angle / pi),
#                      10 fingertip-to-fingertip distances (3D, / hand size),
#                      42 = 2D distances of wrist + 5 fingertips to the 7 face points
#                      (nose tip, chin, 2 mouth corners, 2 cheeks, forehead), in shoulder widths
#   wrist acceleration (2 x 2), two-hand distances (3: wrist-wrist, dominant index / middle
#   fingertip to the other palm center).  Hand z is wrist-relative in MediaPipe, so it is only
#   used inside a hand (angles, fingertip distances), never against the face.
# Face points are the clip median over frames with a face (stable when a hand covers the face);
# without any face frame they are estimated from the pose nose + FACE_OFFSETS.
FRAME_DIMS = {"feat1": FRAME_DIM, "feat2": FRAME_DIM + 126 + 4, "feat2dom": FRAME_DIM + 126 + 4,
              "feat3": FRAME_DIM + 126 + 4 + 2 * 71 + 4 + 3}
TIPS = [4, 8, 12, 16, 20]
_J = np.array([(0, 1, 2), (1, 2, 3), (2, 3, 4), (0, 5, 6), (5, 6, 7), (6, 7, 8), (0, 9, 10), (9, 10, 11),
               (10, 11, 12), (0, 13, 14), (13, 14, 15), (14, 15, 16), (0, 17, 18), (17, 18, 19), (18, 19, 20)])
_SPREAD = np.array([(1, 4, 5, 8), (5, 8, 9, 12), (9, 12, 13, 16), (13, 16, 17, 20)])   # finger direction pairs
_TIP_I, _TIP_J = np.triu_indices(5, k=1)
_PALM = [0, 5, 9, 13, 17]
# face point offsets (x, y) from the pose nose in shoulder widths: median over 964 v5 WLASL clips
# (every clip had face frames; face found in 99.6% of frames). Used only when a clip has no face.
FACE_OFFSETS = np.array([[-0.010, 0.018, 0], [0.001, 0.273, 0], [-0.083, 0.122, 0], [0.078, 0.115, 0],
                         [-0.163, 0.007, 0], [0.151, -0.005, 0], [-0.013, -0.290, 0]], np.float32)


def mirror(points, presence):
    """Horizontal flip of a normalized clip: x -> -x, left <-> right hand, left <-> right shoulder
    (and, with face points, left <-> right mouth corner / cheek)."""
    p = points[:, _MIRROR_ORDER_FACE if points.shape[1] > N_POINTS else _MIRROR_ORDER].copy()
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


def face_points(raw):
    """(7, 3) face points in the normalized body frame (see the feat3 note above)."""
    raw = np.asarray(raw, dtype=np.float32)
    center, width = body_frame(raw)
    if raw.shape[1] >= RAW_DIM and (raw[:, 159] > 0).any():
        f = np.median(raw[raw[:, 159] > 0, 138:159].reshape(-1, N_FACE, 3), axis=0)
        f[:, :2] -= center
        f[:, 2] -= f[0, 2]                     # z relative to the nose tip (z is unused anyway)
        return (f / width).astype(np.float32)
    pose = raw[raw[:, 137] > 0, 126:129]
    nose = np.median(pose, axis=0)
    nose[:2] -= center
    nose /= width
    nose[2] = 0
    return (nose + FACE_OFFSETS).astype(np.float32)


def prepare(raw, fs="feat1", dominant=None):
    """normalize(), plus dominant-hand mirroring for feat2dom / feat3 (feat3 also appends the 7
    face points as points 45..51 of every frame, so augmentation moves them with the body).
    dominant: None = guess per clip (the hand whose wrist moves more; used in training/eval),
              "right" = never mirror, "left" = always mirror (live mode: the user says which)."""
    points, presence = normalize(raw)
    if fs == "feat3":
        face = np.broadcast_to(face_points(raw), (len(points), N_FACE, 3))
        points = np.concatenate([points, face], axis=1)
    if fs in ("feat2dom", "feat3"):
        flip = left_dominant(points, presence) if dominant is None else dominant == "left"
        if flip:
            points, presence = mirror(points, presence)
    return points, presence


def _hand_shape(p, present):
    """(F, 21, 3) shoulder-normalized hand -> wrist-relative, hand-size-scaled (F, 63)."""
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


def _wrist_acceleration(wrist_xy, present):
    """Change of velocity over three consecutive frames; 0 unless the hand is in all three."""
    a = np.zeros_like(wrist_xy)
    ok = (present[2:] > 0) & (present[1:-1] > 0) & (present[:-2] > 0)
    a[2:][ok] = (wrist_xy[2:] - 2 * wrist_xy[1:-1] + wrist_xy[:-2])[ok]
    return a


def _angle(u, v):
    cos = (u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1) + 1e-9)
    return np.arccos(np.clip(cos, -1, 1)) / np.pi


def _hand_extras(hand, present, face):
    """(F, 21, 3) hand, (F,) present, (F, 7, 3) face -> (F, 71): angles, fingertip distances, face distances."""
    out = np.zeros((len(hand), 71), np.float32)
    size = np.linalg.norm(hand[:, MIDDLE_MCP, :2] - hand[:, WRIST, :2], axis=1)
    ok = (present > 0) & (size > 1e-6)
    if not ok.any():
        return out
    h, f = hand[ok], face[ok]
    joints = _angle(h[:, _J[:, 0]] - h[:, _J[:, 1]], h[:, _J[:, 2]] - h[:, _J[:, 1]])           # 15
    spread = _angle(h[:, _SPREAD[:, 1]] - h[:, _SPREAD[:, 0]], h[:, _SPREAD[:, 3]] - h[:, _SPREAD[:, 2]])  # 4
    tips = h[:, TIPS]
    tipdist = np.linalg.norm(tips[:, _TIP_I] - tips[:, _TIP_J], axis=-1) / size[ok][:, None]      # 10
    pts = h[:, [WRIST] + TIPS, :2]
    facedist = np.linalg.norm(pts[:, :, None] - f[:, None, :, :2], axis=-1).reshape(len(h), -1)  # 42
    out[ok] = np.concatenate([joints, spread, tipdist, facedist], axis=1)
    return out


def _two_hands(p, pr):
    """(F, 3): wrist-wrist distance, dominant (right slot) index / middle tip to the other palm center."""
    out = np.zeros((len(p), 3), np.float32)
    ok = (pr[:, 0] > 0) & (pr[:, 1] > 0)
    if ok.any():
        left, right = p[ok][:, LH, :2], p[ok][:, RH, :2]
        palm = left[:, _PALM].mean(axis=1)
        out[ok] = np.stack([np.linalg.norm(right[:, WRIST] - left[:, WRIST], axis=1),
                            np.linalg.norm(right[:, 8] - palm, axis=1),
                            np.linalg.norm(right[:, 12] - palm, axis=1)], axis=1)
    return out


def to_feature(points, presence, times=None, fs="feat1", n_frames=N_FRAMES):
    """Resample to n_frames and flatten. `times` are positions in [0, 1] along the clip
    (default: evenly spaced). Nearest-frame sampling, so a missing hand's zeros never get
    blended with real coordinates. fs = feature set (see above)."""
    if times is None:
        times = np.linspace(0, 1, n_frames)
    idx = np.clip(np.round(np.asarray(times) * (len(points) - 1)).astype(int), 0, len(points) - 1)
    p, pr = points[idx], presence[idx]
    n = len(idx)
    parts = [p[:, :N_POINTS].reshape(n, -1), pr]
    if fs != "feat1":
        parts += [_hand_shape(p[:, LH], pr[:, 0]), _hand_shape(p[:, RH], pr[:, 1]),
                  _wrist_velocity(p[:, WRIST, :2], pr[:, 0]), _wrist_velocity(p[:, 21 + WRIST, :2], pr[:, 1])]
    if fs == "feat3":
        face = p[:, FACE]
        parts += [_hand_extras(p[:, LH], pr[:, 0], face), _hand_extras(p[:, RH], pr[:, 1], face),
                  _wrist_acceleration(p[:, WRIST, :2], pr[:, 0]), _wrist_acceleration(p[:, 21 + WRIST, :2], pr[:, 1]),
                  _two_hands(p, pr)]
    return np.concatenate(parts, axis=1).ravel().astype(np.float32)


def features_from_raw(raw, fs="feat1", dominant=None, n_frames=N_FRAMES):
    """THE shared feature function: raw landmarks -> feature vector for feature set `fs`."""
    return to_feature(*prepare(raw, fs, dominant), fs=fs, n_frames=n_frames)


def features_from_video(path, fs="feat1", n_frames=N_FRAMES):
    return features_from_raw(video_to_raw(path), fs, n_frames=n_frames)
