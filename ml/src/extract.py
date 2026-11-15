"""Run videos through MediaPipe (features.py) and save raw per-frame landmarks.

Two kinds of input, each saved as its own *source* so they never get mixed up:

    python src/extract.py --manifest data/wlasl/manifest.csv          # source "wlasl" (frozen v2 data)
    python src/extract.py --manifest m.csv --source wlasl_vocab --reuse data/landmarks/wlasl
    python src/extract.py --folder videos --source clips              # your 13 phone clips
    python src/extract.py --folder data/webcam --source webcam        # your webcam recordings

Output: data/landmarks/<source>/<LABEL>/<video>.npy   (shape (frames, 138), see features.py)
        data/landmarks/<source>/index.csv             one row per video, incl. dropped ones
A video is kept when, between its first and last frame with a hand, a hand is detected in
>= 80% of frames (idle hands-down frames at start/end don't count against it), it has at least
8 hand frames, and shoulders are found. Otherwise it is marked kept=0 in index.csv and not used for
training/eval (landmarks are still saved, so the threshold can be revisited without re-running
MediaPipe). in-sign% = hand rate between the first and last frame with a hand.
Caching: a video whose .npy already exists in the output (or in a --reuse folder: same pipeline)
is not re-extracted, and each .npy is written atomically, so a run can be interrupted (Ctrl-C) and
simply rerun to resume. index.csv is rebuilt from all videos at the end.
"""
import argparse
import csv
import os
import re
import shutil
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np

from augment import SKIP_LABELS
from features import video_to_raw

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".webm"}
LANDMARK_ROOT = Path("data/landmarks")
WLASL_VIDEOS = Path("data/wlasl/videos")
MIN_IN_SIGN_RATE = 0.8      # hand rate between first and last hand frame
MIN_HAND_FRAMES = 8
INDEX_FIELDS = ["video", "label", "split", "signer_id", "frames", "hand_rate", "hand_rate_in_sign", "kept"]


def to_label(name):
    """'thank you' -> THANKYOU, help_2 -> HELP. One label format for every source."""
    return re.sub(r"[^A-Z0-9]", "", re.sub(r"_\d+$", "", name).upper())


def jobs_from_manifest(manifest):
    jobs = []
    for r in csv.DictReader(open(manifest)):
        path = WLASL_VIDEOS / f"{r['video_id']}.mp4"
        if not path.exists():
            print(f"  missing file, run wlasl_download.py: {path}")
            continue
        jobs.append(dict(path=path, video=r["video_id"], label=to_label(r["gloss"]), split=r["split"],
                         signer_id=r["signer_id"], start=int(r["frame_start"]), end=int(r["frame_end"])))
    return jobs


def jobs_from_folder(folder, source):
    """Own recordings: label from the filename prefix (HELP_3.mp4 -> HELP). The whole
    source counts as one signer, and split 'own' marks it as never-trained-on."""
    jobs = []
    for path in sorted(p for p in Path(folder).iterdir() if p.suffix.lower() in VIDEO_EXTS):
        label = to_label(path.stem.split("-")[0])
        if label in SKIP_LABELS:
            print(f"  skipped {path.name} ({label} is in SKIP_LABELS, src/augment.py)")
            continue
        jobs.append(dict(path=path, video=path.stem, label=label, split="own",
                         signer_id=source, start=1, end=-1))
    return jobs


def run(job):
    """Extract one video and save it atomically (tmp file + rename). Runs in a worker process."""
    raw = video_to_raw(job["path"], job["start"], job["end"])
    f = Path(job["out"])
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(f".tmp{os.getpid()}")
    with open(tmp, "wb") as fh:
        np.save(fh, raw)
    os.replace(tmp, f)
    return job


def stats(raw):
    hands = (raw[:, 135] + raw[:, 136]) > 0
    hand_rate = float(hands.mean()) if len(raw) else 0.0
    span = np.flatnonzero(hands)        # rate between first and last hand frame: ignores idle start/end
    in_sign = float(hands[span[0]:span[-1] + 1].mean()) if len(span) else 0.0
    kept = in_sign >= MIN_IN_SIGN_RATE and hands.sum() >= MIN_HAND_FRAMES and bool(raw[:, 137].any())
    return hand_rate, in_sign, kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", type=Path, help="WLASL manifest from wlasl_select.py")
    ap.add_argument("--folder", type=Path, help="folder of your own videos")
    ap.add_argument("--source", help="output name: required for --folder; for --manifest default 'wlasl'")
    ap.add_argument("--reuse", type=Path, action="append", default=[],
                    help="landmark folder(s) from the same pipeline to copy cached videos from")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--quiet", action="store_true", help="progress lines instead of one line per video")
    args = ap.parse_args()
    if bool(args.manifest) == bool(args.folder) or (args.folder and not args.source):
        ap.error("use either --manifest, or --folder together with --source")

    source = args.source or "wlasl"
    jobs = jobs_from_manifest(args.manifest) if args.manifest else jobs_from_folder(args.folder, source)
    out_dir = LANDMARK_ROOT / source
    todo, reused = [], 0
    for job in jobs:
        job["out"] = str(out_dir / job["label"] / f"{job['video']}.npy")
        if Path(job["out"]).exists():
            continue
        cached = next((d / job["label"] / f"{job['video']}.npy" for d in args.reuse
                       if (d / job["label"] / f"{job['video']}.npy").exists()), None)
        if cached:
            Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cached, job["out"])
            reused += 1
        else:
            todo.append(job)
    print(f"Source '{source}': {len(jobs)} videos -> {out_dir}/  ({len(jobs) - len(todo) - reused} cached, "
          f"{reused} reused, {len(todo)} to extract with {args.workers} workers)\n", flush=True)

    t0 = time.time()
    if todo:
        with Pool(args.workers) as pool:
            for n, job in enumerate(pool.imap_unordered(run, todo), 1):
                if not args.quiet or n % 25 == 0 or n == len(todo):
                    rate = n / (time.time() - t0)
                    print(f"  [{n}/{len(todo)}] {job['video']} {job['label']}   {rate:.2f} videos/s, "
                          f"~{(len(todo) - n) / rate / 60:.1f} min left", flush=True)
    elapsed = time.time() - t0

    rows, dropped = [], []
    for job in jobs:
        raw = np.load(job["out"])
        hand_rate, in_sign, kept = stats(raw)
        if not kept:
            dropped.append(job)
        rows.append(dict(video=job["video"], label=job["label"], split=job["split"],
                         signer_id=job["signer_id"], frames=len(raw), hand_rate=round(hand_rate, 3),
                         hand_rate_in_sign=round(in_sign, 3), kept=int(kept)))
        if not args.quiet:
            note = "" if kept else "  <-- DROPPED (in-sign hand < 80%, < 8 hand frames, or no pose)"
            print(f"{job['video']:<16}{job['label']:<10}{job['split']:<7}{len(raw):>7}{hand_rate:>8.0%}"
                  f"{in_sign:>9.0%}{note}")

    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "index.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=INDEX_FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nKept {len(rows) - len(dropped)} / {len(rows)} videos. Index: {out_dir / 'index.csv'}")
    if todo:
        print(f"Extracted {len(todo)} videos in {elapsed:.0f}s = {elapsed / len(todo):.2f} s/video with "
              f"{args.workers} workers")
    if dropped:
        by_label = {}
        for j in dropped:
            by_label[j["label"]] = by_label.get(j["label"], 0) + 1
        print("Dropped per label:", ", ".join(f"{k} {v}" for k, v in sorted(by_label.items())))


if __name__ == "__main__":
    main()
