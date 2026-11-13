"""What kind of miss is each pinch the model does not catch?

Replays the new `pinch_in` model (`runs/final-pinch_in/bundle`, built by `final_models.py`) over the 11 recordings it never
trained on, at its own cut-off, and sorts every labelled pinch into: caught in its window; fired late (the action still
happens, after the window); or silent (nothing fired while the pinch was under way). For the late ones, how late; for the
silent ones, how high the score got, and how much the wrist was turning in the two seconds before.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/training-improvements-2026-11/misses.py
"""
from __future__ import annotations

import json

import numpy as np

from experiment import HERE, UNSEEN, spec_for
from label_trainer import cnn, label_train as lt, ppg_onset
from label_trainer.events import detect


def main() -> None:
    bundle = HERE / "runs" / "final-pinch_in" / "bundle"
    manifest = json.loads((bundle / "manifest.json").read_text())
    threshold = manifest["thresholds"]["activation"]
    model = (bundle / manifest["model"]["file"]).read_bytes()
    spec = spec_for("pinch_in")
    recordings = lt.load_spec_recordings(spec)
    earliest_ms, latest_ms = ppg_onset.match_window_ms(spec.decision_delay_ms)
    rows = []
    for rid in spec.evaluation:
        recording = recordings[rid]
        held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
        starts = sorted(s for s, _, label in held if label == "pinch_in")
        if not starts:
            continue
        ends = {s: max([e for s2, e, label in held if label.startswith("pinch") and s <= s2 <= s + 6e9] + [s + latest_ms * 1e6]) for s in starts}
        ts, _ = lt.pulse_of(recording)
        x = lt.inputs(spec, recording, ts)
        ok = np.isfinite(x).all(axis=1)
        times, scores = ts[ok], cnn.predict(model, x[ok])
        rises = np.array([rise for rise, _ in detect(times, scores, lt.policy_for(threshold, spec.trigger))], dtype=np.int64)
        motion_ts, motion = lt.motion_of(recording)
        for s in starts:
            if not (times[0] <= s + earliest_ms * 1e6 <= times[-1]):
                continue
            during = rises[(rises >= s) & (rises <= ends[s])]
            delay = (during[0] - s) / 1e6 if len(during) else None
            near = (times >= s) & (times <= s + 2e9)
            before = (motion_ts >= s - 2e9) & (motion_ts < s)
            turning = float(np.sqrt((motion[before, 3:6] ** 2).sum(axis=1).mean())) if before.any() else float("nan")
            kind = "silent" if delay is None else "caught" if earliest_ms <= delay <= latest_ms else "early" if delay < earliest_ms else "late"
            rows.append({"recording": rid[16:], "unseen": rid.endswith(UNSEEN), "kind": kind, "delayMs": delay,
                         "peak": float(scores[near].max()) if near.any() else None, "turningBefore": turning})
    total = len(rows)
    lines = ["# What kind of miss is each pinch not caught?", "",
             f"The new `pinch_in` model at its own cut-off ({threshold}) over the 11 recordings it never trained on: {total} pinches.",
             f"A pinch is caught when the model fires {earliest_ms} to {latest_ms} ms after its labelled start. See `misses.py`.", "",
             "| what happened | pinches | share |", "|---|---:|---:|"]
    for kind, text in (("caught", "caught in its window"), ("late", "fired late: the action happens, after the window"),
                       ("early", "fired early: before the window"), ("silent", "silent: nothing fired during the pinch")):
        n = sum(r["kind"] == kind for r in rows)
        lines.append(f"| {text} | {n} | {100 * n / total:.0f}% |")
    late = sorted(r["delayMs"] for r in rows if r["kind"] == "late")
    if late:
        lines += ["", "Late firings, ms after the labelled start: " + ", ".join(f"{d:.0f}" for d in late) + "."]
    silent = [r for r in rows if r["kind"] == "silent"]
    if silent:
        peaks = sorted(r["peak"] for r in silent)
        lines += ["", "Silent pinches' highest score in the 2 s after the start: " + ", ".join(f"{p:.2f}" for p in peaks) + ".",
                  f"{sum(p >= 0.9 for p in peaks)} of {len(peaks)} reached 0.9; {sum(p < 0.5 for p in peaks)} stayed under 0.5."]
    def turning(kind):
        values = [r["turningBefore"] for r in rows if r["kind"] == kind and np.isfinite(r["turningBefore"])]
        return f"{np.median(values):.2f} (most {max(values):.2f})" if values else "-"
    lines += ["", "Wrist turning in the 2 s before the start (gyroscope RMS, rad/s; median and most): caught " + turning("caught")
              + ", late " + turning("late") + ", silent " + turning("silent") + "."]
    by_recording = {}
    for r in rows:
        counts = by_recording.setdefault(r["recording"], {"caught": 0, "late": 0, "early": 0, "silent": 0})
        counts[r["kind"]] += 1
    lines += ["", "| recording | caught | late | early | silent |", "|---|---:|---:|---:|---:|"]
    lines += [f"| {name} | {c['caught']} | {c['late']} | {c['early']} | {c['silent']} |" for name, c in by_recording.items()]
    (HERE / "misses.md").write_text("\n".join(lines) + "\n")
    (HERE / "misses.json").write_text(json.dumps(rows, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
