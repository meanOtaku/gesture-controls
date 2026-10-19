"""Checks the app's definition of the multi-scale model against the research result before it ships.

The app (tools/label-trainer/src/label_trainer/ppg_onset.py) differs from the research in two ways:
  * its 25 Hz grid ends at each decision's newest PPG sample instead of starting at the recording's first, and a decision
    with a gap of more than 250 ms in its 5.6 s has no features;
  * it trains on its own sample of decisions (`ppg_onset.sample_decisions`), made from each recording's labels by the
    rules the archived events follow, instead of the archived events themselves.
Both are scored here on the same 20 splits, archived events and live-detection replay as ppg-multiscale-zscore/.

    uv run --project tools/label-trainer --extra torch python docs/research/artifacts/ppg-benchmark-2026-10/app_definition_check.py
"""
import importlib.util, json, sys, time
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)
sys.path.insert(0, str(HERE.parents[3] / "tools/label-trainer/src"))
from label_trainer import ppg_onset as P  # noqa: E402


def trees():
    return ExtraTreesClassifier(n_estimators=300, min_samples_leaf=3, max_features=0.7, n_jobs=-1, random_state=17)


def newest_at_or_before(ts, t):
    return ts[np.clip(np.searchsorted(ts, t, side="right") - 1, 0, None)]


def main():
    t0 = time.time()
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((R.ABL / "events.json").read_text())
    splits = json.loads((R.ABL / "splits.json").read_text())
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    X = np.full((len(events), P.FEATURE_COUNT), np.nan)
    rec, train_sets = {}, {}
    for sid, r in inv.items():
        ppg_files, label_files = R.recording_files(Path(r["path"]).name)
        ts, x = R.load_ppg(ppg_files); origin = int(ts[0])
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        X[ev] = P.features(ts, x, newest_at_or_before(ts, np.array([events[i]["decision_ns"] for i in ev])))
        anchors, decisions = R.timeline(int(ts[-1]) - origin)
        starts_abs = R.pinch_starts(label_files)
        starts = [s - origin for s in starts_abs if anchors[0] <= s - origin <= anchors[-1]]
        Xa = P.features(ts, x, newest_at_or_before(ts, decisions + origin))
        rec[sid] = dict(decisions=decisions, starts=starts, minutes=(anchors[-1] - anchors[0] + R.ANCHOR_STEP) / 60e9, X=Xa)
        rows = sorted(((int(row["timestamp_ns"]), {"pinching": "pinch"}.get(row.get("label", "").strip(), row.get("label", "").strip()))
                       for f in label_files for row in R.csv_rows(f)), key=lambda row: row[0])
        all_holds = P.holds(np.array([row[0] for row in rows], dtype=np.int64), np.array([row[1] for row in rows]))
        d, yy, _ = P.sample_decisions(ts, all_holds, "pinch", set())
        Xs = P.features(ts, x, d); keep = np.isfinite(Xs).all(1)
        train_sets[sid] = (Xs[keep], yy[keep])
    missing = int((~np.isfinite(X).all(1)).sum())
    print(f"features in {time.time() - t0:.0f}s; archived events without app features (gap or warm-up): {missing} of {len(events)}")
    anchor_missing = sum(int((~np.isfinite(v['X']).all(1)).sum()) for v in rec.values())
    print(f"timeline anchors without features: {anchor_missing} of {sum(len(v['X']) for v in rec.values())}")
    ok = np.isfinite(X).all(1)

    def run(name, fit_on):
        aucs, pooled = [], dict(activations=0, matched=0, starts=0, latency_sum=0, minutes=0.0)
        for sp in splits:
            tr, te = np.isin(sess, sp["train"]) & ok, np.isin(sess, sp["test"]) & ok
            if fit_on == "events":
                model = trees().fit(X[tr], y[tr])
            else:
                model = trees().fit(np.concatenate([train_sets[s][0] for s in sp["train"]]),
                                    np.concatenate([train_sets[s][1] for s in sp["train"]]))
            aucs.append(roc_auc_score(y[te], model.predict_proba(X[te])[:, 1]))
            for s in sp["test"]:
                Xa = rec[s]["X"]; p = np.zeros(len(Xa)); f = np.isfinite(Xa).all(1)
                p[f] = model.predict_proba(Xa[f])[:, 1]
                for k, v in R.evaluate_timeline(p, rec[s]["decisions"], rec[s]["starts"]).items(): pooled[k] += v
                pooled["minutes"] += rec[s]["minutes"]
        r = dict(min=min(aucs), mean=float(np.mean(aucs)), max=max(aucs), folds=aucs, **R.rates(pooled))
        print(f"{name:52s} min {r['min']:.4f} mean {r['mean']:.4f} max {r['max']:.4f} recall {r['recall']:.3f} "
              f"precision {r['precision']:.3f} false/min {r['false_per_min']:.2f}", flush=True)
        return r

    research = json.loads((HERE / "ppg-multiscale-zscore/results.json").read_text())["z 1s+2s+4s"]
    print(f"{'research (recording-anchored grid, archived events)':52s} min {research['min']:.4f} mean {research['mean']:.4f} "
          f"max {research['max']:.4f} recall {research['recall']:.3f} precision {research['precision']:.3f} false/min {research['false_per_min']:.2f}")
    a = run("app features, trained on archived events", "events")
    b = run("app features, trained on the app's own sample", "sample")
    n_train = sum(len(v[1]) for v in train_sets.values()); n_pos = sum(int(v[1].sum()) for v in train_sets.values())
    print(f"app sample: {n_train} decisions, {n_pos} positives over {len(train_sets)} recordings")
    (HERE / "ppg-multiscale-zscore/app-definition-check.json").write_text(json.dumps(
        dict(research=research, app_features_archived_events=a, app_features_app_sample=b,
             events_without_features=missing, app_sample=dict(decisions=n_train, positives=n_pos)), indent=1))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
