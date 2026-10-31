"""Do features that match the pulse signal against the average pinch shape help the PPG + IMU model?

Step 1 (cardiac_residual_check.py) found that a pinch leaves a consistent mark in the pulse signal: all three colours rise to
a peak 0.4-0.5 s after the start, while other gestures' starts dip in red and infrared. A window's match with the average
pinch shape told pinch starts from random moments with an AUC of about 0.74 on its own. This study adds such matches to the
app's model and compares, on the same 20 recording-disjoint splits as the earlier studies (app_fusion_check.py,
timing_negatives_check.py): event AUC on the archived events, and each test recording replayed through the runtime's peak
rule at a sweep of cut-offs.

Shape features, causal, at each decision (a PPG sample time, 880 ms after the moment it describes):

* each colour is detrended (causal 0.3 Hz high-pass) on a regular 25 Hz grid;
* the window is the 1.88 s up to the decision, i.e. from 1.0 s before to 0.88 s after the moment the decision describes;
* the average shapes are the start-aligned windows of the **training recordings of each split only** (each recording's mean,
  then the mean over recordings), so no test recording shapes its own features;
* per colour: the window's correlation with the average pinch shape (`match`), its projection on that shape over the
  spread of the 4 s before the window (`strength`), and, in one variant, its correlation with the average other-gesture
  shape (`other match`).

Variants (fixed before any was scored), all with the trainer's negatives 0, 200 and 400 ms after each start:

* app: the app's features only;
* + pinch shape: and match and strength per colour (6);
* + pinch and other shapes: and other match per colour (9);
* shape only: the 9 shape features alone.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/shape_features_check.py

Run from the repository root (about 25 minutes). Writes shape-features/results.json and results.md.
"""
import importlib.util, json, sys, time, warnings
from dataclasses import replace
from pathlib import Path
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import butter, lfilter
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)
sys.path.insert(0, str(HERE.parents[3] / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

MS = 1_000_000
RATE = 25.0
STEP_NS = int(1e9 / RATE)
DELAY_S = P.ONSET_DELAY_MS / 1000            # a decision describes the moment this long before it
WINDOW_BEFORE_S = 1.0                        # the window starts this long before the moment it describes
WIN = int(round((WINDOW_BEFORE_S + DELAY_S) * RATE))   # samples in a window, ending at the decision
SPREAD_S = 4.0                               # strength is over the spread of this long before the window
EARLY = P.EARLY_OFFSETS_MS
THRESHOLDS = tuple(round(t, 2) for t in np.arange(0.3, 0.951, 0.05))
BUDGETS = (0.5, 1, 2, 5)
VARIANTS = ("app", "+ pinch shape", "+ pinch and other shapes", "shape only")


def causal_highpass(x, cut):
    b, a = butter(2, cut / (RATE / 2), btype="high")
    return lfilter(b, a, x - x[0])


class Signals:
    """One recording's detrended colours on a regular grid, its windows ending at each grid point, and their spread."""

    def __init__(self, recording):
        ts, values = lt.pulse_of(recording)
        self.grid = np.arange(ts[0], ts[-1], STEP_NS, dtype=np.int64)
        after = np.clip(np.searchsorted(ts, self.grid), 1, len(ts) - 1)
        gap = (ts[after] - ts[after - 1]) > 500 * MS
        reg = np.column_stack([np.interp(self.grid, ts, values[:, c].astype(float)) for c in range(3)])
        self.x = np.column_stack([causal_highpass(reg[:, c], 0.3) for c in range(3)])   # (n, 3)
        n = len(self.grid)
        # A window is usable when it and the spread stretch before it hold no gap.
        span = WIN + int(SPREAD_S * RATE)
        bad = np.convolve(gap.astype(float), np.ones(span), mode="full")[:n] > 0
        bad[:span] = True
        self.ok = ~bad
        self.windows = [sliding_window_view(self.x[:, c], WIN) for c in range(3)]            # row i ends at i + WIN - 1
        spread_rows = [sliding_window_view(self.x[:, c], int(SPREAD_S * RATE)) for c in range(3)]
        self.spread = [r.std(1) for r in spread_rows]                                         # row j covers j .. j+S-1

    def index_at(self, times_ns):
        """The grid point at or just before each time."""
        return np.searchsorted(self.grid, times_ns, side="right") - 1

    def start_windows(self, starts_ns):
        """Each start's window (as at its decision), per colour: rows of WIN samples."""
        idx = self.index_at(np.asarray(starts_ns, dtype=np.int64) + int(DELAY_S * 1e9))
        keep = (idx >= WIN - 1) & (idx < len(self.grid))
        idx = idx[keep]
        idx = idx[self.ok[idx]]
        return [self.windows[c][idx - WIN + 1] for c in range(3)]

    def features(self, times_ns, pinch_shapes, other_shapes):
        """match, strength (per colour) and other match (per colour) at each time: (len, 9), NaN where unusable."""
        idx = self.index_at(np.asarray(times_ns, dtype=np.int64))
        out = np.full((len(idx), 9), np.nan, dtype=np.float32)
        usable = (idx >= WIN - 1 + int(SPREAD_S * RATE)) & (idx < len(self.grid))
        usable[usable] &= self.ok[idx[usable]]
        rows = idx[usable]
        for c in range(3):
            w = self.windows[c][rows - WIN + 1]
            wc = w - w.mean(1, keepdims=True)
            norm = np.linalg.norm(wc, axis=1) + 1e-12
            p = pinch_shapes[c]
            out[usable, c] = (wc @ p) / norm                                  # correlation (p is centred, unit length)
            spread = self.spread[c][rows - WIN + 1 - int(SPREAD_S * RATE)] + 1e-12
            out[usable, 3 + c] = (wc @ p) / spread / np.sqrt(WIN)             # projection over the earlier spread
            out[usable, 6 + c] = (wc @ other_shapes[c]) / norm
        return out


def unit_shape(rows_by_recording):
    """The mean over recordings of each recording's mean window, centred and of unit length."""
    means = [r.mean(0) for r in rows_by_recording if len(r)]
    m = np.mean(means, axis=0)
    m = m - m.mean()
    return m / (np.linalg.norm(m) + 1e-12)


def main():
    t0 = time.time()
    out_dir = HERE / "shape-features"; out_dir.mkdir(exist_ok=True)
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((R.ABL / "events.json").read_text())
    splits = json.loads((R.ABL / "splits.json").read_text())
    spec = lt.Spec("pinch", [], [], {}, [], [], False, 17)
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    X = np.full((len(events), len(spec.feature_names)), np.nan, dtype=np.float32)
    event_at = np.zeros(len(events), dtype=np.int64)
    recs, sig, starts, timelines, samples = {}, {}, {}, {}, {}
    for sid, r in inv.items():
        recording = lt.repair_millisecond_ppg_timestamps(load_recording(R.RECORDINGS / Path(r["path"]).name))
        recording = replace(recording, raw_labels=np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels))
        recs[sid] = recording
        sig[sid] = Signals(recording)
        ts, _ = lt.pulse_of(recording)
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        at = ts[np.clip(np.searchsorted(ts, np.array([events[i]["decision_ns"] for i in ev]), side="right") - 1, 0, None)]
        X[ev] = lt.inputs(spec, recording, at)
        event_at[ev] = at
        full = lt.inputs(spec, recording, ts); ok = np.isfinite(full).all(1)
        timelines[sid] = (ts[ok], full[ok].astype(np.float32))
        held = P.holds(recording.timestamps_ns, recording.raw_labels)
        starts[sid] = {"pinch": [s for s, _, label in held if label == "pinch"], "other": [s for s, _, label in held if label != "pinch"]}
        d, yy, _ = P.sample_decisions(ts, held, "pinch", set(), EARLY)
        xs = lt.inputs(spec, recording, d); keep = np.isfinite(xs).all(1)
        samples[sid] = (d[keep], xs[keep], yy[keep])
    print(f"app features in {time.time() - t0:.0f}s", flush=True)
    start_rows = {sid: {kind: sig[sid].start_windows(starts[sid][kind]) for kind in ("pinch", "other")} for sid in inv}

    results = {}
    for name in VARIANTS:
        aucs, counts = [], {t: dict(caught=0, gestures=0, rises=0, minutes=0.0, latency=[]) for t in THRESHOLDS}
        for sp in splits:
            # The average shapes, from this split's training recordings only.
            pinch_shapes = [unit_shape([start_rows[s]["pinch"][c] for s in sp["train"]]) for c in range(3)]
            other_shapes = [unit_shape([start_rows[s]["other"][c] for s in sp["train"]]) for c in range(3)]

            def with_shape(sid, times, app_x):
                if name == "app":
                    return app_x
                shape = sig[sid].features(times, pinch_shapes, other_shapes)
                if name == "+ pinch shape":
                    return np.concatenate([app_x, shape[:, :6]], axis=1)
                if name == "+ pinch and other shapes":
                    return np.concatenate([app_x, shape], axis=1)
                return shape

            train_x, train_y = [], []
            for s in sp["train"]:
                d, xs, yy = samples[s]
                xx = with_shape(s, d, xs)
                keep = np.isfinite(xx).all(1)
                train_x.append(xx[keep]); train_y.append(yy[keep])
            model = lt.fit(np.concatenate(train_x), np.concatenate(train_y), 17)
            te = np.flatnonzero(np.isin(sess, sp["test"]) & np.isfinite(X).all(1))
            xt = np.concatenate([with_shape(s, event_at[te[sess[te] == s]], X[te[sess[te] == s]]) for s in sp["test"]])
            yt = np.concatenate([y[te[sess[te] == s]] for s in sp["test"]])
            fine = np.isfinite(xt).all(1)
            aucs.append(roc_auc_score(yt[fine], model.predict_proba(xt[fine])[:, 1]))
            for s in sp["test"]:
                times, x = timelines[s]
                xx = with_shape(s, times, x)
                fine = np.isfinite(xx).all(1)
                times_ok = times[fine]
                scores = model.predict_proba(xx[fine])[:, 1]
                for t in THRESHOLDS:
                    det = lt.detections(spec, recs[s], times_ok, scores, lt.policy_for(t, "peak"))
                    c = counts[t]
                    c["caught"] += det["caught"]; c["gestures"] += det["gestures"]; c["rises"] += det["caught"] + det["falseActivations"]
                    c["minutes"] += (times_ok[-1] - times_ok[0]) / 60e9; c["latency"] += det["latenciesMs"]
        curve = {str(t): dict(recall=c["caught"] / c["gestures"], false_per_min=(c["rises"] - c["caught"]) / c["minutes"],
                              latency_ms=float(np.median(c["latency"])) if c["latency"] else None) for t, c in counts.items()}
        budget = {}
        for b in BUDGETS:
            within = [(v["recall"], t) for t, v in curve.items() if v["false_per_min"] <= b]
            budget[str(b)] = dict(recall=max(within)[0], threshold=float(max(within)[1])) if within else None
        results[name] = dict(min=min(aucs), mean=float(np.mean(aucs)), folds=aucs, curve=curve, budget=budget)
        print(f"{name:26s} AUC min {min(aucs):.4f} mean {np.mean(aucs):.4f} | " + "  ".join(
            f"<= {b}/min {budget[str(b)]['recall']:.3f}" if budget[str(b)] else f"<= {b}/min -" for b in BUDGETS) + f" ({time.time() - t0:.0f}s)", flush=True)

    base = results["app"]["folds"]
    lines = ["| Features | Min AUC | Mean AUC | Splits better | " + " | ".join(f"Recall <= {b}/min" for b in BUDGETS) + " | Delay at <= 2/min |",
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
