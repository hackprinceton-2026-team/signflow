"""Test the LIVE model (models/sign_model.joblib) on your webcam clips. No training, no tuning.

    python src/eval_webcam.py [--runs 3] [--folder data/webcam]

Runs `python src/predict_video.py <clip>` as a fresh process --runs times per clip (MediaPipe
gives slightly different landmarks run to run), then prints:
  - per clip: true sign, predicted sign (majority over runs), mean / min / max confidence of the
    top sign, and how many runs passed CONF_THRESHOLD
  - per sign: clips correct, and what each sign was confused with
True sign = filename prefix (STOP-20261114-201500.mp4 -> STOP).
"""
import argparse
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

from config import CONF_THRESHOLD

PREDICT = Path(__file__).resolve().parent / "predict_video.py"


def run_once(clip):
    out = subprocess.run([sys.executable, str(PREDICT), str(clip)], capture_output=True, text=True)
    result = json.loads(out.stdout.strip().splitlines()[-1])
    if result.get("error"):
        return None, 0.0, result["error"]
    return result.get("best_guess", result["sign"]), result["confidence"], None   # top sign, its confidence


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--folder", type=Path, default=Path("data/webcam"))
    args = ap.parse_args()
    clips = sorted(args.folder.glob("*.mp4"))
    if not clips:
        sys.exit(f"No clips in {args.folder}/ - record some with src/record_webcam.py")

    print(f"Live model on {len(clips)} clips, {args.runs} runs each, threshold {CONF_THRESHOLD}\n")
    print(f"{'clip':<28}{'true':<10}{'predicted':<11}{'mean':>6}{'min':>6}{'max':>6}  {'passed 0.5':<11}{'runs (sign conf)'}")
    per_sign = defaultdict(lambda: dict(correct=0, total=0, confused=Counter()))
    for clip in clips:
        true = clip.stem.split("-")[0].upper()
        runs = [run_once(clip) for _ in range(args.runs)]
        errors = [e for _, _, e in runs if e]
        ok_runs = [(s, c) for s, c, e in runs if not e]
        if not ok_runs:
            print(f"{clip.name:<28}{true:<10}ERROR: {errors[0]}")
            per_sign[true]["total"] += 1
            per_sign[true]["confused"]["(error)"] += 1
            continue
        pred = Counter(s for s, _ in ok_runs).most_common(1)[0][0]       # majority over runs
        confs = [c for s, c in ok_runs if s == pred]
        passed = sum(c >= CONF_THRESHOLD for s, c in ok_runs if s == pred)
        flips = "" if len({s for s, _ in ok_runs}) == 1 else "  <- prediction changed between runs"
        detail = ", ".join(f"{s} {c:.2f}" for s, c in ok_runs)
        print(f"{clip.name:<28}{true:<10}{pred:<11}{sum(confs) / len(confs):>6.2f}{min(confs):>6.2f}{max(confs):>6.2f}"
              f"  {passed}/{len(ok_runs):<9}{detail}{flips}", flush=True)
        per_sign[true]["total"] += 1
        if pred == true:
            per_sign[true]["correct"] += 1
        else:
            per_sign[true]["confused"][pred] += 1

    print("\nPer sign (majority prediction per clip):")
    for sign, r in sorted(per_sign.items()):
        conf = ", ".join(f"{k} x{v}" for k, v in r["confused"].most_common()) or "-"
        print(f"  {sign:<10} {r['correct']}/{r['total']} correct   confused with: {conf}")
    print("\nThese are your own clips, never used for training or model selection.")


if __name__ == "__main__":
    main()
