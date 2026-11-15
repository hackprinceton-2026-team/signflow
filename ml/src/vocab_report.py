"""Phase 1/2 of the vocabulary expansion: WLASL coverage report + vocabulary choice.

    python src/vocab_report.py --measure     # also (re)measure download + extraction speed on 10 videos
    python src/vocab_report.py               # reuse reports/speed.json

Writes reports/wlasl_gloss_stats.csv, reports/vocab_coverage.md, and the chosen vocabulary's
manifest data/wlasl/manifest_vocab.csv (same columns as wlasl_select.py).
"""
import argparse
import csv
import difflib
import json
import os
import shutil
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool
from pathlib import Path

import numpy as np

import extract
from wlasl_download import OUT_DIR as VIDEO_DIR, download

W = Path("data/wlasl")
REPORTS = Path("reports")
SPEED = REPORTS / "speed.json"
CARE = ["hello", "help", "doctor", "pain", "hurt", "sick", "medicine", "hospital", "nurse", "emergency",
        "headache", "yes", "no", "please", "thank you", "sorry", "water", "eat", "drink", "bathroom", "hungry",
        "thirsty", "tired", "cold", "hot", "need", "want", "where", "what", "when", "today", "tomorrow",
        "yesterday", "family", "mother", "father", "friend", "deaf", "understand", "again", "stop", "wait",
        "fine", "good", "bad"]
DEMO = ["bathroom", "doctor", "drink", "food", "help", "hungry", "no", "please", "ready", "sorry", "stop",
        "thank you", "thirsty", "yes"]                     # the 14 signs of the frozen v2 model
MIN_CARE = 8            # default rule: care-list words with >= 8 available videos
BUDGET_MIN = 60         # expand to ~200 glosses if the full pipeline is estimated under this
FIELDS = ["video_id", "gloss", "split", "signer_id", "frame_start", "frame_end"]


def load():
    entries = json.load(open(W / "WLASL_v0.3.json"))
    missing = set((W / "missing.txt").read_text().split())
    sizes = {r["name"][7:-4]: int(r["size"]) for r in csv.DictReader(open(REPORTS / "kaggle_file_sizes.csv"))
             if r["name"].startswith("videos/")}
    vid2gloss = {i["video_id"]: e["gloss"] for e in entries for i in e["instances"]}
    subsets = {n: {vid2gloss[v] for v in json.load(open(W / f"nslt_{n}.json")) if v in vid2gloss}
               for n in (100, 300)}
    stats = []
    for rank, e in enumerate(entries):
        avail = [i for i in e["instances"] if i["video_id"] not in missing]
        split = Counter(i["split"] for i in avail)
        stats.append(dict(gloss=e["gloss"], rank=rank, total=len(e["instances"]), available=len(avail),
                          signers=len({i["signer_id"] for i in avail}), train=split["train"], val=split["val"],
                          test=split["test"], available_mb=round(sum(sizes.get(i["video_id"], 0) for i in avail) / 1e6, 1),
                          in_nslt100=int(e["gloss"] in subsets[100]), in_nslt300=int(e["gloss"] in subsets[300])))
    return entries, missing, sizes, subsets, stats


def rows_for(entries, missing, glosses):
    glosses = set(glosses)
    return [dict(video_id=i["video_id"], gloss=e["gloss"], split=i["split"], signer_id=i["signer_id"],
                 frame_start=i["frame_start"], frame_end=i["frame_end"])
            for e in entries if e["gloss"] in glosses for i in e["instances"] if i["video_id"] not in missing]


def measure(entries, missing):
    """Download 10 not-yet-downloaded WLASL100 videos (4 parallel) and time extraction on them:
    1 worker on the 10 videos, then N workers on 2 x the 10 videos (to keep all workers busy)."""
    pool_rows = [r for r in rows_for(entries, missing, [e["gloss"] for e in entries[:100]])
                 if not (VIDEO_DIR / f"{r['video_id']}.mp4").exists()]
    sample = pool_rows[::max(1, len(pool_rows) // 10)][:10]          # spread over the 100 glosses
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    t = time.time()
    with ThreadPoolExecutor(4) as ex:
        errors = list(ex.map(download, [r["video_id"] for r in sample]))
    dl_s = time.time() - t
    shutil.rmtree(VIDEO_DIR / "_tmp", ignore_errors=True)
    ok = [r for r, e in zip(sample, errors) if e is None]
    dl_bytes = sum((VIDEO_DIR / f"{r['video_id']}.mp4").stat().st_size for r in ok)

    tmp = Path("data/landmarks/_speedtest")
    jobs = [dict(path=VIDEO_DIR / f"{r['video_id']}.mp4", video=r["video_id"], label="X", split=r["split"],
                 signer_id=r["signer_id"], start=int(r["frame_start"]), end=int(r["frame_end"]),
                 out=str(tmp / f"{k}_{r['video_id']}.npy")) for k, r in enumerate(ok)]
    t = time.time()
    with Pool(1) as p:
        list(p.imap_unordered(extract.run, jobs))
    serial_s = time.time() - t
    frames = sum(len(np.load(j["out"])) for j in jobs)
    workers = max(1, (os.cpu_count() or 2) - 1)
    jobs2 = [dict(j, out=str(tmp / f"p{k}.npy")) for k, j in enumerate(jobs + jobs)]
    t = time.time()
    with Pool(workers) as p:
        list(p.imap_unordered(extract.run, jobs2))
    par_s = time.time() - t
    shutil.rmtree(tmp, ignore_errors=True)
    speed = dict(download_files=len(ok), download_failed=len(sample) - len(ok), download_seconds=round(dl_s, 1),
                 download_parallel=4, download_files_per_s=round(len(ok) / dl_s, 3),
                 download_mb=round(dl_bytes / 1e6, 2), extract_videos=len(jobs), extract_frames=frames,
                 extract_serial_s_per_video=round(serial_s / len(jobs), 2),
                 extract_serial_frames_per_s=round(frames / serial_s, 1), extract_workers=workers,
                 extract_parallel_s_per_video=round(par_s / len(jobs2), 3),
                 measured=time.strftime("%Y-%m-%d %H:%M"), cpu_count=os.cpu_count(),
                 sample_video_ids=[r["video_id"] for r in ok])
    REPORTS.mkdir(exist_ok=True)
    SPEED.write_text(json.dumps(speed, indent=2))
    return speed


def estimate(glosses, entries, missing, sizes, speed, have):
    rows = rows_for(entries, missing, glosses)
    new = [r for r in rows if r["video_id"] not in have]
    mb = sum(sizes.get(r["video_id"], 0) for r in rows) / 1e6
    new_mb = sum(sizes.get(r["video_id"], 0) for r in new) / 1e6
    dl_min = len(new) / speed["download_files_per_s"] / 60
    ex_min = len(new) * speed["extract_parallel_s_per_video"] / 60
    return dict(glosses=len(set(glosses)), videos=len(rows), new_videos=len(new), mb=mb, new_mb=new_mb,
                dl_min=dl_min, ex_min=ex_min, total_min=dl_min + ex_min)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true")
    args = ap.parse_args()
    entries, missing, sizes, subsets, stats = load()
    REPORTS.mkdir(exist_ok=True)
    with open(REPORTS / "wlasl_gloss_stats.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(stats[0]))
        w.writeheader()
        w.writerows(stats)
    by = {s["gloss"]: s for s in stats}

    speed = measure(entries, missing) if args.measure or not SPEED.exists() else json.loads(SPEED.read_text())
    have = {p.stem for p in VIDEO_DIR.glob("*.mp4")}

    # ---------------- vocabulary options ----------------
    care_in = [g for g in CARE if g in by]
    top200 = [s["gloss"] for s in sorted(stats, key=lambda s: (-s["available"], s["rank"]))[:200]]
    wlasl100 = [e["gloss"] for e in entries[:100]]
    default = list(dict.fromkeys(wlasl100 + [g for g in care_in if by[g]["available"] >= MIN_CARE] + DEMO))
    opt_b = list(dict.fromkeys(top200 + care_in + DEMO))
    wlasl300 = [e["gloss"] for e in entries[:300]]
    options = {"WLASL100 + care-list (>= 8) + 14 demo signs (default)": default,
               "top-200 by available + all care-list words in WLASL + 14 demo signs": opt_b,
               "WLASL300 (+ 14 demo signs)": list(dict.fromkeys(wlasl300 + DEMO))}
    est = {name: estimate(g, entries, missing, sizes, speed, have) for name, g in options.items()}
    expand = est[list(options)[1]]["total_min"] < BUDGET_MIN
    chosen_name = list(options)[1] if expand else list(options)[0]
    chosen = options[chosen_name]
    with open(W / "manifest_vocab.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows_for(entries, missing, chosen))

    # ---------------- report ----------------
    idx = list(csv.DictReader(open("data/landmarks/wlasl/index.csv")))
    kept = Counter(r["label"] for r in idx if r["kept"] == "1")
    L = ["# WLASL vocabulary coverage", "", f"Generated {time.strftime('%Y-%m-%d %H:%M')} by `src/vocab_report.py`. "
         "Full per-gloss table: `reports/wlasl_gloss_stats.csv`.", "",
         "## 1. Current demo model (v2_rf_feat2dom, frozen)", "",
         "| sign | WLASL gloss | training videos (kept) | available in WLASL |", "|---|---|---|---|"]
    for g in DEMO:
        lab = extract.to_label(g)
        L.append(f"| {lab} | {g} | {kept[lab]} | {by[g]['available']} |")
    L.append(f"| **total** | | **{sum(kept.values())}** | |")

    def summary(name, glosses):
        av = [by[g]["available"] for g in glosses]
        return (f"| {name} | {len(glosses)} | {sum(a >= 5 for a in av)} | {sum(a >= 8 for a in av)} | "
                f"{sum(a >= 12 for a in av)} | {sum(av)} | {np.median(av):.0f} | "
                f"{np.median([by[g]['signers'] for g in glosses]):.0f} |")
    L += ["", "## 2. WLASL overall", "",
          f"{len(entries)} glosses, {sum(s['total'] for s in stats)} instances, "
          f"{sum(s['available'] for s in stats)} available (not in missing.txt), "
          f"{sum(s['available_mb'] for s in stats) / 1000:.2f} GB of available video.", "",
          "| set | glosses | >= 5 available | >= 8 | >= 12 | available videos | median per gloss | median signers |",
          "|---|---|---|---|---|---|---|---|",
          summary("all WLASL", [s["gloss"] for s in stats]),
          summary("nslt_100 (WLASL100)", sorted(subsets[100])),
          summary("nslt_300 (WLASL300)", sorted(subsets[300])),
          "", "Note: per-gloss availability is ~50% of the original instances (the rest are in missing.txt).",
          "", "## 3. Care list", "", "| word | status | available | signers |", "|---|---|---|---|"]
    demo_labels = {extract.to_label(g) for g in DEMO}
    for word in CARE:
        if extract.to_label(word) in demo_labels:
            status = "in our model"
        elif word in by:
            status = f"in WLASL ({by[word]['available']} videos)"
        else:
            close = difflib.get_close_matches(word, by, n=3, cutoff=0.75)
            status = "not in WLASL" + (f" (similar glosses: {', '.join(close)})" if close else "")
        a = by.get(word, {})
        L.append(f"| {word} | {status} | {a.get('available', '-')} | {a.get('signers', '-')} |")
    n_care = len(care_in)
    L += ["", f"{n_care}/{len(CARE)} care-list words are WLASL glosses; "
          f"{sum(by[g]['available'] >= MIN_CARE for g in care_in)} have >= {MIN_CARE} available videos.", "",
          "## 4. Measured speed on this machine", "",
          f"- Download (Kaggle CLI, one file per call, {speed['download_parallel']} in parallel): "
          f"{speed['download_files']} files ({speed['download_mb']} MB) in {speed['download_seconds']} s = "
          f"**{speed['download_files_per_s']} files/s** ({speed['download_failed']} failed). Per-call overhead dominates, "
          "so time scales with the number of files more than with MB.",
          f"- Extraction (MediaPipe Holistic): {speed['extract_videos']} videos / {speed['extract_frames']} frames; "
          f"1 worker: {speed['extract_serial_s_per_video']} s/video ({speed['extract_serial_frames_per_s']} frames/s); "
          f"{speed['extract_workers']} workers: **{speed['extract_parallel_s_per_video']} s/video** "
          f"({speed['cpu_count']} CPU cores). Measured {speed['measured']}.", "",
          "## 5. Size and time estimates (from exact Kaggle file sizes and the measured speeds)", "",
          "| option | glosses | videos | GB | new videos to fetch | download | extraction | total |",
          "|---|---|---|---|---|---|---|---|"]
    for name, e in est.items():
        L.append(f"| {name} | {e['glosses']} | {e['videos']} | {e['mb'] / 1000:.2f} | {e['new_videos']} | "
                 f"{e['dl_min']:.0f} min | {e['ex_min']:.0f} min | **{e['total_min']:.0f} min** |")
    L += ["", "Already-downloaded videos are skipped. Estimates assume the measured rates hold for the whole run.", "",
          "## 6. Decision (Phase 2 rule)", "",
          f"- Rule: default = WLASL100 + care-list words with >= {MIN_CARE} videos; expand to ~200 glosses if the "
          f"full pipeline is estimated under {BUDGET_MIN} min.",
          f"- Estimate for the ~200 option: {est[list(options)[1]]['total_min']:.0f} min -> "
          f"**{'expand' if expand else 'keep the default'}**.",
          f"- Chosen: **{chosen_name}** = {len(chosen)} glosses, {est[chosen_name]['videos']} available videos. "
          "The 14 demo signs are always included so the expanded model can be compared with v2 on them.",
          "- After extraction, glosses with fewer than 6 usable videos (>= 80% in-sign hand rule) are dropped.",
          f"- Manifest: `data/wlasl/manifest_vocab.csv`"]
    (REPORTS / "vocab_coverage.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
