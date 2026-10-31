"""Does the Haar wavelet detail set a pinch apart from everything else, in the pulse signal and in the motion sensors?

The Recordings tab's raw image viewer draws a channel's Haar wavelet detail: at each sample, the mean of the `scale`
samples up to and including it less the mean of the `scale` samples after it, over the square root of two
(`recording_bundle::haar_wavelet_detail_by_row`; the viewer's scale is 4 samples). This study computes exactly that, at
scales of 2, 4, 8 and 16 samples, for the three pulse colours (25 Hz: 80 to 640 ms either side) and for the motion sensors
(about 50 Hz: 40 to 320 ms either side): each accelerometer and gyroscope axis and the two magnitudes.

Two questions, each scored by ROC AUC (0.5 is chance, 1.0 is perfect separation), pooled over the 36 recordings, with the
median over recordings beside it:

* **Starts.** Around each labelled pinch start, the largest detail (in units of its recording's spread) from 0.5 s before
  to 1.0 s after the start (labels are often a few hundred milliseconds late), against the same around random moments
  (every half second with no pinch start within 2.5 s) and around other gestures' starts.
* **Holds.** Every sample inside a pinch hold against every sample outside any hold: does the detail itself mark the
  stretch the viewer labels as a pinch? For comparison, the same is scored for the signal's level (detrended over 10 s),
  which is what the grayscale and rainbow views show.

Offline (the detail uses samples after each point, as the viewer does). One recording's spread is its detail's median
absolute deviation, so recordings weigh alike.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/haar_detail_check.py

Run from the repository root (about a minute). Writes haar-detail/results.json and results.md.
"""
import importlib.util, json, sys, time
from dataclasses import replace
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)
sys.path.insert(0, str(HERE.parents[3] / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

MS = 1_000_000
SCALES = (2, 4, 8, 16)
VIEWER_SCALE = 4
AROUND_S = (-0.5, 1.0)          # where a start's largest detail is looked for
RANDOM_EVERY_S, RANDOM_CLEAR_S = 0.5, 2.5
LEVEL_WINDOW_S = 10.0
TARGET = "pinch"


def haar_detail(x, scale):
    """The viewer's Haar detail at every sample: mean of up to `scale` samples ending here less the mean of up to `scale`
    after, over sqrt(2); NaN at the last sample."""
    n = len(x)
    c = np.concatenate([[0.0], np.cumsum(x)])
    i = np.arange(n)
    left_lo = np.maximum(0, i + 1 - scale)
    right_hi = np.minimum(n, i + 1 + scale)
    left = (c[i + 1] - c[left_lo]) / (i + 1 - left_lo)
    with np.errstate(invalid="ignore", divide="ignore"):
        right = (c[right_hi] - c[i + 1]) / (right_hi - (i + 1))
    out = (left - right) / np.sqrt(2)
    out[right_hi <= i + 1] = np.nan
    return out


def robust(x):
    finite = x[np.isfinite(x)]
    spread = np.median(np.abs(finite - np.median(finite))) * 1.4826
    return (x - np.median(finite)) / (spread + 1e-12)


def moving_mean(x, n):
    """The mean of the `n` samples centred on each one (shrinking at the ends)."""
    c = np.concatenate([[0.0], np.cumsum(x)])
    i = np.arange(len(x))
    lo, hi = np.maximum(0, i - n // 2), np.minimum(len(x), i + n // 2 + 1)
    return (c[hi] - c[lo]) / (hi - lo)


def channels(recording):
    """name -> (timestamps, values) for each pulse colour and motion axis, and the motion magnitudes."""
    out = {}
    ts, ppg = lt.pulse_of(recording)
    for c, name in enumerate(("ppg_green", "ppg_red", "ppg_ir")):
        out[name] = (ts, ppg[:, c].astype(float))
    mts, imu = lt.motion_of(recording)
    ok = np.isfinite(imu).all(1)
    mts, imu = mts[ok], imu[ok]
    for c, name in enumerate(("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")):
        out[name] = (mts, imu[:, c])
    out["accel_magnitude"] = (mts, np.linalg.norm(imu[:, :3], axis=1))
    out["gyro_magnitude"] = (mts, np.linalg.norm(imu[:, 3:], axis=1))
    return out


def auc(pos, neg):
    if len(pos) < 3 or len(neg) < 3:
        return None
    return float(roc_auc_score(np.r_[np.ones(len(pos)), np.zeros(len(neg))], np.r_[pos, neg]))


def main():
    t0 = time.time()
    out_dir = HERE / "haar-detail"; out_dir.mkdir(exist_ok=True)
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    starts = {}    # (channel, scale) -> kind -> [values]; and per recording
    per_rec = {}   # (channel, scale) -> [(pinch, random)]
    holds = {}     # (channel, feature) -> (inside values, outside values), subsampled
    names = None
    rng = np.random.default_rng(17)
    for sid, r in inv.items():
        recording = lt.repair_millisecond_ppg_timestamps(load_recording(R.RECORDINGS / Path(r["path"]).name))
        recording = replace(recording, raw_labels=np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels))
        held = P.holds(recording.timestamps_ns, recording.raw_labels)
        pinch = np.array([s for s, _, label in held if label == TARGET], dtype=np.int64)
        other = np.array([s for s, _, label in held if label != TARGET], dtype=np.int64)
        chans = channels(recording)
        names = list(chans)
        for name, (ts, x) in chans.items():
            if len(ts) < 200:
                continue
            span = ts[-1] - ts[0]
            points = np.arange(ts[0] + int(3e9), ts[-1] - int(3e9), int(RANDOM_EVERY_S * 1e9), dtype=np.int64)
            random = points if len(pinch) == 0 else points[np.min(np.abs(points[:, None] - pinch[None, :]), axis=1) > RANDOM_CLEAR_S * 1e9]
            # Inside a pinch hold, or outside every hold.
            inside = np.zeros(len(ts), dtype=bool); anywhere = np.zeros(len(ts), dtype=bool)
            for s, e, label in held:
                m = (ts >= s) & (ts <= e)
                anywhere |= m
                if label == TARGET:
                    inside |= m
            rate = (len(ts) - 1) / (span / 1e9)
            level = robust(x - moving_mean(x, max(3, int(LEVEL_WINDOW_S * rate))))
            pick_in = np.flatnonzero(inside); pick_out = np.flatnonzero(~anywhere)
            pick_in = rng.choice(pick_in, min(len(pick_in), 400), replace=False) if len(pick_in) else pick_in
            pick_out = rng.choice(pick_out, min(len(pick_out), 400), replace=False) if len(pick_out) else pick_out
            entry = holds.setdefault((name, "level"), ([], []))
            entry[0].extend(level[pick_in]); entry[1].extend(level[pick_out])
            for scale in SCALES:
                d = robust(haar_detail(x, scale))
                a = np.abs(d)
                entry = holds.setdefault((name, f"|detail| {scale}"), ([], []))
                entry[0].extend(a[pick_in][np.isfinite(a[pick_in])]); entry[1].extend(a[pick_out][np.isfinite(a[pick_out])])

                def largest(moments):
                    vals = []
                    for t in moments:
                        m = (ts >= t + AROUND_S[0] * 1e9) & (ts <= t + AROUND_S[1] * 1e9)
                        if m.sum() >= 3 and np.isfinite(a[m]).any():
                            vals.append(float(np.nanmax(a[m])))
                    return vals

                key = (name, scale)
                got = {"pinch": largest(pinch), "random": largest(random), "other": largest(other)}
                bucket = starts.setdefault(key, {"pinch": [], "random": [], "other": []})
                for kind, vals in got.items():
                    bucket[kind].extend(vals)
                per = auc(got["pinch"], got["random"])
                if per is not None:
                    per_rec.setdefault(key, []).append(per)

    results = {"starts": {}, "holds": {}}
    for (name, scale), b in starts.items():
        results["starts"][f"{name}/{scale}"] = {
            "pinch_vs_random": auc(b["pinch"], b["random"]),
            "pinch_vs_other": auc(b["pinch"], b["other"]),
            "median_per_recording_vs_random": float(np.median(per_rec.get((name, scale), [np.nan]))),
            "recordings": len(per_rec.get((name, scale), [])),
            "counts": {k: len(v) for k, v in b.items()},
        }
    for (name, feature), (inside, outside) in holds.items():
        results["holds"][f"{name}/{feature}"] = auc(inside, outside)
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    def fmt(v):
        return "–" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:.3f}"

    lines = [
        "# Does the Haar wavelet detail set a pinch apart?",
        "",
        "ROC AUC: 0.5 is chance, 1.0 is perfect separation. Pulse colours are sampled at 25 Hz and the motion sensors at about",
        f"50 Hz, so a scale of n samples spans n/25 or n/50 seconds either side. The viewer's scale is {VIEWER_SCALE}.",
        "",
        "## Pinch starts: the largest detail from 0.5 s before to 1.0 s after",
        "",
        "| Channel | " + " | ".join(f"Scale {s}: vs random" for s in SCALES) + " | Best scale: median per recording | Best scale: vs other gestures |",
        "|---|" + "---:|" * len(SCALES) + "---:|---:|",
    ]
    for name in names:
        row = [results["starts"].get(f"{name}/{s}", {}) for s in SCALES]
        best = max(SCALES, key=lambda s: results["starts"].get(f"{name}/{s}", {}).get("pinch_vs_random") or 0)
        b = results["starts"].get(f"{name}/{best}", {})
        lines.append(f"| {name} | " + " | ".join(fmt(r.get("pinch_vs_random")) for r in row)
                     + f" | {fmt(b.get('median_per_recording_vs_random'))} (scale {best}) | {fmt(b.get('pinch_vs_other'))} |")
    lines += [
        "",
        "## Inside pinch holds against outside every hold, sample by sample",
        "",
        "| Channel | Level (as in grayscale) | " + " | ".join(f"Detail size, scale {s}" for s in SCALES) + " |",
        "|---|---:|" + "---:|" * len(SCALES),
    ]
    for name in names:
        lines.append(f"| {name} | {fmt(results['holds'].get(f'{name}/level'))} | " + " | ".join(fmt(results["holds"].get(f"{name}/|detail| {s}")) for s in SCALES) + " |")
    any_key = next(iter(results["starts"].values()))
    lines += ["", f"Moments (all channels alike): {any_key['counts']}; {results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
