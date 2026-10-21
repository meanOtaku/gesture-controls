"""How much of the false-activation count is the model firing on real pinches earlier than their labels?

Re-scores the held-out predictions of trigger_rules.py (ppg and ppg+imu, one ExtraTrees fit per split, the 20
recording-disjoint splits) with every mapped pinch start moved by one common shift, from 700 ms earlier to 350 ms later.
Nothing is retrained: the model and its probabilities stay the same, only the label times the fires are matched against
move. Later shifts are the control: if earlier shifts gain only because a moved window catches stray fires, later
shifts would gain about as much.

For each shift and rule (edge, peak) the thresholds are swept and the most pinches caught within each false-activation
budget is reported, as in trigger_rules.py. The label-lag audit found the best common shift for the original pipeline
at -350 ms; picking the best shift here on the same predictions is descriptive, not a timing measurement.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/label_shift.py [out_dir]

Run from the repository root (a few minutes). Writes results.json and results.md to out_dir.
"""
import importlib.util, json, sys, tempfile, time, warnings
from pathlib import Path
import numpy as np

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("trigger_rules", HERE / "trigger_rules.py")
T = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(T)
B, R, F = T.B, T.R, T.F
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="ppg-label-shift-"))

SHIFTS_MS = (-700, -500, -350, -200, 0, 200, 350)
RULES = ("edge", "peak")


def main():
    t0 = time.time(); OUT.mkdir(parents=True, exist_ok=True)
    splits = json.loads((R.ABL / "splits.json").read_text())
    events, rec, inputs = F.build_inputs()
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    res = {}
    for name in T.CONFIGS:
        X, Xr = inputs[name]
        preds = []
        for sp in splits:
            tr = np.isin(sess, sp["train"])
            m = B.Tree("trees").fit(X[tr], y[tr], sess[tr])
            preds += [(s, m.predict(Xr[s])) for s in sp["test"]]
        minutes = sum(rec[s]["minutes"] for s, _ in preds)
        res[name] = {}
        for shift in SHIFTS_MS:
            for rule in RULES:
                curve = {}
                for t in T.THRESHOLDS:
                    c = dict(activations=0, matched=0, starts=0, latency_sum=0, early=0, blocked=0)
                    for s, p in preds:
                        starts = [st + shift * R.MS for st in rec[s]["starts"]]
                        for k, v in T.evaluate(p, rec[s]["decisions"], starts, t, rule).items():
                            c[k] += v
                    curve[str(t)] = R.rates(dict(c, minutes=minutes))
                best = {}
                for b in T.BUDGETS:
                    ok = [(v["recall"], t) for t, v in curve.items() if v["false_per_min"] <= b]
                    best[str(b)] = dict(recall=max(ok)[0], threshold=float(max(ok)[1])) if ok else None
                res[name][f"{shift}/{rule}"] = dict(shift_ms=shift, rule=rule, at_05=curve["0.5"], budget=best)
                o = curve["0.5"]
                print(f"{name:8s} shift {shift:+5d} {rule:5s} @0.5 recall {o['recall']:.3f} false/min {o['false_per_min']:.2f} | "
                      + "  ".join(f"<= {b}/min {best[str(b)]['recall']:.3f}" if best[str(b)] else f"<= {b}/min -" for b in T.BUDGETS), flush=True)
    (OUT / "results.json").write_text(json.dumps(res, indent=1))
    (OUT / "results.md").write_text(table(res))
    print("\n" + table(res) + f"\nWrote {OUT} in {time.time() - t0:.0f}s")

def table(res):
    lines = ["| Input | Label shift | Rule | Recall @0.5 | False/min @0.5 | " + " | ".join(f"Recall <= {b}/min" for b in T.BUDGETS) + " |",
             "|---|---:|---|---:|---:|" + "---:|" * len(T.BUDGETS)]
    for name, r in res.items():
        for v in r.values():
            cells = [f"{v['budget'][str(b)]['recall']:.3f}" if v["budget"][str(b)] else "–" for b in T.BUDGETS]
            lines.append(f"| {name} | {v['shift_ms']:+d} ms | {v['rule']} | {v['at_05']['recall']:.3f} | {v['at_05']['false_per_min']:.2f} | "
                         + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"

if __name__ == "__main__":
    main()
