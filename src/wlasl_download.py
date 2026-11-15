"""Download only the manifest's videos from Kaggle (needs a Kaggle API token in ~/.kaggle).

    python src/wlasl_download.py [--manifest data/wlasl/manifest.csv]

Saves to data/wlasl/videos/<video_id>.mp4 and skips files that already exist.
"""
import argparse
import csv
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

DATASET = "risangbaskoro/wlasl-processed"
OUT_DIR = Path("data/wlasl/videos")
KAGGLE = Path(sys.executable).parent / "kaggle"       # the CLI installed in this venv


def download(video_id):
    """Fetch videos/<id>.mp4 into a temp folder, then move it to OUT_DIR/<id>.mp4.
    Depending on the Kaggle CLI version the file may arrive inside a videos/ subfolder
    and/or as a .zip, so we search the temp folder for it."""
    target = OUT_DIR / f"{video_id}.mp4"
    tmp = OUT_DIR / "_tmp"
    tmp.mkdir(exist_ok=True)
    cmd = [str(KAGGLE), "datasets", "download", DATASET, "-f", f"videos/{video_id}.mp4",
           "-p", str(tmp), "-q"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    for f in tmp.rglob(f"{video_id}.mp4*"):
        if f.suffix == ".zip":
            with zipfile.ZipFile(f) as z:
                target.write_bytes(z.read(z.namelist()[0]))
            f.unlink()
        else:
            f.rename(target)
    if not target.exists() or target.stat().st_size == 0:
        lines = (proc.stderr + proc.stdout).strip().splitlines()
        return [line for line in lines if "rror" in line][-1:] or lines[-1:] or ["no file created"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="data/wlasl/manifest.csv", type=Path)
    args = ap.parse_args()
    rows = list(csv.DictReader(open(args.manifest)))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    done = skipped = 0
    failed = []
    for n, row in enumerate(rows, 1):
        vid = row["video_id"]
        prefix = f"[{n:>3}/{len(rows)}] {vid} {row['gloss']:<10}"
        if (OUT_DIR / f"{vid}.mp4").exists():
            skipped += 1
            print(f"{prefix} already there", flush=True)
            continue
        error = download(vid)
        if error:
            failed.append(vid)
            print(f"{prefix} FAILED: {error[0]}", flush=True)
        else:
            done += 1
            print(f"{prefix} ok ({(OUT_DIR / f'{vid}.mp4').stat().st_size / 1e6:.1f} MB)", flush=True)

    shutil.rmtree(OUT_DIR / "_tmp", ignore_errors=True)
    print(f"\nDownloaded {done}, already present {skipped}, failed {len(failed)}")
    if failed:
        print("Failed ids:", " ".join(failed))


if __name__ == "__main__":
    main()
