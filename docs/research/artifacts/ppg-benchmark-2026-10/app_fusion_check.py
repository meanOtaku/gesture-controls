"""Checks the app's PPG + IMU pinch-start model against the research result (ppg-imu-fusion/, ppg-trigger-rules/) before it ships.

The app (tools/label-trainer/src/label_trainer/label_train.py, imu_onset.py) differs from the research in that:
  * both grids end at each decision's newest PPG sample, a decision is made at every PPG sample, and one with a gap in its
    PPG or motion history has no features;
  * it trains on its own sample of decisions (`ppg_onset.sample_decisions`) instead of the archived events;
  * the live rule is the runtime's (`events.detect`): the peak trigger, a release threshold 0.15 under activation, and the
    cooldown counted from the detection's end.
Scored on the same 20 splits: event AUC on the archived events, and each test recording replayed through the runtime's rule
at a sweep of cut-offs (recall, and false activations per minute of the whole recording, as the research counts them).

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/app_fusion_check.py

Run from the repository root (about 10 minutes). Writes ppg-imu-fusion/app-definition-check.json.
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

THRESHOLDS = tuple(round(t, 2) for t in np.arange(0.3, 0.951, 0.05))
BUDGETS = (0.5, 1, 2, 5)


def main():
    t0 = time.time()
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((R.ABL / "events.json").read_text())
    splits = json.loads((R.ABL / "splits.json").read_text())
    spec = lt.Spec("pinch", [], [], {}, [], [], False, 17)              # the motion model, target pinch
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
        samples[sid] = (xs[keep], yy[keep])
    ok = np.isfinite(X).all(1)
    print(f"features in {time.time() - t0:.0f}s; archived events without app features: {int((~ok).sum())} of {len(events)}", flush=True)

    aucs, counts = [], {t: dict(caught=0, gestures=0, rises=0, minutes=0.0, latency=[]) for t in THRESHOLDS}
    for sp in splits:
        model = lt.fit(np.concatenate([samples[s][0] for s in sp["train"]]), np.concatenate([samples[s][1] for s in sp["train"]]), 17)
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
        print(f"split {sp['fold']}: AUC {aucs[-1]:.4f} ({time.time() - t0:.0f}s)", flush=True)
    curve = {str(t): dict(recall=c["caught"] / c["gestures"], false_per_min=(c["rises"] - c["caught"]) / c["minutes"],
                          precision=c["caught"] / c["rises"] if c["rises"] else float("nan"),
                          latency_ms=float(np.median(c["latency"])) if c["latency"] else None) for t, c in counts.items()}
    budget = {}
    for b in BUDGETS:
        within = [(v["recall"], t) for t, v in curve.items() if v["false_per_min"] <= b]
        budget[str(b)] = dict(recall=max(within)[0], threshold=float(max(within)[1])) if within else None
    research_auc = json.loads((HERE / "ppg-imu-fusion/results.json").read_text())["ppg+imu"]
    research_peak = json.loads((HERE / "ppg-trigger-rules/results.json").read_text())["ppg+imu"]["peak"]["budget"]
    out = dict(app=dict(min=min(aucs), mean=float(np.mean(aucs)), max=max(aucs), folds=aucs, curve=curve, budget=budget),
               research=dict(min=research_auc["min"], mean=research_auc["mean"], peak_budget=research_peak),
               events_without_features=int((~ok).sum()))
    (HERE / "ppg-imu-fusion/app-definition-check.json").write_text(json.dumps(out, indent=1))
    print(f"\nevent AUC: app min {min(aucs):.4f} mean {np.mean(aucs):.4f} | research min {research_auc['min']:.4f} mean {research_auc['mean']:.4f}")
    for b in BUDGETS:
        a, r = budget[str(b)], research_peak[str(b)]
        print(f"recall within {b}/min: app {a['recall'] if a else float('nan'):.3f} (cut-off {a['threshold'] if a else '-'}) | "
              f"research {r['recall'] if r else float('nan'):.3f}")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
