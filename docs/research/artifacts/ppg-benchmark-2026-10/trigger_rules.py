"""Does a better trigger rule turn the same predictions into more caught pinches and fewer false ones?

The frozen live rule fires on the first tick a probability crosses the threshold (a rising edge), then ignores edges
for 1.5 s. A fire before the scoring window (680-1,280 ms after the pinch start) is false and its lockout can then
block the right fire, so lowering the threshold catches fewer pinches. This study first counts how often that happens,
then scores four causal rules on the same held-out predictions (ppg and ppg+imu from imu_fusion.py, one ExtraTrees
fit per split, the 20 recording-disjoint splits, unchanged matching):

- edge: the frozen rule.
- debounce: fire on the third consecutive tick above the threshold (80 ms later than edge).
- smooth: the edge rule on the mean of the last three probabilities.
- peak: within a run above the threshold, fire on the first tick the probability falls, i.e. one tick after its peak.

Every rule fires at most once per run above the threshold and shares the 1.5 s lockout (a rejected fire does not
restart it). Each rule is swept over the same thresholds and compared by the most pinches it catches within a
false-activation budget. The threshold behind each budget figure is read off these held-out predictions, so the
figures compare rules fairly with each other but are optimistic in absolute terms. The rules were fixed before any was
scored.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/trigger_rules.py [out_dir]

Run from the repository root (a few minutes). Writes results.json and results.md to out_dir.
"""
import importlib.util, json, sys, tempfile, time, warnings
from pathlib import Path
import numpy as np

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("imu_fusion", HERE / "imu_fusion.py")
F = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(F)
B, R = F.B, F.R
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="ppg-trigger-"))

CONFIGS = ("ppg", "ppg+imu")
RULES = ("edge", "debounce", "smooth", "peak")
THRESHOLDS = tuple(round(t, 2) for t in np.arange(0.2, 0.96, 0.05))
BUDGETS = (0.5, 1, 2, 5)                   # false activations per minute
EARLY_MS = 1000                            # a fire up to this long before the scoring window counts as early


def fires(p, t, rule):
    """Tick indices where `rule` fires at threshold `t`, before the lockout."""
    if rule == "smooth":
        p = np.convolve(p, np.ones(3))[:len(p)] / np.minimum(np.arange(1, len(p) + 1), 3)
    above = p >= t
    out, run, fired = [], 0, False
    for i in range(len(p)):
        if not above[i]:
            run, fired = 0, False; continue
        run += 1
        if fired:
            continue
        if (rule in ("edge", "smooth") and run == 1) or (rule == "debounce" and run == 3) or \
           (rule == "peak" and run > 1 and p[i] < p[i - 1]):
            out.append(i); fired = True
    return out

def evaluate(p, decisions, starts, t, rule):
    accepted, last = [], None
    for i in fires(p, t, rule):
        if last is None or decisions[i] - last >= R.REFRACTORY:
            accepted.append(int(decisions[i])); last = decisions[i]
    used, latencies, early = set(), [], 0
    for d in accepted:
        cands = [(abs(d - s - R.MATCH_TARGET), j) for j, s in enumerate(starts)
                 if j not in used and R.MATCH_LO <= d - s <= R.MATCH_HI]
        if cands:
            j = min(cands)[1]; used.add(j); latencies.append(d - starts[j])
        elif any(R.MATCH_LO - EARLY_MS * R.MS <= d - s < R.MATCH_LO for s in starts):
            early += 1
    # missed starts that had an early fire just before their window, which then locked the right one out
    blocked = sum(1 for j, s in enumerate(starts) if j not in used and any(R.MATCH_LO - EARLY_MS * R.MS <= d - s < R.MATCH_LO for d in accepted))
    return dict(activations=len(accepted), matched=len(used), starts=len(starts), latency_sum=sum(latencies),
                early=early, blocked=blocked)

def main():
    t0 = time.time(); OUT.mkdir(parents=True, exist_ok=True)
    splits = json.loads((R.ABL / "splits.json").read_text())
    events, rec, inputs = F.build_inputs()
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    res = {}
    for name in CONFIGS:
        X, Xr = inputs[name]
        preds = []                                         # (recording, held-out probabilities) per appearance
        for sp in splits:
            tr = np.isin(sess, sp["train"])
            m = B.Tree("trees").fit(X[tr], y[tr], sess[tr])
            preds += [(s, m.predict(Xr[s])) for s in sp["test"]]
        minutes = sum(rec[s]["minutes"] for s, _ in preds)
        res[name] = {}
        for rule in RULES:
            curve = {}
            for t in THRESHOLDS:
                c = dict(activations=0, matched=0, starts=0, latency_sum=0, early=0, blocked=0)
                for s, p in preds:
                    for k, v in evaluate(p, rec[s]["decisions"], rec[s]["starts"], t, rule).items():
                        c[k] += v
                false = c["activations"] - c["matched"]
                curve[str(t)] = dict(**R.rates(dict(c, minutes=minutes)), early_share_of_false=c["early"] / false if false else 0.0,
                                     missed_blocked_share=c["blocked"] / (c["starts"] - c["matched"]))
            best = {}
            for b in BUDGETS:
                ok = [(v["recall"], t) for t, v in curve.items() if v["false_per_min"] <= b]
                best[str(b)] = dict(recall=max(ok)[0], threshold=float(max(ok)[1])) if ok else None
            res[name][rule] = dict(curve=curve, budget=best)
            print(f"{name:8s} {rule:9s} " + "  ".join(f"<= {b}/min: {best[str(b)]['recall']:.3f}@{best[str(b)]['threshold']}"
                                                     if best[str(b)] else f"<= {b}/min: -" for b in BUDGETS), flush=True)
    (OUT / "results.json").write_text(json.dumps(res, indent=1))
    (OUT / "results.md").write_text(table(res))
    print("\n" + table(res) + f"\nWrote {OUT} in {time.time() - t0:.0f}s")

def table(res):
    lines = ["## How the frozen edge rule loses pinches", "",
             "| Input | Threshold | Recall | False/min | False fires just before a pinch's window | Missed pinches with such a fire |",
             "|---|---:|---:|---:|---:|---:|"]
    for name, r in res.items():
        for t in ("0.3", "0.5", "0.7"):
            v = r["edge"]["curve"][t]
            lines.append(f"| {name} | {t} | {v['recall']:.3f} | {v['false_per_min']:.2f} | {v['early_share_of_false']:.1%} | {v['missed_blocked_share']:.1%} |")
    lines += ["", "## Most pinches caught within a false-activation budget", "",
              "| Input | Rule | " + " | ".join(f"<= {b}/min" for b in BUDGETS) + " | Latency at <= 2/min |",
              "|---|---|" + "---:|" * (len(BUDGETS) + 1)]
    for name, r in res.items():
        for rule, v in r.items():
            cells = [f"{v['budget'][str(b)]['recall']:.3f} (t {v['budget'][str(b)]['threshold']:.2f})" if v["budget"][str(b)] else "–" for b in BUDGETS]
            b2 = v["budget"]["2"]
            lat = f"{v['curve'][str(round(b2['threshold'], 2))]['latency_ms']:.0f} ms" if b2 else "–"
            lines.append(f"| {name} | {rule} | " + " | ".join(cells) + f" | {lat} |")
    return "\n".join(lines) + "\n"

if __name__ == "__main__":
    main()
