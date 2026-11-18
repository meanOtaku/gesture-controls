"""Threshold sweeps and the event confusion matrix behind the paper's operating-curve and confusion figures.

Both models are replayed over the same eight evaluation recordings (the first model's held-out set, which is also the
trusted cohort of the application's current model), each with the trainer version it was trained with, under the
paper's 300-900 ms match window. Nothing is trained; the model files are only scored.

  python docs/paper/replay-assets/replay_figures.py            # replays both models (~3 min), then plots
  python docs/paper/replay-assets/replay_figures.py --plot     # re-plots from the saved JSON

Run it with tools/label-trainer/.venv/bin/python (it needs numpy and torch); the plots also need matplotlib, which
the codex-assets environment provides (docs/paper/codex-assets/.venv/bin/python replay_figures.py --plot).

The first model is trained-models/pinch_in-hand-labeled (pinch_in-ae0a22bf). The current model is the application's
pinch_in-8f79677396d8, read from Model Lab (MODEL_LAB, default the macOS application-support folder); its run spec and
evaluation are not in the repository.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / "replay-sweeps.json"
LAB = Path(os.environ.get("MODEL_LAB", Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab"))

THRESHOLDS = [0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
FIRST_COMMIT = "c924661"      # trainer the first model was trained with (revision-assets/HAND_LABELLED_REPLAY.md)
CURRENT_COMMIT = "07e6915f"   # trainer at the current model's training run (queued 2026-11-16T17:07Z)
CURRENT_MODEL = "pinch_in-8f79677396d8"
CURRENT_RUN = "run-337c4d70aa"
PAPER_MATCH_EARLIEST_MS = 300
FIRST_NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]


def trainer(commit: str, into: Path) -> Path:
    subprocess.run(f"git -C '{ROOT}' archive {commit} tools/label-trainer/src | tar -x -C '{into}'", shell=True, check=True)
    return into / "tools/label-trainer/src"


def summary(d: dict) -> dict:
    keys = ("gestures", "caught", "late", "repeats", "falseActivations", "negativeSeconds", "falseActivationsPerHour", "medianLatencyMs")
    return {k: (float(d[k]) if hasattr(d[k], "item") else d[k]) for k in keys if k in d}


def replay_first(src: Path) -> dict:
    sys.path.insert(0, str(src))
    from label_trainer import label_train as lt, cnn
    from label_trainer.events import summarise
    bundle = ROOT / "trained-models/pinch_in-hand-labeled"
    man = json.loads((bundle / "manifest.json").read_text())
    mb = (bundle / "model.cnn").read_bytes()
    assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
    ev = man["provenance"]["evaluationRecordings"]
    spec = lt.parse_spec({"version": 1, "target": "pinch_in", "negatives": FIRST_NEGATIVES, "excludes": ["left_out"],
                          "recordings": {r: str(ROOT / "data/recordings/Hand labeled" / r) for r in ev}, "train": [],
                          "evaluation": ev, "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND,
                          "seed": man["provenance"]["seed"], "steadyStarts": False})
    recs = lt.load_spec_recordings(spec)
    scored = {r: lt.timeline(spec, recs[r], lambda x: cnn.predict(mb, x)) for r in sorted(ev)}
    sweep = []
    for th in THRESHOLDS:
        per = [lt.detections(spec, recs[r], *scored[r], lt.policy_for(th, spec.trigger)) for r in sorted(ev) if scored[r]]
        sweep.append({"threshold": th, **summary(summarise(per))})
    at = next(s for s in sweep if s["threshold"] == man["thresholds"]["activation"])
    assert (at["caught"], at["gestures"], at["falseActivations"]) == (47, 57, 0), at  # the paper's Table: reproduced
    return {"model": man["modelId"], "trainer": FIRST_COMMIT, "operatingThreshold": man["thresholds"]["activation"],
            "recordings": sorted(ev), "sweep": {"pinch_in": sweep}}


def replay_current(src: Path) -> dict:
    sys.path.insert(0, str(src))
    from dataclasses import replace
    import numpy as np
    from label_trainer import label_train as lt, cnn_v2, multi_gesture as mg
    from label_trainer.events import summarise
    lt.CNN_MATCH_EARLIEST_MS = PAPER_MATCH_EARLIEST_MS
    man = json.loads((LAB / "label-models" / CURRENT_MODEL / "manifest.json").read_text())
    mb = (LAB / "label-models" / CURRENT_MODEL / "model.cnn").read_bytes()
    assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
    run = LAB / "training-runs" / CURRENT_RUN
    raw = json.loads((run / "spec.json").read_text())
    trusted = [r for r in raw["evaluation"] if raw["labelTiming"].get(r) in ("camera", "noGesture")]
    raw = {**raw, "train": [], "evaluation": trusted, "recordings": {r: raw["recordings"][r] for r in trusted},
           "labelTiming": {r: raw["labelTiming"][r] for r in trusted},
           "sessions": {r: s for r, s in raw.get("sessions", {}).items() if r in trusted},
           "decideFromNs": {r: t for r, t in raw.get("decideFromNs", {}).items() if r in trusted}}
    spec = replace(lt.parse_spec(raw), gate_min_jerk=man["preprocessing"]["gate"]["minJerk"])
    assert spec.match_window_ms == (300, 900), spec.match_window_ms
    recs = lt.load_spec_recordings(spec)
    thresholds = {g: json.loads((run / "gestures" / g / "evaluation.json").read_text())["activationThreshold"] for g in spec.classes}
    scores = lambda x: cnn_v2.predict(mb, x)  # noqa: E731
    timelines = []
    for r in sorted(trusted):
        t = mg.all_timelines(spec, recs[r], scores)
        if t is not None:
            timelines.append((r, recs[r], *t))
    sweep = {}
    for i, g in enumerate(spec.classes, 1):
        one = mg.for_gesture(spec, g)
        sweep[g] = []
        for th in THRESHOLDS:
            per = [lt.detections(one, rec, ts, p[:, i], lt.policy_for(th, one.trigger)) for _, rec, ts, p in timelines]
            sweep[g].append({"threshold": th, **summary(summarise(per))})
    confusion = mg.event_confusion(spec, timelines, thresholds)
    pin = next(s for s in sweep["pinch_in"] if s["threshold"] == thresholds["pinch_in"])
    assert (pin["caught"], pin["gestures"], pin["falseActivations"]) == (40, 57, 4), pin  # the paper's text: reproduced
    return {"model": man["modelId"], "trainer": CURRENT_COMMIT, "operatingThresholds": thresholds,
            "recordings": sorted(trusted), "sweep": sweep, "eventConfusion": confusion}


def plot() -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                         "pdf.fonttype": 42, "svg.fonttype": "none"})
    d = json.loads(OUT.read_text())
    first, cur = d["first"], d["current"]

    # Operating curve: event recall against false activations per hour of no-gesture time, one point per threshold,
    # joined in threshold order (strictest first).
    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    offsets = {"First model, pinch-in": (7, 2), "Current model, pinch-in": (7, -11), "Current model, pinch-out": (7, -11)}
    series = [(first["sweep"]["pinch_in"], first["operatingThreshold"], "First model, pinch-in", "#0072B2", "o"),
              (cur["sweep"]["pinch_in"], cur["operatingThresholds"]["pinch_in"], "Current model, pinch-in", "#D55E00", "s"),
              (cur["sweep"]["pinch_out"], cur["operatingThresholds"]["pinch_out"], "Current model, pinch-out", "#009E73", "^")]
    for sweep, op, label, color, marker in series:
        x = [s["falseActivationsPerHour"] for s in sweep]; y = [100 * s["caught"] / s["gestures"] for s in sweep]
        ax.plot(x, y, color=color, lw=1.2, marker=marker, ms=3, label=label)
        o = next(s for s in sweep if s["threshold"] == op)
        ax.plot(o["falseActivationsPerHour"], 100 * o["caught"] / o["gestures"], marker=marker, ms=8, mfc="white", mec=color, mew=1.6)
        ax.annotate(f'{o["caught"]}/{o["gestures"]}', (o["falseActivationsPerHour"], 100 * o["caught"] / o["gestures"]),
                    textcoords="offset points", xytext=offsets[label], fontsize=7, color=color, fontweight="bold")
    ax.axvline(6.2, color="0.55", lw=0.8, ls=":")
    ax.text(6.6, 99.5, "95% upper bound for\n0 events in 0.48 h", fontsize=6.3, color="0.4", va="top")
    ax.set_xlabel("False activations per hour of no-gesture time")
    ax.set_ylabel("Event recall (%)")
    ax.set_ylim(50, 100); ax.set_xlim(-1, 25)
    ax.legend(fontsize=6.5, loc="lower right", frameon=False)
    fig.tight_layout()
    fig.savefig(HERE / "operating-curve.pdf"); fig.savefig(HERE / "operating-curve.png", dpi=300)
    plt.close(fig)

    # Event confusion of the current model at its operating thresholds.
    c = cur["eventConfusion"]; g = c["gestures"]; names = {"pinch_in": "Pinch-in", "pinch_hold": "Pinch-hold", "pinch_out": "Pinch-out"}
    m = np.array([[r["caughtBy"][k] for k in g] + [r["missed"]] for r in c["rows"]], dtype=float)
    starts = np.array([r["starts"] for r in c["rows"]], dtype=float)
    pct = 100 * m / starts[:, None]
    fa = c["noGesture"]["falseActivations"]; fah = c["noGesture"]["falseActivationsPerHour"]; hrs = c["noGesture"]["hours"]
    fig, ax = plt.subplots(figsize=(3.5, 2.9))
    shown = np.vstack([pct, np.full((1, pct.shape[1]), np.nan)])
    ax.imshow(np.ma.masked_invalid(shown), cmap="Blues", vmin=0, vmax=100, aspect="auto")
    ax.axhspan(len(g) - 0.5, len(g) + 0.5, color="#f3f3f3", zorder=0)
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            ax.text(j, i, f"{int(m[i, j])}\n({pct[i, j]:.0f}%)", ha="center", va="center", fontsize=7,
                    color="white" if pct[i, j] > 60 else "black")
    for j, k in enumerate(g):
        ax.text(j, len(g), f"{fa[k]} false\n({fah[k]:.1f}/h)", ha="center", va="center", fontsize=6.5, color="#B22222")
    ax.text(len(g), len(g), "—", ha="center", va="center", fontsize=7, color="0.5")
    ax.axhline(len(g) - 0.5, color="white", lw=2)
    ax.set_xticks(range(len(g) + 1), [names[k] for k in g] + ["Missed"], fontsize=7)
    ax.set_yticks(range(len(g) + 1), [f'{names[r["gesture"]]}\n(n={r["starts"]})' for r in c["rows"]]
                  + [f"No gesture\n({min(hrs.values()):.2f} h)" if f"{min(hrs.values()):.2f}" == f"{max(hrs.values()):.2f}"
                     else f"No gesture\n({min(hrs.values()):.2f}\u2013{max(hrs.values()):.2f} h)"], fontsize=7)
    ax.set_xlabel("Detector that fired", fontsize=8)
    ax.set_ylabel("Annotated start", fontsize=8)
    ax.set_ylim(len(g) + 0.5, -0.5)
    for s in ax.spines.values(): s.set_visible(False)
    fig.tight_layout()
    fig.savefig(HERE / "event-confusion.pdf"); fig.savefig(HERE / "event-confusion.png", dpi=300)
    plt.close(fig)
    print("wrote operating-curve.pdf/png and event-confusion.pdf/png")


def main() -> int:
    if "--plot" in sys.argv:
        plot(); return 0
    if len(sys.argv) > 1 and sys.argv[1] in ("--first", "--current"):
        src = Path(sys.argv[2])
        result = replay_first(src) if sys.argv[1] == "--first" else replay_current(src)
        print(json.dumps(result, default=float))
        return 0
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        for key, flag, commit in (("first", "--first", FIRST_COMMIT), ("current", "--current", CURRENT_COMMIT)):
            dest = Path(tmp) / key; dest.mkdir()
            src = trainer(commit, dest)
            out = subprocess.run([sys.executable, "-I", __file__, flag, str(src)], check=True, capture_output=True, text=True).stdout
            results[key] = json.loads(out.strip().splitlines()[-1])
            print(f"replayed {key}: {results[key]['model']}", flush=True)
    results["matchWindowMs"] = [300, 900]
    OUT.write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}; now plot with --plot (needs matplotlib)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
