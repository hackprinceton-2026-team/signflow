"""Download only the manifest's videos from Kaggle (needs a Kaggle API token in ~/.kaggle).

    python src/wlasl_download.py [--manifest data/wlasl/manifest.csv] [--workers 4]

Saves to data/wlasl/videos/<video_id>.mp4 and skips files that already exist (rerun = resume).
Kaggle rate-limits per-file API calls; 429 errors are retried with back-off.

    python src/wlasl_download.py --manifest m.csv --bulk     # for large manifests
--bulk downloads the dataset archive ONCE (5.2 GB, a single API call - per-file downloads get
rate-limited after ~80 calls), unpacks only the manifest's videos, then deletes the archive
(--keep-archive to keep it). Interrupted? Rerun: present videos are skipped.
"""
import argparse
import csv
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import zipfile
from pathlib import Path

DATASET = "risangbaskoro/wlasl-processed"
OUT_DIR = Path("data/wlasl/videos")
KAGGLE = Path(sys.executable).parent / "kaggle"       # the CLI installed in this venv
MAX_TRIES = 6          # on HTTP 429/404 (rate limiting): back off 30 s, 60 s, 120 s, ... and retry


def download(video_id):
    """Fetch videos/<id>.mp4 into a temp folder, then move it to OUT_DIR/<id>.mp4.
    Depending on the Kaggle CLI version the file may arrive inside a videos/ subfolder
    and/or as a .zip, so we search the temp folder for it."""
    target = OUT_DIR / f"{video_id}.mp4"
    tmp = OUT_DIR / "_tmp" / video_id               # one temp folder per video: safe in parallel
    tmp.mkdir(parents=True, exist_ok=True)
    cmd = [str(KAGGLE), "datasets", "download", DATASET, "-f", f"videos/{video_id}.mp4",
           "-p", str(tmp), "-q"]
    for attempt in range(MAX_TRIES):                # Kaggle rate-limits per-file calls (HTTP 429)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        out = proc.stderr + proc.stdout
        if not ("429" in out or "404" in out) or any(tmp.rglob(f"{video_id}.mp4*")):
            break
        time.sleep(min(30 * 2 ** attempt, 300))
    for f in tmp.rglob(f"{video_id}.mp4*"):
        if f.suffix == ".zip":
            part = target.with_suffix(".part")      # write + rename: never a half file at target
            with zipfile.ZipFile(f) as z:
                part.write_bytes(z.read(z.namelist()[0]))
            part.rename(target)
            f.unlink()
        else:
            f.rename(target)
    shutil.rmtree(tmp, ignore_errors=True)
    if not target.exists() or target.stat().st_size == 0:
        lines = (proc.stderr + proc.stdout).strip().splitlines()
        return [line for line in lines if "rror" in line][-1:] or lines[-1:] or ["no file created"]
    return None


def bulk(rows, keep_archive):
    """One archive download, then unpack only the wanted videos (write .part + rename)."""
    archive_dir = OUT_DIR.parent / "_bulk"
    archive = archive_dir / "wlasl-processed.zip"
    want = {f"videos/{r['video_id']}.mp4" for r in rows if not (OUT_DIR / f"{r['video_id']}.mp4").exists()}
    if not want:
        print("all videos already present")
        return 0, []
    if not archive.exists() or not zipfile.is_zipfile(archive):
        archive_dir.mkdir(parents=True, exist_ok=True)
        print(f"downloading the full archive once ({DATASET}) ...", flush=True)
        t0 = time.time()
        for attempt in range(MAX_TRIES):
            proc = subprocess.run([str(KAGGLE), "datasets", "download", DATASET, "-p", str(archive_dir)])
            if proc.returncode == 0 and zipfile.is_zipfile(archive):
                break
            print(f"  archive download failed (attempt {attempt + 1}), retrying ...", flush=True)
            time.sleep(min(60 * 2 ** attempt, 600))
        else:
            sys.exit("archive download failed - rerun later")
        print(f"archive: {archive.stat().st_size / 1e9:.2f} GB in {time.time() - t0:.0f}s", flush=True)
    failed = []
    with zipfile.ZipFile(archive) as z:
        names = set(z.namelist())
        for n, member in enumerate(sorted(want), 1):
            if member not in names:
                failed.append(member[7:-4])
                continue
            target = OUT_DIR / member[7:]
            part = target.with_suffix(".part")
            part.write_bytes(z.read(member))
            part.rename(target)
            if n % 200 == 0 or n == len(want):
                print(f"  unpacked {n}/{len(want)}", flush=True)
    if not keep_archive:
        shutil.rmtree(archive_dir)
        print("archive deleted (only the selected videos are kept)")
    return len(want) - len(failed), failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="data/wlasl/manifest.csv", type=Path)
    ap.add_argument("--workers", type=int, default=4, help="parallel downloads")
    ap.add_argument("--bulk", action="store_true", help="one archive download instead of per-file calls")
    ap.add_argument("--keep-archive", action="store_true")
    args = ap.parse_args()
    rows = list(csv.DictReader(open(args.manifest)))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if args.bulk:
        t0 = time.time()
        done, failed = bulk(rows, args.keep_archive)
        print(f"\nUnpacked {done} videos in {time.time() - t0:.0f}s; not in archive: {len(failed)} {failed[:20]}")
        return

    todo = [r for r in rows if not (OUT_DIR / f"{r['video_id']}.mp4").exists()]
    skipped, done, failed = len(rows) - len(todo), 0, []
    print(f"{len(rows)} videos in manifest: {skipped} already present, {len(todo)} to download "
          f"({args.workers} in parallel). Safe to interrupt: rerun to resume.", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(download, r["video_id"]): r for r in todo}
        for n, fut in enumerate(as_completed(futures), 1):
            r, error = futures[fut], fut.result()
            prefix = f"[{n:>4}/{len(todo)}] {r['video_id']} {r['gloss']:<12}"
            if error:
                failed.append(r["video_id"])
                print(f"{prefix} FAILED: {error[0]}", flush=True)
            else:
                done += 1
                rate = n / (time.time() - t0)
                print(f"{prefix} ok ({(OUT_DIR / (r['video_id'] + '.mp4')).stat().st_size / 1e6:.1f} MB)  "
                      f"{rate:.1f} files/s, ~{(len(todo) - n) / rate / 60:.0f} min left", flush=True)

    shutil.rmtree(OUT_DIR / "_tmp", ignore_errors=True)
    print(f"\nDownloaded {done}, already present {skipped}, failed {len(failed)} in {time.time() - t0:.0f}s")
    if failed:
        print("Failed ids (rerun to retry):", " ".join(failed))


if __name__ == "__main__":
    main()
