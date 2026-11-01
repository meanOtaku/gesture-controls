"""ViWatch (Chen et al., UIST 2023), replicated as published, on this repository's recordings.

"Robust Finger Interactions with COTS Smartwatches via Unsupervised Siamese Adaptation." Nothing here is taken from the
earlier steps of this study; every choice is the paper's, except where the paper does not say, listed under "Not
published" below with the value used.

The paper's method (section 4, figures 6-8, section 5):

* 100 Hz accelerometer and gyroscope (6 axes).
* Segmentation: energy-based double thresholds find where a tap's vibration starts; the segment is the 0.5 s after.
* A 20 Hz Butterworth high-pass removes body motion (below 10 Hz) and gravity.
* Each segment z-score normalised, and aligned by time difference of arrival with generalised cross-correlation (GCC).
* Backbone CNN (figure 6), input 43 timesteps x 6 axes: four blocks of Conv1D, BatchNorm, ELU, Dropout 0.35, MaxPool 2,
  with (kernel, filters) (5, 64), (5, 64), (3, 64), (3, 32); then Fully connected 64, LayerNorm, ELU, Dropout 0.35;
  Fully connected (one per class), Sigmoid, LogSoftmax. Trained up to 600 epochs, keeping the model that does best on
  a validation set.
* DANN (figure 7): the feature extractor (the convolution blocks) feeds the classifier and, through a gradient-reversal
  layer, a domain discriminator. The discriminator takes the features and the classifier's output, each through
  FC 256, BatchNorm, ReLU, summed, then FC 1024, BatchNorm, ReLU, Dropout 0.5, FC 2. 33 epochs, keeping the best model
  on the source validation set. Loss L = L_y - alpha L_d(source) + lambda L_d(target).
* Siamese DANN (figure 8): the discriminator's last layer becomes a 16-value embedding, trained with the contrastive
  loss d ||f(x1) - f(x2)||^2 + (1 - d) max(0, delta - ||f(x1) - f(x2)||^2) on balanced pairs from the same domain
  (d = 1) or different domains (d = 0).
* Evaluation: a 3:1:1 train/validation/test split within the data, and leave-one-participant-out, where part of the
  left-out user's data, with labels removed, is the unlabelled target set T_train and the rest is the test set.

How it maps onto these recordings. There is one person, so a recording day (the watch put on afresh) stands in for a
user: leave-one-day-out for leave-one-participant-out, and days are the domains. The classes are the labelled gestures:
pinch, fist, hand open, thumbs up, wrist twist for the within-data split; pinch and fist for leave-one-day-out, the only
gestures recorded on more than one day (2026-10-04, 10-11, 10-14, 10-17). A segment takes a gesture's label when it
starts from 1 s before the labelled gesture to its end (labels trail the movement); only the first segment per
gesture counts, as one tap per prompt.

Not published, and the value used:

* The recordings are 50 Hz, not 100 Hz. They are interpolated to 100 Hz so the CNN's 43-timestep input and the
  0.5 s segment are as published. Nothing above 25 Hz exists in them, so the 20 Hz high-pass leaves only 20-25 Hz.
* The recordings hold linear acceleration (gravity removed by Android), not raw acceleration; the 20 Hz high-pass
  would remove gravity anyway.
* Energy and thresholds ([15] in the paper): energy is the mean square, over 50 ms, of the accelerometer less its 1 s
  mean; the high threshold is set so 90% of labelled gestures in the training days reach it, the low threshold is half
  of it, and the start is the last low-threshold crossing before the high one.
* The SNR-based noise threshold ([11]) and the Fisher-score features are not applied: the CNN's stated input is the
  43 x 6 signal.
* Filter order 4, run causally. z-score per axis over each segment. GCC alignment: each segment's accelerometer
  magnitude is cross-correlated with the training segments' mean, shifts up to 7 samples; the 43 samples start at the
  shift.
* Where figure 6 says BatchNorm 2D (32), BatchNorm over the block's channels is used.
* The paper's stopping rule reads "stopped early if the validation accuracy is greater than 50%"; the best-on-validation
  rule it states for DANN is used for both. Validation is a random 20% of the training days' segments.
* Adam, learning rate 1e-3, batch 64; alpha = lambda = 1; delta = 1; the gradient-reversal weight is 1.
* T_train is a random half of the held-out day's segments (the paper used 30 a key), T_test the other half.

Scores: accuracy, and balanced accuracy (the mean of each class's recall), against always guessing the largest class.
Neural results are the mean of 5 training runs.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/paper_viwatch_check.py

Run from the repository root (about 10 minutes). Writes paper-viwatch/results.json and results.md.
"""
import copy, importlib.util, json, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from scipy.signal import butter, sosfilt

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("imu_models_check", HERE / "imu_models_check.py")
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)
S = M.S

HZ = 100.0
SEGMENT_S = 0.5
TIMESTEPS = 43
MAX_SHIFT = 7
HP = butter(4, 20, btype="highpass", fs=HZ, output="sos")
ENERGY_S, MEAN_S = 0.05, 1.0
DETECT_SHARE = 0.90
LABEL_FROM_S = -1.0
EPOCHS, DANN_EPOCHS, BATCH, LR = 600, 33, 64, 1e-3
DELTA = 1.0
RUNS = 5
CLASSES_ALL = ("pinch", "fist", "hand_open", "thumbs_up", "hand_twit_clockwise_and_anti_clockwise")
CLASSES_DAYS = ("pinch", "fist")
DAYS = ("2026-10-04", "2026-10-11", "2026-10-14", "2026-10-17")


def upsample(r):
    """100 Hz copies of the 50 Hz motion, the energy for segmentation, and the high-passed signal."""
    grid = np.arange(r["grid"][0], r["grid"][-1], int(S / HZ), dtype=np.int64)
    x = np.column_stack([np.interp(grid, r["grid"], r["x"][:, c]) for c in range(6)])
    gap = np.interp(grid, r["grid"], r["gap_ok"].astype(float)) > 0.99
    mag = np.linalg.norm(x[:, :3], axis=1)
    detrended = mag - M.trailing_mean(mag, int(MEAN_S * HZ))
    energy = M.trailing_mean(detrended ** 2, int(ENERGY_S * HZ))
    r.update(g100=grid, x100=x, gap100=gap, energy=energy, hp100=sosfilt(HP, x, axis=0))


def segments(r, high):
    """Start indices of double-threshold segments, one per crossing of the high threshold."""
    e = r["energy"]
    n = int(SEGMENT_S * HZ)
    starts, i = [], 0
    above = np.flatnonzero(e > high)
    for k in above:
        if k < i:
            continue
        s = k
        while s > 0 and e[s - 1] > high / 2:
            s -= 1
        if s + n + MAX_SHIFT < len(e) and r["gap100"][s:s + n + MAX_SHIFT].all():
            starts.append(s)
        i = s + n                                    # the next segment starts after this one ends
    return np.array(starts, dtype=int)


def labelled(r, starts, classes):
    """(start index, class index) for the first segment of each labelled gesture of `classes`."""
    t = r["g100"][starts] if len(starts) else np.array([])
    out = []
    for a, b, label in r["holds"]:
        if label in classes:
            k = np.flatnonzero((t >= a + LABEL_FROM_S * S) & (t <= b))
            if len(k):
                out.append((starts[k[0]], classes.index(label)))
    return out


def gesture_peak_energy(r, classes):
    return [r["energy"][(r["g100"] >= a + LABEL_FROM_S * S) & (r["g100"] <= b)].max()
            for a, b, label in r["holds"] if label in classes and ((r["g100"] >= a + LABEL_FROM_S * S) & (r["g100"] <= b)).any()]


def raw_segments(r, items):
    n = int(SEGMENT_S * HZ)
    return np.stack([r["hp100"][s:s + n + MAX_SHIFT] for s, _ in items]) if items else np.zeros((0, n + MAX_SHIFT, 6))


def finish(raw, template):
    """GCC alignment to the template, the 43 timesteps from the shift, z-score per axis: (n, 6, 43)."""
    out = []
    for seg in raw:
        m = np.linalg.norm(seg[:, :3], axis=1)
        if template is not None:
            cc = [np.dot(m[s:s + TIMESTEPS] - m[s:s + TIMESTEPS].mean(), template) for s in range(MAX_SHIFT + 1)]
            s = int(np.argmax(cc))
        else:
            s = 0
        w = seg[s:s + TIMESTEPS]
        out.append(((w - w.mean(0)) / (w.std(0) + 1e-8)).T)
    return np.array(out, dtype=np.float32)


def template_of(raw):
    m = np.linalg.norm(raw[:, :TIMESTEPS, :3], axis=2).mean(0)
    return m - m.mean()


class Extractor(nn.Module):
    def __init__(self):
        super().__init__()
        layers, c = [], 6
        for k, f in ((5, 64), (5, 64), (3, 64), (3, 32)):
            layers += [nn.Conv1d(c, f, k, padding=k // 2), nn.BatchNorm1d(f), nn.ELU(), nn.Dropout(0.35), nn.MaxPool1d(2)]
            c = f
        self.body = nn.Sequential(*layers)

    def forward(self, x):
        return self.body(x).flatten(1)


class Classifier(nn.Module):
    def __init__(self, width, classes):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(width, 64), nn.LayerNorm(64), nn.ELU(), nn.Dropout(0.35),
                                 nn.Linear(64, classes), nn.Sigmoid(), nn.LogSoftmax(dim=1))

    def forward(self, f):
        return self.net(f)


class Discriminator(nn.Module):
    def __init__(self, width, classes, out):
        super().__init__()
        self.f = nn.Sequential(nn.Linear(width, 256), nn.BatchNorm1d(256), nn.ReLU())
        self.y = nn.Sequential(nn.Linear(classes, 256), nn.BatchNorm1d(256), nn.ReLU())
        self.head = nn.Sequential(nn.Linear(256, 1024), nn.BatchNorm1d(1024), nn.ReLU(), nn.Dropout(0.5), nn.Linear(1024, out))

    def forward(self, f, y):
        return self.head(self.f(f) + self.y(y))


class Reverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        return x.view_as(x)

    @staticmethod
    def backward(ctx, g):
        return -g


def accuracy(model, X, y):
    ext, clf = model
    ext.eval(); clf.eval()
    with torch.no_grad():
        p = clf(ext(torch.from_numpy(X))).argmax(1).numpy()
    return p


def scores(pred, y, k):
    acc = float((pred == y).mean())
    recalls = [float((pred[y == c] == c).mean()) for c in range(k) if (y == c).any()]
    return acc, float(np.mean(recalls))


def train_backbone(X, y, k, seed):
    torch.manual_seed(seed); rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y)); nv = max(1, len(y) // 5)
    va, tr = idx[:nv], idx[nv:]
    ext = Extractor(); width = ext(torch.zeros(1, 6, TIMESTEPS)).shape[1]
    clf = Classifier(width, k)
    opt = torch.optim.Adam(list(ext.parameters()) + list(clf.parameters()), lr=LR)
    best, state = -1.0, None
    Xt, yt = torch.from_numpy(X), torch.from_numpy(y).long()
    for _ in range(EPOCHS):
        ext.train(); clf.train()
        order = rng.permutation(tr)
        for b in range(0, len(order), BATCH):
            pick = order[b:b + BATCH]
            if len(pick) < 2:
                continue
            loss = nn.functional.nll_loss(clf(ext(Xt[pick])), yt[pick])
            opt.zero_grad(); loss.backward(); opt.step()
        v = float((accuracy((ext, clf), X[va], y[va]) == y[va]).mean())
        if v > best:
            best, state = v, (copy.deepcopy(ext.state_dict()), copy.deepcopy(clf.state_dict()))
    ext.load_state_dict(state[0]); clf.load_state_dict(state[1])
    return (ext, clf), va


def adapt(model, X, y, dom, va, Xt, k, seed, siamese):
    """DANN or Siamese DANN from the backbone, 33 epochs, best on the source validation set."""
    torch.manual_seed(seed); rng = np.random.default_rng(seed + 100)
    ext, clf = copy.deepcopy(model[0]), copy.deepcopy(model[1])
    width = ext(torch.zeros(1, 6, TIMESTEPS)).shape[1]
    disc = Discriminator(width, k, 16 if siamese else 2)
    opt = torch.optim.Adam(list(ext.parameters()) + list(clf.parameters()) + list(disc.parameters()), lr=LR)
    tr = np.setdiff1d(np.arange(len(y)), va)
    Xs, ys = torch.from_numpy(X), torch.from_numpy(y).long()
    XT = torch.from_numpy(Xt)
    target_dom = dom.max() + 1
    best, state = -1.0, None
    for _ in range(DANN_EPOCHS):
        ext.train(); clf.train(); disc.train()
        order = rng.permutation(tr)
        for b in range(0, len(order), BATCH):
            pick = order[b:b + BATCH]
            if len(pick) < 2:
                continue
            tp = rng.integers(0, len(Xt), len(pick))
            xb = torch.cat([Xs[pick], XT[tp]])
            f = ext(xb)
            logp = clf(f)
            loss = nn.functional.nll_loss(logp[:len(pick)], ys[pick])
            emb = disc(Reverse.apply(f), logp.exp().detach())     # no gradient from the discriminator to the classifier
            if siamese:
                d = np.r_[dom[pick], np.full(len(pick), target_dom)]
                n = len(d)
                i1 = rng.integers(0, n, 4 * n); i2 = rng.integers(0, n, 4 * n)
                same = d[i1] == d[i2]
                pos, neg = np.flatnonzero(same), np.flatnonzero(~same)
                m = min(len(pos), len(neg))
                if m == 0:
                    continue
                sel = np.r_[rng.choice(pos, m, replace=False), rng.choice(neg, m, replace=False)]
                dist = ((emb[i1[sel]] - emb[i2[sel]]) ** 2).sum(1)
                lab = torch.from_numpy(same[sel].astype(np.float32))
                loss = loss + (lab * dist + (1 - lab) * torch.clamp(DELTA - dist, min=0)).mean()
            else:
                dl = torch.cat([torch.zeros(len(pick)), torch.ones(len(pick))]).long()
                loss = loss + nn.functional.cross_entropy(emb[:len(pick)], dl[:len(pick)]) + nn.functional.cross_entropy(emb[len(pick):], dl[len(pick):])
            opt.zero_grad(); loss.backward(); opt.step()
        v = float((accuracy((ext, clf), X[va], y[va]) == y[va]).mean())
        if v > best:
            best, state = v, (copy.deepcopy(ext.state_dict()), copy.deepcopy(clf.state_dict()))
    ext.load_state_dict(state[0]); clf.load_state_dict(state[1])
    return ext, clf


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / "paper-viwatch"; out_dir.mkdir(exist_ok=True)
    recs = [r for r in M.load_all()]
    for r in recs:
        upsample(r)

    def collect(pool, classes, high):
        items = []
        for r in pool:
            lab = labelled(r, segments(r, high), classes)
            items += [(r, s, c) for s, c in lab]
        return items

    def threshold(pool, classes):
        peaks = [e for r in pool for e in gesture_peak_energy(r, classes)]
        return float(np.quantile(peaks, 1 - DETECT_SHARE))

    results = {}

    # 1. Within the data: a 3:1:1 split of all segments, all five gestures.
    high = threshold(recs, CLASSES_ALL)
    items = collect(recs, CLASSES_ALL, high)
    gestures = sum(1 for r in recs for *_, l in r["holds"] if l in CLASSES_ALL)
    y_all = np.array([c for *_, c in items])
    raw = np.concatenate([raw_segments(r, [(s, c)]) for r, s, c in items])
    within = []
    for run in range(RUNS):
        rng = np.random.default_rng(M.SEED + run)
        idx = rng.permutation(len(items)); n = len(idx)
        tr, te = idx[:int(0.8 * n)], idx[int(0.8 * n):]          # 3:1 of the 80% inside train_backbone, 1 held out
        tmpl = template_of(raw[tr])
        X = finish(raw, tmpl)
        model, _ = train_backbone(X[tr], y_all[tr], len(CLASSES_ALL), M.SEED + run)
        within.append(scores(accuracy(model, X[te], y_all[te]), y_all[te], len(CLASSES_ALL)))
    counts = {CLASSES_ALL[c]: int((y_all == c).sum()) for c in range(len(CLASSES_ALL))}
    results["within"] = {"segments": len(items), "gestures": gestures, "per_class": counts,
                         "accuracy": float(np.mean([a for a, _ in within])), "balanced": float(np.mean([b for _, b in within])),
                         "majority": max(counts.values()) / len(items)}
    print(f"within: {results['within']}", flush=True)

    # 2-4. Leave one day out: pinch and fist; backbone, DANN, Siamese DANN.
    per_day = {}
    for day in DAYS:
        train_recs = [r for r in recs if r["day"] in DAYS and r["day"] != day]
        test_recs = [r for r in recs if r["day"] == day]
        high = threshold(train_recs, CLASSES_DAYS)
        tr_items, te_items = collect(train_recs, CLASSES_DAYS, high), collect(test_recs, CLASSES_DAYS, high)
        raw_tr = np.concatenate([raw_segments(r, [(s, c)]) for r, s, c in tr_items])
        raw_te = np.concatenate([raw_segments(r, [(s, c)]) for r, s, c in te_items])
        tmpl = template_of(raw_tr)
        Xtr, Xte = finish(raw_tr, tmpl), finish(raw_te, tmpl)
        ytr = np.array([c for *_, c in tr_items]); yte = np.array([c for *_, c in te_items])
        dom = np.array([DAYS.index(r["day"]) for r, _, _ in tr_items])
        got = {"backbone": [], "DANN": [], "Siamese DANN": []}
        for run in range(RUNS):
            seed = M.SEED + run
            rng = np.random.default_rng(seed)
            half = rng.permutation(len(yte)); T_train, T_test = half[:len(half) // 2], half[len(half) // 2:]
            model, va = train_backbone(Xtr, ytr, 2, seed)
            got["backbone"].append(scores(accuracy(model, Xte[T_test], yte[T_test]), yte[T_test], 2))
            for name, siamese in (("DANN", False), ("Siamese DANN", True)):
                adapted = adapt(model, Xtr, ytr, dom, va, Xte[T_train], 2, seed, siamese)
                got[name].append(scores(accuracy(adapted, Xte[T_test], yte[T_test]), yte[T_test], 2))
        per_day[day] = {"train_segments": len(ytr), "test_segments": len(yte),
                        "test_pinch": int((yte == 0).sum()), "test_fist": int((yte == 1).sum()),
                        "majority": float(max((yte == 0).mean(), (yte == 1).mean())),
                        **{k: {"accuracy": float(np.mean([a for a, _ in v])), "balanced": float(np.mean([b for _, b in v]))} for k, v in got.items()}}
        print(f"day {day}: {per_day[day]}", flush=True)
    results["leave_one_day_out"] = per_day
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    w = results["within"]
    lines = ["# ViWatch (UIST 2023), as published, on these recordings", "",
             "## Within the data (3:1:1 split, five gestures)", "",
             f"{w['segments']} segments from {w['gestures']} labelled gestures ("
             + ", ".join(f"{k} {v}" for k, v in w["per_class"].items()) + ").", "",
             "| | Accuracy | Balanced accuracy | Always the largest class |", "|---|---:|---:|---:|",
             f"| Backbone CNN | {w['accuracy']:.0%} | {w['balanced']:.0%} | {w['majority']:.0%} |", "",
             "## Leave one day out (pinch against fist)", "",
             "Each day's segments: a random half, labels removed, is the unlabelled set the adaptation uses; the other half is tested.", "",
             "| Held-out day | Test segments (pinch / fist) | Always the largest class | Backbone | DANN | Siamese DANN |",
             "|---|---|---:|---|---|---|"]
    for day, v in per_day.items():
        cell = lambda k: f"{v[k]['accuracy']:.0%} (balanced {v[k]['balanced']:.0%})"
        lines.append(f"| {day} | {v['test_segments']} ({v['test_pinch']} / {v['test_fist']}) | {v['majority']:.0%} | {cell('backbone')} | {cell('DANN')} | {cell('Siamese DANN')} |")
    mean = lambda k, f: np.mean([v[k][f] for v in per_day.values()])
    lines.append(f"| Mean | | {np.mean([v['majority'] for v in per_day.values()]):.0%} | "
                 + " | ".join(f"{mean(k, 'accuracy'):.0%} (balanced {mean(k, 'balanced'):.0%})" for k in ("backbone", "DANN", "Siamese DANN")) + " |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
