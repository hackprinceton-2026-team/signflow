"""Settings shared by the live/predict/record scripts. Change them here only."""

# Below this top-1 confidence the scripts answer "?" (live.py: shows "?" and sends nothing).
# From held-out-signer cross-validation of v2_rf_feat2dom: at 0.5, 78% of predictions are
# shown and 97.8% of the shown ones are correct (models/v2_rf_feat2dom.json, "thresholds").
CONF_THRESHOLD = 0.5

# Mirror the on-screen webcam preview (feels like a mirror). This only affects what you SEE:
# the model and the saved recordings always get the original, unmirrored camera frames,
# matching the orientation of the WLASL training videos.
MIRROR_PREVIEW = True

# ---- live sign segmentation (hands-down rule), used by live.py and live_test.py ----
# Heights are in shoulder widths below the shoulder line (0 = shoulders, + = lower).
# A hand is "up" when its wrist is above HAND_UP_Y (about mid-chest). Measured on the data:
# 90% of WLASL clips raise a wrist above 0.42 during the sign; your webcam signs reach -0.46.
HAND_UP_Y = 0.6
END_FRAMES = 8              # no hand up for this many frames -> the sign has ended
MIN_SEGMENT_FRAMES = 10     # shorter segments (first to last hand-up frame) are ignored
MAX_SEGMENT_FRAMES = 150    # safety cut (~5 s at 30 fps) if hands never go down
PREROLL_FRAMES = 5          # frames kept from before the hand rose, so the sign's start is included
SENTENCE_PAUSE_S = 1.5      # no hand up this long after >= 1 sign -> end_of_sentence

# Spacebar fallback mode
COUNTDOWN_SECONDS = 1.0
RECORD_SECONDS = 2.5

# WebSocket output
WS_HOST, WS_PORT = "localhost", 8765
