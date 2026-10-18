"""Multi-scale causal z-score study: which z-score history lengths help ExtraTrees' worst-split AUC.

Each configuration builds the 567 derivative summaries (benchmark_all.py) from PPG z-scored against one or more past
windows (1, 2, 4 or 8 s; minimum 20 ticks of history, current sample excluded), optionally through a sigmoid, and
concatenates them. ExtraTrees keeps the frozen settings; the splits, events and live-detection rules are unchanged.

    uv run --project tools/label-trainer --extra torch python docs/research/artifacts/ppg-benchmark-2026-10/multiscale_zscore.py [out_dir]

Run from the repository root (about 10 minutes). Writes results.json and results.md to out_dir.
"""
import importlib.util, json, sys, tempfile, time, warnings
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("benchmark_all", HERE / "benchmark_all.py")
B = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(B)
R = B.R
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="ppg-multiscale-"))
TICKS_PER_SECOND = 25

# (stage, seconds of history per block); B = z-score, C = z-score -> sigmoid. Fixed before any of them were scored.
CONFIGS = {
    "z 1s (baseline)": ("B", [1]),
    "z 2s": ("B", [2]),
    "z 4s": ("B", [4]),
    "z 8s": ("B", [8]),
    "z 2s+4s": ("B", [2, 4]),
    "z 1s+2s+4s": ("B", [1, 2, 4]),
    "z 1s+2s+4s+8s": ("B", [1, 2, 4, 8]),
    "z+sigmoid 1s+2s+4s": ("C", [1, 2, 4]),
    "z+sigmoid 1s+2s+4s+8s": ("C", [1, 2, 4, 8]),
}

def block(stage, seconds, cache={}):
    key = (stage, seconds)
    if key not in cache:
        R.HIST = seconds * TICKS_PER_SECOND
        events, S, _, rec = B.prepare(stage)
        R.HIST = 25
        cache[key] = (events, S, {k: v["S"] for k, v in rec.items()}, rec)
    return cache[key]

def main():
    t0 = time.time(); OUT.mkdir(parents=True, exist_ok=True)
    splits = json.loads((R.ABL / "splits.json").read_text())
    res = {}
    for name, (stage, secs) in CONFIGS.items():
        t1 = time.time()
        blocks = [block(stage, s) for s in secs]
        events, rec = blocks[0][0], blocks[0][3]
        X = np.concatenate([b[1] for b in blocks], 1)
        Xr = {k: np.concatenate([b[2][k] for b in blocks], 1) for k in rec}
        y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
        aucs, pooled = [], dict(activations=0, matched=0, starts=0, latency_sum=0, minutes=0.0)
        for sp in splits:
            tr, te = np.isin(sess, sp["train"]), np.isin(sess, sp["test"])
            m = B.Tree("trees").fit(X[tr], y[tr], sess[tr])
            aucs.append(roc_auc_score(y[te], m.predict(X[te])))
            for s in sp["test"]:
                for k, v in R.evaluate_timeline(m.predict(Xr[s]), rec[s]["decisions"], rec[s]["starts"]).items():
                    pooled[k] += v
                pooled["minutes"] += rec[s]["minutes"]
        res[name] = dict(stage=stage, seconds=secs, features=X.shape[1], min=min(aucs), mean=float(np.mean(aucs)),
                         max=max(aucs), folds=aucs, **R.rates(pooled))
        print(f"{name:24s} min {min(aucs):.4f} mean {np.mean(aucs):.4f} recall {res[name]['recall']:.3f} "
              f"false/min {res[name]['false_per_min']:.2f} ({time.time() - t1:.0f}s)", flush=True)
    base = res["z 1s (baseline)"]["folds"]; worst = np.argsort(base)[:5]
    lines = ["| Configuration | Features | Min AUC | Mean AUC | Max AUC | Folds better than baseline | Worst-5-fold mean | Recall | Precision | False/min |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for k in sorted(res, key=lambda k: (-res[k]["min"], -res[k]["mean"])):
        r = res[k]
        lines.append(f"| {k} | {r['features']} | {r['min']:.4f} | {r['mean']:.4f} | {r['max']:.4f} | "
                     f"{sum(a > b for a, b in zip(r['folds'], base))}/20 | {np.mean([r['folds'][i] for i in worst]):.4f} | "
                     f"{r['recall']:.3f} | {r['precision']:.3f} | {r['false_per_min']:.2f} |")
    (OUT / "results.json").write_text(json.dumps(res, indent=1))
    (OUT / "results.md").write_text("\n".join(lines) + "\n")
    print("\n" + "\n".join(lines) + f"\n\nWrote {OUT} in {time.time() - t0:.0f}s")

if __name__ == "__main__":
    main()
