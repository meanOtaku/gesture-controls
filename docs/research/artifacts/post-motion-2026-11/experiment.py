"""Does training on pinches made right after arm motion close the short blind spot that is left after motion?

The motion-filtered scaling (`cnn_input.moving_ticks`) removed the long blind spot. What is left is the first half second
after the wrist stops: `../readiness-2026-11` caught 53-77% of pinches made within 0.5 s of motion stopping, against
94-97% after 1 s of calm. No training pinch has motion close before it, so the model may simply never have seen one.

Both models train with the spec of the application's current model (`pinch_in-8f79677396d8`: CNN v2, 100 Hz, pinch in,
hold and out), with hand labels throughout (no `labelTiming`) and research checks off, i.e. `spec.json` here.

* `base`  the trainer as it is.
* `post`  the same, plus POST_COPIES copies of each training gesture recording in which, before each pinch-in start that
          has room, DURATION_S of real arm motion from the TRAINING everyday-noise recordings replaces both streams (the
          pulse level-matched), ending GAP_S before the start. Only the decisions from the motion's start to 1.5 s after
          the pinch are added, so the copies teach "motion, then calm, then a pinch" and the motion itself as no gesture.
          A gesture the motion overwrites loses its label, and the decisions around it are dropped.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/post-motion-2026-11/experiment.py train base|post [seed]
    tools/label-trainer/.venv/bin/python docs/research/artifacts/post-motion-2026-11/experiment.py evaluate

`evaluate` scores every trained run here:

1. Splice test: the pinch-in starts of the three long held-out pinch recordings, with the held-out everyday-noise
   recording's most intense motion (lasting 2, 6, 10 or 14 s) spliced in to end 0.25, 0.5, 1 or 2 s before each. A pinch
   counts when the gated pinch-in score from 0.1 to 1 s after its start reaches the model's own pinch-in cut-off.
2. Event replay over all 17 held-out recordings at a sweep of cut-offs: pinches caught, false activations an hour.

Writes `results.json` and `results.md`. Runs go to `runs/<variant>-<seed>/` (not committed: the bundles are large).
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn_input, cnn_v2, label_train as lt, multi_gesture as mg, ppg_onset  # noqa: E402
from label_trainer.events import summarise  # noqa: E402

S = 1_000_000_000
POST_COPIES = 2
DURATION_S = (1.0, 12.0)        # uniform
GAP_S = (0.1, 3.0)              # log-uniform: most mass close to the pinch, where the misses are
MIN_MEAN_GYRO = 1.0             # rad/s: a motion stretch must average at least this (the moving-tick level)
AFTER_S = 1.5                   # decisions kept after each pinch start
DROP_S = (0.5, 1.5)             # around an overwritten gesture, decisions dropped before its start and after its end
TEST_DURATIONS = (2.0, 6.0, 10.0, 14.0)
TEST_GAPS = (0.25, 0.5, 1.0, 2.0)
SWEEP = (0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5)
RUNS = HERE / "runs"


def raw_spec(seed: int = 17) -> dict:
    return {**json.loads((HERE / "spec.json").read_text()), "seed": seed}


# ------------------------------------------------------------------------------------------------- splicing a recording

def splice(recording, source, at: int, source_at: int, width: int):
    """A copy of `recording` whose motion and pulse in [at, at + width) are `source`'s from [source_at, ...), moved in time
    (the pulse shifted to the level just before `at`), with the labels there cleared."""
    ts = recording.timestamps_ns
    rows = (ts >= at) & (ts < at + width)
    channels = dict(recording.channels)
    m_ts, motion = lt.motion_of(source)
    p_ts, pulse = lt.pulse_of(source)
    src = ts[rows] - at + source_at
    for i, axis in enumerate(("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")):
        values = channels[axis].copy()
        values[rows] = np.interp(src, m_ts, motion[:, i])
        channels[axis] = values
    own_ts, own_pulse = lt.pulse_of(recording)
    before = own_pulse[(own_ts < at) & (own_ts >= at - S // 2)]
    first = pulse[(p_ts >= source_at) & (p_ts < source_at + S // 2)]
    shift = (before.mean(axis=0) if len(before) else own_pulse[:25].mean(axis=0)) - (first.mean(axis=0) if len(first) else 0)
    for i, name in enumerate(("ppg_green", "ppg_red", "ppg_ir")):
        values = channels[name].copy()
        values[rows] = np.interp(src, p_ts, pulse[:, i]) + shift[i]
        channels[name] = values
    labels = recording.raw_labels.copy()
    labels[rows] = ""
    return replace(recording, channels=channels, raw_labels=labels)


def intense_start(source, width: int, rng: np.random.Generator, tries: int = 40) -> int | None:
    """A start in `source` where `width` of motion averages at least MIN_MEAN_GYRO; the most intense of `tries` random ones."""
    m_ts, motion = lt.motion_of(source)
    if m_ts[-1] - m_ts[0] <= width:
        return None
    gyro = np.linalg.norm(motion[:, 3:6], axis=1)
    cum = np.concatenate([[0.0], np.cumsum(gyro)])
    starts = rng.integers(int(m_ts[0]), int(m_ts[-1]) - width, tries)
    lo, hi = np.searchsorted(m_ts, starts), np.searchsorted(m_ts, starts + width)
    mean = (cum[hi] - cum[lo]) / np.maximum(hi - lo, 1)
    best = int(np.argmax(mean))
    return int(starts[best]) if mean[best] >= MIN_MEAN_GYRO else None


def busiest(source, seconds: float, count: int) -> list[int]:
    """Starts of the `count` most intense non-overlapping stretches of `seconds` (`../readiness-2026-11`)."""
    m_ts, motion = lt.motion_of(source)
    width = int(seconds * S)
    gyro_power = np.sum(motion[:, 3:6] ** 2, axis=1)
    starts = np.arange(m_ts[0], m_ts[-1] - width, S // 4)
    cum = np.concatenate([[0.0], np.cumsum(gyro_power)])
    score = (cum[np.searchsorted(m_ts, starts + width)] - cum[np.searchsorted(m_ts, starts)]) / width
    chosen: list[int] = []
    for i in np.argsort(score)[::-1]:
        if all(abs(starts[i] - c) >= width for c in chosen):
            chosen.append(int(starts[i]))
        if len(chosen) == count:
            break
    return chosen


# ------------------------------------------------------------------------------------------------- the post-motion copies

def post_motion_copies(spec, recordings, train, say=lambda _: None):
    """`train` plus the post-motion copies (see the module docstring); grouped with their recording, as the overlays are."""
    noise = [recordings[rid] for rid in spec.train if "everyday_noise" in set(recordings[rid].raw_labels.tolist())
             and not any(label in spec.gestures for _, _, label in ppg_onset.holds(recordings[rid].timestamps_ns, recordings[rid].raw_labels))]
    rng = np.random.default_rng(spec.seed + 1000)
    xs, ys, groups, kinds, decisions = [train.x], [train.y], [train.groups], list(train.kinds), [train.decisions]
    spliced = 0
    for rid in spec.train:
        recording = recordings[rid]
        held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
        starts = [s for s, _, label in held if label == "pinch_in"]
        if not starts:
            continue
        first_ok = int(recording.timestamps_ns[0]) + 11 * S
        for _ in range(POST_COPIES):
            copy, keep_spans, drop_spans, free_from = recording, [], [], first_ok
            for start in starts:
                duration = rng.uniform(*DURATION_S)
                gap = float(np.exp(rng.uniform(np.log(GAP_S[0]), np.log(GAP_S[1]))))
                at, width = start - int((gap + duration) * S), int(duration * S)
                if at < free_from:
                    continue
                source = noise[rng.integers(len(noise))]
                source_at = intense_start(source, width, rng)
                if source_at is None:
                    continue
                copy = splice(copy, source, at, source_at, width)
                for s, e, label in held:  # gestures the motion overwrote: unlabelled, their decisions dropped
                    if label and s < at + width and e >= at:
                        copy = replace(copy, raw_labels=np.where((copy.timestamps_ns >= s) & (copy.timestamps_ns <= e), "", copy.raw_labels))
                        drop_spans.append((s - int(DROP_S[0] * S), e + int(DROP_S[1] * S)))
                keep_spans.append((at, start + int(AFTER_S * S)))
                free_from = start + int(AFTER_S * S) + 2 * S
                spliced += 1
            if not keep_spans:
                continue
            d, y, k = lt.cnn_examples(spec, copy)
            inside = np.zeros(len(d), dtype=bool)
            for a, b in keep_spans:
                inside |= (d >= a) & (d <= b)
            for a, b in drop_spans:
                inside &= ~((d >= a) & (d <= b))
            d, y, k = d[inside], y[inside], [kind for kind, keep in zip(k, inside.tolist()) if keep]
            x = lt.inputs(spec, copy, d)
            ok = np.isfinite(x).all(axis=1) & spec.decided(rid, d)
            xs.append(x[ok]); ys.append(y[ok]); groups.append(np.array([rid] * int(ok.sum())))
            kinds += [kind for kind, keep in zip(k, ok.tolist()) if keep]; decisions.append(d[ok])
    added = sum(len(v) for v in ys[1:])
    say(f"Added {added} decisions from post-motion copies: {spliced} pinch-in starts with arm motion spliced in before them")
    return lt.Examples(np.concatenate(xs), np.concatenate(ys), np.concatenate(groups), kinds, np.concatenate(decisions))


def train(variant: str, seed: int) -> None:
    out = RUNS / f"{variant}-{seed}"
    out.mkdir(parents=True, exist_ok=True)
    if variant == "post":
        original = lt.overlay_copies

        def with_post_motion(spec, recordings, examples, say=lambda _: None):
            return post_motion_copies(spec, recordings, original(spec, recordings, examples, say), say)
        lt.overlay_copies = with_post_motion
    elif variant != "base":
        raise SystemExit(f"unknown variant {variant}")
    result = lt.run(raw_spec(seed), out)
    print(json.dumps({"outcome": result["outcome"], "message": result["message"]}), flush=True)


# ------------------------------------------------------------------------------------------------- evaluation

def evaluate() -> None:
    raw = raw_spec()
    held_out = raw["evaluation"]
    spec = lt.parse_spec({**raw, "train": [], "recordings": {r: raw["recordings"][r] for r in held_out},
                          "sessions": {r: s for r, s in raw.get("sessions", {}).items() if r in held_out},
                          "decideFromNs": {r: t for r, t in raw.get("decideFromNs", {}).items() if r in held_out}})
    recordings = lt.load_spec_recordings(spec)
    labels_of = {r: [label for _, _, label in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)] for r, rec in recordings.items()}
    noise = next(recordings[r] for r, labels in labels_of.items() if labels == ["everyday_noise"])
    pinches = [r for r, rec in recordings.items() if labels_of[r].count("pinch_in") >= 20]
    results = {}
    for run in sorted(p for p in RUNS.iterdir() if (p / "gestures" / "pinch_in" / "bundle" / "manifest.json").exists()):
        bundle = run / "gestures" / "pinch_in" / "bundle"
        manifest = json.loads((bundle / "manifest.json").read_text())
        model = (bundle / "model.cnn").read_bytes()
        gated = replace(spec, gate_min_jerk=manifest["preprocessing"]["gate"]["minJerk"])
        cutoffs = {g: json.loads((run / "gestures" / g / "evaluation.json").read_text())["activationThreshold"] for g in spec.classes}
        own = cutoffs["pinch_in"]
        predict = lambda x: cnn_v2.predict(model, x)  # noqa: E731

        def peak(recording, start: int) -> float | None:
            ts, _ = lt.pulse_of(recording)
            d = ts[(ts >= start + S // 10) & (ts <= start + S)]
            x = lt.inputs(gated, recording, d)
            ok = np.isfinite(x).all(axis=1)
            if not ok.any():
                return None
            p = np.asarray(predict(x[ok]))[:, 1]
            m_ts, axes = lt.motion_of(recording)
            p = np.where(cnn_input.spike(m_ts, axes, d[ok]) >= gated.gate_min_jerk, p, 0.0)
            return float(p.max())

        splices = []
        for rid in pinches:
            rec = recordings[rid]
            starts = [s for s, _, label in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
                      if label == "pinch_in" and s - 25 * S > rec.timestamps_ns[0]]
            for start in starts:
                splices.append({"recording": rid, "duration": 0.0, "gap": None, "peak": peak(rec, start)})
            for duration in TEST_DURATIONS:
                sources = busiest(noise, duration, 3)
                for gap in TEST_GAPS:
                    for k, start in enumerate(starts):
                        at = start - int((gap + duration) * S)
                        copy = splice(rec, noise, at, sources[k % 3], int(duration * S))
                        splices.append({"recording": rid, "duration": duration, "gap": gap, "peak": peak(copy, start)})
        timelines = []
        for rid in sorted(held_out):
            t = mg.all_timelines(gated, recordings[rid], predict)
            if t is not None:
                timelines.append((rid, recordings[rid], *t))
        one = mg.for_gesture(gated, "pinch_in")
        sweep = []
        for threshold in sorted(set(SWEEP) | {own}, reverse=True):
            s = summarise([lt.detections(one, rec, ts, p[:, 1], lt.policy_for(threshold, one.trigger)) for _, rec, ts, p in timelines])
            sweep.append({"threshold": threshold, **{k: s[k] for k in ("gestures", "caught", "falseActivations",
                                                                          "negativeSeconds", "falseActivationsPerHour", "medianLatencyMs")}})
        results[run.name] = {"cutoffs": cutoffs, "gateMinJerk": gated.gate_min_jerk, "splices": splices, "sweep": sweep,
                             "confusion": mg.event_confusion(gated, timelines, cutoffs)}
        print(run.name, "evaluated", flush=True)
    (HERE / "results.json").write_text(json.dumps(results, indent=1))
    report(results)


def report(results: dict) -> None:
    lines = ["# Training on pinches made right after arm motion", "", "See `experiment.py`. One seed per variant unless named.", ""]
    names = sorted(results)
    lines += ["## Splice test: held-out pinch-in starts caught after spliced held-out motion", "",
              "Each model at its own pinch-in cut-off; then each at the base model's cut-off.", ""]
    base_cut = next((results[n]["cutoffs"]["pinch_in"] for n in names if n.startswith("base")), None)
    for label, cut_of in (("own cut-off", lambda n: results[n]["cutoffs"]["pinch_in"]), ("base's cut-off", lambda n: base_cut)):
        if cut_of(names[0]) is None:
            continue
        lines += [f"### At {label}", "", "| motion | gap | " + " | ".join(f"{n} ({cut_of(n):g})" for n in names) + " |",
                  "|---|---|" + "---|" * len(names)]
        conditions = [(0.0, None)] + [(d, g) for d in TEST_DURATIONS for g in TEST_GAPS]
        for duration, gap in conditions:
            cells = []
            for n in names:
                rows = [r for r in results[n]["splices"] if r["duration"] == duration and r["gap"] == gap]
                caught = sum(r["peak"] is not None and r["peak"] >= cut_of(n) for r in rows)
                cells.append(f"{caught}/{len(rows)}")
            lines.append(f"| {'none' if not duration else f'{duration:g} s'} | {'' if gap is None else f'{gap:g} s'} | " + " | ".join(cells) + " |")
        lines.append("")
    lines += ["## Event replay over the 17 held-out recordings (pinch in)", "",
              "| threshold | " + " | ".join(f"{n} caught | {n} false/h" for n in names) + " |", "|---|" + "---|---|" * len(names)]
    thresholds = sorted({row["threshold"] for n in names for row in results[n]["sweep"]}, reverse=True)
    for th in thresholds:
        cells = []
        for n in names:
            row = next((r for r in results[n]["sweep"] if r["threshold"] == th), None)
            cells += [f"{row['caught']}/{row['gestures']}", f"{row['falseActivationsPerHour']:.1f}"] if row else ["", ""]
        lines.append(f"| {th:g} | " + " | ".join(cells) + " |")
    (HERE / "results.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "train":
        train(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 17)
    elif sys.argv[1:] == ["evaluate"]:
        evaluate()
    else:
        raise SystemExit(__doc__)
