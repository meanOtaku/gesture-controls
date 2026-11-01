"""Which conditions can a double-pinch detector refuse to work in, and which candidate jolts can it reject, while losing
almost no real pinches?

Two kinds of rule are measured on the repository's recordings, against the camera-timed pinch contacts
(`imu_models_check.py`'s labels: the first camera contact inside each labelled pinch):

* **Context gates**, from the second before a moment: how much the arm moves (the user's rule: high acceleration muddies
  the data), how fast the wrist turns, how still it was just before, how many jolts came in the last 3 s, whether the
  motion is rhythmic (typing, walking), and the watch's pose. Each is scored at every pinch contact and every 0.25 s of
  each everyday activity.
* **Candidate checks**, on a jolt itself: its size (an upper bound), its width, whether the accelerometer and gyroscope
  jolt together, how sharp it is, and whether its direction in the watch's axes matches pinches. Each is scored at the
  jolt peak after each contact and at every jolt peak in the everyday activities as large as the smallest 5% of pinches.

A rule's threshold is set to keep 98% of pinches; the table reports how much of each activity it then removes. The
activities: rest between cues in the pinch sessions; the typing (60 s), mouse (45 s) and arm movement (45 s) stretches
at the end of the 2026-10-31 guided session (timed from its last cue, as `guidedSession.ts` plans them); the
everything_else recordings; and the fist, thumbs up and wrist twist holds. The thresholds are set on the same pinches
they are scored on, so the figures are a first look, to be checked on new sessions.

Last, the guided sessions buzz the watch for 120 ms at each cue (`CUE_BUZZ_MS`), about 0.3 s before each pinch: the
jolt around the cue is averaged to see whether the buzz shows in the motion sensors.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/conditions_check.py

Run from the repository root (under a minute). Writes conditions/results.json and results.md.
"""
import importlib.util, json, time
from pathlib import Path
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("models", HERE / "imu_models_check.py")
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)

S, HZ = M.S, M.HZ
KEEP = 0.98
CONTEXT_S = (-1.0, -0.05)
STILL_S = (-0.5, -0.05)
DENSITY_S = (-3.0, -0.2)
RHYTHM_S = 4.0
RHYTHM_LAGS_S = (0.3, 1.2)
EVERY_S = 0.25
PEAK_AFTER_S = (0.0, 0.4)
PEAK_GAP_S = 0.3
GUIDED_DAY = "2026-10-31"
ACTIVITIES = (("typing", 3, 63), ("mouse", 66, 111), ("arm movement", 114, 159))   # s after the last cue ends
NEGATIVE_HOLDS = {"fist": "fist", "thumbs_up": "thumbs up", "hand_twit_clockwise_and_anti_clockwise": "wrist twist"}


def streams(rec):
    x = rec["x"]
    hp = x - M.trailing_mean(x, M.HIGHPASS)
    quick = x - M.trailing_mean(x, 3)
    rec.update(
        acc=np.linalg.norm(x[:, :3], axis=1), gyr=np.linalg.norm(x[:, 3:], axis=1),
        hp=hp, ja=np.linalg.norm(hp[:, :3], axis=1), jg=np.linalg.norm(hp[:, 3:], axis=1),
        quick=np.linalg.norm(quick[:, :3], axis=1),
    )


def span(rec, t, lo, hi):
    g = rec["grid"]
    return slice(int(np.searchsorted(g, t + lo * S)), int(np.searchsorted(g, t + hi * S)))


def local_peaks(v, min_height):
    n = int(PEAK_GAP_S * HZ)
    padded = np.pad(v, n, constant_values=-np.inf)
    local = sliding_window_view(padded, 2 * n + 1).max(1)
    return np.flatnonzero((v >= local) & (v >= min_height))


def context(rec, t, density_height):
    """The context features at moment t, or None near the edges."""
    g = rec["grid"]
    if t - RHYTHM_S * S < g[0] or t > g[-1]:
        return None
    c = span(rec, t, *CONTEXT_S)
    if not rec["gap_ok"][c].all():
        return None
    st = span(rec, t, *STILL_S)
    d = span(rec, t, *DENSITY_S)
    r = span(rec, t, -RHYTHM_S, 0)
    a = rec["acc"][r] - rec["acc"][r].mean()
    ac = np.correlate(a, a, mode="full")[len(a) - 1:]
    ac = ac / (ac[0] + 1e-12)
    lags = ac[int(RHYTHM_LAGS_S[0] * HZ):int(RHYTHM_LAGS_S[1] * HZ)]
    up = rec["up"][int(np.searchsorted(g, t)) - 1]
    return {
        "arm movement (accel RMS, m/s²)": float(np.sqrt(np.mean(rec["acc"][c] ** 2))),
        "wrist turning (gyro RMS, rad/s)": float(np.sqrt(np.mean(rec["gyr"][c] ** 2))),
        "stillness just before (jolt, m/s²)": float(rec["ja"][st].mean()),
        "jolts in the last 3 s": float(len(local_peaks(rec["ja"][d], density_height))),
        "rhythm (autocorrelation 0.3-1.2 s)": float(lags.max()) if len(lags) else 0.0,
        "face tilt from level (°)": float(np.degrees(np.arccos(min(1.0, abs(up[2]))))),
    }


def candidate(rec, k, axis_a, axis_g):
    """The checks on a jolt peaking at grid index k."""
    lo, hi = max(0, k - int(0.5 * HZ)), k
    base = float(np.median(rec["ja"][lo:hi])) if hi - lo > 3 else 0.0
    peak = rec["ja"][k]
    above = rec["ja"] >= base + (peak - base) / 2
    a = b = k
    while a > 0 and above[a - 1]:
        a -= 1
    while b < len(above) - 1 and above[b + 1]:
        b += 1
    w = slice(max(0, k - int(0.25 * HZ)), k + int(0.25 * HZ) + 1)
    kg = w.start + int(np.argmax(rec["jg"][w]))
    va = rec["hp"][k, :3] / (np.linalg.norm(rec["hp"][k, :3]) + 1e-12)
    vg = rec["hp"][kg, 3:] / (np.linalg.norm(rec["hp"][kg, 3:]) + 1e-12)
    q = slice(max(0, k - 3), k + 4)
    return {
        "size (jolt peak, m/s²)": float(peak),
        "width at half height (ms)": (b - a + 1) / HZ * 1000,
        "accel-gyro lag (ms, absolute)": abs(kg - k) / HZ * 1000,
        "gyro jolt with it (rad/s)": float(rec["jg"][kg]),
        "sharpness (60 ms part / jolt)": float(rec["quick"][q].max() / (peak + 1e-12)),
        "accel direction match (|cos|)": float(abs(va @ axis_a)) if axis_a is not None else np.nan,
        "gyro direction match (|cos|)": float(abs(vg @ axis_g)) if axis_g is not None else np.nan,
    }


def principal_axis(vectors):
    v = np.array(vectors)
    v = v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-12)
    return np.linalg.svd(v, full_matrices=False)[2][0]


# Which way each rule cuts: gate when above ("high"), below ("low"), or report only (None).
CONTEXT_SIDE = {"arm movement (accel RMS, m/s²)": "high", "wrist turning (gyro RMS, rad/s)": "high",
                "stillness just before (jolt, m/s²)": "high", "jolts in the last 3 s": "high",
                "rhythm (autocorrelation 0.3-1.2 s)": "high", "face tilt from level (°)": None}
CANDIDATE_SIDE = {"size (jolt peak, m/s²)": "high", "width at half height (ms)": "high", "accel-gyro lag (ms, absolute)": "high",
                  "gyro jolt with it (rad/s)": "low", "sharpness (60 ms part / jolt)": "low",
                  "accel direction match (|cos|)": "low", "gyro direction match (|cos|)": "low"}


def threshold(values, side):
    v = np.asarray(values, dtype=float); v = v[np.isfinite(v)]
    return float(np.quantile(v, KEEP)) if side == "high" else float(np.quantile(v, 1 - KEEP))


def removed(values, thr, side):
    v = np.asarray(values, dtype=float); v = v[np.isfinite(v)]
    if len(v) == 0:
        return None
    return float(np.mean(v > thr) if side == "high" else np.mean(v < thr))


def main():
    t0 = time.time()
    out_dir = HERE / "conditions"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    for r in recs:
        streams(r)
    cam = [r for r in recs if r["kind"] == "camera"]

    # The jolt after each contact, and pinch directions per recording (for leave-one-recording-out templates).
    pinch_peak = []
    for r in cam:
        for c in r["contacts"]:
            s = span(r, c, *PEAK_AFTER_S)
            if s.stop > s.start:
                k = s.start + int(np.argmax(r["ja"][s]))
                pinch_peak.append((r, c, k))
    min_height = float(np.quantile([r["ja"][k] for r, _, k in pinch_peak], 0.05))
    density_height = float(np.quantile([r["ja"][k] for r, _, k in pinch_peak], 0.25))

    def axes_without(name):
        others = [(r, k) for r, _, k in pinch_peak if r["name"] != name]
        a = principal_axis([r["hp"][k, :3] for r, k in others])
        g = principal_axis([r["hp"][min(len(r["jg"]) - 1, k - int(0.25 * HZ) + int(np.argmax(r["jg"][max(0, k - int(0.25 * HZ)):k + int(0.25 * HZ) + 1]))), 3:]
                            for r, k in others])
        return a, g

    all_axes = axes_without(None)
    pinch_ctx, pinch_cand = [], []
    loo = {}
    for r, c, k in pinch_peak:
        if r["name"] not in loo:
            loo[r["name"]] = axes_without(r["name"])
        ctx = context(r, c, density_height)
        if ctx:
            pinch_ctx.append(ctx)
        pinch_cand.append(candidate(r, k, *loo[r["name"]]))

    # Everyday activities: (name, recording, start ns, end ns).
    stretches = []
    for r in recs:
        holds = r["holds"]
        if r["kind"] == "camera":
            busy = [(a - 2 * S, b + 2 * S) for a, b, _ in holds] + [(c - 2 * S, c + 2 * S) for c in np.r_[r["contacts"], r["other"]]]
            t = r["grid"][0]
            for a, b in sorted(busy) + [(r["grid"][-1], r["grid"][-1])]:
                if a - t > 3 * S:
                    stretches.append(("rest (pinch sessions)", r, t, a))
                t = max(t, b)
        elif r["kind"] == "loose" and r["day"] == GUIDED_DAY:
            last = max(b for _, b, _ in holds)
            if r["grid"][-1] - last > 100 * S:
                for name, lo, hi in ACTIVITIES:
                    stretches.append((name, r, last + lo * S, min(r["grid"][-1], last + hi * S)))
        elif r["kind"] == "negative":
            if r["name"].startswith("gesture-dataset-everything_else"):
                stretches.append(("everything_else recordings", r, r["grid"][0], r["grid"][-1]))
            for a, b, label in holds:
                if label in NEGATIVE_HOLDS:
                    stretches.append((NEGATIVE_HOLDS[label], r, a - 0.5 * S, b + 0.5 * S))
    every_ctx, every_cand, minutes = {}, {}, {}
    for name, r, a, b in stretches:
        minutes[name] = minutes.get(name, 0.0) + (b - a) / S / 60
        for t in np.arange(a, b, EVERY_S * S):
            ctx = context(r, t, density_height)
            if ctx:
                every_ctx.setdefault(name, []).append(ctx)
        s = span(r, a, 0, (b - a) / S)
        for k in local_peaks(r["ja"][s], min_height) + s.start:
            every_cand.setdefault(name, []).append(candidate(r, k, *all_axes))
    names = list(minutes)

    def table(pinch_rows, every_rows, sides, per_minute):
        out = {}
        for feat, side in sides.items():
            pv = [row[feat] for row in pinch_rows]
            entry = {"pinch_median": float(np.nanmedian(pv)), "side": side, "activities": {}}
            if side:
                thr = threshold(pv, side)
                entry["threshold"] = thr
            for name in names:
                ev = [row[feat] for row in every_rows.get(name, [])]
                a = {"median": float(np.nanmedian(ev)) if ev else None}
                if side:
                    a["removed"] = removed(ev, thr, side)
                out_rate = len(ev) / minutes[name] if per_minute else None
                if per_minute:
                    a["candidates_per_minute"] = out_rate
                entry["activities"][name] = a
            out[feat] = entry
        return out

    results = {
        "pinches": len(pinch_peak), "candidate_min_height": min_height, "minutes": minutes,
        "context": table(pinch_ctx, every_ctx, CONTEXT_SIDE, False),
        "candidates": table(pinch_cand, every_cand, CANDIDATE_SIDE, True),
    }

    # All the gates and checks together, each at its 98% threshold.
    def passes(row, table_, sides):
        for feat, side in sides.items():
            if not side or not np.isfinite(row[feat]):
                continue
            thr = table_[feat]["threshold"]
            if (side == "high" and row[feat] > thr) or (side == "low" and row[feat] < thr):
                return False
        return True

    ctx_keep = np.mean([passes(r, results["context"], CONTEXT_SIDE) for r in pinch_ctx])
    cand_keep = np.mean([passes(r, results["candidates"], CANDIDATE_SIDE) for r in pinch_cand])
    combined = {"pinches_kept_context": float(ctx_keep), "pinches_kept_candidate": float(cand_keep), "activities": {}}
    for name in names:
        ctx_open = np.mean([passes(r, results["context"], CONTEXT_SIDE) for r in every_ctx.get(name, [])]) if every_ctx.get(name) else None
        cand_left = sum(passes(r, results["candidates"], CANDIDATE_SIDE) for r in every_cand.get(name, []))
        combined["activities"][name] = {
            "time_open": None if ctx_open is None else float(ctx_open),
            "candidates_per_minute_before": len(every_cand.get(name, [])) / minutes[name],
            "candidates_per_minute_after_checks": cand_left / minutes[name],
            "after_checks_and_gates": (cand_left / minutes[name]) * (ctx_open if ctx_open is not None else 1.0),
        }
    results["combined"] = combined

    # The cue buzz: the jolt averaged around each cue (label start) in the guided sessions.
    rows = []
    for r in recs:
        if r["day"] != GUIDED_DAY:
            continue
        for a, _, label in r["holds"]:
            s = span(r, a, -1.0, 1.5)
            if s.stop - s.start == int(2.5 * HZ) and r["gap_ok"][s].all():
                rows.append(r["ja"][s])
    buzz = {}
    if rows:
        avg = np.mean(rows, axis=0)
        tt = np.arange(len(avg)) / HZ - 1.0
        base = float(np.median(avg[tt < -0.3]))
        early = (tt >= 0) & (tt <= 0.16)
        late = (tt > 0.16) & (tt <= 1.2)
        buzz = {"cues": len(rows), "baseline": base,
                "peak_0_160ms": float(avg[early].max()), "at_ms": float(tt[early][np.argmax(avg[early])] * 1000),
                "peak_160_1200ms": float(avg[late].max()), "late_at_ms": float(tt[late][np.argmax(avg[late])] * 1000),
                "average": [round(float(v), 4) for v in avg]}
    results["cue_buzz"] = buzz
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    def pct(v):
        return "–" if v is None else f"{v:.0%}"

    lines = [
        "# Conditions and checks for a double-pinch detector",
        "",
        f"{len(pinch_peak)} camera-timed pinch contacts. Each rule's threshold keeps {KEEP:.0%} of them; the cells give the"
        " share of each activity it removes (context: of moments every 0.25 s; checks: of candidate jolts).",
        "",
        "Minutes: " + ", ".join(f"{n} {minutes[n]:.1f}" for n in names) + ".",
        "",
        "## Context gates (from the second before)",
        "",
        "| Rule | Pinch median | Threshold | " + " | ".join(names) + " |",
        "|---|---:|---:|" + "---:|" * len(names),
    ]
    for feat, e in results["context"].items():
        cells = [pct(e["activities"][n].get("removed")) if e["side"] else f"median {e['activities'][n]['median']:.0f}"
                 if e["activities"][n]["median"] is not None else "–" for n in names]
        thr = f"{'>' if e['side'] == 'high' else '<'} {e['threshold']:.3g}" if e["side"] else "report only"
        lines.append(f"| {feat} | {e['pinch_median']:.3g} | {thr} | " + " | ".join(cells) + " |")
    lines += ["", f"## Checks on a candidate jolt (as large as the smallest 5% of pinches: {min_height:.3f} m/s² or more)", "",
              "| Check | Pinch median | Reject when | " + " | ".join(names) + " |",
              "|---|---:|---:|" + "---:|" * len(names)]
    for feat, e in results["candidates"].items():
        thr = f"{'>' if e['side'] == 'high' else '<'} {e['threshold']:.3g}"
        lines.append(f"| {feat} | {e['pinch_median']:.3g} | {thr} | " + " | ".join(pct(e["activities"][n].get("removed")) for n in names) + " |")
    lines += ["", "## All together", "",
              f"Pinches kept: {combined['pinches_kept_context']:.0%} by the context gates, {combined['pinches_kept_candidate']:.0%} by the checks.", "",
              "| Activity | Time the gates leave open | Candidate jolts a minute | After the checks | After checks and gates |",
              "|---|---:|---:|---:|---:|"]
    for n in names:
        a = combined["activities"][n]
        lines.append(f"| {n} | {pct(a['time_open'])} | {a['candidates_per_minute_before']:.1f} | {a['candidates_per_minute_after_checks']:.1f} | {a['after_checks_and_gates']:.1f} |")
    if buzz:
        lines += ["", "## The cue buzz", "",
                  f"Jolt averaged over {buzz['cues']} guided cues: {buzz['baseline']:.3f} m/s² before; highest {buzz['peak_0_160ms']:.3f} at"
                  f" {buzz['at_ms']:.0f} ms within 160 ms of the cue (the 120 ms buzz, if it shows); highest {buzz['peak_160_1200ms']:.3f} at {buzz['late_at_ms']:.0f} ms"
                  " (the pinch, after the reaction time)."]
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
