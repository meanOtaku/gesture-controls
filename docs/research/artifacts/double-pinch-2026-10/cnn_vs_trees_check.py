"""The app's trees model against the research CNN, on the same recordings, scored the same way.

Both models learn `pinch_in` from the camera-timed recordings in `data/recordings/pinch-relabelled` (pinch_hold,
pinch_out, fist and hand_open as negatives, left_out excluded), under the same splits:

* **The app's split**: the 10 training and 4 evaluation recordings the current pinch_in model was trained with.
* **A day held out**: train on 2026-10-14 and test on 2026-10-17, and the other way round.

The models:

* **Trees**: the app's trainer exactly (`label_trainer.label_train`): its decisions, features (PPG and motion summaries
  over 5.6 s), ExtraTrees and peak trigger. It decides about 0.88 s after a pinch starts.
* **CNN**: step 9's best pipeline, sliding: motion (accelerometer, gyroscope) and pulse (green, red, IR) on a 50 Hz grid,
  each channel z-scored over its trailing 10 s and put through a sigmoid, the last 1.0 s into step 3's CNN. It learns
  the decisions 0.4-0.6 s after a pinch starts (the touch near the window's middle) against those with no start from
  1.2 s before to 0.2 s after; the rest are left out. So it decides about 0.5 s after a pinch starts.

Both are scored at the same moments (every PPG sample the trees model can score) and their scores go through the same
rule: the runtime's peak trigger (`events.detect`, release 0.15 under activation, 1.5 s cooldown). A detection from the
pinch's start to 1.3 s after catches it (each start once); any other is a false alarm, except inside a left_out hold. The
time from each start to 1.3 s after, and left_out holds, are not counted as time a false alarm could happen in. The
activation threshold is swept, and each model is reported at the best threshold within each false-alarm budget.

With **still hand** (the setting the app uses, and the trainer's `steadyStarts`): both learn only from moments the hand
was still before, and a detection counts only if the hand was still before its own estimated start (each model's
delay); only pinches made from a still hand are counted. The jolt and turning checks are not applied to either.

Each model is trained three times (seeds 17-19) and its scores averaged.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/double-pinch-2026-10/cnn_vs_trees_check.py

Run from the repository root (about 10-20 minutes). Writes cnn-vs-trees/results.json and results.md.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from label_trainer import label_train as lt
from label_trainer import ppg_onset, steadiness
from label_trainer.events import detect

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DATA = ROOT / "data" / "recordings" / "pinch-relabelled"
OUT = HERE / "cnn-vs-trees"

TARGET = "pinch_in"
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open"]
EXCLUDES = ["left_out"]
APP_EVALUATION = {
    "gesture-dataset-pinch-2026-10-14T00-57-01.701Z", "gesture-dataset-pinch-2026-10-14T01-13-08.108Z",
    "gesture-dataset-pinch-2026-10-17T12-25-10.832Z", "gesture-dataset-pinch-2026-10-17T12-26-46.748Z",
}
SEEDS = (17, 18, 19)
MS = 1_000_000
CATCH_NS = 1300 * MS
BUDGETS = (1.0, 0.5, 0.2)          # false alarms a minute
THRESHOLDS = np.round(np.arange(0.05, 0.991, 0.01), 2)
TREES_DELAY_MS = ppg_onset.ONSET_DELAY_MS

# The CNN.
HZ = 50
STEP_NS = 1_000_000_000 // HZ
WINDOW = 50                        # 1.0 s
CNN_DELAY_MS = 500
RECENT = 10 * HZ
STD_FLOOR = np.array([0.02] * 3 + [0.01] * 3)
EPOCHS = 12
MAX_NEGATIVES = 40_000


def recordings() -> dict[str, Path]:
    found = {}
    for path in sorted(DATA.rglob("*")):
        if path.suffix == ".csv" and path.parent.name == "2026-10-downloads":
            found[path.stem] = path
        elif path.is_dir() and (path / "imu.csv").exists():
            found[path.name] = path
    return found


def spec_for(paths: dict[str, Path], train: list[str], evaluation: list[str], still: bool) -> lt.Spec:
    return lt.parse_spec({
        "version": 1, "target": TARGET, "negatives": NEGATIVES, "excludes": EXCLUDES,
        "recordings": {rid: str(paths[rid]) for rid in train + evaluation}, "train": train, "evaluation": evaluation,
        "sources": ["watchPpg", "watchOrientation"], "backend": "ppg-onset-trees", "seed": 17, "steadyStarts": still,
    })


def still_at(rec, decisions_ns: np.ndarray, delay_ms: int) -> np.ndarray:
    rows = rec.orient_observed if rec.orient_observed is not None else np.ones(len(rec.timestamps_ns), dtype=bool)
    ch = lambda names: np.stack([rec.channels[c][rows] for c in names], axis=1)  # noqa: E731
    return steadiness.still_before(rec.timestamps_ns[rows].astype(np.int64), ch(("accel_x", "accel_y", "accel_z")),
                                   ch(("gyro_x", "gyro_y", "gyro_z")), ch(("quat_w", "quat_x", "quat_y", "quat_z")),
                                   np.asarray(decisions_ns, dtype=np.int64), delay_ms * MS)


class Prepared:
    """One recording: its label holds, the moments both models are scored at, the trees inputs there, and the CNN's
    normalised 50 Hz streams."""

    def __init__(self, rid: str, rec, spec: lt.Spec):
        self.rid, self.rec = rid, rec
        self.holds = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
        self.starts = np.array([s for s, _, label in self.holds if label == TARGET], dtype=np.int64)
        self.excluded = [(s, e) for s, e, label in self.holds if label in EXCLUDES]
        ts, _ = lt.pulse_of(rec)
        x = lt.inputs(spec, rec, ts)
        ok = np.isfinite(x).all(axis=1)
        mts, axes = lt.motion_of(rec)
        pts, pulse = lt.pulse_of(rec)
        good = np.isfinite(axes).all(1)
        mts, axes = mts[good], axes[good]
        good = np.isfinite(pulse).all(1)
        pts, pulse = pts[good], pulse[good]
        self.grid = np.arange(max(mts[0], pts[0]), min(mts[-1], pts[-1]), STEP_NS, dtype=np.int64)
        motion = np.column_stack([np.interp(self.grid, mts, axes[:, c]) for c in range(6)])
        ppg = np.column_stack([np.interp(self.grid, pts, pulse[:, c]) for c in range(3)])
        self.streams = np.concatenate([self._z_sig(motion, STD_FLOOR), self._z_sig(ppg, None)], axis=1).astype(np.float32)
        # The moments scored: those the trees model can score and the CNN has a full second of grid for.
        last = np.searchsorted(self.grid, ts, side="right") - 1
        ok &= last >= WINDOW - 1 + RECENT // 5
        self.times, self.x, self.last = ts[ok], x[ok], last[ok]
        self.still_trees = still_at(rec, self.times, TREES_DELAY_MS)
        self.still_cnn = still_at(rec, self.times, CNN_DELAY_MS)
        self.still_starts = still_at(rec, self.starts + TREES_DELAY_MS * MS, TREES_DELAY_MS) if len(self.starts) else np.zeros(0, bool)

    @staticmethod
    def _z_sig(x: np.ndarray, floor) -> np.ndarray:
        c = np.concatenate([np.zeros((1, x.shape[1])), np.cumsum(x, 0)])
        c2 = np.concatenate([np.zeros((1, x.shape[1])), np.cumsum(x * x, 0)])
        i = np.arange(len(x)); lo = np.maximum(0, i + 1 - RECENT); n = (i + 1 - lo)[:, None]
        mean = (c[i + 1] - c[lo]) / n
        std = np.sqrt(np.maximum((c2[i + 1] - c2[lo]) / n - mean * mean, 0))
        std = std + (floor if floor is not None else 1e-3 * (np.abs(mean) + 1))
        return 1 / (1 + np.exp(-(x - mean) / std))

    def windows(self, rows: np.ndarray) -> np.ndarray:
        idx = self.last[rows][:, None] + np.arange(-WINDOW + 1, 1)[None, :]
        return np.transpose(self.streams[idx], (0, 2, 1))

    def cnn_labels(self) -> np.ndarray:
        """1 for a decision 0.4-0.6 s after a start, 0 with no start from 1.2 s before to 0.2 s after, -1 otherwise
        (between, or in an excluded hold)."""
        y = np.zeros(len(self.times), dtype=np.int64)
        for s in self.starts:
            age = self.times - s
            y[(age >= -200 * MS) & (age <= 1200 * MS)] = -1
        for s in self.starts:
            age = self.times - s
            y[(age >= 400 * MS) & (age <= 600 * MS)] = 1
        for s, e in self.excluded:
            y[(self.times >= s) & (self.times <= e + 1200 * MS)] = -1
        return y


class Net(nn.Module):
    """Step 3's CNN (`imu_models_check.Net`)."""

    def __init__(self, channels: int):
        super().__init__()
        layers, c = [], channels
        for out, dil in ((32, 1), (32, 2), (64, 4)):
            layers += [nn.Conv1d(c, out, 5, padding=2 * dil, dilation=dil), nn.BatchNorm1d(out), nn.ReLU()]
            c = out
        self.body = nn.Sequential(*layers)
        self.head = nn.Sequential(nn.Linear(2 * c, 32), nn.ReLU(), nn.Dropout(0.2), nn.Linear(32, 1))

    def forward(self, x):
        h = self.body(x)
        return self.head(torch.cat([h.amax(2), h.mean(2)], 1)).squeeze(1)


def cnn_scores(train: list[Prepared], test: list[Prepared], still: bool, seed: int) -> list[np.ndarray]:
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    W, Y = [], []
    for p in train:
        y = p.cnn_labels()
        keep = y >= 0
        if still:
            keep &= p.still_cnn
        rows = np.flatnonzero(keep)
        W.append(p.windows(rows)); Y.append(y[rows])
    W, Y = np.concatenate(W), np.concatenate(Y).astype(np.float32)
    neg = np.flatnonzero(Y == 0)
    if len(neg) > MAX_NEGATIVES:
        keep = np.sort(np.concatenate([np.flatnonzero(Y == 1), rng.choice(neg, MAX_NEGATIVES, replace=False)]))
        W, Y = W[keep], Y[keep]
    net = Net(W.shape[1])
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    pos = max(1.0, float(Y.sum()))
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(20.0, (len(Y) - pos) / pos)))
    Wt, Yt = torch.from_numpy(W), torch.from_numpy(Y)
    for _ in range(EPOCHS):
        net.train()
        order = torch.from_numpy(rng.permutation(len(Y)))
        for b in range(0, len(order), 256):
            pick = order[b:b + 256]
            loss = loss_fn(net(Wt[pick]), Yt[pick])
            opt.zero_grad(); loss.backward(); opt.step()
    net.eval()
    out = []
    with torch.no_grad():
        for p in test:
            w = torch.from_numpy(p.windows(np.arange(len(p.times))))
            out.append(torch.sigmoid(torch.cat([net(w[i:i + 4096]) for i in range(0, len(w), 4096)])).numpy())
    return out


def trees_scores(spec: lt.Spec, recs: dict, train_ids: list[str], test: list[Prepared], seed: int) -> list[np.ndarray]:
    ex = lt.examples(spec, recs, train_ids)
    model = lt.fit(ex.x, ex.y, seed)
    return [model.predict_proba(p.x)[:, 1] for p in test]


def events(p: Prepared, scores: np.ndarray, threshold: float, still: bool, delay_ms: int) -> tuple[int, int, int, float, list[float]]:
    """(pinches counted, caught, false alarms, minutes a false alarm could happen in, latencies in ms)."""
    rises = np.array([r for r, _ in detect(p.times, scores, lt.policy_for(threshold, "peak"))], dtype=np.int64)
    if len(rises):
        rises = rises[[not any(s <= r <= e for s, e in p.excluded) for r in rises]]
    if still and len(rises):
        rises = rises[still_at(p.rec, rises, delay_ms)]
    counted = p.still_starts if still else np.ones(len(p.starts), bool)
    used = np.zeros(len(rises), bool)
    caught, latencies, ignored = 0, [], np.zeros(len(rises), bool)
    for s, count in zip(p.starts, counted):
        hit = np.flatnonzero(~used & (rises >= s) & (rises <= s + CATCH_NS))
        if len(hit):
            used[hit[0]] = True
            if count:
                caught += 1
                latencies.append((rises[hit[0]] - s) / MS)
            else:
                ignored[hit[0]] = True   # a pinch not made from a still hand: neither caught nor a false alarm
    false = int((~used).sum())
    busy = [(s, s + CATCH_NS) for s in p.starts] + p.excluded
    span = p.times[-1] - p.times[0]
    covered = sum(max(0, min(e, p.times[-1]) - max(s, p.times[0])) for s, e in busy)
    return int(counted.sum()), caught, false, max(span - covered, 0) / 60e9, latencies


def operating_points(test: list[Prepared], scores: list[np.ndarray], still: bool, delay_ms: int) -> dict:
    sweep = []
    for th in THRESHOLDS:
        totals = [events(p, s, float(th), still, delay_ms) for p, s in zip(test, scores)]
        pinches = sum(t[0] for t in totals); caught = sum(t[1] for t in totals)
        false = sum(t[2] for t in totals); minutes = sum(t[3] for t in totals)
        lat = [x for t in totals for x in t[4]]
        sweep.append({"threshold": float(th), "pinches": pinches, "caught": caught, "false": false, "minutes": minutes,
                      "perMinute": false / minutes if minutes else float("inf"),
                      "medianLatencyMs": float(np.median(lat)) if lat else None})
    best = {}
    for budget in BUDGETS:
        ok = [s for s in sweep if s["perMinute"] <= budget]
        best[str(budget)] = max(ok, key=lambda s: (s["caught"], -s["perMinute"])) if ok else None
    return {"best": best, "sweep": sweep}


def run_split(name: str, paths: dict, train_ids: list[str], test_ids: list[str], still: bool, say) -> dict:
    spec = spec_for(paths, train_ids, test_ids, still)
    recs = lt.load_spec_recordings(spec)
    prepared = {rid: Prepared(rid, recs[rid], spec) for rid in train_ids + test_ids}
    test = [prepared[r] for r in test_ids]
    out = {}
    for model in ("trees", "cnn"):
        started = time.time()
        runs = []
        for seed in SEEDS:
            if model == "trees":
                runs.append(trees_scores(spec, recs, train_ids, test, seed))
            else:
                runs.append(cnn_scores([prepared[r] for r in train_ids], test, still, seed))
        scores = [np.mean([run[i] for run in runs], axis=0) for i in range(len(test))]
        delay = TREES_DELAY_MS if model == "trees" else CNN_DELAY_MS
        out[model] = operating_points(test, scores, still, delay)
        say(f"  {name} ({'still hand' if still else 'any'}) {model}: {time.time() - started:.0f} s, "
            + ", ".join(f"{b}/min: {_fmt(out[model]['best'][str(b)])}" for b in BUDGETS))
    return out


def _fmt(point) -> str:
    if point is None:
        return "none within budget"
    return f"{point['caught']}/{point['pinches']}"


def main() -> int:
    say = lambda line: print(line, flush=True)  # noqa: E731
    paths = recordings()
    ids = sorted(paths)
    day = lambda rid: "2026-10-14" if "2026-10-14" in rid else "2026-10-17"  # noqa: E731
    splits = {
        "app split": ([r for r in ids if r not in APP_EVALUATION], sorted(APP_EVALUATION)),
        "train 10-14, test 10-17": ([r for r in ids if day(r) == "2026-10-14"], [r for r in ids if day(r) == "2026-10-17"]),
        "train 10-17, test 10-14": ([r for r in ids if day(r) == "2026-10-17"], [r for r in ids if day(r) == "2026-10-14"]),
    }
    say(f"{len(ids)} recordings")
    results = {}
    for still in (True, False):
        for name, (train_ids, test_ids) in splits.items():
            results[f"{name} | {'still hand' if still else 'any'}"] = run_split(name, paths, train_ids, test_ids, still, say)
    OUT.mkdir(exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(results, indent=1) + "\n")
    lines = ["# Trees against the CNN, same recordings, same scoring", "",
             "Pinch ins caught (of those counted) at the best threshold within each false-alarm budget, and the median time",
             "from the pinch's start to the detection. See `cnn_vs_trees_check.py` for the method.", "",
             "| Split | Hand | Model | ≤1 false alarm/min | ≤0.5/min | ≤0.2/min | Latency at ≤1/min |",
             "|---|---|---|---:|---:|---:|---:|"]
    for key, models in results.items():
        name, hand = key.split(" | ")
        for model, res in models.items():
            cells = []
            for b in BUDGETS:
                p = res["best"][str(b)]
                cells.append("—" if p is None else f"{p['caught']}/{p['pinches']} ({p['caught'] / max(p['pinches'], 1):.0%})")
            p = res["best"]["1.0"]
            latency = f"{p['medianLatencyMs']:.0f} ms" if p and p["medianLatencyMs"] is not None else "—"
            lines.append(f"| {name} | {hand} | {model} | " + " | ".join(cells) + f" | {latency} |")
    (OUT / "results.md").write_text("\n".join(lines) + "\n")
    say("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
