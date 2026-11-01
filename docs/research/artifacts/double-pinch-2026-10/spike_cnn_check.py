"""Can a CNN tell a pinch from a key press or a click when it sees only the spike and a little around it?

Each candidate spike is a peak of the high-passed accelerometer shake (Butterworth order 2 at 8 Hz, `filter_check.py`;
peaks at least 0.3 s apart, as large as the smallest 2% of pinch peaks). A window centred on the peak is cut from all six
axes (linear accelerometer and gyroscope) and given to the CNN of `imu_models_check.py` (three dilated convolutions,
global max and mean pooling), trained with random rotations up to 20°, scaling by 0.8-1.25 and shifts of up to two
samples. Variants:

* high-passed, ±0.1 s around the peak (the spike only, 11 samples at 50 Hz);
* high-passed, ±0.2 s (the spike and some values around it, 21 samples);
* high-passed, ±0.5 s (51 samples);
* unfiltered, ±0.2 s (to see what the filter adds).

A candidate is a pinch when a camera-timed contact (`imu_models_check.py`'s labels) came 0 to 0.4 s before its peak.
Candidates just after a release, near another camera contact, or inside a labelled pinch without a camera contact are
left out of training and scoring, as in step 3. Each variant is also scored behind two context rules from the
conditions document: B0, steady before (1.1 to 0.2 s before the peak: acceleration spread ≤ 0.4 m/s², turning
≤ 0.5 rad/s, tilt change ≤ 10°), and B4, no more than 4 spikes in the 3 s before.

Scored as in step 3: the share of contacts found at a false-alarm rate over the test recordings, with whole recordings
held out (5 folds) and each recording day held out. Scores are the average of 5 training runs. Then a model trained on
all of it scores the typing, mouse and arm movement at the end of the 2026-10-31 guided session, which no model trained
on; and the candidates a minute in each activity are counted at the threshold that gives 1 false alarm a minute on
held-out recordings.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/spike_cnn_check.py

Run from the repository root (a few minutes). Writes spike-cnn/results.json and results.md.
"""
import importlib.util, json, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from scipy.signal import butter, sosfilt
from sklearn.model_selection import GroupKFold

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("stability_check", HERE / "stability_check.py")
ST = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ST)
C, M, S, HZ = ST.C, ST.M, ST.S, ST.HZ

HP = butter(2, 8, btype="highpass", fs=HZ, output="sos")
MAX_HALF = 25                    # the widest window, ±0.5 s: every variant sees the same candidates
PEAK_AFTER_S = (0.0, 0.4)
CANDIDATE_QUANTILE = 0.02
RELEASE_IGNORE_S = (0.0, 0.55)
OTHER_IGNORE_S = (-0.2, 0.7)
STEADY_S = (-1.1, -0.2)
STEADY_LIMITS = np.array([0.4, 0.5, 10.0])
DENSITY_S, DENSITY_MAX = (-3.0, -0.2), 4
RATES = (1.0, 0.5, 0.2)
RUNS = 5
EPOCHS = 30
VARIANTS = {"high-passed, ±0.1 s (spike only)": ("hp", 5), "high-passed, ±0.2 s (spike and around)": ("hp", 10),
            "high-passed, ±0.5 s": ("hp", 25), "unfiltered, ±0.2 s": ("x", 10)}


def prepare(r, min_height=None):
    r["hp"] = sosfilt(HP, r["x"], axis=0)
    r["shake"] = np.linalg.norm(r["hp"][:, :3], axis=1)


def candidates(r, min_height, density_height):
    """Candidate peaks (grid indices), their labels (1, 0, -1 left out) and whether they pass B0 and B4."""
    g = r["grid"]
    k = C.local_peaks(r["shake"], min_height)
    lead = int(-DENSITY_S[0] * HZ)
    k = k[(k >= lead) & (k + MAX_HALF < len(g))]
    k = np.array([i for i in k if r["gap_ok"][i - lead:i + MAX_HALF + 1].all()], dtype=int)
    t = g[k]
    y = np.zeros(len(k), dtype=np.int8)
    if r["kind"] == "camera":
        def near(events, lo, hi):
            m = np.zeros(len(t), dtype=bool)
            for e in events:
                m |= (t - e >= lo * S) & (t - e <= hi * S)
            return m
        out = near(r["releases"], *RELEASE_IGNORE_S) | near(r["other"], *OTHER_IGNORE_S)
        for lo, hi in r["missed"]:
            out |= (t >= lo) & (t <= hi)
        for a, b, label in r["holds"]:
            if label == "pinch":
                out |= (t >= a - 1 * S) & (t <= b + 1 * S)
        y[out] = -1
        y[near(r["contacts"], *PEAK_AFTER_S)] = 1
    elif r["kind"] == "loose":
        y[:] = -1
    steady = np.array([(v := ST.steadiness(r, ti, *STEADY_S)) is not None and bool((v <= STEADY_LIMITS).all()) for ti in t], dtype=bool)
    sparse = np.array([len(C.local_peaks(r["shake"][C.span(r, ti, *DENSITY_S)], density_height)) <= DENSITY_MAX for ti in t], dtype=bool)
    r.update(ck=k, ct=t, cy=y, gate=steady & sparse)


def windows(r, source, half, shift=0):
    src = r[source]
    idx = r["ck"][:, None] + shift + np.arange(-half, half + 1)[None, :]
    return np.transpose(src[idx], (0, 2, 1)).astype(np.float32)      # (candidates, 6, samples)


class SpikeCnn:
    def __init__(self, source, half, seed):
        self.source, self.half, self.seed = source, half, seed

    def fit(self, recs):
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        y = np.concatenate([r["cy"] for r in recs]); keep = y >= 0; y = y[keep].astype(np.float32)
        # Every shift of up to two samples, picked per example at each epoch.
        Ws = [np.concatenate([windows(r, self.source, self.half, s) for r in recs])[keep] for s in range(-2, 3)]
        self.scale = Ws[2].std(axis=(0, 2), keepdims=True) + 1e-6
        self.net = M.Net(6)
        opt = torch.optim.Adam(self.net.parameters(), lr=1e-3, weight_decay=1e-4)
        pos = max(1.0, y.sum())
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(20.0, (len(y) - pos) / pos)))
        for _ in range(EPOCHS):
            self.net.train()
            order = rng.permutation(len(y))
            for b in range(0, len(order), 128):
                pick = order[b:b + 128]
                shifts = rng.integers(0, 5, len(pick))
                batch = np.stack([Ws[s][i] for s, i in zip(shifts, pick)])
                R = M.random_rotations(len(pick), 20, rng)
                for sl in (slice(0, 3), slice(3, 6)):
                    batch[:, sl] = np.einsum("nij,njt->nit", R, batch[:, sl])
                batch *= rng.uniform(0.8, 1.25, (len(pick), 1, 1))
                loss = loss_fn(self.net(torch.from_numpy((batch / self.scale).astype(np.float32))), torch.from_numpy(y[pick]))
                opt.zero_grad(); loss.backward(); opt.step()
        return self

    def score(self, r):
        self.net.eval()
        with torch.no_grad():
            return self.net(torch.from_numpy(windows(r, self.source, self.half) / self.scale)).numpy()


def averaged_scores(train, test, source, half):
    out = [np.zeros(len(r["ck"])) for r in test]
    for run in range(RUNS):
        model = SpikeCnn(source, half, M.SEED + run).fit(train)
        for o, r in zip(out, test):
            o += model.score(r) / RUNS
    return out


def operating_points(test, scores, gated):
    """Per rate: (share of contacts found, threshold)."""
    found, false, minutes = [], [], 0.0
    for r, s in zip(test, scores):
        s = np.where(r["gate"], s, -np.inf) if gated else s
        minutes += (r["grid"][-1] - r["grid"][0]) / S / 60
        false.extend(s[(r["cy"] == 0) & np.isfinite(s)])
        for c in r["contacts"]:
            m = (r["ct"] - c >= PEAK_AFTER_S[0] * S) & (r["ct"] - c <= PEAK_AFTER_S[1] * S)
            found.append(s[m].max() if m.any() else -np.inf)
    false = np.sort(false)[::-1]; found = np.array(found)
    out = {}
    for rate in RATES:
        allowed = int(rate * minutes)
        thr = false[allowed] if allowed < len(false) else -np.inf
        out[rate] = (float((found > thr).mean()), float(thr))
    return out


def run_split(folds, source, half):
    test_all, scores_all = [], []
    for train, test in folds:
        scores_all += averaged_scores(train, test, source, half)
        test_all += test
    return {gated: operating_points(test_all, scores_all, gated) for gated in (False, True)}, test_all, scores_all


def main(variants=VARIANTS, out_name="spike-cnn", title="# A CNN on the spike and a little around it", add_streams=None):
    """Runs the study for `variants` (name -> (stream, half width)); `add_streams(r)` adds any streams they read."""
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / out_name; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    for r in recs:
        prepare(r)
        if add_streams:
            add_streams(r)
    cam = [r for r in recs if r["kind"] == "camera"]
    pinch_peaks = [r["shake"][s].max() for r in cam for c in r["contacts"] if (s := C.span(r, c, *PEAK_AFTER_S)).stop > s.start]
    min_height = float(np.quantile(pinch_peaks, CANDIDATE_QUANTILE))
    density_height = float(np.quantile(pinch_peaks, 0.25))
    for r in recs:
        candidates(r, min_height, density_height)
    trainable = [r for r in recs if r["kind"] in ("camera", "negative")]
    guided = [r for r in recs if r["kind"] == "loose" and r["day"] == C.GUIDED_DAY]

    # The same folds as step 3.
    gkf = GroupKFold(n_splits=5, shuffle=True, random_state=M.SEED)
    cam_i = [i for i, r in enumerate(trainable) if r["kind"] == "camera"]
    neg_i = [i for i, r in enumerate(trainable) if r["kind"] == "negative"]
    folds = []
    for (_, a), (_, b) in zip(gkf.split(cam_i, groups=cam_i), gkf.split(neg_i, groups=neg_i)):
        test_ids = {cam_i[j] for j in a} | {neg_i[j] for j in b}
        folds.append(([r for i, r in enumerate(trainable) if i not in test_ids], [trainable[i] for i in sorted(test_ids)]))
    days = sorted({r["day"] for r in cam})
    day_folds = [([r for r in trainable if r["day"] != d], [r for r in trainable if r["day"] == d]) for d in days]

    stretches = ST.everyday_stretches(recs)
    names = list(dict.fromkeys(n for n, *_ in stretches))
    minutes = {n: sum((b - a) / S / 60 for m, _, a, b in stretches if m == n) for n in names}
    n_pos = int(sum((r["cy"] == 1).sum() for r in trainable)); n_neg = int(sum((r["cy"] == 0).sum() for r in trainable))
    print(f"{n_pos} pinch candidates, {n_neg} other candidates; candidate height {min_height:.3f} m/s²", flush=True)
    results = {"candidates": {"pinch": n_pos, "other": n_neg, "min_height": min_height,
                              "contacts": int(sum(len(r["contacts"]) for r in cam)),
                              "contacts_with_candidate": int(sum(((r["ct"][None, :] - r["contacts"][:, None] >= 0) & (r["ct"][None, :] - r["contacts"][:, None] <= PEAK_AFTER_S[1] * S)).any(1).sum() for r in cam if len(r["contacts"]))),
                              "contacts_passing_rules": None},
               "minutes": minutes, "variants": {}}
    for variant, (source, half) in variants.items():
        tv = time.time()
        rec_split, test_all, scores_all = run_split(folds, source, half)
        day_split, _, _ = run_split(day_folds, source, half)
        # Activities: held-out scores for the trainable recordings' stretches; a model on everything for the guided session.
        held = {id(r): s for r, s in zip(test_all, scores_all)}
        for r, s in zip(guided, averaged_scores(trainable, guided, source, half)):
            held[id(r)] = s
        acts = {}
        for gated in (False, True):
            thr = rec_split[gated][1.0][1]
            counts = dict.fromkeys(names, 0)
            for name, r, a, b in stretches:
                if id(r) not in held:
                    continue
                s = held[id(r)]
                m = (r["ct"] >= a) & (r["ct"] < b) & (s > thr) & (r["gate"] if gated else True)
                counts[name] += int(m.sum())
            acts[gated] = {n: counts[n] / minutes[n] for n in names}
        results["variants"][variant] = {
            "recordings_split": {str(g): {str(k): v[0] for k, v in d.items()} for g, d in rec_split.items()},
            "day_split": {str(g): {str(k): v[0] for k, v in d.items()} for g, d in day_split.items()},
            "activities_per_minute": {str(g): v for g, v in acts.items()},
        }
        print(f"  {variant}: {time.time() - tv:.0f} s", flush=True)
    passing = sum(any(r["gate"][(r["ct"] - c >= 0) & (r["ct"] - c <= PEAK_AFTER_S[1] * S)]) for r in cam for c in r["contacts"])
    results["candidates"]["contacts_passing_rules"] = int(passing)
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    cd = results["candidates"]
    lines = [title, "",
             f"{cd['contacts']} camera-timed contacts; {cd['contacts_with_candidate']} have a candidate spike 0-0.4 s after them, and"
             f" {cd['contacts_passing_rules']} of those pass the context rules (B0 steady before, B4 few spikes before)."
             f" {cd['pinch']} pinch candidates and {cd['other']} other candidates for training (spikes of at least {cd['min_height']:.3f} m/s²"
             " after the 8 Hz high-pass). Scores are the average of 5 training runs.", ""]
    for key, title in (("recordings_split", "Whole recordings held out (5 folds)"), ("day_split", "Each recording day held out")):
        lines += [f"## {title}: contacts found", "",
                  "| Window | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |",
                  "|---|---:|---:|---:|---:|---:|---:|"]
        for variant, v in results["variants"].items():
            a, b = v[key]["False"], v[key]["True"]
            lines.append(f"| {variant} | {a['1.0']:.0%} | {a['0.5']:.0%} | {a['0.2']:.0%} | {b['1.0']:.0%} | {b['0.5']:.0%} | {b['0.2']:.0%} |")
        lines.append("")
    lines += ["## Candidates a minute in each activity, at 1 false alarm a minute on held-out recordings", "",
              "Typing, mouse and arm movement: a model trained on all the other recordings (it never saw them). The rest: held-out"
              " scores from the recordings split. Without / with the rules.", "",
              "| Window | " + " | ".join(names) + " |", "|---|" + "---:|" * len(names)]
    for variant, v in results["variants"].items():
        a, b = v["activities_per_minute"]["False"], v["activities_per_minute"]["True"]
        lines.append(f"| {variant} | " + " | ".join(f"{a[n]:.1f} / {b[n]:.1f}" for n in names) + " |")
    lines += ["", "Minutes: " + ", ".join(f"{n} {minutes[n]:.1f}" for n in names) + ".", "", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
