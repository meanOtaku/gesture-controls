"""What the trees pinch model makes of the ideas in Rylo, de Medeiros and de Lucena Jr. (2022), "Gesture recognition of
wrist motion based on wearables sensors" (Procedia Computer Science 210, 181-188): the same watch (Galaxy Watch 4), PPG at
25 Hz and motion at 100 Hz, statistical features and a random forest.

The paper's random forest chose mostly gyroscope features, many from the power spectrum (`maxPSD_gyrx`, `entroS_gyry`);
it recorded motion at 100 Hz; and it kept 27 of 147 features with no loss. The trees here read 2,733 time-domain features
(1,701 PPG, 1,032 motion) on a 50 Hz motion grid. So:

* `trees`            the trees as the trainer makes them (the baseline).
* `trees+spectral`   plus, for each motion channel (six axes and the two magnitudes) and window (320, 640, 1,280 ms): the
                     log of the total power, the share in five bands, the peak frequency, the spectral centroid and the
                     spectral entropy (216 more features).
* `trees@25`         the motion features on a 25 Hz grid (the same spans), to see whether the rate matters at all.
* `trees@100`        the motion features on a 100 Hz grid (the rate the watch sends; the trainer uses every other sample).
* `trees+spectral@100`  both: the spectrum up to 50 Hz instead of 25.
* `trees-top50`, `-top200`, `-top500`  trained again on only the features the baseline's trees found most useful (their
                     impurity importance on the training recordings), as the paper's selection did.

The CNN's numbers on the same test are in `../training-improvements-2026-11/results-pinch_in.md` (its `@100` variants
answer the rate question for the CNN).

Same test as `../training-improvements-2026-11/experiment.py`: train on the 22 recordings the live models trained on, score
the 11 they never saw, and count the pinches caught at the best cut-off within 2, 5 and 10 false activations an hour
(chosen on the scored recordings, so for comparing variants only). At the best cut-off within 5 an hour it also says which
label each false activation fell on, the paper's question of which gestures are taken for which.

    SEEDS=17,18 tools/label-trainer/.venv/bin/python docs/research/artifacts/paper-rylo-2022/paper_experiments.py pinch_in [variant...]

Results add to `results-<target>.json` (a variant and seed already there is skipped) and `results-<target>.md` is rewritten.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "training-improvements-2026-11"))

from experiment import BUDGETS, SEEDS, THRESHOLDS, UNSEEN, spec_for as cnn_spec_for  # noqa: E402
from label_trainer import events, imu_onset, label_train as lt  # noqa: E402

# Bands of the motion spectrum, in Hz. Above 25 Hz only exists on the 100 Hz grid.
BANDS = ((0.5, 2.0), (2.0, 4.0), (4.0, 8.0), (8.0, 15.0), (15.0, 50.0))
SPECTRAL_STATS = ("log_power", *(f"band_{lo:g}_{hi:g}" for lo, hi in BANDS), "peak_hz", "centroid_hz", "entropy")
EPS = 1e-12


def spec_for(target: str, hz: int = 50) -> lt.Spec:
    """The CNN experiment's recordings and roles, for the trees, with motion on the `hz` grid (the trainer's default is now
    100 Hz; these experiments' baseline is the 50 Hz the trees had)."""
    return replace(cnn_spec_for(target), backend=lt.BACKEND, motion_hz=hz)


# A 25 Hz grid over the same spans, for the experiment only.
imu_onset.GRIDS.setdefault(25, (40_000_000, (8, 16, 32), 75))


def spectral(ts_ns: np.ndarray, axes: np.ndarray, decisions_ns: np.ndarray, chunk: int = 512, hz: int = 50) -> np.ndarray:
    """(decisions, 216): the spectrum of each motion channel over each of the motion features' windows."""
    tick, grid_windows, _, _ = imu_onset.grid_of(hz)
    ts_ns = np.asarray(ts_ns, dtype=np.int64)
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64)
    channels = 8
    width = len(grid_windows) * channels * len(SPECTRAL_STATS)
    out = np.full((len(decisions_ns), width), np.nan)
    if len(ts_ns) == 0 or len(decisions_ns) == 0:
        return out
    values = imu_onset.with_magnitudes(axes)
    rate = 1e9 / tick
    for start in range(0, len(decisions_ns), chunk):
        part = slice(start, start + chunk)
        g = imu_onset.grid(ts_ns, values, decisions_ns[part], hz)
        blocks = []
        for window in grid_windows:
            segment = g[:, -window:, :]
            segment = (segment - segment.mean(axis=1, keepdims=True)) * np.hanning(window)[None, :, None]
            power = np.abs(np.fft.rfft(segment, axis=1)) ** 2          # (n, frequencies, channels)
            freqs = np.fft.rfftfreq(window, 1.0 / rate)
            power, freqs = power[:, 1:, :], freqs[1:]                  # without the mean
            total = power.sum(axis=1) + EPS
            share = power / total[:, None, :]
            stats = [np.log(total)]
            stats += [share[:, (freqs >= lo) & (freqs < hi), :].sum(axis=1) for lo, hi in BANDS]
            stats.append(freqs[np.argmax(power, axis=1)])
            stats.append((share * freqs[None, :, None]).sum(axis=1))
            stats.append(-(share * np.log(share + EPS)).sum(axis=1) / np.log(len(freqs)))
            blocks += [s for s in stats]
        block = np.concatenate(blocks, axis=1)
        block[~np.isfinite(block).all(axis=1)] = np.nan
        out[part] = block
    return out


def with_spectral() -> None:
    """The trainer's inputs with the spectral features after them."""
    base = lt.inputs

    def inputs(spec, recording, decisions_ns):
        x = base(spec, recording, decisions_ns)
        motion_ts, axes = lt.motion_of(recording)
        return np.concatenate([x, spectral(motion_ts, axes, decisions_ns, hz=spec.motion_hz)], axis=1)

    lt.inputs = inputs


def setup(variant: str) -> tuple[int | None, int]:
    """Changes the trainer for the variant; returns how many features a `top` variant keeps, and the motion grid's rate."""
    hz = 25 if variant.endswith("@25") else 100 if variant.endswith("@100") else 50
    if "+spectral" in variant:
        with_spectral()
    return (int(variant.split("-top")[1]) if "-top" in variant else None), hz


class Selected:
    """A model trained on some columns, scoring rows of all of them."""

    def __init__(self, model, columns: np.ndarray):
        self.model, self.columns = model, columns

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        return self.model.predict_proba(x[:, self.columns])


def judged(spec: lt.Spec, recordings, scored) -> dict:
    """The replay at every cut-off over the scored recordings; the best catch within each budget, with where its false
    activations fell."""
    curve = []
    for threshold in THRESHOLDS:
        per = [(rid, lt.detections(spec, recordings[rid], times, scores, lt.policy_for(threshold, spec.trigger)))
               for rid, (times, scores) in scored.items()]
        total = events.summarise([r for _, r in per])
        unseen = events.summarise([r for rid, r in per if rid.endswith(UNSEEN)])
        curve.append({"threshold": threshold, "caught": total["caught"], "gestures": total["gestures"],
                      "falseActivations": total["falseActivations"], "perHour": total["falseActivationsPerHour"],
                      "repeats": total["repeats"], "falseOn": total.get("falseOn", {}),
                      "unseenCaught": unseen["caught"], "unseenGestures": unseen["gestures"],
                      "medianLatencyMs": total.get("medianLatencyMs")})
    best = {}
    for budget in BUDGETS:
        within = [p for p in curve if p["perHour"] is not None and p["perHour"] <= budget]
        best[str(budget)] = max(within, key=lambda p: (p["caught"], p["threshold"])) if within else None
    return {"curve": curve, "best": best}


def run(target: str, variant: str, seed: int) -> dict:
    keep, hz = setup(variant)
    spec = replace(spec_for(target, hz), seed=seed)
    recordings = lt.load_spec_recordings(spec)
    started = time.time()
    train = lt.examples(spec, recordings, spec.train)
    model = lt.fit(train.x, train.y, seed, backend=spec.backend)
    width = train.x.shape[1]
    top = None
    if keep is not None:
        order = np.argsort(model.feature_importances_)[::-1]
        columns = np.sort(order[:keep])
        model = Selected(lt.fit(train.x[:, columns], train.y, seed, backend=spec.backend), columns)
        names = feature_names(spec, width)
        top = [names[i] for i in order[:15]]
    scored = {}
    for rid in spec.evaluation:
        result = lt.timeline(spec, recordings[rid], lambda x: model.predict_proba(x)[:, 1])
        if result is not None:
            scored[rid] = result
    out = judged(spec, recordings, scored)
    out.update(seconds=round(time.time() - started), features=width if keep is None else keep, trainMoments=int(train.y.shape[0]))
    if top is not None:
        out["topFeatures"] = top
    return out


def feature_names(spec: lt.Spec, width: int) -> list[str]:
    from label_trainer import ppg_onset

    names = list(ppg_onset.FEATURE_NAMES) + list(imu_onset.FEATURE_NAMES)
    if width > len(names):
        names += [f"spec_{stat}_{c}_w{w}" for w in imu_onset.grid_of(spec.motion_hz)[1] for stat in SPECTRAL_STATS
                  for c in (*imu_onset.AXES, "accel_mag", "gyro_mag")]
    return names[:width]


VARIANTS = ("trees", "trees+spectral", "trees@25", "trees@100", "trees+spectral@100", "trees-top50", "trees-top200", "trees-top500")


def cell(point) -> str:
    if point is None:
        return "none"
    return f"{point['caught']}/{point['gestures']} ({point['unseenCaught']}/{point['unseenGestures']}) at {point['threshold']:g}"


def report(target: str, results: dict) -> None:
    lines = [f"# The paper's ideas on the trees, `{target}`", "",
             "Pinches caught of those in the 11 recordings no variant trained on, at the cut-off that catches the most within each",
             "budget of false activations an hour (chosen on these recordings: for comparing variants only). In brackets, of the",
             "three sessions of 9 Nov alone. See `paper_experiments.py`.", "",
             "| variant | seed | features | " + " | ".join(f"within {b:g} an hour" for b in BUDGETS) + " | seconds |",
             "|---|---:|---:|" + "---|" * len(BUDGETS) + "---:|"]
    for name in [v for v in VARIANTS if v in results] + sorted(set(results) - set(VARIANTS)):
        for seed, run in sorted(results[name].items(), key=lambda item: int(item[0])):
            lines.append(f"| {name} | {seed} | {run['features']} | " + " | ".join(cell(run["best"][str(b)]) for b in BUDGETS)
                         + f" | {run['seconds']} |")
    lines += ["", "## Where the false activations fell", "",
              "At each run's best cut-off within 5 an hour: the label held where the start it fired for would be.", "",
              "| variant | seed | false activations | on |", "|---|---:|---:|---|"]
    for name in [v for v in VARIANTS if v in results]:
        for seed, run in sorted(results[name].items(), key=lambda item: int(item[0])):
            point = run["best"]["5.0"]
            if point:
                on = ", ".join(f"{label} {n}" for label, n in sorted(point["falseOn"].items(), key=lambda kv: -kv[1]))
                lines.append(f"| {name} | {seed} | {point['falseActivations']} | {on or '-'} |")
    tops = [(name, seed, run["topFeatures"]) for name in results for seed, run in results[name].items() if "topFeatures" in run]
    if tops:
        name, seed, top = tops[0]
        lines += ["", f"## The 15 features the trees found most useful ({name}, seed {seed})", "", *[f"- `{f}`" for f in top]]
    (HERE / f"results-{target}.md").write_text("\n".join(lines) + "\n")


def main() -> None:
    target = sys.argv[1]
    variants = sys.argv[2:] or list(VARIANTS)
    path = HERE / f"results-{target}.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    for variant in variants:
        for seed in SEEDS:
            if str(seed) in results.get(variant, {}):
                continue
            print(f"{variant} seed {seed}...", flush=True)
            # Each variant changes module state, so each runs in a fresh interpreter.
            import subprocess

            done = subprocess.run([sys.executable, __file__, "--one", target, variant, str(seed)], capture_output=True, text=True)
            if done.returncode != 0:
                print(done.stderr[-3000:], flush=True)
                continue
            results.setdefault(variant, {})[str(seed)] = json.loads(done.stdout.strip().splitlines()[-1])
            path.write_text(json.dumps(results, indent=1))
            report(target, results)
            best = results[variant][str(seed)]["best"]
            print(f"  {' | '.join(cell(best[str(b)]) for b in BUDGETS)}", flush=True)
    report(target, results)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--one":
        print(json.dumps(run(sys.argv[2], sys.argv[3], int(sys.argv[4]))))
    else:
        main()
