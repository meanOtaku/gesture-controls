"""Did the app feed its models what the trainer feeds them? Live scores against the trainer's, on the same saved data.

The nine 45 s miss clips saved on 13 November (Model Lab datasets with a `live_log.json`) hold the samples the desktop
had buffered and, in the log, the score each model gave live at each pulse sample (`kind: score`, stamped only with the
milliseconds before the save, on the desktop's clock). Here the trainer scores the same saved samples with the same model
files (`pinch_in-00652068`, `pinch_out-4ba930b3`, both 50 Hz median-scaled CNNs). A clip's first 11 s cannot be scored
offline (no history before the clip), so only decisions after that are compared.

The live scores carry no sample timestamp, so they are matched to the offline decisions by order, allowing either side
to skip a decision (`align_skipping`): the app may not have decided on every sample, and the log may have lost some.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/live-parity-2026-11/compare.py

Writes `results.json` and `results.md`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn, cnn_input, label_train as lt  # noqa: E402
from label_trainer.csv_io import load_recording, repair_millisecond_ppg_timestamps  # noqa: E402

LAB = Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab"
MODELS = {"pinch_in": LAB / "training-runs/run-9fd71b2838/bundle", "pinch_out": LAB / "label-models/pinch_out-4ba930b39d1e"}
MAX_SHIFT = 60


def offline(recording, bundle: Path) -> tuple[np.ndarray, np.ndarray]:
    manifest = json.loads((bundle / "manifest.json").read_text())
    model = (bundle / manifest["model"]["file"]).read_bytes()
    hz = manifest["preprocessing"].get("motionHz", 50)
    scaling = cnn_input.MEDIAN if manifest["preprocessing"]["kind"].endswith("median") else cnn_input.ROLLING
    p_ts, pulse = lt.pulse_of(recording)
    m_ts, motion = lt.motion_of(recording)
    x = cnn_input.inputs(m_ts, motion, p_ts, pulse, p_ts, scaling=scaling, hz=hz)
    scores = np.full(len(p_ts), np.nan)
    ok = np.isfinite(x).all(axis=1)
    scores[ok] = cnn.predict(model, x[ok])
    return p_ts, scores


def align(live: np.ndarray, off: np.ndarray) -> tuple[int, np.ndarray, np.ndarray]:
    """The shift k (live[i] against off[i + k]) with the smallest median |difference| over the decisions both have."""
    best = None
    for k in range(-MAX_SHIFT, MAX_SHIFT + 1):
        i = np.arange(len(live))
        j = i + k
        keep = (j >= 0) & (j < len(off))
        a, b = live[i[keep]], off[j[keep]]
        both = np.isfinite(b)
        if both.sum() < 200:
            continue
        err = float(np.median(np.abs(a[both] - b[both])))
        if best is None or err < best[0]:
            best = (err, k, a[both], b[both])
    return best[1], best[2], best[3]


SKIP = 1e-3   # the cost of leaving a live or an offline decision unmatched


def align_skipping(live: np.ndarray, off: np.ndarray, band: int = 120) -> list[tuple[int, int]]:
    """Live decision i matched to offline decision j in order, either side allowed to skip (a decision the app did not
    make, or one the log lost), at least cost: |difference| per match, SKIP per skip, SKIP for an offline one without
    inputs. The matched (i, j) pairs."""
    n, m = len(live), len(off)
    inf = float("inf")
    cost = np.full((n + 1, m + 1), inf)
    move = np.zeros((n + 1, m + 1), dtype=np.int8)
    cost[0, :] = 0.0       # the live log may start anywhere in the clip
    cost[:, 0] = np.arange(n + 1) * SKIP
    centre = m - n
    for i in range(1, n + 1):
        lo, hi = max(1, i + centre - band), min(m, i + centre + band)
        for j in range(lo, hi + 1):
            match = cost[i - 1, j - 1] + (abs(live[i - 1] - off[j - 1]) if np.isfinite(off[j - 1]) else SKIP)
            skip_live, skip_off = cost[i - 1, j] + SKIP, cost[i, j - 1] + SKIP
            best = min(match, skip_live, skip_off)
            cost[i, j], move[i, j] = best, (0 if best == match else 1 if best == skip_live else 2)
    i, j, pairs = n, int(np.argmin(cost[n])), []
    while i > 0 and j > 0:
        if move[i, j] == 0:
            pairs.append((i - 1, j - 1)); i, j = i - 1, j - 1
        elif move[i, j] == 1:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def main() -> None:
    clips = sorted(p.parent for p in (LAB / "datasets").glob("*/live_log.json"))
    rows = []
    for folder in clips:
        log = json.loads((folder / "live_log.json").read_text())
        recording = repair_millisecond_ppg_timestamps(load_recording(folder))
        for label, bundle in MODELS.items():
            live = [e for e in log["entries"] if e["kind"] == "score" and e["label"] == label]
            live = np.array([e["value"] for e in sorted(live, key=lambda e: -e["msBeforeMark"])])
            _, off = offline(recording, bundle)
            shift, _, _ = align(live, off)
            pairs = [(i, j) for i, j in align_skipping(live, off) if np.isfinite(off[j])]
            a, b = live[[i for i, _ in pairs]], off[[j for _, j in pairs]]
            diff = np.abs(a - b)
            js = [j for _, j in pairs]
            skipped = int(sum(1 for j in range(js[0], js[-1] + 1) if np.isfinite(off[j])) - len(js)) if js else 0
            threshold = json.loads((bundle / "manifest.json").read_text())["thresholds"]["activation"]
            rows.append({
                "clip": folder.name[:8], "label": label, "live": len(live), "offline": int(np.isfinite(off).sum()),
                "pulseSamples": len(off), "compared": len(a), "shift": shift, "offlineSkipped": skipped,
                "medianDiff": float(np.median(diff)), "p99Diff": float(np.quantile(diff, 0.99)), "maxDiff": float(diff.max()),
                "over001": int((diff > 0.01).sum()), "liveAbove": int((a >= threshold).sum()),
                "offlineAbove": int((b >= threshold).sum()), "bothAbove": int(((a >= threshold) & (b >= threshold)).sum()),
            })
            print(rows[-1], flush=True)
    (HERE / "results.json").write_text(json.dumps(rows, indent=1))
    lines = ["# Live scores against the trainer's, on the same saved samples", "", "See `compare.py`.", "",
             "| clip | model | live scores | offline scorable | compared | offline skipped | median diff | 99th pct diff | max diff | diffs > 0.01 | above cut-off live / offline / both |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['clip']} | {r['label']} | {r['live']} | {r['offline']} | {r['compared']} | {r['offlineSkipped']} | {r['medianDiff']:.1e} | "
                     f"{r['p99Diff']:.1e} | {r['maxDiff']:.2g} | {r['over001']} | {r['liveAbove']} / {r['offlineAbove']} / {r['bothAbove']} |")
    (HERE / "results.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
