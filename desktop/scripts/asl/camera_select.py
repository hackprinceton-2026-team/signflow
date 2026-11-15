"""Which camera the SignFlow recognizer launcher opens (macOS-aware, no OpenCV import).

Names come from AVFoundation, but OpenCV only takes an index, and its index order is
NOT reliably AVFoundation's list order: on the test MacBook Air, AVFoundation listed the
built-in camera first while OpenCV index 0 was the iPhone Continuity Camera. So the
index is never assumed. It is VERIFIED physically (locate_index): every camera has a
set of capture formats; a format only the wanted camera supports (the MacBook Air's
1552x1552, for instance) is requested from each OpenCV index in turn, and only the
right camera can deliver it. One camera is open at a time. If no such format exists,
nothing is guessed: --camera N is required.

Order of preference:
  1. --camera N        (explicit; always wins)
  2. --camera-name X   (explicit; first camera whose name contains X, case-insensitive)
  3. the built-in camera (AVCaptureDeviceTypeBuiltInWideAngleCamera / built-in transport)
  4. any other non-iPhone camera
  5. an iPhone Continuity Camera
If the devices can't be listed (no pyobjc), nothing is guessed: index 0 is used only
with a warning that says to pass --camera N.
"""
from dataclasses import dataclass
import re

BUILTIN_TYPE = "AVCaptureDeviceTypeBuiltInWideAngleCamera"
CONTINUITY_TYPE = "AVCaptureDeviceTypeContinuityCamera"
TRANSPORT_BUILTIN = 0x626C746E  # 'bltn'
BUILTIN_NAME = re.compile(r"\b(macbook|facetime|built-?in)\b", re.I)
IPHONE = re.compile(r"iphone|ipad|continuity", re.I)


@dataclass(frozen=True)
class Camera:
    index: int  # OpenCV's index for this device
    name: str
    model: str = ""
    device_type: str = ""
    transport: int = 0
    #: Capture sizes the device supports, (width, height).
    formats: frozenset = frozenset()

    @property
    def builtin(self) -> bool:
        if self.device_type == BUILTIN_TYPE or self.transport == TRANSPORT_BUILTIN:
            return True
        return bool(BUILTIN_NAME.search(self.name)) and not self.continuity

    @property
    def continuity(self) -> bool:
        return self.device_type == CONTINUITY_TYPE or bool(IPHONE.search(self.name) or IPHONE.search(self.model))

    @property
    def kind(self) -> str:
        return "built-in" if self.builtin else "iPhone" if self.continuity else "external"


@dataclass(frozen=True)
class Choice:
    index: int
    camera: "Camera | None"
    how: str  # explicit-index | explicit-name | automatic | unidentified
    note: str


def unique_format(target, cameras):
    """A capture size only `target` supports (the largest such), or None."""
    others = set().union(*(c.formats for c in cameras if c is not target)) if len(cameras) > 1 else set()
    mine = sorted(target.formats - others, key=lambda wh: wh[0] * wh[1], reverse=True)
    return mine[0] if mine else None


def locate_index(target, cameras, probe, max_index=None):
    """OpenCV's index for `target`, verified with probe(index, (w, h)) -> delivered (w, h) or None
    (which opens index, requests that size, reads a frame and releases it). The index
    AVFoundation suggests is tried first. Returns None if it can't be verified."""
    if len(cameras) == 1:
        return 0  # only one camera: nothing to confuse it with
    fmt = unique_format(target, cameras)
    if fmt is None:
        return None
    n = max_index if max_index is not None else len(cameras)
    for index in [target.index] + [i for i in range(n) if i != target.index]:
        if probe(index, fmt) == fmt:
            return index
    return None


def list_cameras():
    """Cameras in OpenCV's index order, or None if they can't be listed (not macOS, no pyobjc)."""
    try:
        import AVFoundation as AV  # pyobjc-framework-AVFoundation
    except Exception:
        return None
    devices = list(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo))
    devices += list(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeMuxed))
    try:
        import CoreMedia as CM

        def formats(d):
            dims = (CM.CMVideoFormatDescriptionGetDimensions(f.formatDescription()) for f in d.formats())
            return frozenset((int(x.width), int(x.height)) for x in dims)
    except Exception:
        def formats(d):
            return frozenset()
    return [
        Camera(index=i, name=str(d.localizedName()), model=str(d.modelID() or ""),
               device_type=str(d.deviceType() or ""), transport=int(d.transportType() or 0), formats=formats(d))
        for i, d in enumerate(devices)
    ]


def choose_camera(cameras, explicit_index=None, name_query=None) -> Choice:
    """Pick the camera to open. `cameras` is list_cameras()'s result (None = unknown).
    Raises ValueError for an explicit choice that doesn't exist, or when no camera exists."""
    if explicit_index is not None:
        if cameras is not None and not 0 <= explicit_index < len(cameras):
            raise ValueError(f"no camera {explicit_index}; there are {len(cameras)}: {describe(cameras)}")
        # No name: AVFoundation's order isn't OpenCV's, so the name at that position may be wrong.
        return Choice(explicit_index, None, "explicit-index", "chosen with --camera")
    if name_query:
        if cameras is None:
            raise ValueError("--camera-name needs the camera list (pip install pyobjc-framework-AVFoundation); use --camera N")
        cam = next((c for c in cameras if name_query.lower() in c.name.lower()), None)
        if cam is None:
            raise ValueError(f"no camera matches {name_query!r}; available: {describe(cameras)}")
        return Choice(cam.index, cam, "explicit-name", f"chosen with --camera-name {name_query!r}")
    if cameras is None:
        return Choice(0, None, "unidentified",
                      "cameras can't be identified (install pyobjc-framework-AVFoundation); using index 0. "
                      "It may be an iPhone: pass --camera N to choose")
    if not cameras:
        raise ValueError("no camera found")
    for pick, note in (
        (lambda c: c.builtin, "built-in camera preferred"),
        (lambda c: not c.continuity, "no built-in camera; using an external camera"),
        (lambda c: True, "no built-in camera; falling back to the iPhone"),
    ):
        cam = next((c for c in cameras if pick(c)), None)
        if cam:
            return Choice(cam.index, cam, "automatic", note)
    raise ValueError("no camera found")  # unreachable


def describe(cameras) -> str:
    return ", ".join(f"{c.index}: {c.name} ({c.kind})" for c in cameras) or "none"
