"""Make an approved, versioned model the live one (the ONLY way sign_model.joblib changes).

    python src/approve_model.py models/v2_svm_feat2.joblib

Copies it to models/sign_model.joblib (loaded by predict_video.py / predict_webcam.py).
The previous sign_model.joblib is first kept as models/sign_model.replaced-<timestamp>.joblib.
"""
import filecmp
import shutil
import sys
import time
from pathlib import Path

import joblib

LIVE = Path("models/sign_model.joblib")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python src/approve_model.py models/<version>_<model>_<features>.joblib")
    src = Path(sys.argv[1])
    bundle = joblib.load(src)                       # fail early if it is not a model bundle
    if LIVE.exists() and filecmp.cmp(LIVE, src, shallow=False):
        print(f"{src.name} is already the live model (byte-identical) - nothing to back up or copy")
        return
    if LIVE.exists():
        backup = LIVE.with_name(f"sign_model.replaced-{time.strftime('%Y%m%d-%H%M%S')}.joblib")
        shutil.copy2(LIVE, backup)
        print(f"previous live model kept as {backup}")
    shutil.copy2(src, LIVE)
    print(f"live model is now {src.name}: {bundle.get('version')} {bundle['model_name']} "
          f"features={bundle.get('features', 'feat1')}")


if __name__ == "__main__":
    main()
