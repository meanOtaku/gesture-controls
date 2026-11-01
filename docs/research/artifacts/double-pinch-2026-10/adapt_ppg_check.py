"""Does adapting to a new session, or adding the pulse sensor, help the spike CNN on a day it never saw?

Step 8's best pipeline is the base: each motion axis z-scored over its trailing 10 s and put through a sigmoid, a
±0.2 s window around each candidate spike, `spike_cnn_check.py`'s CNN and candidates. Each recording day with camera
contacts is held out in turn, and the model trains on the rest. Then, following the published systems
(`double-pinch-conditions-2026-10.md`, "What published systems did"):

* **AdaBN**: the CNN's batch-normalisation statistics are recomputed on the new day's candidate windows, without labels.
* **Domain-adversarial (DANN)**, after ViWatch: during training, a second head tries to tell the training days' windows
  from the new day's unlabelled windows, and a reversed gradient pushes the CNN's features to make them alike. (ViWatch
  adds a Siamese discriminator to separate hundreds of users; with one new day, the plain discriminator suffices.)
* **Calibration with 5 or 10 pinches**, after Tsunoda and rule F4: the new day's first 5 or 10 camera-timed pinches, with
  the other spikes around them up to 1 s after the last, fine-tune the trained CNN (mixed with training-day windows).
* **Pulse sensor (PPG)**, after Apple and OpenWatch: the green, red and IR channels (25 Hz) are put on the motion grid,
  z-scored over their trailing 10 s and put through the sigmoid, and given to the CNN as three more channels. The pulse
  responds more slowly than the motion, so a ±0.5 s window is tried too.

Every variant is scored on the same part of each held-out day: everything after its 10th pinch (plus 1 s), so the
calibration pinches are never scored. The unlabelled windows that AdaBN and DANN adapt on are that day's candidates,
as a watch would collect them during use. The PPG variants are also scored with whole recordings held out (5 folds).
Scores are the average of 5 training runs, as contacts found at a false-alarm rate (step 3's measure), without and
with the context rules (B0, B4).

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/adapt_ppg_check.py

Run from the repository root (about 15 minutes). Writes adapt-ppg/results.json and results.md.
"""
import copy, importlib.util, json, sys, time
from pathlib import Path
import numpy as np
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("normalize_cnn_check", HERE / "normalize_cnn_check.py")
NC = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(NC)
SC, M = NC.SC, NC.M
from label_trainer import label_train as lt  # noqa: E402  (on the path through imu_models_check)
from label_trainer.csv_io import load_recording, repair_millisecond_ppg_timestamps  # noqa: E402

S = M.S
CALIBRATION = (5, 10)
SCORED_AFTER = max(CALIBRATION)
FINETUNE_STEPS, FINETUNE_LR = 150, 3e-4
DANN_WEIGHT = 0.5


def add_pulse(r):
    """The PPG channels on the motion grid, z-scored over their trailing 10 s and through the sigmoid."""
    path = next(p for f in M.FOLDERS for p in (M.ROOT / f).iterdir() if p.name == r["name"])
    ts, v = lt.pulse_of(repair_millisecond_ppg_timestamps(load_recording(path)))
    ok = np.isfinite(v).all(1)
    ts, v = ts[ok], v[ok]
    p = np.column_stack([np.interp(r["grid"], ts, v[:, c]) for c in range(3)])
    mean = M.trailing_mean(p, NC.RECENT)
    std = np.sqrt(np.maximum(M.trailing_mean(p * p, NC.RECENT) - mean * mean, 0)) + 1e-3 * (np.abs(mean) + 1)
    r["z_sig_ppg"] = np.concatenate([r["z_sig"], 1 / (1 + np.exp(-(p - mean) / std))], axis=1)


class Reverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, weight):
        ctx.weight = weight
        return x.view_as(x)

    @staticmethod
    def backward(ctx, grad):
        return -ctx.weight * grad, None


class Model:
    """`spike_cnn_check.SpikeCnn` for any number of channels, with the adaptation steps."""

    def __init__(self, source, half, seed):
        self.source, self.half, self.seed = source, half, seed

    def _windows(self, recs, labelled=True):
        Ws = [np.concatenate([SC.windows(r, self.source, self.half, s) for r in recs]) for s in range(-2, 3)]
        if not labelled:
            return Ws, None
        y = np.concatenate([r["cy"] for r in recs]); keep = y >= 0
        return [W[keep] for W in Ws], y[keep].astype(np.float32)

    def _augment(self, Ws, pick, rng):
        shifts = rng.integers(0, 5, len(pick))
        batch = np.stack([Ws[s][i] for s, i in zip(shifts, pick)])
        R = M.random_rotations(len(pick), 20, rng)
        for sl in (slice(0, 3), slice(3, 6)):
            batch[:, sl] = np.einsum("nij,njt->nit", R, batch[:, sl])
        batch *= rng.uniform(0.8, 1.25, (len(pick), 1, 1))
        return torch.from_numpy((batch / self.scale).astype(np.float32))

    def _features(self, x):
        h = self.net.body(x)
        return torch.cat([h.amax(2), h.mean(2)], 1)

    def fit(self, recs, target=None):
        """Trains on `recs`; with `target` (unlabelled recordings), domain-adversarially."""
        torch.manual_seed(self.seed)
        self.rng = rng = np.random.default_rng(self.seed)
        Ws, y = self._windows(recs)
        self.source_windows, self.source_y = Ws, y
        self.scale = Ws[2].std(axis=(0, 2), keepdims=True) + 1e-6
        self.net = M.Net(Ws[0].shape[1])
        params = list(self.net.parameters())
        if target is not None:
            Wt, _ = self._windows(target, labelled=False)
            width = self.net.head[0].in_features
            self.domain = nn.Sequential(nn.Linear(width, 32), nn.ReLU(), nn.Linear(32, 1))
            params += list(self.domain.parameters())
        opt = torch.optim.Adam(params, lr=1e-3, weight_decay=1e-4)
        pos = max(1.0, y.sum())
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(20.0, (len(y) - pos) / pos)))
        steps = SC.EPOCHS * int(np.ceil(len(y) / 128)); step = 0
        for _ in range(SC.EPOCHS):
            self.net.train()
            order = rng.permutation(len(y))
            for b in range(0, len(order), 128):
                pick = order[b:b + 128]
                xb = self._augment(Ws, pick, rng)
                if target is None:
                    loss = loss_fn(self.net(xb), torch.from_numpy(y[pick]))
                else:
                    tp = rng.integers(0, len(Wt[0]), len(pick))
                    xt = self._augment(Wt, tp, rng)
                    feats = self._features(torch.cat([xb, xt]))
                    logits = self.net.head(feats[:len(pick)]).squeeze(1)
                    weight = DANN_WEIGHT * (2 / (1 + np.exp(-10 * step / steps)) - 1)
                    dom = self.domain(Reverse.apply(feats, weight)).squeeze(1)
                    dom_y = torch.cat([torch.zeros(len(pick)), torch.ones(len(pick))])
                    loss = loss_fn(logits, torch.from_numpy(y[pick])) + nn.functional.binary_cross_entropy_with_logits(dom, dom_y)
                opt.zero_grad(); loss.backward(); opt.step(); step += 1
        return self

    def adabn(self, target):
        """Batch-normalisation statistics from the target windows (cumulative average), weights unchanged."""
        out = copy.deepcopy(self)
        W = SC.windows(target[0], self.source, self.half) if len(target) == 1 else np.concatenate([SC.windows(r, self.source, self.half) for r in target])
        for m in out.net.modules():
            if isinstance(m, nn.BatchNorm1d):
                m.reset_running_stats(); m.momentum = None
        out.net.train()
        with torch.no_grad():
            for b in range(0, len(W), 256):
                out.net(torch.from_numpy((W[b:b + 256] / self.scale).astype(np.float32)))
        return out

    def finetune(self, Wc, yc):
        """Fine-tuned on calibration windows (each step: all of them, with as many training-day windows)."""
        out = copy.deepcopy(self)
        rng = np.random.default_rng(self.seed + 1)
        opt = torch.optim.Adam(out.net.parameters(), lr=FINETUNE_LR)
        pos = max(1.0, yc.sum())
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(20.0, max(1.0, (len(yc) - pos) / pos))))
        Wc5 = [Wc[s] for s in range(5)]
        for _ in range(FINETUNE_STEPS):
            out.net.train()
            src = rng.integers(0, len(self.source_y), len(yc))
            xb = torch.cat([out._augment(Wc5, np.arange(len(yc)), rng), out._augment(self.source_windows, src, rng)])
            yb = torch.from_numpy(np.concatenate([yc, self.source_y[src]]))
            loss = loss_fn(out.net(xb), yb)
            opt.zero_grad(); loss.backward(); opt.step()
        return out

    def score(self, r):
        self.net.eval()
        with torch.no_grad():
            return self.net(torch.from_numpy(SC.windows(r, self.source, self.half) / self.scale)).numpy()


def split_day(test):
    """(calibration windows per K, the test recordings with the calibration part left out of scoring)."""
    cams = sorted((r for r in test if r["kind"] == "camera"), key=lambda r: r["grid"][0])
    events = [(c, r) for r in cams for c in r["contacts"]]          # in recording order, then time
    cut = {}
    if len(events) >= SCORED_AFTER:
        for c, r in events[:SCORED_AFTER]:
            cut[r["name"]] = max(cut.get(r["name"], 0), c + 1 * S)
    scored = []
    for r in test:
        q = dict(r)
        if r["name"] in cut:
            q["cy"] = np.where(r["ct"] <= cut[r["name"]], -1, r["cy"]).astype(np.int8)
            q["contacts"] = r["contacts"][r["contacts"] > cut[r["name"]]]
        scored.append(q)
    calib = {}
    for k in CALIBRATION:
        part = {}
        for c, r in events[:k]:
            part[r["name"]] = max(part.get(r["name"], 0), c + 1 * S)
        recs = []
        for r in cams:
            if r["name"] in part:
                q = dict(r)
                q["cy"] = np.where(r["ct"] <= part[r["name"]], r["cy"], -1).astype(np.int8)
                recs.append(q)
        calib[k] = recs
    return calib, scored


def run_days(day_folds, source, half, methods):
    scores = {m: [] for m in methods}
    tests = []
    for train, test in day_folds:
        calib, scored = split_day(test)
        tests += scored
        acc = {m: [np.zeros(len(r["ck"])) for r in test] for m in methods}
        for run in range(SC.RUNS):
            seed = M.SEED + run
            base = Model(source, half, seed).fit(train)
            fitted = {"none": base}
            if "AdaBN" in methods:
                fitted["AdaBN"] = base.adabn(test)
            if "DANN" in methods:
                fitted["DANN"] = Model(source, half, seed).fit(train, target=test)
            for k in CALIBRATION:
                name = f"calibration, {k} pinches"
                if name in methods:
                    Wc, yc = base._windows(calib[k])
                    fitted[name] = base.finetune(Wc, yc)
            for m in methods:
                for a, r in zip(acc[m], test):
                    a += fitted[m].score(r) / SC.RUNS
        for m in methods:
            scores[m] += acc[m]
    return {m: {g: SC.operating_points(tests, scores[m], g) for g in (False, True)} for m in methods}


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / "adapt-ppg"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    for r in recs:
        SC.prepare(r); NC.add_streams(r); add_pulse(r)
    cam = [r for r in recs if r["kind"] == "camera"]
    peaks = [r["shake"][s].max() for r in cam for c in r["contacts"] if (s := SC.C.span(r, c, *SC.PEAK_AFTER_S)).stop > s.start]
    for r in recs:
        SC.candidates(r, float(np.quantile(peaks, SC.CANDIDATE_QUANTILE)), float(np.quantile(peaks, 0.25)))
    trainable = [r for r in recs if r["kind"] in ("camera", "negative")]
    days = sorted({r["day"] for r in cam})
    day_folds = [([r for r in trainable if r["day"] != d], [r for r in trainable if r["day"] == d]) for d in days]
    print(f"days {days}; contacts per day " + ", ".join(str(sum(len(r['contacts']) for r in cam if r['day'] == d)) for d in days), flush=True)

    adapt_methods = ["none", "AdaBN", "DANN", "calibration, 5 pinches", "calibration, 10 pinches"]
    results = {"days": days, "day_split": {}, "recordings_split": {}}
    for label, (source, half), methods in (("motion, ±0.2 s", ("z_sig", 10), adapt_methods),
                                           ("motion + pulse, ±0.2 s", ("z_sig_ppg", 10), ["none", "calibration, 10 pinches"]),
                                           ("motion, ±0.5 s", ("z_sig", 25), ["none"]),
                                           ("motion + pulse, ±0.5 s", ("z_sig_ppg", 25), ["none", "calibration, 10 pinches"])):
        tv = time.time()
        got = run_days(day_folds, source, half, methods)
        for m, v in got.items():
            results["day_split"][f"{label} | {m}"] = {str(g): {str(k): x[0] for k, x in d.items()} for g, d in v.items()}
        print(f"  day split, {label}: {time.time() - tv:.0f} s", flush=True)
    # The pulse with whole recordings held out (step 7's folds).
    from sklearn.model_selection import GroupKFold
    gkf = GroupKFold(n_splits=5, shuffle=True, random_state=M.SEED)
    cam_i = [i for i, r in enumerate(trainable) if r["kind"] == "camera"]
    neg_i = [i for i, r in enumerate(trainable) if r["kind"] == "negative"]
    folds = []
    for (_, a), (_, b) in zip(gkf.split(cam_i, groups=cam_i), gkf.split(neg_i, groups=neg_i)):
        ids = {cam_i[j] for j in a} | {neg_i[j] for j in b}
        folds.append(([r for i, r in enumerate(trainable) if i not in ids], [trainable[i] for i in sorted(ids)]))
    for label, (source, half) in (("motion, ±0.2 s", ("z_sig", 10)), ("motion + pulse, ±0.2 s", ("z_sig_ppg", 10)),
                                  ("motion, ±0.5 s", ("z_sig", 25)), ("motion + pulse, ±0.5 s", ("z_sig_ppg", 25))):
        tv = time.time()
        got, _, _ = SC.run_split(folds, source, half)
        results["recordings_split"][label] = {str(g): {str(k): x[0] for k, x in d.items()} for g, d in got.items()}
        print(f"  recordings split, {label}: {time.time() - tv:.0f} s", flush=True)
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    def row(name, v):
        a, b = v["False"], v["True"]
        return f"| {name} | {a['1.0']:.0%} | {a['0.5']:.0%} | {a['0.2']:.0%} | {b['1.0']:.0%} | {b['0.5']:.0%} | {b['0.2']:.0%} |"

    head = ["| Variant | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |",
            "|---|---:|---:|---:|---:|---:|---:|"]
    lines = ["# Adapting to a new session, and adding the pulse sensor", "",
             f"Base: step 8's z-score + sigmoid windows and spike CNN; scores are the average of {SC.RUNS} training runs.", "",
             f"## Each recording day held out ({', '.join(days)})", "",
             f"Scored after each held-out day's first {SCORED_AFTER} pinches (the calibration pinches), for every variant.", ""] + head
    lines += [row(k, v) for k, v in results["day_split"].items()]
    lines += ["", "## Whole recordings held out (5 folds)", ""] + head
    lines += [row(k, v) for k, v in results["recordings_split"].items()]
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
