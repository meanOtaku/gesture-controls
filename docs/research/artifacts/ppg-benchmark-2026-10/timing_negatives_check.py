"""Does training on moments just before and just after a gesture's decision moment sharpen when the model fires?

The app trains on a positive 880 ms after each start and, as negatives, other labels' starts, points inside holds at least
1.5 s from their edges, and quiet time. Nothing tells the model that 200 ms or 1.6 s after a pinch's start is not the
moment, so its score rises early and stays up late, and a detection outside the 680-1,280 ms window is a false activation
and a miss together. This study adds, for every start of the target, negatives at chosen offsets after it, and compares
with the app's sample on the same 20 recording-disjoint splits (app_fusion_check.py): event AUC on the archived events,
and each test recording replayed through the runtime's peak rule at a sweep of cut-offs.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/timing_negatives_check.py

Run from the repository root (about 15 minutes). Writes timing-negatives/results.json and results.md.
"""
import importlib.util, json, sys, time, warnings
from dataclasses import replace
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)
sys.path.insert(0, str(HERE.parents[3] / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

MS = 1_000_000
THRESHOLDS = tuple(round(t, 2) for t in np.arange(0.3, 0.951, 0.05))
BUDGETS = (0.5, 1, 2, 5)
# Offsets after a start (ms) whose decisions are added as negatives; fixed before any was scored.
VARIANTS = {
    "app sample": (),
    "early (0, 200, 400 ms)": (0, 200, 400),
    "late (1,500, 1,800 ms)": (1500, 1800),
    "early and late": (0, 200, 400, 1500, 1800),
}


def extra_negatives(ts, held, target, offsets):
    """Decisions at `offsets` after each start of `target`: the nearest PPG sample within 60 ms."""
    out = []
    for start, _, label in held:
        if label != target:
            continue
        for offset in offsets:
            want = start + offset * MS
            i = int(np.argmin(np.abs(ts - want)))
            if abs(int(ts[i]) - want) <= 60 * MS:
                out.append(int(ts[i]))
    return np.array(sorted(set(out)), dtype=np.int64)


def main():
    t0 = time.time()
    out_dir = HERE / "timing-negatives"; out_dir.mkdir(exist_ok=True)
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((R.ABL / "events.json").read_text())
    splits = json.loads((R.ABL / "splits.json").read_text())
    spec = lt.Spec("pinch", [], [], {}, [], [], False, 17)
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    X = np.full((len(events), len(spec.feature_names)), np.nan, dtype=np.float32)
    recs, timelines, samples = {}, {}, {}
    for sid, r in inv.items():
        recording = lt.repair_millisecond_ppg_timestamps(load_recording(R.RECORDINGS / Path(r["path"]).name))
        recording = replace(recording, raw_labels=np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels))
        recs[sid] = recording
        ts, _ = lt.pulse_of(recording)
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        at = ts[np.clip(np.searchsorted(ts, np.array([events[i]["decision_ns"] for i in ev]), side="right") - 1, 0, None)]
        X[ev] = lt.inputs(spec, recording, at)
        full = lt.inputs(spec, recording, ts); ok = np.isfinite(full).all(1)
        timelines[sid] = (ts[ok], full[ok].astype(np.float32))
        held = P.holds(recording.timestamps_ns, recording.raw_labels)
        d, yy, _ = P.sample_decisions(ts, held, "pinch", set())
        xs = lt.inputs(spec, recording, d); keep = np.isfinite(xs).all(1)
        base = (xs[keep], yy[keep])
        per_variant = {}
        for name, offsets in VARIANTS.items():
            extra = extra_negatives(ts, held, "pinch", offsets) if offsets else np.zeros(0, dtype=np.int64)
            extra = extra[~np.isin(extra, d)]
            if len(extra):
                xe = lt.inputs(spec, recording, extra); ke = np.isfinite(xe).all(1)
                per_variant[name] = (np.concatenate([base[0], xe[ke]]), np.concatenate([base[1], np.zeros(int(ke.sum()), dtype=np.int64)]))
            else:
                per_variant[name] = base
        samples[sid] = per_variant
    ok = np.isfinite(X).all(1)
    print(f"features in {time.time() - t0:.0f}s", flush=True)

    results = {}
    for name in VARIANTS:
        aucs, counts = [], {t: dict(caught=0, gestures=0, rises=0, minutes=0.0, latency=[]) for t in THRESHOLDS}
        for sp in splits:
            model = lt.fit(np.concatenate([samples[s][name][0] for s in sp["train"]]), np.concatenate([samples[s][name][1] for s in sp["train"]]), 17)
            te = np.isin(sess, sp["test"]) & ok
            aucs.append(roc_auc_score(y[te], model.predict_proba(X[te])[:, 1]))
            for s in sp["test"]:
                times, x = timelines[s]
                scores = model.predict_proba(x)[:, 1]
                for t in THRESHOLDS:
                    d = lt.detections(spec, recs[s], times, scores, lt.policy_for(t, "peak"))
                    c = counts[t]
                    c["caught"] += d["caught"]; c["gestures"] += d["gestures"]; c["rises"] += d["caught"] + d["falseActivations"]
                    c["minutes"] += (times[-1] - times[0]) / 60e9; c["latency"] += d["latenciesMs"]
        curve = {str(t): dict(recall=c["caught"] / c["gestures"], false_per_min=(c["rises"] - c["caught"]) / c["minutes"],
                              latency_ms=float(np.median(c["latency"])) if c["latency"] else None) for t, c in counts.items()}
        budget = {}
        for b in BUDGETS:
            within = [(v["recall"], t) for t, v in curve.items() if v["false_per_min"] <= b]
            budget[str(b)] = dict(recall=max(within)[0], threshold=float(max(within)[1])) if within else None
        results[name] = dict(min=min(aucs), mean=float(np.mean(aucs)), folds=aucs, curve=curve, budget=budget)
        print(f"{name:24s} AUC min {min(aucs):.4f} mean {np.mean(aucs):.4f} | " + "  ".join(
            f"<= {b}/min {budget[str(b)]['recall']:.3f}" if budget[str(b)] else f"<= {b}/min -" for b in BUDGETS) + f" ({time.time() - t0:.0f}s)", flush=True)
    base = results["app sample"]["folds"]
    lines = ["| Negatives added | Min AUC | Mean AUC | Splits better | " + " | ".join(f"Recall <= {b}/min" for b in BUDGETS) + " | Delay at <= 2/min |",
             "|---|---:|---:|---:|" + "---:|" * len(BUDGETS) + "---:|"]
    for name, r in results.items():
        b2 = r["budget"]["2"]
        delay = r["curve"][str(round(b2["threshold"], 2))]["latency_ms"] if b2 else None
        lines.append(f"| {name} | {r['min']:.4f} | {r['mean']:.4f} | {sum(a > b for a, b in zip(r['folds'], base))}/20 | "
                     + " | ".join(f"{r['budget'][str(b)]['recall']:.3f}" if r["budget"][str(b)] else "–" for b in BUDGETS)
                     + f" | {f'{delay:.0f} ms' if delay else '–'} |")
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n" + "\n".join(lines) + f"\n\ndone in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
