"""Would another kind of model catch more pinches than the CNN on this data?

Same test as `experiment.py`: train on the 22 recordings the live models trained on, score the 11 they never saw, and count
the pinches caught at the best cut-off within 2, 5 and 10 false activations an hour (chosen on the scored recordings, so
for comparing only). Every model reads the CNN's own input (9 channels x 50 ticks, each scaled by its recent level).

* `cnn`        the trainer as it is (`cnn.fit`): three small dilated convolutions, three networks averaged.
* `big`        the same with twice the channels (64, 64, 128) and a dense layer of 64.
* `gru`        two convolutions, then a recurrent layer (GRU, 48 units) reading the second in order, so it can tell what
               came first; trained like the CNN.
* `multitask`  one network for pinch in, pinch out and neither at once, so the two gestures share what they learn and
               compete for each moment; its pinch-in probability is scored.
* `rocket`     2,000 random convolution kernels (MiniRocket's idea: fixed random filters, the share of each one's output
               above a threshold and its maximum as features) and a logistic regression on those. The usual strong choice
               for small sets of time series, and nothing in it is trained but the last layer.
* `boosted`    gradient-boosted trees (scikit-learn's histogram kind) on the window's 450 values and simple summaries of
               each channel.
* `cnn+rocket` the CNN's and `rocket`'s probabilities averaged.

    SEEDS=17,18,19 tools/label-trainer/.venv/bin/python docs/research/artifacts/training-improvements-2026-11/alternatives.py pinch_in [model...]

Results add to `alternatives-<target>.json` and `alternatives-<target>.md` is rewritten.
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np

from experiment import BUDGETS, HERE, SEEDS, judged, spec_for
from label_trainer import cnn, label_train as lt, ppg_onset


class Probabilities:
    """Anything with the positive class's probability for each row, as the trainer's models give it."""

    def __init__(self, positive):
        self.positive = positive

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        p = np.asarray(self.positive(x), dtype=np.float64)
        return np.stack([1.0 - p, p], axis=1)


def subsample(x: np.ndarray, y: np.ndarray, rng: np.random.Generator, extra: np.ndarray | None = None):
    """All the gesture moments and at most `cnn.MAX_NEGATIVES` others, as each network of the CNN trains on."""
    negatives = np.flatnonzero(y == 0)
    rows = np.arange(len(y))
    if len(negatives) > cnn.MAX_NEGATIVES:
        rows = np.sort(np.concatenate([np.flatnonzero(y != 0), rng.choice(negatives, cnn.MAX_NEGATIVES, replace=False)]))
    return (x[rows], y[rows]) if extra is None else (x[rows], y[rows], extra[rows])


def fit_big(x, y, seed, **_):
    saved = (cnn.CONVOLUTIONS, cnn.HIDDEN)
    cnn.CONVOLUTIONS, cnn.HIDDEN = ((64, 1), (64, 2), (128, 4)), 64
    try:
        return cnn.fit(x, y, seed)
    finally:
        cnn.CONVOLUTIONS, cnn.HIDDEN = saved


def fit_gru(x, y, seed, **_):
    import torch
    from torch import nn

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.front = nn.Sequential(nn.Conv1d(cnn.CHANNELS, 32, 5, padding=2), nn.BatchNorm1d(32), nn.ReLU(),
                                       nn.Conv1d(32, 32, 5, padding=4, dilation=2), nn.BatchNorm1d(32), nn.ReLU())
            self.gru = nn.GRU(32, 48, batch_first=True)
            self.head = nn.Sequential(nn.Linear(96, 32), nn.ReLU(), nn.Dropout(0.2), nn.Linear(32, 1))

        def forward(self, windows):
            states, last = self.gru(self.front(windows).transpose(1, 2))
            return self.head(torch.cat([last[0], states.mean(1)], 1)).squeeze(1)

    nets = []
    for member in range(cnn.MEMBERS):
        torch.manual_seed(seed + member)
        net = Net()
        cnn._train(net, x, y, None, cnn.EPOCHS, np.random.default_rng(seed + member))
        nets.append(net.eval())
    return cnn.Model(nets)


def fit_multitask(x, y, seed, other=None, **_):
    """Three classes: neither (0), the target (1), the other pinch (2). `other` marks the other pinch's moments."""
    import torch
    from torch import nn

    classes = np.where(y == 1, 1, np.where(other, 2, 0))
    where = cnn.device()
    nets = []
    for member in range(cnn.MEMBERS):
        rng = np.random.default_rng(seed + member)
        net = cnn._new_net(seed + member)
        net.head[-1] = nn.Linear(cnn.HIDDEN, 3)
        net.forward = (lambda n: lambda w: n.head(torch.cat([n.body(w).amax(2), n.body(w).mean(2)], 1)))(net)
        xs, _, cs = subsample(x, (classes != 0).astype(int), rng, classes)
        windows = torch.from_numpy(np.asarray(xs, dtype=np.float32).reshape(-1, cnn.CHANNELS, cnn.LENGTH)).to(where)
        truth = torch.from_numpy(cs.astype(np.int64)).to(where)
        net.to(where)
        loss_fn = nn.CrossEntropyLoss(weight=torch.tensor([1.0, cnn.MAX_POSITIVE_WEIGHT, cnn.MAX_POSITIVE_WEIGHT], device=where))
        optimiser = torch.optim.Adam(net.parameters(), lr=cnn.LEARNING_RATE, weight_decay=cnn.WEIGHT_DECAY)
        schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, cnn.EPOCHS * ((len(truth) + cnn.BATCH - 1) // cnn.BATCH))
        generator = torch.Generator(device=where).manual_seed(seed + member)
        for _ in range(cnn.EPOCHS):
            net.train()
            order = torch.from_numpy(rng.permutation(len(truth))).to(where)
            for b in range(0, len(order), cnn.BATCH):
                pick = order[b:b + cnn.BATCH]
                if len(pick) < 2:
                    continue
                loss = loss_fn(net(cnn._augmented(windows[pick], generator)), truth[pick])
                optimiser.zero_grad()
                loss.backward()
                optimiser.step()
                schedule.step()
        nets.append(net.to("cpu").eval())

    def positive(rows):
        windows = torch.from_numpy(np.asarray(rows, dtype=np.float32).reshape(-1, cnn.CHANNELS, cnn.LENGTH))
        with torch.no_grad():
            return np.mean([torch.softmax(net(windows), 1)[:, 1].numpy() for net in nets], axis=0)
    return Probabilities(positive)


KERNELS = 2000


def rocket_features(seed: int):
    """A function from windows to 2 x KERNELS features: random kernels of 9 taps over one to three channels, dilated to
    reach up to the whole window; for each, the share of its output above its threshold and its maximum."""
    import torch

    rng = np.random.default_rng(seed)
    where = cnn.device()
    groups = []
    for dilation in (1, 2, 3, 4, 6):
        count = KERNELS // 5
        weight = np.zeros((count, cnn.CHANNELS, 9), dtype=np.float32)
        for k in range(count):
            channels = rng.choice(cnn.CHANNELS, size=int(rng.integers(1, 4)), replace=False)
            taps = rng.normal(size=(len(channels), 9))
            weight[k, channels] = taps - taps.mean(axis=1, keepdims=True)
        bias = rng.uniform(-1.0, 1.0, size=count).astype(np.float32)
        groups.append((dilation, torch.from_numpy(weight).to(where), torch.from_numpy(bias).to(where)))

    def features(rows: np.ndarray) -> np.ndarray:
        out = []
        for start in range(0, len(rows), 4096):
            windows = torch.from_numpy(np.asarray(rows[start:start + 4096], dtype=np.float32).reshape(-1, cnn.CHANNELS, cnn.LENGTH))
            windows = torch.logit(windows.clamp(1e-3, 1 - 1e-3)).to(where) / 3.0
            parts = []
            with torch.no_grad():
                for dilation, weight, bias in groups:
                    response = torch.nn.functional.conv1d(windows, weight, bias, dilation=dilation, padding=4 * dilation)
                    parts += [(response > 0).float().mean(2), response.amax(2)]
            out.append(torch.cat(parts, 1).cpu().numpy())
        return np.concatenate(out)
    return features


def fit_rocket(x, y, seed, **_):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    features = rocket_features(seed)
    xs, ys = subsample(x, y, np.random.default_rng(seed))
    model = make_pipeline(StandardScaler(), LogisticRegression(C=0.02, max_iter=400, class_weight={0: 1.0, 1: cnn.MAX_POSITIVE_WEIGHT}))
    model.fit(features(xs), ys)
    return Probabilities(lambda rows: model.predict_proba(features(rows))[:, 1])


def summaries(rows: np.ndarray) -> np.ndarray:
    """The window's values, then each channel's mean, spread, range, and the change from its first half to its second and
    over its last fifth."""
    windows = np.asarray(rows, dtype=np.float32).reshape(-1, cnn.CHANNELS, cnn.LENGTH)
    half, fifth = cnn.LENGTH // 2, cnn.LENGTH // 5
    extra = [windows.mean(2), windows.std(2), windows.max(2) - windows.min(2),
             windows[:, :, half:].mean(2) - windows[:, :, :half].mean(2), windows[:, :, -fifth:].mean(2) - windows[:, :, -2 * fifth:-fifth].mean(2),
             np.abs(np.diff(windows, axis=2)).mean(2)]
    return np.concatenate([windows.reshape(len(windows), -1), *extra], axis=1)


def fit_boosted(x, y, seed, **_):
    from sklearn.ensemble import HistGradientBoostingClassifier

    xs, ys = subsample(x, y, np.random.default_rng(seed))
    model = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, max_leaf_nodes=31, l2_regularization=1.0, random_state=seed,
                                           class_weight={0: 1.0, 1: cnn.MAX_POSITIVE_WEIGHT})
    model.fit(summaries(xs), ys)
    return Probabilities(lambda rows: model.predict_proba(summaries(rows))[:, 1])


def fit_both(x, y, seed, **_):
    first, second = cnn.fit(x, y, seed), fit_rocket(x, y, seed)
    return Probabilities(lambda rows: (first.predict_proba(rows)[:, 1] + second.predict_proba(rows)[:, 1]) / 2)


MODELS = {"cnn": lambda x, y, seed, **_: cnn.fit(x, y, seed), "big": fit_big, "gru": fit_gru, "multitask": fit_multitask,
          "rocket": fit_rocket, "boosted": fit_boosted, "cnn+rocket": fit_both}


def report(target: str, results: dict) -> None:
    lines = [f"# Other kinds of model for `{target}`", "",
             "Pinches caught of those in the 11 recordings no model trained on, at the cut-off that catches the most within each",
             "budget of false activations an hour (chosen on these recordings: for comparing models only). In brackets, of the",
             "three sessions of 9 Nov alone. See `alternatives.py`.", "",
             "| model | seed | " + " | ".join(f"within {b:g} an hour" for b in BUDGETS) + " | seconds |", "|---|---:|" + "---|" * len(BUDGETS) + "---:|"]
    for name in MODELS:
        for seed, run in sorted(results.get(name, {}).items(), key=lambda item: int(item[0])):
            cells = []
            for budget in BUDGETS:
                point = run["best"][str(budget)]
                cells.append("none" if point is None else
                             f"{point['caught']}/{point['gestures']} ({point['unseenCaught']}/{point['unseenGestures']}) at {point['threshold']:g}")
            lines.append(f"| {name} | {seed} | " + " | ".join(cells) + f" | {run['seconds']:.0f} |")
    (HERE / f"alternatives-{target}.md").write_text("\n".join(lines) + "\n")


def main(target: str, wanted: list[str]) -> None:
    path = HERE / f"alternatives-{target}.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    spec = spec_for(target)
    recordings = lt.load_spec_recordings(spec)
    train = lt.examples(spec, recordings, list(spec.train))
    # The other pinch's moments among the training rows, for the model that learns both.
    other_label = "pinch_out" if target == "pinch_in" else "pinch_in"
    other = np.zeros(len(train.y), dtype=bool)
    for rid in spec.train:
        rows = np.flatnonzero(train.groups == rid)
        if not len(rows):
            continue
        held = ppg_onset.holds(recordings[rid].timestamps_ns, recordings[rid].raw_labels)
        starts = [s for s, _, label in held if label == other_label]
        other[rows] = cnn.labels(train.decisions[rows], starts, []) == 1
    other &= train.y == 0
    held_out = {}
    for rid in spec.evaluation:
        ts, _ = lt.pulse_of(recordings[rid])
        x = lt.inputs(spec, recordings[rid], ts)
        ok = np.isfinite(x).all(axis=1)
        held_out[rid] = (ts[ok], x[ok])
    print(f"{len(train.y)} training moments: {int(train.y.sum())} of {target}, {int(other.sum())} of {other_label}", flush=True)
    for name in wanted or list(MODELS):
        for seed in SEEDS:
            if str(seed) in results.get(name, {}):
                continue
            began = time.time()
            model = MODELS[name](train.x, train.y, seed, other=other)
            scored = {rid: (times, model.predict_proba(x)[:, 1]) for rid, (times, x) in held_out.items()}
            run = {**judged(spec, recordings, scored), "seconds": time.time() - began}
            results.setdefault(name, {})[str(seed)] = run
            path.write_text(json.dumps(results, indent=1))
            report(target, results)
            print(name, seed, {b: (p and (p["caught"], p["gestures"], p["threshold"])) for b, p in run["best"].items()},
                  f"{run['seconds']:.0f} s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
