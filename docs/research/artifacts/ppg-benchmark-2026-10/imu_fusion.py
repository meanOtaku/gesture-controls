"""Does adding the watch's IMU stop the PPG pinch-start model from firing on other hand movement?

Compares three inputs on the frozen benchmark (37 recordings, 1,390 events, the 20 recording-disjoint splits, the
live-detection rules of reproduce.py), all with the same ExtraTrees:

- ppg: the app's model, PPG z-scored against the previous 1, 2 and 4 s -> derivatives -> 1,701 summaries
  (multiscale_zscore.py's "z 1s+2s+4s").
- imu: IMU features only (below).
- ppg+imu: both blocks side by side.

IMU features, all causal and ending at the decision tick: accelerometer x/y/z, gyroscope x/y/z and the two magnitudes,
held on a 50 Hz grid (the rate the watch records). For each channel and each of the last 320, 640 and 1,280 ms: the 21
summaries of reproduce.py on the signal and on its sample-to-sample change, plus how much the window's spread exceeds
the 3 s before it. Before the first IMU sample the grid holds that sample (under 130 ms at a recording's start, well
before the first decision).

The question is mainly the false activations on the 13 recordings with no pinch (fist, thumbs-up, everything else),
which the label-lag audit found at about 22 a minute, and how other gestures' starts score against pinch starts. The
configurations and features were fixed before any of them were scored.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/imu_fusion.py [out_dir]

Run from the repository root (about 15 minutes). Writes results.json and results.md to out_dir.
"""
import importlib.util, json, sys, tempfile, time, warnings
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("multiscale_zscore", HERE / "multiscale_zscore.py")
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)
B, R = M.B, M.R
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="ppg-imu-fusion-"))

IMU_TICK = 20 * R.MS                       # 50 Hz
IMU_WINDOWS = (16, 32, 64)                 # 320, 640, 1,280 ms
BACKGROUND = 150                           # 3 s before the longest window
AXES = ("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")
CONFIGS = ("ppg", "imu", "ppg+imu")
THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)


def load_imu(files):
    rows = [r for f in files for r in R.csv_rows(f) if all(r.get(c, "") != "" for c in AXES)]
    ts = np.array([int(r["timestamp_ns"]) for r in rows], dtype=np.int64)
    x = np.array([[float(r[c]) for c in AXES] for r in rows])
    order = np.argsort(ts, kind="stable"); ts, x = ts[order], x[order]
    return ts, np.concatenate([x, np.linalg.norm(x[:, :3], axis=1, keepdims=True), np.linalg.norm(x[:, 3:], axis=1, keepdims=True)], 1)

def imu_grid(ts, x, origin, end):
    """Row g holds the last IMU sample at or before origin + g * 20 ms."""
    grid = origin + np.arange((end - origin) // IMU_TICK + 1, dtype=np.int64) * IMU_TICK
    return x[np.clip(np.searchsorted(ts, grid, side="right") - 1, 0, None)]

def imu_features(G, at_ns):
    """IMU features for decisions at `at_ns` (ns after the recording's origin)."""
    ticks = at_ns // IMU_TICK
    assert ticks.min() >= IMU_WINDOWS[-1] - 1 and ticks.max() < len(G)
    dG = np.vstack([np.zeros((1, G.shape[1])), np.diff(G, axis=0)])
    cols = []
    for win in IMU_WINDOWS:
        idx = ticks[:, None] + np.arange(-win + 1, 1)[None, :]
        for sig in (G, dG):
            cols += [R.summarize(sig[:, c][idx]) for c in range(G.shape[1])]
        bidx = np.clip(ticks[:, None] - IMU_WINDOWS[-1] + np.arange(-BACKGROUND + 1, 1)[None, :], 0, None)
        cols.append(np.log((G[idx].std(1) + 1e-6) / (G[bidx].std(1) + 1e-6)))
    return np.concatenate(cols, 1)

def prepare_imu(events):
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    rec, blocks = {}, {}
    for sid, r in inv.items():
        ppg_files, label_files = R.recording_files(Path(r["path"]).name)
        origin = r["start_ns"]                                          # the PPG origin every decision is measured from
        ts, x = load_imu(label_files)
        anchors, decisions = R.timeline(r["end_ns"] - origin)
        G = imu_grid(ts, x, origin, r["end_ns"])
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        blocks[sid] = (ev, imu_features(G, np.array([events[i]["decision_ns"] - origin for i in ev])))
        rec[sid] = imu_features(G, decisions)
    width = next(iter(rec.values())).shape[1]
    X = np.full((len(events), width), np.nan)
    for ev, F in blocks.values():
        X[ev] = F
    assert np.isfinite(X).all() and all(np.isfinite(v).all() for v in rec.values())
    return X, rec

def build_inputs():
    """Events, per-recording timelines, and {config: (event features, {recording: timeline features})}."""
    ppg = [M.block("B", s) for s in (1, 2, 4)]
    events, rec = ppg[0][0], ppg[0][3]
    Xp = np.concatenate([b[1] for b in ppg], 1); Xpr = {k: np.concatenate([b[2][k] for b in ppg], 1) for k in rec}
    Xi, Xir = prepare_imu(events)
    inputs = {"ppg": (Xp, Xpr), "imu": (Xi, Xir),
              "ppg+imu": (np.concatenate([Xp, Xi], 1), {k: np.concatenate([Xpr[k], Xir[k]], 1) for k in rec})}
    return events, rec, inputs

def main():
    t0 = time.time(); OUT.mkdir(parents=True, exist_ok=True)
    splits = json.loads((R.ABL / "splits.json").read_text())
    events, rec, inputs = build_inputs()
    print(f"inputs ready: ppg {inputs['ppg'][0].shape[1]}, imu {inputs['imu'][0].shape[1]} features ({time.time() - t0:.0f}s)", flush=True)
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    kinds = np.array([e["kind"] for e in events])
    no_pinch = {k for k, v in rec.items() if not v["starts"]}
    res = {}
    for name in CONFIGS:
        t1 = time.time(); X, Xr = inputs[name]
        aucs, other_aucs = [], []
        score_sum, score_n = np.zeros(len(events)), np.zeros(len(events))
        pooled = {t: {g: dict(activations=0, matched=0, starts=0, latency_sum=0, minutes=0.0) for g in ("all", "no_pinch", "pinch")}
                  for t in THRESHOLDS}
        for sp in splits:
            tr, te = np.isin(sess, sp["train"]), np.isin(sess, sp["test"])
            m = B.Tree("trees").fit(X[tr], y[tr], sess[tr])
            p = m.predict(X[te]); aucs.append(roc_auc_score(y[te], p))
            score_sum[te] += p; score_n[te] += 1
            hard = te & ((y == 1) | (kinds == "other_start"))           # pinch starts against other gestures' starts only
            if len(set(y[hard])) == 2:
                other_aucs.append(roc_auc_score(y[hard], m.predict(X[hard])))
            for s in sp["test"]:
                ps = m.predict(Xr[s])
                for t in THRESHOLDS:
                    R.THRESHOLD = t
                    for k, v in R.evaluate_timeline(ps, rec[s]["decisions"], rec[s]["starts"]).items():
                        for g in ("all", "no_pinch" if s in no_pinch else "pinch"):
                            pooled[t][g][k] += v
                    for g in ("all", "no_pinch" if s in no_pinch else "pinch"):
                        pooled[t][g]["minutes"] += rec[s]["minutes"]
        R.THRESHOLD = 0.5
        mean_score = score_sum / np.maximum(score_n, 1)
        res[name] = dict(features=X.shape[1], min=min(aucs), mean=float(np.mean(aucs)), max=max(aucs), folds=aucs,
                         pinch_vs_other_start_min=min(other_aucs), pinch_vs_other_start_mean=float(np.mean(other_aucs)),
                         mean_score_by_kind={k: float(mean_score[(kinds == k) & (score_n > 0)].mean()) for k in sorted(set(kinds))},
                         operating={str(t): {g: R.rates(c) for g, c in pooled[t].items()} for t in THRESHOLDS})
        o = res[name]["operating"]["0.5"]
        print(f"{name:8s} AUC min {min(aucs):.4f} mean {np.mean(aucs):.4f} | pinch vs other starts {np.mean(other_aucs):.4f} | "
              f"recall {o['all']['recall']:.3f} false/min {o['all']['false_per_min']:.2f} "
              f"(no-pinch recordings {o['no_pinch']['false_per_min']:.2f}) ({time.time() - t1:.0f}s)", flush=True)
    (OUT / "results.json").write_text(json.dumps(res, indent=1))
    (OUT / "results.md").write_text(table(res))
    print("\n" + table(res) + f"\nWrote {OUT} in {time.time() - t0:.0f}s")

def table(res):
    base = res["ppg"]["folds"]
    lines = ["## Event AUC", "",
             "| Input | Features | Min AUC | Mean AUC | Max AUC | Splits better than ppg | Pinch vs other starts, min / mean |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for k, r in res.items():
        lines.append(f"| {k} | {r['features']} | {r['min']:.4f} | {r['mean']:.4f} | {r['max']:.4f} | "
                     f"{sum(a > b for a, b in zip(r['folds'], base))}/20 | {r['pinch_vs_other_start_min']:.4f} / {r['pinch_vs_other_start_mean']:.4f} |")
    kinds = list(next(iter(res.values()))["mean_score_by_kind"])
    lines += ["", "## Mean held-out score by event kind", "", "| Input | " + " | ".join(kinds) + " |", "|---|" + "---:|" * len(kinds)]
    for k, r in res.items():
        lines.append(f"| {k} | " + " | ".join(f"{r['mean_score_by_kind'][x]:.3f}" for x in kinds) + " |")
    lines += ["", "## Live detection by threshold", "",
              "| Input | Threshold | Recall | Precision | False/min, all | False/min, no-pinch recordings | False/min, pinch recordings |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for k, r in res.items():
        for t, o in r["operating"].items():
            lines.append(f"| {k} | {t} | {o['all']['recall']:.3f} | {o['all']['precision']:.3f} | {o['all']['false_per_min']:.2f} | "
                         f"{o['no_pinch']['false_per_min']:.2f} | {o['pinch']['false_per_min']:.2f} |")
    return "\n".join(lines) + "\n"

if __name__ == "__main__":
    main()
