"""Guided live test: prompts each sign, records what live.py's engine predicts, plus an idle check.

    python src/live_test.py                       # all 14 signs x 3, random order, then 20 s idle check
    python src/live_test.py --reps 2 --spacebar   # SPACE-triggered recording instead of auto segmentation
    python src/live_test.py --dry-run             # no camera: code check using your recorded clips

For each prompt ("Sign: HELP") it waits for ONE segmented sign (or --timeout seconds = "missed"),
using exactly the same engine, threshold and --dominant rule as live.py.
Idle check: --idle seconds of "don't sign, move naturally"; every segment it cuts = a false trigger,
and those that would have been SENT (confidence >= threshold) are counted separately.
Results: logs/live_test_<timestamp>.csv (one row per prompt) and .md (summary).
"""
import argparse
import csv
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

import config as C
from features import read_frames
from live import LiveEngine, add_common_args, draw, log

LOGS = Path("logs")
CLIPS = Path("data/webcam")


class Camera:
    def __init__(self, index):
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            sys.exit("Cannot open camera. On macOS allow camera access for your terminal / VS Code "
                     "(System Settings > Privacy & Security > Camera) and restart it.")

    def frames(self, seconds=None):
        """(bgr, t) in real time, for `seconds` or forever."""
        end = None if seconds is None else time.time() + seconds
        while end is None or time.time() < end:
            ok, frame = self.cap.read()
            if not ok:
                return
            yield frame, time.time()


class DryRun:
    """Stand-in for the camera: plays a recorded clip of the prompted sign, then empty frames."""

    def __init__(self, seed):
        self.rng, self.t = random.Random(seed), 0.0
        self.by_sign = defaultdict(list)
        for f in sorted(CLIPS.glob("*.mp4")):
            self.by_sign[f.stem.split("-")[0].upper()].append(f)

    def _blank(self, seconds):
        for _ in range(int(seconds * 30)):
            self.t += 1 / 30
            yield np.zeros((480, 640, 3), np.uint8), self.t

    def clip(self, sign):
        for rgb in read_frames(self.rng.choice(self.by_sign[sign])):
            self.t += 1 / 30
            yield cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), self.t
        yield from self._blank(2.0)

    def idle(self, seconds):
        yield from self._blank(seconds)


def show(args, engine, bgr, lines):
    """Draw and handle keys. Returns the key pressed (or -1)."""
    if args.headless:
        return -1
    cv2.imshow("SignFlow live test", draw(engine, bgr, lines))
    key = cv2.waitKey(1) & 0xFF
    if key in (ord("q"), 27):
        raise KeyboardInterrupt
    return key


def wait_for_sign(args, engine, frames, prompt_lines):
    """Feed frames until the engine predicts one segment. Returns the prediction event or None."""
    for bgr, t in frames:
        key = show(args, engine, bgr, prompt_lines)
        for e in engine.step(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, space=key == ord(" ")):
            if e["kind"] == "prediction":
                return e
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--idle", type=float, default=20.0, help="seconds of idle check")
    ap.add_argument("--timeout", type=float, default=15.0, help="seconds to wait for a sign per prompt")
    ap.add_argument("--seed", type=int, default=None, help="prompt order seed (default: random)")
    ap.add_argument("--dry-run", action="store_true", help="no camera: feed recorded clips (code check only)")
    args = ap.parse_args()
    if args.dry_run:
        args.headless = True
        if args.spacebar:
            ap.error("--dry-run uses automatic segmentation")
    seed = args.seed if args.seed is not None else random.randrange(10**6)

    engine = LiveEngine(args.model, args.dominant, args.spacebar)
    labels = list(engine.bundle["labels"])
    source = DryRun(seed) if args.dry_run else Camera(args.camera)
    if args.dry_run:
        skipped = [s for s in labels if s not in source.by_sign]
        labels = [s for s in labels if s in source.by_sign]
        log(f"DRY RUN: no camera, prompts limited to signs with recorded clips {labels}; skipped {skipped}")
    prompts = labels * args.reps
    random.Random(seed).shuffle(prompts)
    mode = "spacebar" if args.spacebar else "auto segmentation"
    log(f"{len(prompts)} prompts ({len(labels)} signs x {args.reps}), seed {seed}, dominant {args.dominant}, {mode}")

    if not args.headless:                           # start screen
        for bgr, _ in source.frames():
            if show(args, engine, bgr, ["Live test: " + str(len(prompts)) + " signs", "Press SPACE to start"]) == ord(" "):
                break

    trials = []
    try:
        for i, sign in enumerate(prompts, 1):
            hint = "SPACE, then sign" if args.spacebar else "sign, then lower your hands"
            lines = [f"Sign: {sign}", f"{i}/{len(prompts)}  ({hint})"]
            frames = source.clip(sign) if args.dry_run else source.frames(args.timeout)
            e = wait_for_sign(args, engine, frames, lines)
            if e is None or e["decision"] is None:
                pred, conf, shown, outcome = "", 0.0, "", "missed" if e is None else "no hands"
            else:
                d = e["decision"]
                pred, conf, shown = d.get("best_guess", d["sign"]), d["confidence"], d["sign"]
                outcome = "?" if shown == "?" else ("correct" if shown == sign else "wrong")
            trials.append(dict(trial=i, prompt=sign, predicted=pred, confidence=conf, shown=shown,
                               correct=int(outcome == "correct"), outcome=outcome))
            log(f"[{i}/{len(prompts)}] {sign:<10} -> {shown or outcome:<10} {conf:.2f}  {outcome}")
            if not args.headless:                   # show the result for a moment
                for bgr, _ in source.frames(1.2):
                    show(args, engine, bgr, [f"{sign}: {outcome.upper()}"])

        # ---- idle check ----
        log(f"Idle check: {args.idle:.0f} s - don't sign, move naturally")
        idle = []
        frames = source.idle(args.idle) if args.dry_run else source.frames(args.idle)
        start = None
        for bgr, t in frames:
            start = start or t
            key = show(args, engine, bgr, ["IDLE CHECK: don't sign", f"move naturally... {args.idle - (t - start):.0f}s"])
            for e in engine.step(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, space=key == ord(" ")):
                if e["kind"] == "prediction":
                    idle.append(e)
    except KeyboardInterrupt:
        log("stopped early - saving what we have")
        idle = locals().get("idle", None)
    finally:
        engine.close()
        cv2.destroyAllWindows()

    write_report(args, seed, trials, idle, mode)


def write_report(args, seed, trials, idle, mode):
    LOGS.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"live_test_{'dryrun_' if args.dry_run else ''}{stamp}"
    with open(LOGS / f"{name}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["trial", "prompt", "predicted", "confidence", "shown", "correct", "outcome"])
        w.writeheader()
        w.writerows(trials)

    n = len(trials)
    per_sign = defaultdict(list)
    for r in trials:
        per_sign[r["prompt"]].append(r)
    outcomes = Counter(r["outcome"] for r in trials)
    confusions = Counter((r["prompt"], r["predicted"]) for r in trials if r["outcome"] == "wrong")
    unsure = Counter((r["prompt"], r["predicted"]) for r in trials if r["outcome"] == "?")
    confs = [r["confidence"] for r in trials if r["predicted"]]
    conf_ok = [r["confidence"] for r in trials if r["outcome"] == "correct"]
    conf_bad = [r["confidence"] for r in trials if r["outcome"] == "wrong"]
    mean = lambda xs: f"{np.mean(xs):.2f}" if xs else "-"
    idle_sent = [e for e in (idle or []) if e["decision"] and e["decision"]["sign"] != "?"]

    md = [f"# Live test {'(DRY RUN - recorded clips, not a live result) ' if args.dry_run else ''}{stamp}", "",
          f"- model: models/sign_model.joblib, threshold {C.CONF_THRESHOLD}, dominant `{args.dominant}`, {mode}, seed {seed}",
          f"- prompts: {n}" + (f" (stopped early)" if n < len(set(r['prompt'] for r in trials)) * args.reps else ""), "",
          "## Summary", "",
          f"| | |", "|---|---|",
          f"| accuracy (shown sign correct) | {outcomes['correct']}/{n} = {outcomes['correct'] / n:.0%} |" if n else "| accuracy | - |",
          f"| \"?\" responses (below {C.CONF_THRESHOLD}) | {outcomes['?']}/{n} = {outcomes['?'] / n:.0%} |" if n else "| ? | - |",
          f"| wrong sign shown | {outcomes['wrong']} |",
          f"| missed (no sign detected in {args.timeout:.0f} s) | {outcomes['missed'] + outcomes['no hands']} |",
          f"| average confidence: all / correct / wrong | {mean(confs)} / {mean(conf_ok)} / {mean(conf_bad)} |",
          (f"| idle false triggers ({args.idle:.0f} s): segments / would be sent | {len(idle)} / {len(idle_sent)}"
           + (" (dry run: empty frames, not meaningful)" if args.dry_run else "") + " |") if idle is not None
          else "| idle check | not run (stopped early) |",
          "", "## Per sign", "", "| sign | correct | ? | wrong | missed | avg conf |", "|---|---|---|---|---|---|"]
    for sign in sorted(per_sign):
        rs = per_sign[sign]
        c = Counter(r["outcome"] for r in rs)
        md.append(f"| {sign} | {c['correct']}/{len(rs)} | {c['?']} | {c['wrong']} | {c['missed'] + c['no hands']} | "
                  f"{mean([r['confidence'] for r in rs if r['predicted']])} |")
    md += ["", "## Confusions (prompted -> shown)", ""]
    md += [f"- {a} -> {b}: {k}x" for (a, b), k in confusions.most_common()] or ["- none"]
    md += ["", "## \"?\" responses (prompted -> best guess)", ""]
    md += [f"- {a} -> {b}: {k}x" for (a, b), k in unsure.most_common()] or ["- none"]
    if idle_sent:
        md += ["", "## Idle false triggers that would be sent", ""]
        md += [f"- {e['decision']['sign']} {e['decision']['confidence']:.2f}" for e in idle_sent]
    text = "\n".join(md) + "\n"
    (LOGS / f"{name}.md").write_text(text)
    print(text)
    print(f"Saved {LOGS / name}.csv and .md")


if __name__ == "__main__":
    main()
