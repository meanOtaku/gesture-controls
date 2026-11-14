"""The phase 2 candidate, end to end: per-sensor branches + warping + jerk envelope (3 networks averaged), optionally
trained with noise-overlay augmentation, peak-gated, and with its threshold chosen without the test set
(`bench.choose_threshold_v2`). The test set is used once, to score the chosen model at the chosen threshold.

Noise overlay: each training pinch recording gets `--copies` extra copies whose raw accelerometer and gyroscope carry
wrist motion from the TRAINING everyday-noise recordings (never the test noise): a random stretch of the noise stream,
minus its own mean, times a random factor in `SCALE`, added sample by sample (interpolated onto the pinch's motion
times). Labels and pulse are unchanged. A copy counts as its source recording when folds are made.

Gate: as `gate.py`, a decision may fire only if the raw accelerometer jerk reached the `--gate-q` quantile of the training
pinch moments within the last `--gate-ms`.

Run: tools/label-trainer/.venv/bin/python docs/research/artifacts/pinch-cnn-v2-2026-11/exp_final.py --copies 2
"""
import argparse
import dataclasses
import json

import numpy as np

import bench
import exp_cnn
import gate as gating
import inputs_v2
from label_trainer import imu_onset, label_train

NOISE = [bench.P + "everyday_noise-2026-11-04T03-44-21.667Z", bench.P + "unlabeled-2026-11-14T09-58-34.967Z"]
SCALE = (0.5, 1.0)


def overlaid(rec, noise_recs, rng):
    """A copy of `rec` with a random stretch of training wrist motion added to its raw accelerometer and gyroscope."""
    ts = rec.timestamps_ns
    span = ts[-1] - ts[0]
    src = noise_recs[rng.integers(len(noise_recs))]
    nts, nm = label_train.motion_of(src)
    if nts[-1] - nts[0] <= span:
        return None
    start = nts[0] + rng.integers(0, int(nts[-1] - nts[0] - span))
    pick = (nts >= start) & (nts <= start + span)
    t_rel, m = nts[pick] - start, nm[pick]
    m = (m - m.mean(axis=0)) * rng.uniform(*SCALE)
    channels = dict(rec.channels)
    for i, axis in enumerate(imu_onset.AXES):
        channels[axis] = rec.channels[axis] + np.interp(ts - ts[0], t_rel, m[:, i])
    return dataclasses.replace(rec, channels=channels)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--copies", type=int, default=0)
    ap.add_argument("--members", type=int, default=3)
    ap.add_argument("--gate-ms", type=int, default=600)
    ap.add_argument("--gate-q", type=float, default=0.10)
    ap.add_argument("--budget", type=float, default=5.0)
    ap.add_argument("--seed", type=int, default=17)
    a = ap.parse_args()
    hz = 100
    name = f"final-branches-warp-env-m{a.members}" + (f"-overlay{a.copies}" if a.copies else "") + f"-gate{a.gate_ms}q{int(a.gate_q * 100):02d}"

    inputs, input_name = inputs_v2.make(env=True)
    exp_cnn.GROUPS = inputs_v2.channel_groups(env=True)[0]
    args = argparse.Namespace(arch="branches", hz=hz, jerk=False, warp=True, hard=False, members=a.members, seed=a.seed)
    fit = exp_cnn.make_fit(args)

    data = bench.training_data(inputs, input_name, hz)
    if a.copies:
        rng = np.random.default_rng(a.seed)
        noise_recs = [bench.recording(r) for r in NOISE]
        spec = bench.spec_for(bench.SPLIT["train"], hz)
        xs, ys, gs = [data.x], [data.y], [data.groups]
        for rid in bench.SPLIT["train"]:
            rec = bench.recording(rid)
            if not any(lab == "pinch_in" for _, _, lab in label_train.ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)):
                continue
            for c in range(a.copies):
                aug = overlaid(rec, noise_recs, rng)
                if aug is None:
                    continue
                arid = f"{rid}#overlay{c}-s{a.seed}"
                bench.register(arid, aug)
                d, y, _ = label_train.cnn_examples(spec, aug)
                x = inputs(spec, aug, d)
                ok = np.isfinite(x).all(axis=1)
                xs.append(x[ok].astype(np.float32)); ys.append(y[ok].astype(np.int8)); gs.append(np.array([rid] * int(ok.sum())))
        data = bench.Data(np.concatenate(xs), np.concatenate(ys), np.concatenate(gs))
    print(f"{name}: {len(data.y)} training moments, {int(data.y.sum())} positive", flush=True)

    # Gate level from the training pinch moments only.
    spec = bench.spec_for(bench.SPLIT["train"], hz)
    pos = []
    for rid in bench.SPLIT["train"]:
        rec = bench.recording(rid)
        d, y, _ = label_train.cnn_examples(spec, rec)
        if (y == 1).any():
            pos.append(gating.spike(rec, d[y == 1], a.gate_ms))
    level = float(np.quantile(np.concatenate(pos), a.gate_q))
    gate = lambda rec, t: gating.spike(rec, t, a.gate_ms) >= level

    chosen, oof = bench.choose_threshold_v2(fit, data, inputs, input_name, hz, gate=gate, budget=a.budget)
    print(f"  threshold chosen without the test set: {chosen}", flush=True)
    predict = fit(data)
    res = bench.score(lambda x: predict(x), inputs, input_name, hz)
    # Apply the gate to the scored test timelines and score again.
    timelines = {rid: (t, s * gate(bench.recording(rid), t)) for rid, (t, s) in bench.LAST_TIMELINES.items()}
    res = bench.score_timelines(timelines, hz)
    bench.LAST_TIMELINES.clear(); bench.LAST_TIMELINES.update(timelines)
    bench.save(name, res, chosen, {"copies": a.copies, "members": a.members, "gateMs": a.gate_ms, "gateQ": a.gate_q,
                                   "gateLevel": level, "budget": a.budget, "outOfFold": oof},
               notes=f"Branches + warping + jerk envelope, {a.members} networks" + (f", {a.copies} noise-overlay copies per training pinch recording" if a.copies else "")
                     + f"; peak gate {a.gate_ms} ms at {level:.1f} m/s^3 (training pinches' {a.gate_q:.0%} quantile); threshold chosen out of fold on "
                     f"the training recordings, at most {a.budget:g} false activations an hour on their no-gesture recordings.")


if __name__ == "__main__":
    main()
