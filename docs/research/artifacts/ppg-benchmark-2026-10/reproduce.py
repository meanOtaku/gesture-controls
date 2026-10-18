"""Independent reproduction of the PPG preprocessing component ablation (stages A/B/C/D x HGB/ExtraTrees).

Rebuilt from this folder's archived specs (protocol, method ledger, feature schema, events, splits, inventory,
mapped labels); the original study scripts were not versioned. Reports event AUCs and the continuous
live-detection metrics, then compares every number with ppg-preprocess-component-ablation/.

    uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/reproduce.py [out_dir]

Run from the repository root. Takes a few minutes; writes results.json and comparison.md to out_dir
(default: a temporary directory).
"""
import csv, json, sys, tempfile, time
from pathlib import Path
import numpy as np
from scipy.special import expit
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RECORDINGS = ROOT / "data/recordings/2026-10-downloads"
ABL = HERE / "ppg-derivative-ablation"
CMP = HERE / "ppg-preprocess-component-ablation"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="ppg-repro-"))

MS = 1_000_000
TICK = 40 * MS                       # 25 Hz grid
HIST, MINH, MAD_SCALE = 25, 20, 1.4826
WINDOWS = (8, 16, 32)
CHANNELS = ("ppg_green", "ppg_red", "ppg_ir")
STAGES = "ABCD"
STATS = ["q10", "q25", "median", "q75", "q90", "mad", "mean", "std", "energy", "min", "max", "positive_peak",
         "negative_peak", "absolute_peak", "zero_crossings", "max_age_seconds", "min_age_seconds",
         "absolute_peak_age_seconds", "end_minus_start", "late_minus_early_mean", "mean_absolute_change"]
# continuous evaluation (frozen protocol)
FIRST_ANCHOR, END_MARGIN, ANCHOR_STEP, DECISION_DELAY = 2500 * MS, 1500 * MS, 40 * MS, 880 * MS
THRESHOLD, REFRACTORY, MATCH_LO, MATCH_HI, MATCH_TARGET = 0.5, 1500 * MS, 680 * MS, 1280 * MS, 880 * MS
MERGE_GAP, MIN_HOLD = 400 * MS, 200 * MS


# ---------- recordings ----------
def csv_rows(f):
    header = None
    for line in f.read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cells = line.split(",")
        if header is None:
            header = cells
            continue
        yield dict(zip(header, cells))

def recording_files(name):
    p = RECORDINGS / name
    return ([p / "ppg.csv"], [p / "imu.csv", p / "ppg.csv"]) if p.is_dir() else ([p], [p])

def load_ppg(files):
    rows = [r for f in files for r in csv_rows(f) if all(r.get(c, "") != "" for c in CHANNELS)]
    ts = np.array([int(r["timestamp_ns"]) for r in rows], dtype=np.int64)
    x = np.array([[float(r[c]) for c in CHANNELS] for r in rows])
    order = np.argsort(ts, kind="stable")
    return ts[order], x[order]

def pinch_starts(files):
    """Label holds: runs of one label over all rows (PPG and IMU) in time order; pinching -> pinch;
    same-label holds merged across gaps < 400 ms; holds >= 200 ms kept. Returns pinch hold start times (ns)."""
    rows = sorted(((int(r["timestamp_ns"]), r.get("label", "").strip()) for f in files for r in csv_rows(f)),
                  key=lambda r: r[0])
    runs = []
    for ts, lab in rows:
        lab = {"pinching": "pinch"}.get(lab, lab)
        if runs and runs[-1][2] == lab:
            runs[-1][1] = ts
        else:
            runs.append([ts, ts, lab])
    merged = []
    for h in (r for r in runs if r[2]):
        if merged and merged[-1][2] == h[2] and h[0] - merged[-1][1] < MERGE_GAP:
            merged[-1][1] = h[1]
        else:
            merged.append(h)
    return [a for a, b, lab in merged if lab == "pinch" and b - a >= MIN_HOLD]


# ---------- causal signal path ----------
def zoh_grid(ts, x):
    grid = ts[0] + np.arange((ts[-1] - ts[0]) // TICK + 1, dtype=np.int64) * TICK
    return x[np.searchsorted(ts, grid, side="right") - 1]

def past_windows(v):
    """Row t holds v[t-25 .. t-1] (NaN before the recording starts); the current sample is excluded."""
    pad = np.concatenate([np.full(HIST, np.nan), v])
    return pad[np.arange(len(v))[:, None] + np.arange(HIST)[None, :]]

def normalize(v, center, scale):
    w = past_windows(v)
    with np.errstate(invalid="ignore", divide="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            c, s = center(w), scale(w)
        out = np.where(s > 0, (v - c) / s, 0.0)
    out[(np.sum(np.isfinite(w), 1) < MINH) | ~np.isfinite(v)] = np.nan
    return out

def zscore(v):
    return normalize(v, lambda w: np.nanmean(w, 1), lambda w: np.nanstd(w, 1))

def median_mad(v):
    med = lambda w: np.nanmedian(w, 1)
    return normalize(v, med, lambda w: MAD_SCALE * np.nanmedian(np.abs(w - med(w)[:, None]), 1))

def stage(v, s):
    if s == "A":
        return v
    z = zscore(v)
    return z if s == "B" else expit(z) if s == "C" else median_mad(expit(z))

def diff_coeffs():
    """Least-squares cubic over the strictly previous nine samples, derivatives evaluated at the current tick."""
    t = np.arange(-9, 0) * (TICK / 1e9)
    return np.linalg.pinv(np.vander(t, 4, increasing=True)) * np.array([1, 1, 2, 6])[:, None]

COEF = diff_coeffs()

def derivatives(v):
    out = np.full((3, len(v)), np.nan)
    seg = np.lib.stride_tricks.sliding_window_view(v, 9)[:-1]       # seg[i] = v[i .. i+8] -> tick i+9
    out[:, 9:] = (seg @ COEF[1:].T).T
    out[:, 9:][:, ~np.all(np.isfinite(seg), 1)] = np.nan
    return out


# ---------- 21 summary statistics, vectorised over windows (rows) ----------
def zero_crossings(w):
    sign = np.sign(w); last = sign[:, 0].copy(); count = np.zeros(len(w))
    for j in range(1, w.shape[1]):
        cur = sign[:, j]
        count += (cur != 0) & (last != 0) & (cur != last)
        last = np.where(cur != 0, cur, last)
    return count

def summarize(w):
    n = w.shape[1]; dt = TICK / 1e9; h = n // 2; r = np.arange(len(w))
    q = np.quantile(w, [.1, .25, .5, .75, .9], axis=1)
    a = np.abs(w)
    return np.stack([*q, np.median(np.abs(w - q[2][:, None]), 1), w.mean(1), w.std(1), np.mean(w ** 2, 1),
                     w.min(1), w.max(1), np.maximum(w.max(1), 0), np.minimum(w.min(1), 0), a.max(1),
                     zero_crossings(w), (n - 1 - w.argmax(1)) * dt, (n - 1 - w.argmin(1)) * dt,
                     (n - 1 - a.argmax(1)) * dt, w[r, -1] - w[r, 0], w[:, h:].mean(1) - w[:, :h].mean(1),
                     np.abs(np.diff(w, axis=1)).mean(1)], axis=1)

def features(D, ticks):
    """D: (order, channel, n). Column order d{order}_{channel}_n{win}_{stat}: order, window, stat, channel."""
    cols = []
    for o in range(3):
        for win in WINDOWS:
            idx = ticks[:, None] + np.arange(-win + 1, 1)[None, :]
            per_channel = [summarize(D[o, c][idx]) for c in range(3)]      # each (rows, 21)
            cols.append(np.stack(per_channel, axis=2).reshape(len(ticks), -1))
    return np.concatenate(cols, axis=1)


# ---------- continuous live-detection metrics ----------
def timeline(dur):
    anchors = np.arange(FIRST_ANCHOR, dur - END_MARGIN, ANCHOR_STEP, dtype=np.int64)
    return anchors, anchors + DECISION_DELAY

def evaluate_timeline(p, decisions, starts):
    above = p >= THRESHOLD
    edges = np.flatnonzero(above & ~np.concatenate([[False], above[:-1]]))
    accepted, last = [], None
    for i in edges:
        if last is None or decisions[i] - last >= REFRACTORY:
            accepted.append(decisions[i]); last = decisions[i]
    used, latencies = set(), []
    for d in accepted:
        cands = [(abs(d - s - MATCH_TARGET), j) for j, s in enumerate(starts)
                 if j not in used and MATCH_LO <= d - s <= MATCH_HI]
        if cands:
            j = min(cands)[1]; used.add(j); latencies.append(d - starts[j])
    return dict(activations=len(accepted), matched=len(used), starts=len(starts), latency_sum=sum(latencies))

def rates(c):
    return dict(recall=c["matched"] / c["starts"] if c["starts"] else float("nan"),
                precision=c["matched"] / c["activations"] if c["activations"] else float("nan"),
                false_per_min=(c["activations"] - c["matched"]) / c["minutes"],
                latency_ms=c["latency_sum"] / c["matched"] / MS if c["matched"] else float("nan"))


# ---------- study ----------
MODELS = {
    "hgb_morphology": lambda: HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15,
                              l2_regularization=1, min_samples_leaf=20, early_stopping=False, random_state=17),
    "extra_trees": lambda: ExtraTreesClassifier(n_estimators=300, min_samples_leaf=3, max_features=0.7,
                           n_jobs=-1, random_state=17),
}

def prepare():
    inv = {r["session_id"]: r for r in json.loads((ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((ABL / "events.json").read_text())
    schema = json.loads((HERE / "ppg-derivatives-all-techniques/feature-schema.json").read_text())["summary"]
    assert schema == [f"d{o+1}_{c}_n{w}_{s}" for o in range(3) for w in WINDOWS for s in STATS for c in ("green", "red", "IR")]
    coef_err = np.abs(COEF - np.array(json.loads((ABL / "method-ledger.json").read_text())["coefficients"])).max()
    mapped = json.loads((HERE / "ppg-label-lag-audit/mapped-labels.json").read_text())

    X = {s: np.full((len(events), 567), np.nan) for s in STAGES}
    rec = {}
    problems = []
    for sid, r in inv.items():
        ppg_files, label_files = recording_files(Path(r["path"]).name)
        ts, x = load_ppg(ppg_files)
        if (len(ts), int(ts[0]), int(ts[-1])) != (r["ppg_rows"], r["start_ns"], r["end_ns"]):
            problems.append(f"{sid}: PPG rows/timestamps differ from inventory")
        origin = int(ts[0])
        anchors, decisions = timeline(int(ts[-1]) - origin)
        starts = [s - origin for s in pinch_starts(label_files) if anchors[0] <= s - origin <= anchors[-1]]
        want = mapped[sid]["eligible_zero_shift_pinch_starts_ms"]
        if len(starts) != len(want) or any(abs(a / MS - b) > 1e-6 for a, b in zip(starts, want)):
            problems.append(f"{sid}: eligible pinch starts differ from mapped-labels.json")
        grid = zoh_grid(ts, x)
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        ev_ticks = np.array([(events[i]["decision_ns"] - origin) // TICK for i in ev])
        rec[sid] = dict(decisions=decisions, starts=starts, minutes=(anchors[-1] - anchors[0] + ANCHOR_STEP) / 60e9, X={})
        for s in STAGES:
            D = np.stack([derivatives(stage(grid[:, c], s)) for c in range(3)], axis=1)
            X[s][ev] = features(D, ev_ticks)
            rec[sid]["X"][s] = features(D, decisions // TICK)
    for s in STAGES:
        if not np.isfinite(X[s]).all() or not all(np.isfinite(v["X"][s]).all() for v in rec.values()):
            problems.append(f"stage {s}: non-finite features")
    return events, rec, X, dict(coefficient_max_error=float(coef_err), recordings=len(rec), problems=problems)

def run(events, rec, X):
    splits = json.loads((ABL / "splits.json").read_text())
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    res = {}
    for s in STAGES:
        for m, make in MODELS.items():
            folds, oof_y, oof_p = [], [], []
            for sp in splits:
                assert not set(sp["train"]) & set(sp["test"])
                tr, te = np.isin(sess, sp["train"]), np.isin(sess, sp["test"])
                scaler = StandardScaler().fit(X[s][tr])
                clf = make().fit(scaler.transform(X[s][tr]), y[tr])
                p = clf.predict_proba(scaler.transform(X[s][te]))[:, 1]
                oof_y.append(y[te]); oof_p.append(p)
                c = dict(activations=0, matched=0, starts=0, latency_sum=0, minutes=0.0)
                for sid in sp["test"]:
                    r = rec[sid]
                    pc = clf.predict_proba(scaler.transform(r["X"][s]))[:, 1]
                    for k, v in evaluate_timeline(pc, r["decisions"], r["starts"]).items():
                        c[k] += v
                    c["minutes"] += r["minutes"]
                folds.append(dict(fold=sp["fold"], auc=roc_auc_score(y[te], p), **c))
            pooled = {k: sum(f[k] for f in folds) for k in ("activations", "matched", "starts", "latency_sum", "minutes")}
            aucs = [f["auc"] for f in folds]
            res[f"{m}/{s}"] = dict(auc_min=min(aucs), auc_mean=float(np.mean(aucs)), auc_max=max(aucs),
                                   auc_pooled=roc_auc_score(np.concatenate(oof_y), np.concatenate(oof_p)),
                                   **{f"{k}_pooled": v for k, v in rates(pooled).items()}, folds=folds)
            print(f"{m:15s} {s}  AUC min {min(aucs):.4f} mean {np.mean(aucs):.4f}  "
                  f"recall {res[f'{m}/{s}']['recall_pooled']:.4f}  false/min {res[f'{m}/{s}']['false_per_min_pooled']:.3f}", flush=True)
    return res

def compare(res):
    arch = {(r["model"], r["stage"]): r for r in csv.DictReader((CMP / "results.csv").open())}
    per_fold = {}
    for r in csv.DictReader((CMP / "per-fold-results.csv").open()):
        per_fold[(r["model"], r["stage"], int(r["fold"]))] = r
    metrics = [("auc_min", "auc_min"), ("auc_mean", "auc_mean"), ("auc_pooled", "auc_pooled"),
               ("recall_pooled", "recall_pooled"), ("precision_pooled", "precision_pooled"),
               ("false_activations_per_minute_pooled", "false_per_min_pooled")]
    lines = ["| Model | Stage | " + " | ".join(f"{a} (archived → reproduced)" for a, _ in metrics) + " |",
             "|---|---|" + "---:|" * len(metrics)]
    count_diffs = {"minutes": 0, "pinch_starts": 0, "activations": 0, "matched_starts": 0}
    for key, r in res.items():
        m, s = key.split("/")
        a = arch[(m, s)]
        lines.append(f"| {m} | {s} | " + " | ".join(f"{float(a[x]):.4f} → {r[y]:.4f}" for x, y in metrics) + " |")
        for f in r["folds"]:
            pf = per_fold[(m, s, f["fold"])]
            count_diffs["minutes"] += abs(float(pf["minutes"]) - f["minutes"]) > 1e-9
            count_diffs["pinch_starts"] += int(pf["pinch_starts"]) != f["starts"]
            count_diffs["activations"] += int(pf["activations"]) != f["activations"]
            count_diffs["matched_starts"] += int(pf["matched_starts"]) != f["matched"]
    n = sum(len(r["folds"]) for r in res.values())
    lines += ["", f"Per-fold counts differing from the archive (out of {n} model/stage/fold rows): "
              + ", ".join(f"{k} {v}" for k, v in count_diffs.items())]
    return "\n".join(lines)

def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    events, rec, X, checks = prepare()
    print(json.dumps(checks, indent=1))
    res = run(events, rec, X)
    table = compare(res)
    (OUT / "results.json").write_text(json.dumps(dict(checks=checks, results=res), indent=1, default=float))
    (OUT / "comparison.md").write_text(table + "\n")
    print("\n" + table + f"\n\nWrote {OUT} in {time.time() - t0:.0f}s")

if __name__ == "__main__":
    main()
