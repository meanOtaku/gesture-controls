"""When can the pinch CNN catch a pinch again after the wrist moved, and what can tell the user so?

The 100 Hz CNN (`cnn_input.GRIDS[100]`) trained as the trainer does on the 22 recordings of
`../training-improvements-2026-11/experiment.py`, at a cut-off of 0.99 (what the app's training chose for it). Before each
pinch-in start of the 6 held-out pinch recordings, a real burst of wrist motion from the held-out everyday-noise recording
(11-04T04-27, its most intense stretches) is spliced into both streams (the pulse level-matched), lasting D seconds and ending
G seconds before the start. A pinch counts when the peak score 0.1-1 s after its start reaches the cut-off.

At the start (before the pinch moves anything) it also records what a readiness light could show, from the inputs' own grid:

* `calm_s`      how long since the wrist last turned fast (`cnn_input.moving_ticks`' rule: 0.3 s gyroscope RMS > 1 rad/s);
* `kept_share`  the share of the 11 s grid the scaling keeps (the ticks not left out as moving);
* `inputs`      whether the model has inputs at all (no gap over 250 ms in the 11 s).

    tools/label-trainer/.venv/bin/python docs/research/artifacts/readiness-2026-11/readiness.py

Writes `results.json` and `results.md`.
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "training-improvements-2026-11"))

from experiment import spec_for  # noqa: E402
from label_trainer import cnn_input, label_train as lt, ppg_onset  # noqa: E402

HZ = 100
THRESHOLD = 0.99
NOISE = "gesture-dataset-everyday_noise-2026-11-04T04-27-35.286Z"
DURATIONS = (2.0, 6.0, 10.0, 14.0)
GAPS = (0.25, 0.5, 1.0, 2.0, 4.0)
S = 1_000_000_000


def busiest(ts: np.ndarray, gyro_power: np.ndarray, seconds: float, count: int) -> list[int]:
    """Start times of the `count` most intense non-overlapping stretches of `seconds`."""
    width = int(seconds * S)
    starts = np.arange(ts[0], ts[-1] - width, S // 4)
    cum = np.concatenate([[0.0], np.cumsum(gyro_power)])
    score = [(cum[np.searchsorted(ts, s + width)] - cum[np.searchsorted(ts, s)]) / width for s in starts]
    chosen: list[int] = []
    for i in np.argsort(score)[::-1]:
        if all(abs(starts[i] - c) >= width for c in chosen):
            chosen.append(int(starts[i]))
        if len(chosen) == count:
            break
    return chosen


def splice(ts, values, source_ts, source_values, at: int, source_at: int, width: int, level: bool):
    """`ts`/`values` with [at, at + width) replaced by the source's [source_at, source_at + width), moved in time."""
    keep = (ts < at) | (ts >= at + width)
    take = (source_ts >= source_at) & (source_ts < source_at + width)
    moved = source_ts[take] - source_at + at
    inserted = source_values[take].copy()
    if level and inserted.size and keep.any():
        before = values[ts < at][-50:] if (ts < at).any() else values[keep][:50]
        inserted += before.mean(axis=0) - inserted[:50].mean(axis=0)
    out_ts = np.concatenate([ts[keep], moved])
    order = np.argsort(out_ts, kind="stable")
    return out_ts[order], np.concatenate([values[keep], inserted])[order]


def readiness(motion_ts, motion, pulse_ts, pulse, at: int) -> dict:
    g = cnn_input.grid_of(HZ)
    grid = cnn_input._held(motion_ts, motion, np.array([at]), g)[0]
    if not np.isfinite(grid).all():
        return {"inputs": False, "calm_s": None, "kept_share": None}
    left_out = cnn_input.moving_ticks(grid[None], g)[0]
    # How long since a tick was moving (the margin aside): the raw rule, without the dilation.
    power = np.sum(grid[:, 3:6] ** 2, axis=1)
    total = np.concatenate([[0.0], np.cumsum(power)])
    end = np.arange(1, len(grid) + 1)
    begin = np.maximum(end - g.moving_rms, 0)
    moving = (total[end] - total[begin]) / (end - begin) > cnn_input.MOVING_GYRO ** 2
    last = np.flatnonzero(moving)
    calm = (len(grid) - 1 - last[-1]) * g.tick_ns / S if last.size else len(grid) * g.tick_ns / S
    gap_ok = bool(cnn_input._gap_free(motion_ts, np.array([at]), g)[0] and cnn_input._gap_free(pulse_ts, np.array([at]), g)[0])
    return {"inputs": gap_ok, "calm_s": round(float(calm), 2), "kept_share": round(float(1 - left_out[: -g.window].mean()), 3)}


def main() -> None:
    spec = replace(spec_for("pinch_in"), motion_hz=HZ, seed=17)
    recordings = lt.load_spec_recordings(spec)
    print("training the 100 Hz CNN...", flush=True)
    train = lt.examples(spec, recordings, spec.train)
    model = lt.fit(train.x, train.y, spec.seed, backend=spec.backend)

    noise = recordings[NOISE]
    n_ts, n_motion = lt.motion_of(noise)
    p_ts, p_values = lt.pulse_of(noise)
    power = np.interp(n_ts, n_ts, np.sum(n_motion[:, 3:6] ** 2, axis=1))
    rows = []
    for rid in [r for r in spec.evaluation if "pinch" in r]:
        rec = recordings[rid]
        m_ts, motion = lt.motion_of(rec)
        q_ts, pulse = lt.pulse_of(rec)
        held = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
        starts = [s for s, _, label in held if label == "pinch_in" and s - 25 * S > q_ts[0]]
        for duration in DURATIONS:
            sources = busiest(n_ts, power, duration, 3)
            for gap in GAPS:
                for k, start in enumerate(starts):
                    at = start - int((gap + duration) * S)
                    source = sources[k % len(sources)]
                    mt, mv = splice(m_ts, motion, n_ts, n_motion, at, source, int(duration * S), level=False)
                    pt, pv = splice(q_ts, pulse, p_ts, p_values, at, source, int(duration * S), level=True)
                    decisions = pt[(pt >= start + S // 10) & (pt <= start + S)]
                    x = cnn_input.inputs(mt, mv, pt, pv, decisions, hz=HZ)
                    ok = np.isfinite(x).all(axis=1)
                    peak = float(model.predict_proba(x[ok])[:, 1].max()) if ok.any() else None
                    rows.append({"recording": rid[-29:], "start": int(start), "duration": duration, "gap": gap,
                                 "caught": peak is not None and peak >= THRESHOLD, "peak": peak,
                                 **readiness(mt, mv, pt, pv, start)})
        # The same pinches with nothing spliced.
        for start in starts:
            decisions = q_ts[(q_ts >= start + S // 10) & (q_ts <= start + S)]
            x = cnn_input.inputs(m_ts, motion, q_ts, pulse, decisions, hz=HZ)
            ok = np.isfinite(x).all(axis=1)
            peak = float(model.predict_proba(x[ok])[:, 1].max()) if ok.any() else None
            rows.append({"recording": rid[-29:], "start": int(start), "duration": 0.0, "gap": None,
                         "caught": peak is not None and peak >= THRESHOLD, "peak": peak, **readiness(m_ts, motion, q_ts, pulse, start)})
        print(f"{rid[-29:]}: {len(starts)} starts", flush=True)
    (HERE / "results.json").write_text(json.dumps(rows))
    report(rows)


def report(rows: list[dict]) -> None:
    lines = ["# Catching a pinch after the wrist moved (100 Hz CNN, cut-off 0.99)", "",
             "Pinch-in starts of the 6 held-out pinch recordings, with real everyday motion spliced in before each. See",
             "`readiness.py`.", "", "## Caught, by how long the motion lasted and how long before the pinch it ended", "",
             "| motion | " + " | ".join(f"{g:g} s before" for g in GAPS) + " |", "|---|" + "---|" * len(GAPS)]
    quiet = [r for r in rows if r["duration"] == 0]
    lines.append(f"| none | {sum(r['caught'] for r in quiet)}/{len(quiet)} |" + " |" * (len(GAPS) - 1))
    for d in DURATIONS:
        cells = []
        for g in GAPS:
            sel = [r for r in rows if r["duration"] == d and r["gap"] == g]
            cells.append(f"{sum(r['caught'] for r in sel)}/{len(sel)}")
        lines.append(f"| {d:g} s | " + " | ".join(cells) + " |")
    lines += ["", "## Caught, by what a readiness light would have shown at the start", "",
              "| calm for | kept share | pinches | caught |", "|---|---|---:|---:|"]
    spliced = [r for r in rows if r["inputs"]]
    for lo, hi in ((0, 0.5), (0.5, 1), (1, 2), (2, 99)):
        for klo, khi in ((0, 0.25), (0.25, 0.5), (0.5, 1.01)):
            sel = [r for r in spliced if lo <= (r["calm_s"] or 0) < hi and klo <= r["kept_share"] < khi]
            if sel:
                lines.append(f"| {lo:g}-{hi:g} s | {klo:g}-{khi:g} | {len(sel)} | {sum(r['caught'] for r in sel)} ({100 * sum(r['caught'] for r in sel) // len(sel)}%) |")
    (HERE / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
