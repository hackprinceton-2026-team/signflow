"""Pick WLASL videos for a list of glosses and write a manifest CSV.

    python src/wlasl_select.py --glosses help doctor yes no "thank you"

Reads data/wlasl/WLASL_v0.3.json, skips video_ids in data/wlasl/missing.txt, prints per gloss
how many instances are available per split and how many distinct signers there are, and writes
data/wlasl/manifest.csv: video_id, gloss, split, signer_id, frame_start, frame_end.

Facts checked in WLASL_v0.3.json: frame_start is 1-based (min value is 1, never 0) and
frame_end == -1 means "until the end of the video" (true for ~90% of instances).
"""
import argparse
import csv
import difflib
import json
from collections import Counter
from pathlib import Path

WLASL_DIR = Path("data/wlasl")
FIELDS = ["video_id", "gloss", "split", "signer_id", "frame_start", "frame_end"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glosses", nargs="+", required=True, help='e.g. help yes no "thank you"')
    ap.add_argument("--json", default=WLASL_DIR / "WLASL_v0.3.json", type=Path)
    ap.add_argument("--missing", default=WLASL_DIR / "missing.txt", type=Path)
    ap.add_argument("--out", default=WLASL_DIR / "manifest.csv", type=Path)
    args = ap.parse_args()

    entries = {e["gloss"].lower(): e for e in json.load(open(args.json))}
    missing = set(args.missing.read_text().split())

    rows, unknown = [], []
    print(f"{'gloss':<12}{'total':>6}{'avail':>6}{'train':>6}{'val':>5}{'test':>5}{'signers':>8}")
    for wanted in args.glosses:
        gloss = wanted.lower().replace("_", " ")
        if gloss not in entries:
            unknown.append(wanted)
            continue
        instances = entries[gloss]["instances"]
        avail = [i for i in instances if i["video_id"] not in missing]
        splits = Counter(i["split"] for i in avail)
        signers = len({i["signer_id"] for i in avail})
        print(f"{gloss:<12}{len(instances):>6}{len(avail):>6}{splits['train']:>6}{splits['val']:>5}"
              f"{splits['test']:>5}{signers:>8}")
        for i in avail:
            rows.append({"video_id": i["video_id"], "gloss": gloss, "split": i["split"],
                         "signer_id": i["signer_id"], "frame_start": i["frame_start"],
                         "frame_end": i["frame_end"]})

    for wanted in unknown:
        close = difflib.get_close_matches(wanted.lower(), entries, n=3)
        print(f"NOT IN WLASL: {wanted!r}" + (f"   did you mean: {', '.join(close)}" if close else ""))

    all_signers = Counter(r["signer_id"] for r in rows)
    print(f"\n{len(rows)} available videos, {len(all_signers)} distinct signers overall")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Manifest: {args.out}")


if __name__ == "__main__":
    main()
