"""Should the detector only work when the motion sensors are steady, with the pinch the one short jolt in that steadiness?

The rule: a pinch counts only inside steady motion. "Steady" is measured over a window by three numbers, none of which
depends on how the arm is posed:

* **acceleration spread**: the spread of the linear acceleration about its own mean over the window (m/s², each axis's
  standard deviation, as the magnitude over the three axes);
* **turning**: the gyroscope's RMS (rad/s);
* **tilt change**: how far world up moved in the watch's axes between the window's start and end (degrees).

Two windows are checked for each camera-timed pinch contact (`imu_models_check.py`'s labels): **steady before**, from
1.0 s to 0.1 s before the contact, and **settles after**, from 0.3 s to 1.2 s after its release (for a double pinch,
after the second release). The same windows are slid over each everyday activity (`conditions_check.py`'s stretches),
every 0.25 s: a moment is "open" when the second before is steady, and "bracketed" when, in addition, the motion is
steady again from 0.9 s to 1.8 s later (the time a double pinch and its release take), which is what a detector requiring
steadiness on both sides would accept.

Each number's limit is set at a share of pinches (80%, 90%, 95%, 98% of pinches within it), or at round fixed values;
all three must hold.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/stability_check.py

Run from the repository root (under a minute). Writes stability/results.json and results.md. With `--without-31oct`,
the recordings in data/recordings/old/31oct (the 2026-10-31 guided sessions) are left out, and the results go to
stability-without-31oct/. Typing, mouse and arm movement exist only in those sessions, so those activities drop out.
"""
import importlib.util, json, sys, time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("conditions_check", HERE / "conditions_check.py")
C = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(C)
M, S, HZ = C.M, C.S, C.HZ

BEFORE_S = (-1.0, -0.1)
AFTER_RELEASE_S = (0.3, 1.2)
LATER_S = (0.9, 1.8)
RELEASE_WITHIN_S = 5.0
LEVELS = (0.80, 0.90, 0.95, 0.98)
FIXED = ((0.3, 0.3, 5.0), (0.4, 0.3, 5.0), (0.4, 0.5, 10.0), (0.5, 0.5, 10.0), (0.6, 0.5, 10.0))   # round limits a person would pick
NAMES = ("acceleration spread (m/s²)", "turning (gyro RMS, rad/s)", "tilt change (°)")


def steadiness(rec, t, lo, hi):
    """The three numbers over [t + lo, t + hi], or None near the edges or over a gap."""
    s = C.span(rec, t, lo, hi)
    if s.stop - s.start < int(0.8 * (hi - lo) * HZ) or s.start <= 0 or s.stop >= len(rec["grid"]) or not rec["gap_ok"][s].all():
        return None
    x = rec["x"][s]
    up = rec["up"][[s.start, s.stop - 1]]
    cos = float(np.clip(up[0] @ up[1] / (np.linalg.norm(up[0]) * np.linalg.norm(up[1]) + 1e-12), -1, 1))
    return np.array([np.linalg.norm(x[:, :3].std(0)), float(np.sqrt(np.mean(np.sum(x[:, 3:] ** 2, 1)))), np.degrees(np.arccos(cos))])


def everyday_stretches(recs):
    """conditions_check's everyday stretches: (activity, recording, start ns, end ns)."""
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
        elif r["kind"] == "loose" and r["day"] == C.GUIDED_DAY:
            last = max(b for _, b, _ in holds)
            if r["grid"][-1] - last > 100 * S:
                for name, lo, hi in C.ACTIVITIES:
                    stretches.append((name, r, last + lo * S, min(r["grid"][-1], last + hi * S)))
        elif r["kind"] == "negative":
            if r["name"].startswith("gesture-dataset-everything_else"):
                stretches.append(("everything_else recordings", r, r["grid"][0], r["grid"][-1]))
            for a, b, label in holds:
                if label in C.NEGATIVE_HOLDS:
                    stretches.append((C.NEGATIVE_HOLDS[label], r, a - 0.5 * S, b + 0.5 * S))
    return stretches


def main():
    t0 = time.time()
    without = "--without-31oct" in sys.argv
    out_dir = HERE / ("stability-without-31oct" if without else "stability"); out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    if without:
        left_out = {p.name for p in (M.ROOT / "data/recordings/old/31oct").iterdir()}
        print("leaving out:", [(r["name"], r["kind"]) for r in recs if r["name"] in left_out])
        recs = [r for r in recs if r["name"] not in left_out]
    for r in recs:
        C.streams(r)

    before, after = [], []
    for r in (r for r in recs if r["kind"] == "camera"):
        for c in r["contacts"]:
            b = steadiness(r, c, *BEFORE_S)
            rel = r["releases"][(r["releases"] > c) & (r["releases"] < c + RELEASE_WITHIN_S * S)]
            a = steadiness(r, rel[0], *AFTER_RELEASE_S) if len(rel) else None
            if b is not None and a is not None:
                before.append(b); after.append(a)
    before, after = np.array(before), np.array(after)

    stretches = everyday_stretches(recs)
    moments = {}
    for name, r, a, b in stretches:
        for t in np.arange(a, b, C.EVERY_S * S):
            pre, post = steadiness(r, t, *BEFORE_S), steadiness(r, t, *LATER_S)
            if pre is not None:
                moments.setdefault(name, []).append((pre, post))
    names = list(moments)

    both = np.concatenate([before, after])
    results = {"pinches": len(before), "pinch_medians": {"before": dict(zip(NAMES, np.median(before, 0).tolist())),
                                                         "after": dict(zip(NAMES, np.median(after, 0).tolist()))},
               "activity_medians": {n: dict(zip(NAMES, np.median([p for p, _ in moments[n]], 0).tolist())) for n in names},
               "levels": {}}
    sets = [(f"{level:.0%} of pinches", np.quantile(both, level, axis=0)) for level in LEVELS]
    sets += [("fixed", np.array(f)) for f in FIXED]
    for key, lim in sets:
        # Quantile limits come from the before and after windows together, so one set of limits serves both.
        ok_b = (before <= lim).all(1)
        ok_a = (after <= lim).all(1)
        acts = {}
        for n in names:
            pre_ok = np.array([(p <= lim).all() for p, _ in moments[n]])
            brk = np.array([(p <= lim).all() and q is not None and (q <= lim).all() for p, q in moments[n]])
            acts[n] = {"open": float(pre_ok.mean()), "bracketed": float(brk.mean())}
        results["levels"][f"{key}: " + ", ".join(f"{x:.3g}" for x in lim)] = {"kind": key, "limits": dict(zip(NAMES, lim.tolist())), "steady_before": float(ok_b.mean()),
                                         "settles_after": float(ok_a.mean()), "both": float((ok_b & ok_a).mean()),
                                         "activities": acts}
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    lines = ["# Only detect inside steady motion" + (" (without the 2026-10-31 recordings)" if without else ""), "",
             f"{len(before)} camera-timed pinch contacts with a release. Steady before: {BEFORE_S[0]} to {BEFORE_S[1]} s from the"
             f" contact; settles after: {AFTER_RELEASE_S[0]} to {AFTER_RELEASE_S[1]} s after the release.", "",
             "## Medians", "", "| | " + " | ".join(NAMES) + " |", "|---|" + "---:|" * len(NAMES)]
    for label, v in (("pinch, before", np.median(before, 0)), ("pinch, after release", np.median(after, 0))):
        lines.append(f"| {label} | " + " | ".join(f"{x:.3g}" for x in v) + " |")
    for n in names:
        lines.append(f"| {n} | " + " | ".join(f"{x:.3g}" for x in results["activity_medians"][n].values()) + " |")
    lines += ["", "## Strictness", "",
              "Limits are set at a share of pinch windows, or fixed at round values; all three must hold. Activity cells: share of moments open"
              " (steady second before) / bracketed (steady again 0.9-1.8 s later).", "",
              "| Limits from | Limits (spread, turning, tilt) | Pinches steady before | Settle after | Both | " + " | ".join(names) + " |",
              "|---:|---|---:|---:|---:|" + "---:|" * len(names)]
    for level, v in results["levels"].items():
        lim = ", ".join(f"{x:.3g}" for x in v["limits"].values())
        cells = " | ".join(f"{v['activities'][n]['open']:.0%} / {v['activities'][n]['bracketed']:.0%}" for n in names)
        lines.append(f"| {v['kind']} | {lim} | {v['steady_before']:.0%} | {v['settles_after']:.0%} | {v['both']:.0%} | {cells} |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
