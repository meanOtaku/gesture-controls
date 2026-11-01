"""Tsunoda, Choi and Shizuki (MUM 2024), replicated as published, on this repository's recordings.

"Thumb-to-Finger Gesture Recognition Using COTS Smartwatch Accelerometers." Nothing here is taken from the earlier
steps of this study; every choice is the paper's, except where the paper does not say, listed under "Not published"
below with the value used.

The paper's method (sections 3 and 4):

* Accelerometer only (3 axes), at 4000 Hz.
* Detection: a 15 Hz high-pass on each axis, then the rate-of-change score R_x (from TapType): the absolute changes
  over the last 0.01 s, summed over the three axes. A gesture is detected when the largest R_x in the most recent
  window (100 points, 25 ms) is above a threshold tau and sits at the window's centre; the segment, 0.75 s, is centred
  on that peak. Detection pauses for one window after each detection.
* Each segment split into three frequency bands, 0.22-8 Hz, 8-32 Hz and above 32 Hz (from Xu et al. 2022), giving 9
  channels.
* Kimura's self-supervised method: a representation model is pre-trained without labels on segments from about 2 hours
  of daily activity (kept only where R_x shows movement), turning each segment into a 1280-value feature vector; a
  linear support vector machine is then trained on the feature vectors of a few labelled gestures.
* Evaluation: leave-one-session-out within one participant (the watch put back on for a new session), and with fewer
  labelled samples per gesture.

How it maps onto these recordings. There is one person, so the participant-specific leave-one-session-out protocol
fits directly; a recording day is a session. The gestures recorded on more than one day are pinch and fist
(2026-10-04, 10-11, 10-14, 10-17), so those two are classified. A segment takes a gesture's label when its peak falls
from 1 s before the labelled gesture to its end (labels trail the movement); only the first segment per gesture counts.
The unlabelled pre-training segments are drawn from every detected segment in the other days' recordings, gestures and
everyday activity alike, with no labels: 5,106 of them at random, the number the paper pre-trained on.

Not published, and the value used:

* The recordings are 50 Hz, not 4000 Hz. Parameters given in seconds are kept in seconds: the 0.75 s segment is 37
  samples; R_x over 0.01 s is less than one sample, so it is the change from the previous sample; the 25 ms window is
  under two samples, so a detection is any local peak of R_x above tau, and no second detection within 25 ms.
  The 15 Hz high-pass leaves 15-25 Hz. Of the three bands only two exist below 25 Hz: 0.22-8 Hz and 8-25 Hz, so the
  segments have 6 channels, not 9. The paper found accuracy falls sharply below 200 Hz.
* The recordings hold linear acceleration (gravity removed by Android), not raw acceleration.
* tau: set so 90% of labelled gestures in the training days reach it.
* Filters: Butterworth order 4, run causally.
* **The representation model is not published** (Tsunoda cites Kimura's poster, which does not name it either). The
  poster cites contrastive predictive coding (CPC, Haresamudram et al. 2021) as the framework for this kind of
  pre-training, so CPC is used: an encoder of three 1D convolutions (kernel 3; 32, 64, 128 filters; ReLU; dropout 0.2),
  a 2-layer GRU of 256, predicting the encoder's next 12 steps from the context with the InfoNCE loss (other segments
  in the batch as negatives); Adam, learning rate 5e-4, 150 epochs, batch 64. The feature vector is the GRU's final
  context, 256 values, not 1280. This is the one part not from the paper.
* The SVM: scikit-learn's linear SVC on standardised feature vectors, C = 1.
* Fewer labelled samples: 5 and 10 per gesture, drawn at random from the training days.
* One pre-training run per held-out day (each takes about 10 minutes), so the figures carry run-to-run noise.

Scores: accuracy, and balanced accuracy (the mean of each class's recall), against always guessing the largest class.
One pre-training run per held-out day.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/paper_tsunoda_check.py

Run from the repository root (about 45 minutes). Writes paper-tsunoda/results.json and results.md.
"""
import importlib.util, json, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from scipy.signal import butter, sosfilt
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("imu_models_check", HERE / "imu_models_check.py")
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)
S, HZ = M.S, M.HZ

HALF = int(round(0.75 * HZ / 2))                     # 18 samples either side: 37
HP = butter(4, 15, btype="highpass", fs=HZ, output="sos")
BANDS = (butter(4, (0.22, 8), btype="bandpass", fs=HZ, output="sos"), butter(4, 8, btype="highpass", fs=HZ, output="sos"))
DETECT_SHARE = 0.90
LABEL_FROM_S = -1.0
CLASSES = ("pinch", "fist")
DAYS = ("2026-10-04", "2026-10-11", "2026-10-14", "2026-10-17")
K_AHEAD, CPC_EPOCHS, CPC_LR, BATCH = 12, 150, 5e-4, 64
SHOTS = (5, 10)
RUNS = 1
PRETRAIN_SEGMENTS = 5106                             # the paper's pre-training set size


def prepare(r):
    a = r["x"][:, :3]
    hp = sosfilt(HP, a, axis=0)
    r["rx"] = np.r_[0.0, np.abs(np.diff(hp, axis=0)).sum(1)]
    r["bands"] = np.concatenate([sosfilt(b, a, axis=0) for b in BANDS], axis=1)      # 6 channels


def detections(r, tau):
    """Peaks of R_x above tau whose 0.75 s segment lies inside the recording, with no gap."""
    rx = r["rx"]
    k = np.flatnonzero((rx[1:-1] > tau) & (rx[1:-1] >= rx[:-2]) & (rx[1:-1] > rx[2:])) + 1
    return np.array([i for i in k if i - HALF >= 0 and i + HALF < len(rx) and r["gap_ok"][i - HALF:i + HALF + 1].all()], dtype=int)


def gesture_peaks(r):
    out = []
    for a, b, label in r["holds"]:
        if label in CLASSES:
            m = (r["grid"] >= a + LABEL_FROM_S * S) & (r["grid"] <= b)
            if m.any():
                out.append(r["rx"][m].max())
    return out


def labelled(r, peaks):
    t = r["grid"][peaks] if len(peaks) else np.array([])
    out = []
    for a, b, label in r["holds"]:
        if label in CLASSES:
            k = np.flatnonzero((t >= a + LABEL_FROM_S * S) & (t <= b))
            if len(k):
                out.append((peaks[k[0]], CLASSES.index(label)))
    return out


def windows(r, idx):
    return np.stack([r["bands"][i - HALF:i + HALF + 1].T for i in idx]).astype(np.float32) if len(idx) else np.zeros((0, 6, 2 * HALF + 1), np.float32)


class Cpc(nn.Module):
    def __init__(self):
        super().__init__()
        layers, c = [], 6
        for f in (32, 64, 128):
            layers += [nn.Conv1d(c, f, 3, padding=1), nn.ReLU(), nn.Dropout(0.2)]
            c = f
        self.encoder = nn.Sequential(*layers)
        self.gru = nn.GRU(128, 256, num_layers=2, batch_first=True)
        self.predict = nn.ModuleList([nn.Linear(256, 128) for _ in range(K_AHEAD)])

    def contexts(self, x):
        z = self.encoder(x).transpose(1, 2)            # (n, T, 128)
        c, _ = self.gru(z)
        return z, c

    def loss(self, x, rng):
        z, c = self.contexts(x)
        T = z.shape[1]
        t = int(rng.integers(T // 4, T - K_AHEAD - 1))
        total = 0.0
        for k in range(K_AHEAD):
            pred = self.predict[k](c[:, t])            # (n, 128)
            logits = pred @ z[:, t + 1 + k].T           # the other segments in the batch are the negatives
            total = total + nn.functional.cross_entropy(logits, torch.arange(len(x)))
        return total / K_AHEAD

    def features(self, x):
        self.eval()
        with torch.no_grad():
            return self.contexts(torch.from_numpy(x))[1][:, -1].numpy()


def pretrain(X, seed):
    torch.manual_seed(seed); rng = np.random.default_rng(seed)
    model = Cpc()
    opt = torch.optim.Adam(model.parameters(), lr=CPC_LR)
    scale = X.std(axis=(0, 2), keepdims=True) + 1e-8
    Xs = torch.from_numpy((X / scale).astype(np.float32))
    for _ in range(CPC_EPOCHS):
        model.train()
        order = rng.permutation(len(X))
        for b in range(0, len(order) - 1, BATCH):
            pick = order[b:b + BATCH]
            if len(pick) < 8:
                continue
            loss = model.loss(Xs[pick], rng)
            opt.zero_grad(); loss.backward(); opt.step()
    return model, scale


def scores(pred, y):
    return float((pred == y).mean()), float(np.mean([(pred[y == c] == c).mean() for c in range(len(CLASSES)) if (y == c).any()]))


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / "paper-tsunoda"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    for r in recs:
        prepare(r)
    per_day = {}
    for day in DAYS:
        train_recs = [r for r in recs if r["day"] != day]
        test_recs = [r for r in recs if r["day"] == day]
        tau = float(np.quantile([p for r in train_recs if r["day"] in DAYS for p in gesture_peaks(r)], 1 - DETECT_SHARE))
        det = {r["name"]: detections(r, tau) for r in recs}
        unlabelled = np.concatenate([windows(r, det[r["name"]]) for r in train_recs])
        if len(unlabelled) > PRETRAIN_SEGMENTS:
            unlabelled = unlabelled[np.random.default_rng(M.SEED).choice(len(unlabelled), PRETRAIN_SEGMENTS, replace=False)]
        tr = [(r, i, c) for r in train_recs if r["day"] in DAYS for i, c in labelled(r, det[r["name"]])]
        te = [(r, i, c) for r in test_recs for i, c in labelled(r, det[r["name"]])]
        Xtr = np.concatenate([windows(r, [i]) for r, i, _ in tr]); ytr = np.array([c for *_, c in tr])
        Xte = np.concatenate([windows(r, [i]) for r, i, _ in te]); yte = np.array([c for *_, c in te])
        gestures = sum(1 for r in test_recs for *_, l in r["holds"] if l in CLASSES)
        got = {"all": [], **{f"{n} a gesture": [] for n in SHOTS}}
        for run in range(RUNS):
            seed = M.SEED + run
            model, scale = pretrain(unlabelled, seed)
            Ftr, Fte = model.features((Xtr / scale).astype(np.float32)), model.features((Xte / scale).astype(np.float32))
            svm = make_pipeline(StandardScaler(), LinearSVC(C=1.0, max_iter=20000)).fit(Ftr, ytr)
            got["all"].append(scores(svm.predict(Fte), yte))
            rng = np.random.default_rng(seed)
            for n in SHOTS:
                pick = np.concatenate([rng.choice(np.flatnonzero(ytr == c), n, replace=False) for c in range(len(CLASSES))])
                svm = make_pipeline(StandardScaler(), LinearSVC(C=1.0, max_iter=20000)).fit(Ftr[pick], ytr[pick])
                got[f"{n} a gesture"].append(scores(svm.predict(Fte), yte))
        per_day[day] = {"unlabelled_segments": len(unlabelled), "train_segments": len(ytr), "test_gestures": gestures,
                        "test_segments": len(yte), "test_pinch": int((yte == 0).sum()), "test_fist": int((yte == 1).sum()),
                        "majority": float(max((yte == 0).mean(), (yte == 1).mean())),
                        **{k: {"accuracy": float(np.mean([a for a, _ in v])), "balanced": float(np.mean([b for _, b in v]))} for k, v in got.items()}}
        print(f"day {day}: {per_day[day]}", flush=True)
    results = {"leave_one_session_out": per_day, "seconds": round(time.time() - t0, 1)}
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    keys = ["all"] + [f"{n} a gesture" for n in SHOTS]
    lines = ["# Tsunoda et al. (MUM 2024), as published, on these recordings", "",
             "Leave one session (day) out, pinch against fist. The representation model is a stand-in (CPC); see the script.", "",
             "| Held-out day | Detected / labelled gestures | Test (pinch / fist) | Always the largest class | SVM on all training gestures | 5 a gesture | 10 a gesture |",
             "|---|---|---|---:|---|---|---|"]
    for day, v in per_day.items():
        cell = lambda k: f"{v[k]['accuracy']:.0%} (balanced {v[k]['balanced']:.0%})"
        lines.append(f"| {day} | {v['test_segments']} / {v['test_gestures']} | {v['test_pinch']} / {v['test_fist']} | {v['majority']:.0%} | "
                     + " | ".join(cell(k) for k in keys) + " |")
    mean = lambda k, f: np.mean([v[k][f] for v in per_day.values()])
    lines.append(f"| Mean | | | {np.mean([v['majority'] for v in per_day.values()]):.0%} | "
                 + " | ".join(f"{mean(k, 'accuracy'):.0%} (balanced {mean(k, 'balanced'):.0%})" for k in keys) + " |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
