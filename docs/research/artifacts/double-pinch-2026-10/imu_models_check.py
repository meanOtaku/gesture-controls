"""Which model finds a pinch contact best from the motion sensors alone: a threshold, a linear model, trees, random
convolutions or a CNN?

A double pinch is two contacts in quick succession, so the building block is a detector that marks each contact as it
happens. Every model here sees the same thing at each decision (every 40 ms): the last 1.0 s of the watch's motion on a
50 Hz grid (linear acceleration and gyroscope, each three axes), causally, as the app would.

**Labels.** The camera's thumb-to-index contacts (`imu_contact_check.py`: the distance in hand sizes falling below 0.35,
put on the watch clock), but only the first contact within a labelled pinch (from 1 s before its start to its end): the
camera also "closes" the fingers in fists and in everyday movement, which are not pinches. The pinch recordings in
`data/recordings/` with a matching camera bundle in the app's data folder (same start, same watch clock) give the
contacts; a decision is positive when a contact happened 0.10 to 0.40 s before it (the jolt peaks about 0.12 s after
the camera's contact, and the clocks agree to about 0.1 s). Decisions just around a contact's edges, after a release (a
release jolts alike), near another camera contact or in a pinch the camera lost are left out of training. The
recordings with no pinch at all (fists, thumbs ups, wrist twists, everything_else) are negatives throughout. Unlabelled
recordings, and pinch recordings without a camera, are not trained on.

**Models.**

* jolt threshold: no training; each axis less its trailing 0.3 s mean, as the magnitude per sensor, over its trailing
  10 s mean level, the largest in the last 0.4 s (the two sensors averaged);
* logistic regression (the linear model), ExtraTrees and gradient boosting, on 43 features of the window: per axis, the
  largest and spread of the quick part in each half; per sensor, the jolt's peak, its position, its level before, the
  peak over the recent 10 s and over the level before, the jolt in thirds; the axes' means; the direction of up in the
  watch's axes (from its rotation vector);
* random convolutions (ROCKET-style): 1,000 random dilated kernels over the six axes, each giving the share of the
  window where it exceeds a bias (MiniRocket's PPV), into a logistic regression;
* a 1D CNN (three dilated convolution layers, then global max and mean pooling) on the six axes, trained with random
  small rotations and scalings; and the same CNN with the direction of up as three extra channels.

**Scoring.** Over each test recording, the score's peaks (local maxima within 0.3 s) above a threshold are detections.
A contact is found when a detection falls 0 to 0.6 s after it; a detection that matches no contact, no release and no
left-out moment is a false alarm. The threshold is set so false alarms stay at or under 1, 0.5 or 0.2 a minute over
the test recordings, and the share of contacts found at that rate is reported (a double pinch needs two, so about its
square). Two splits: five folds of whole recordings, and each recording day held out in turn (a new session). On the
pinch recordings without a camera, models trained on everything above are scored by AUC: the highest score from 0.5 s
before to 1.0 s after each labelled pinch start, against the same window at moments 2.5 s or more from any label.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/imu_models_check.py

Run from the repository root (several minutes; the CNNs train on the CPU). Writes imu-models/results.json and
results.md. The camera bundles are the app's (set CAMERA_RECORDINGS to another folder of them).
"""
import importlib.util, json, sys, time
from datetime import datetime
from pathlib import Path
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402
_spec = importlib.util.spec_from_file_location("contact", HERE / "imu_contact_check.py")
C = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(C)

FOLDERS = ("data/recordings/2026-10-downloads", "data/recordings/31oct")
NEGATIVE_GESTURES = ("fist", "thumbs_up", "hand_twit", "everything_else")
HZ = 50.0
WIN = 50                          # 1.0 s
STRIDE = 2                        # a decision every 40 ms
HIGHPASS = 15                     # 0.3 s trailing mean
LEVEL = 500                       # 10 s trailing mean
POS = (0.10, 0.40)                # a contact this long before the decision makes it positive
EDGE = (0.0, 0.55)                # ... and within this, outside POS, it is left out
RELEASE_IGNORE = (0.0, 0.55)
OTHER_IGNORE = (-0.2, 0.7)
MATCH = (0.0, 0.6)                # a detection this long after a contact finds it
PEAK_S = 0.3
RATES = (1.0, 0.5, 0.2)
LOOSE_AROUND = (-0.5, 1.0)
LOOSE_CLEAR = 2.5
SEED = 7
S = 1e9


# ---------------------------------------------------------------- data

def trailing_mean(x, n):
    c = np.concatenate([np.zeros((1,) + x.shape[1:]), np.cumsum(x, axis=0)])
    i = np.arange(len(x))
    lo = np.maximum(0, i + 1 - n)
    w = (i + 1 - lo).reshape((-1,) + (1,) * (x.ndim - 1))
    return (c[i + 1] - c[lo]) / w


def up_vectors(q):
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    return np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=1)


def started_at(path):
    src = path / "imu.csv" if path.is_dir() else path
    with open(src) as f:
        for line in f:
            if line.startswith("# started_at:"):
                return datetime.fromisoformat(line.split(":", 1)[1].strip().replace("Z", "+00:00"))
            if not line.startswith("#"):
                return None


def camera_bundles():
    """started_at -> bundle folder, for the bundles with hand tracking."""
    out = {}
    if not C.SOURCE.exists():
        return out
    for d in C.SOURCE.iterdir():
        if (d / "hand_landmarks.csv").exists() and (d / "clock_sync.csv").exists():
            meta = json.loads((d / "recording.json").read_text())
            out[datetime.fromisoformat(meta["requested_start_at"].replace("Z", "+00:00"))] = d
    return out


def camera_events(bundle, holds):
    """(pinch contacts, their releases, other camera contacts, pinch holds the camera missed), on the watch clock in ns."""
    times, dist = C.camera_frames(bundle / "hand_landmarks.csv")
    offset = C.align(bundle / "clock_sync.csv")
    if offset is None:
        return None
    contacts, releases = C.crossings(times, dist)
    contacts = (contacts - offset[0]) * 1e6
    releases = (releases - offset[0]) * 1e6
    pinch, rel, missed = [], [], []
    used = set()
    for s, e, label in holds:
        if label != "pinch":
            continue
        inside = np.flatnonzero((contacts >= s - 1.0 * S) & (contacts <= e))
        if len(inside) == 0:
            missed.append((s - 1.0 * S, e + 1.0 * S)); continue
        c = contacts[inside[0]]; used.add(int(inside[0]))
        pinch.append(c)
        after = releases[(releases > c) & (releases <= e + 1.0 * S)]
        if len(after):
            rel.append(after[0])
    other = np.array([c for k, c in enumerate(contacts) if k not in used])
    return np.array(pinch), np.array(rel), other, missed


def load_all():
    bundles = camera_bundles()
    recs = []
    for path in [p for f in FOLDERS for p in sorted((ROOT / f).iterdir()) if p.suffix == ".csv" or p.is_dir()]:
        recording = load_recording(path)
        ts, imu = lt.motion_of(recording)
        rows = recording.orient_observed if recording.orient_observed is not None else np.ones(len(recording.timestamps_ns), dtype=bool)
        quat = np.stack([recording.channels[c][rows] for c in ("quat_w", "quat_x", "quat_y", "quat_z")], axis=1)
        ok = np.isfinite(imu).all(1) & np.isfinite(quat).all(1) & (np.linalg.norm(np.nan_to_num(quat), axis=1) > 0.5)
        ts, imu, quat = ts[ok], imu[ok], quat[ok]
        if len(ts) < 400 or len(ts) / ((ts[-1] - ts[0]) / S) < 10:
            continue
        labels = np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels)
        holds = P.holds(recording.timestamps_ns, labels)
        names = {label for _, _, label in holds}
        start = started_at(path)
        bundle = next((b for t, b in bundles.items() if start and abs((t - start).total_seconds()) < 5), None)
        if "pinch" in names:
            events = camera_events(bundle, holds) if bundle else None
            kind = "camera" if events is not None and len(events[0]) >= 5 else "loose"
        elif "pinch" not in path.name and any(path.name.startswith(f"gesture-dataset-{g}") for g in NEGATIVE_GESTURES):
            kind, events = "negative", None
        else:
            continue  # unlabelled, or a pinch recording with no labels: its content is unknown
        grid = np.arange(ts[0], ts[-1], int(S / HZ), dtype=np.int64)
        x = np.column_stack([np.interp(grid, ts, imu[:, c]) for c in range(6)])
        q = np.column_stack([np.interp(grid, ts, quat[:, c]) for c in range(4)])
        k = np.clip(np.searchsorted(ts, grid), 1, len(ts) - 1)
        gap = np.minimum(np.abs(grid - ts[k]), np.abs(grid - ts[k - 1])) < 0.1 * S
        rec = {"name": path.name, "kind": kind, "day": start.strftime("%Y-%m-%d") if start else "unknown",
               "grid": grid, "x": x, "up": up_vectors(q), "gap_ok": gap, "holds": holds}
        if kind == "camera":
            rec["contacts"], rec["releases"], rec["other"], rec["missed"] = events
        else:
            rec["contacts"], rec["releases"], rec["other"], rec["missed"] = np.array([]), np.array([]), np.array([]), []
        recs.append(rec)
    return recs


def prepare(rec):
    """Decisions (grid indices), their times, labels (1, 0, or -1 left out) and the derived streams."""
    x, grid = rec["x"], rec["grid"]
    hp = x - trailing_mean(x, HIGHPASS)
    jolt = np.stack([np.linalg.norm(hp[:, :3], axis=1), np.linalg.norm(hp[:, 3:], axis=1)], axis=1)
    level = trailing_mean(jolt, LEVEL)
    idx = np.arange(WIN - 1, len(grid), STRIDE)
    okw = sliding_window_view(rec["gap_ok"], WIN)[idx - WIN + 1].all(1)
    idx = idx[okw]
    t = grid[idx]
    y = np.zeros(len(idx), dtype=np.int8)

    def mark(events, lo, hi, value, only_zero=True):
        for e in events:
            m = (t - e >= lo * S) & (t - e <= hi * S)
            if only_zero:
                m &= y == 0
            y[m] = value

    if rec["kind"] == "camera":
        mark(rec["contacts"], *EDGE, -1)
        mark(rec["releases"], *RELEASE_IGNORE, -1)
        mark(rec["other"], *OTHER_IGNORE, -1)
        for lo, hi in rec["missed"]:
            y[(t >= lo) & (t <= hi)] = -1
        for c in rec["contacts"]:
            y[(t - c >= POS[0] * S) & (t - c <= POS[1] * S)] = 1
    elif rec["kind"] == "loose":
        y[:] = -1
    rec.update(hp=hp, jolt=jolt, level=level, idx=idx, t=t, y=y)


# ---------------------------------------------------------------- inputs per model

def features(rec):
    idx, hp, jolt, level, x = rec["idx"], rec["hp"], rec["jolt"], rec["level"], rec["x"]
    H = sliding_window_view(hp, WIN, axis=0)[idx - WIN + 1]        # (D, 6, WIN)
    J = sliding_window_view(jolt, WIN, axis=0)[idx - WIN + 1]      # (D, 2, WIN)
    X = sliding_window_view(x, WIN, axis=0)[idx - WIN + 1]
    half = WIN // 2
    f = [np.abs(H[:, :, half:]).max(2), H[:, :, half:].std(2), H[:, :, :half].std(2)]
    late = J[:, :, half:]
    peak = late.max(2)
    before = J[:, :, :half].mean(2)
    thirds = [J[:, :, a:b].mean(2) for a, b in ((0, WIN // 3), (WIN // 3, 2 * WIN // 3), (2 * WIN // 3, WIN))]
    f += [peak, late.argmax(2) / half, before, peak / (level[idx] + 1e-6), peak / (before + 1e-6), *thirds]
    f += [X.mean(2), rec["up"][idx]]
    return np.concatenate(f, axis=1).astype(np.float32)


def jolt_score(rec):
    idx = rec["idx"]
    ratio = rec["jolt"] / (rec["level"] + 1e-6)
    R = sliding_window_view(ratio, 20, axis=0)[idx - 19]
    return R.max(2).mean(1)


def windows(rec, with_up):
    W = sliding_window_view(rec["x"], WIN, axis=0)[rec["idx"] - WIN + 1]
    if with_up:
        W = np.concatenate([W, sliding_window_view(rec["up"], WIN, axis=0)[rec["idx"] - WIN + 1]], axis=1)
    return W.astype(np.float32)


class Rocket:
    """Random dilated kernels over the six axes; each gives the share of the window where it exceeds its bias (PPV)."""

    def __init__(self, n=1000, seed=SEED):
        rng = np.random.default_rng(seed)
        self.kernels = []
        for _ in range(n):
            w = rng.normal(size=9); w -= w.mean()
            d = int(2 ** rng.uniform(0, np.log2((WIN - 1) / 8)))
            self.kernels.append((w, d, int(rng.integers(6)), rng.uniform(0.25, 0.75)))
        self.scale = None
        self.bias = None

    def _conv(self, x, w, d):
        k = np.zeros((len(w) - 1) * d + 1); k[::d] = w
        return np.convolve(x, k[::-1], mode="full")[: len(x)]     # causal: ends at each sample

    def fit_bias(self, recs, rng):
        self.scale = np.concatenate([r["x"] for r in recs]).std(0) + 1e-9
        picks = [recs[i] for i in rng.choice(len(recs), min(12, len(recs)), replace=False)]
        self.bias = []
        for w, d, ch, qt in self.kernels:
            vals = np.concatenate([self._conv(r["x"][:, ch] / self.scale[ch], w, d)[len(w) * d:] for r in picks])
            self.bias.append(np.quantile(vals, qt))

    def transform(self, rec):
        idx = rec["idx"]
        out = np.empty((len(idx), len(self.kernels)), dtype=np.float32)
        for k, ((w, d, ch, _), b) in enumerate(zip(self.kernels, self.bias)):
            z = self._conv(rec["x"][:, ch] / self.scale[ch], w, d) > b
            c = np.concatenate([[0], np.cumsum(z)])
            lo = idx - WIN + 1 + (len(w) - 1) * d
            out[:, k] = (c[idx + 1] - c[lo]) / (idx + 1 - lo)
        return out


class Net(nn.Module):
    def __init__(self, channels):
        super().__init__()
        layers, c = [], channels
        for out, dil in ((32, 1), (32, 2), (64, 4)):
            layers += [nn.Conv1d(c, out, 5, padding=2 * dil, dilation=dil), nn.BatchNorm1d(out), nn.ReLU()]
            c = out
        self.body = nn.Sequential(*layers)
        self.head = nn.Sequential(nn.Linear(2 * c, 32), nn.ReLU(), nn.Dropout(0.2), nn.Linear(32, 1))

    def forward(self, x):
        h = self.body(x)
        return self.head(torch.cat([h.amax(2), h.mean(2)], 1)).squeeze(1)


def random_rotations(n, max_deg, rng):
    axis = rng.normal(size=(n, 3)); axis /= np.linalg.norm(axis, axis=1, keepdims=True)
    ang = np.radians(rng.uniform(-max_deg, max_deg, n))
    K = np.zeros((n, 3, 3))
    K[:, 0, 1], K[:, 0, 2], K[:, 1, 2] = -axis[:, 2], axis[:, 1], -axis[:, 0]
    K = K - K.transpose(0, 2, 1)
    s, c = np.sin(ang)[:, None, None], np.cos(ang)[:, None, None]
    return np.eye(3) + s * K + (1 - c) * K @ K


class Cnn:
    def __init__(self, with_up, epochs=12, seed=SEED):
        self.with_up, self.epochs, self.seed = with_up, epochs, seed

    def fit(self, W, y):
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        self.scale = W.std(axis=(0, 2), keepdims=True) + 1e-6
        if self.with_up:
            self.scale[:, 6:] = 1.0
        self.net = Net(W.shape[1])
        opt = torch.optim.Adam(self.net.parameters(), lr=1e-3, weight_decay=1e-4)
        pos = max(1, int(y.sum()))
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(20.0, (len(y) - pos) / pos)))
        for _ in range(self.epochs):
            self.net.train()
            order = rng.permutation(len(y))
            for b in range(0, len(order), 256):
                pick = order[b:b + 256]
                batch = W[pick].copy()
                R = random_rotations(len(pick), 20, rng)
                for sl in (slice(0, 3), slice(3, 6)):
                    batch[:, sl] = np.einsum("nij,njt->nit", R, batch[:, sl])
                batch[:, :6] *= rng.uniform(0.8, 1.25, (len(pick), 1, 1))
                xb = torch.from_numpy((batch / self.scale).astype(np.float32))
                loss = loss_fn(self.net(xb), torch.from_numpy(y[pick].astype(np.float32)))
                opt.zero_grad(); loss.backward(); opt.step()
        return self

    def score(self, W):
        self.net.eval()
        with torch.no_grad():
            out = [self.net(torch.from_numpy((W[b:b + 4096] / self.scale).astype(np.float32))).numpy() for b in range(0, len(W), 4096)]
        return np.concatenate(out)


MODELS = ("jolt threshold", "logistic regression", "ExtraTrees", "gradient boosting", "random convolutions",
          "CNN", "CNN + orientation")


def fit_and_score(train, test, rng):
    """Model name -> list of score arrays, one per test recording."""
    out = {"jolt threshold": [jolt_score(r) for r in test]}
    ytr = np.concatenate([r["y"] for r in train]); keep = ytr >= 0; ytr = ytr[keep]
    Ftr = np.concatenate([r["F"] for r in train])[keep]
    for name, model in (("logistic regression", make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=3000, class_weight="balanced"))),
                        ("ExtraTrees", ExtraTreesClassifier(300, min_samples_leaf=5, class_weight="balanced", n_jobs=-1, random_state=SEED)),
                        ("gradient boosting", HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced", random_state=SEED))):
        model.fit(Ftr, ytr)
        out[name] = [model.predict_proba(r["F"])[:, 1] for r in test]
    rocket = Rocket(); rocket.fit_bias(train, rng)
    Rtr = np.concatenate([rocket.transform(r) for r in train])[keep]
    lin = make_pipeline(StandardScaler(), LogisticRegression(C=0.01, max_iter=3000, class_weight="balanced")).fit(Rtr, ytr)
    out["random convolutions"] = [lin.predict_proba(rocket.transform(r))[:, 1] for r in test]
    for name, up in (("CNN", False), ("CNN + orientation", True)):
        Wtr = np.concatenate([windows(r, up) for r in train])[keep]
        cnn = Cnn(up).fit(Wtr, ytr)
        out[name] = [cnn.score(windows(r, up)) for r in test]
    return out


# ---------------------------------------------------------------- scoring

def peaks(t, s):
    """Local maxima, the highest kept and any other within PEAK_S of a kept one dropped (so a flat top counts once)."""
    n = max(1, int(PEAK_S * HZ / STRIDE))
    padded = np.pad(s, n, constant_values=-np.inf)
    local = sliding_window_view(padded, 2 * n + 1).max(1)
    blocked = np.zeros(len(s), dtype=bool)
    kept = []
    for i in sorted(np.flatnonzero(s >= local), key=lambda i: -s[i]):
        if not blocked[i]:
            kept.append(i)
            blocked[max(0, i - n):i + n + 1] = True
    return np.sort(np.array(kept, dtype=int))


def events(rec, s):
    """(the highest detection matching each contact, each release, and the heights of false alarms)."""
    t = rec["t"]
    pk = peaks(t, s)
    pt, ph = t[pk], s[pk]
    used = np.zeros(len(pk), dtype=bool)

    def best(moments):
        out = []
        for m in moments:
            hit = (pt - m >= MATCH[0] * S) & (pt - m <= MATCH[1] * S)
            used[hit] = True
            out.append(ph[hit].max() if hit.any() else -np.inf)
        return np.array(out)

    contact = best(rec["contacts"]); release = best(rec["releases"])
    for m in rec["other"]:
        used[(pt - m >= OTHER_IGNORE[0] * S) & (pt - m <= OTHER_IGNORE[1] * S)] = True
    for lo, hi in rec["missed"]:
        used[(pt >= lo) & (pt <= hi)] = True
    return contact, release, ph[~used]


def operating_points(test, scores):
    """Per rate: (contacts found, contacts, releases firing, releases) on one fold's test recordings."""
    contact, release, false = [], [], []
    minutes = 0.0
    for rec, s in zip(test, scores):
        c, r, f = events(rec, s)
        contact.append(c); release.append(r); false.append(f)
        minutes += (rec["t"][-1] - rec["t"][0]) / S / 60
    contact, release, false = np.concatenate(contact), np.concatenate(release), np.sort(np.concatenate(false))[::-1]
    out = {}
    for rate in RATES:
        allowed = int(rate * minutes)
        thr = false[allowed] if allowed < len(false) else -np.inf
        out[rate] = (int((contact > thr).sum()), len(contact), int((release > thr).sum()), len(release))
    return out


def window_scores(test, scores):
    y = np.concatenate([r["y"] for r in test]); s = np.concatenate(scores)
    keep = y >= 0
    if y[keep].min() == y[keep].max():
        return None
    return roc_auc_score(y[keep], s[keep]), average_precision_score(y[keep], s[keep])


def run_split(recs, folds, label, rng):
    totals = {m: {rate: [0, 0, 0, 0] for rate in RATES} for m in MODELS}
    windows_ = {m: [] for m in MODELS}
    for k, (train, test) in enumerate(folds):
        t0 = time.time()
        got = fit_and_score(train, test, rng)
        for m in MODELS:
            for rate, v in operating_points(test, got[m]).items():
                totals[m][rate] = [a + b for a, b in zip(totals[m][rate], v)]
            w = window_scores(test, got[m])
            if w is not None:
                windows_[m].append(w)
        print(f"  {label} fold {k + 1}/{len(folds)}: {time.time() - t0:.0f} s", flush=True)
    out = {}
    for m in MODELS:
        out[m] = {
            "found": {str(r): totals[m][r][0] / max(1, totals[m][r][1]) for r in RATES},
            "releases_firing": {str(r): totals[m][r][2] / max(1, totals[m][r][3]) for r in RATES},
            "contacts": totals[m][RATES[0]][1],
            "window_auc": float(np.mean([w[0] for w in windows_[m]])),
            "window_ap": float(np.mean([w[1] for w in windows_[m]])),
        }
    return out


def loose_check(train, loose, rng):
    got = fit_and_score(train, loose, rng)
    groups = {"all": lambda r: True, "guided 2026-10-31 (rest, then typing, mouse and arm movement)": lambda r: r["day"] == "2026-10-31",
              "earlier sessions": lambda r: r["day"] != "2026-10-31"}
    width = (LOOSE_AROUND[1] - LOOSE_AROUND[0]) * S
    out = {}
    for m in MODELS:
        per_rec = []                  # (recording, highest scores near pinch starts, highest scores in random windows)
        for rec, s in zip(loose, got[m]):
            t = rec["t"]
            starts = np.array([a for a, _, label in rec["holds"] if label == "pinch"])
            labelled = np.array([a for a, _, _ in rec["holds"]] + [b for _, b, _ in rec["holds"]])
            pos, neg = [], []
            for a in starts:
                near = (t >= a + LOOSE_AROUND[0] * S) & (t <= a + LOOSE_AROUND[1] * S)
                if near.sum() > 5:
                    pos.append(s[near].max())
            for w in np.arange(t[0], t[-1] - width, 0.5 * S):
                if len(labelled) and np.min(np.abs(labelled - (w - LOOSE_AROUND[0] * S))) < LOOSE_CLEAR * S:
                    continue
                inside = (t >= w) & (t <= w + width)
                if inside.sum() > 5:
                    neg.append(s[inside].max())
            per_rec.append((rec, pos, neg))
        out[m] = {}
        for group, member in groups.items():
            pos = [v for rec, p_, _ in per_rec if member(rec) for v in p_]
            neg = [v for rec, _, n_ in per_rec if member(rec) for v in n_]
            out[m][group] = {"auc": float(roc_auc_score(np.r_[np.ones(len(pos)), np.zeros(len(neg))], np.r_[pos, neg])),
                             "pinches": len(pos), "random": len(neg)}
    return out


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    rng = np.random.default_rng(SEED)
    out_dir = HERE / "imu-models"; out_dir.mkdir(exist_ok=True)
    recs = load_all()
    for r in recs:
        prepare(r)
        r["F"] = features(r)
    trainable = [r for r in recs if r["kind"] in ("camera", "negative")]
    loose = [r for r in recs if r["kind"] == "loose"]
    cam = [r for r in trainable if r["kind"] == "camera"]
    print(f"{len(cam)} camera recordings ({sum(len(r['contacts']) for r in cam)} contacts), "
          f"{len(trainable) - len(cam)} negative, {len(loose)} pinch recordings without a camera", flush=True)

    groups = np.arange(len(trainable))
    gkf = GroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    # Spread the camera recordings evenly: fold the camera and negative recordings separately, then pair the folds.
    cam_i = [i for i, r in enumerate(trainable) if r["kind"] == "camera"]
    neg_i = [i for i, r in enumerate(trainable) if r["kind"] == "negative"]
    cam_f = [test for _, test in gkf.split(cam_i, groups=cam_i)]
    neg_f = [test for _, test in gkf.split(neg_i, groups=neg_i)]
    folds = []
    for a, b in zip(cam_f, neg_f):
        test_ids = {cam_i[j] for j in a} | {neg_i[j] for j in b}
        folds.append(([trainable[i] for i in groups if i not in test_ids], [trainable[i] for i in sorted(test_ids)]))
    days = sorted({r["day"] for r in cam})
    day_folds = [([r for r in trainable if r["day"] != d], [r for r in trainable if r["day"] == d]) for d in days]

    results = {
        "data": {"camera_recordings": len(cam), "contacts": int(sum(len(r["contacts"]) for r in cam)),
                 "releases": int(sum(len(r["releases"]) for r in cam)),
                 "negative_recordings": len(trainable) - len(cam), "loose_recordings": len(loose),
                 "minutes": float(sum((r["t"][-1] - r["t"][0]) / S / 60 for r in trainable)), "days": days},
        "recordings_split": run_split(trainable, folds, "recordings", rng),
        "day_split": run_split(trainable, day_folds, "days", rng),
        "loose": loose_check(trainable, loose, rng) if loose else {},
    }
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    d = results["data"]
    lines = [
        "# Which model finds a pinch contact best from the motion sensors?",
        "",
        f"{d['camera_recordings']} pinch recordings with camera contacts ({d['contacts']} contacts, {d['releases']} releases),"
        f" {d['negative_recordings']} recordings with no pinch, {d['minutes']:.0f} minutes in all; days {', '.join(d['days'])}."
        " Contacts found at a false-alarm rate over the test recordings (double pinch: about its square);"
        " releases firing at the 1 a minute threshold; window AUC and average precision over decisions.",
    ]
    for key, title in (("recordings_split", "Whole recordings held out (5 folds)"), ("day_split", "Each recording day held out")):
        lines += ["", f"## {title}", "",
                  "| Model | Found at 1/min | 0.5/min | 0.2/min | Double pinch at 1/min | Releases firing | Window AUC | Window AP |",
                  "|---|---:|---:|---:|---:|---:|---:|---:|"]
        for m in MODELS:
            v = results[key][m]
            f1 = v["found"]["1.0"]
            lines.append(f"| {m} | {f1:.0%} | {v['found']['0.5']:.0%} | {v['found']['0.2']:.0%} | {f1 * f1:.0%} | "
                         f"{v['releases_firing']['1.0']:.0%} | {v['window_auc']:.3f} | {v['window_ap']:.3f} |")
    if results["loose"]:
        any_m = next(iter(results["loose"].values()))
        names = list(any_m)
        lines += ["", f"## Pinch recordings without a camera ({d['loose_recordings']} recordings), trained on all of the above", "",
                  "AUC of the highest score near a labelled pinch start against random windows (0.5 is chance; below it, the"
                  " model fires more away from pinches).", "",
                  "| Model | " + " | ".join(f"{g} ({any_m[g]['pinches']} pinches, {any_m[g]['random']} random)" for g in names) + " |",
                  "|---|" + "---:|" * len(names)]
        for m in MODELS:
            lines.append(f"| {m} | " + " | ".join(f"{results['loose'][m][g]['auc']:.3f}" for g in names) + " |")
    lines += ["", f"{results['seconds']:.0f} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
