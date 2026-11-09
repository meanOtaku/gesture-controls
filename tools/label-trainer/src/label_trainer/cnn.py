"""The CNN pinch-start model: training, its file (`model.cnn`), and a plain evaluation of that file.

Research: `docs/research/artifacts/double-pinch-2026-10/` steps 3, 8, 9 and 12. The network reads `cnn_input`'s 9 channels
x 50 ticks: three dilated convolutions (32, 32, 64 channels, kernel 5, dilation 1, 2, 4), each with batch normalisation
and a ReLU; each channel's maximum and mean over time; a dense layer of 32 with a ReLU and dropout; one output through a
sigmoid. `MEMBERS` such networks are trained from different seeds and their probabilities averaged, which steadies the
score (step 12 averaged three). It learns the decisions `POSITIVE_FROM_MS`..`POSITIVE_TO_MS` after a start (the touch near the middle of its
second) against the decisions with no start from `CLEAR_BEFORE_MS` before to `CLEAR_AFTER_MS` after.

The file is JSON with batch normalisation folded into the convolutions, read by `crates/label-inference/src/cnn.rs`:
plain weights, not code. `predict` evaluates the file exactly as the runtime does, so training can check the exported
file reproduces the trained network before it is shipped.

PyTorch is only needed to train (the `cnn` extra): `uv run --project tools/label-trainer --extra cnn ...`. It trains and
scores on the GPU where there is one that can run it (Apple's MPS, else CUDA): on an M3, about 4 times faster than the CPU
for training and 20 times for scoring. `LABEL_TRAINER_DEVICE` names the device instead. The networks are moved back
to the CPU when trained, so the file and its check (`predict`) are the same either way. `python -m label_trainer.gpu_check`
says what a machine will use and how fast it is; `docs/architecture/pinch-models.md` covers older NVIDIA cards.
"""

from __future__ import annotations

import json
import os

import numpy as np

from . import cnn_input

FORMAT = "ppg-imu-cnn"
VERSION = 1
CHANNELS = len(cnn_input.CHANNELS)
LENGTH = cnn_input.WINDOW_TICKS
CONVOLUTIONS = ((32, 1), (32, 2), (64, 4))         # (channels, dilation)
KERNEL = 5
HIDDEN = 32
MEMBERS = 3
EPOCHS = 12
BATCH = 256
LEARNING_RATE = 1e-3
WEIGHT_DECAY = 1e-4
MAX_POSITIVE_WEIGHT = 20.0
MAX_NEGATIVES = 40_000
# The model decides about this long after a gesture starts: the middle of the moments it learns as positives.
DECISION_DELAY_MS = 500
POSITIVE_FROM_MS, POSITIVE_TO_MS = 400, 600
CLEAR_BEFORE_MS, CLEAR_AFTER_MS = 200, 1200
# The exported file must reproduce the trained network this closely (it trains in single precision).
PARITY_TOLERANCE = 1e-4


def labels(decisions_ns: np.ndarray, starts_ns: list[int], excluded: list[tuple[int, int]]) -> np.ndarray:
    """1 for a decision POSITIVE_FROM_MS..POSITIVE_TO_MS after a start, 0 with no start from CLEAR_AFTER_MS before it to
    CLEAR_BEFORE_MS after (and outside excluded holds, until CLEAR_AFTER_MS after them), -1 otherwise (left out)."""
    ms = 1_000_000
    y = np.zeros(len(decisions_ns), dtype=np.int64)
    for s in starts_ns:
        age = decisions_ns - s
        y[(age >= -CLEAR_BEFORE_MS * ms) & (age <= CLEAR_AFTER_MS * ms)] = -1
    for s, e in excluded:
        y[(decisions_ns >= s) & (decisions_ns <= e + CLEAR_AFTER_MS * ms)] = -1
    for s in starts_ns:
        age = decisions_ns - s
        y[(age >= POSITIVE_FROM_MS * ms) & (age <= POSITIVE_TO_MS * ms)] = 1
    return y


# Whether each GPU backend was found able to run the network, so it is tried once.
_runs: dict[str, bool] = {}


def _runs_on(where: str) -> bool:
    """Whether `where` can really run a convolution. A PyTorch build can see a GPU it has no code for (an old NVIDIA card
    with a recent build reports CUDA as available, then fails with "no kernel image"), so seeing it is not enough."""
    import torch

    if where not in _runs:
        try:
            torch.nn.Conv1d(1, 1, 3).to(where)(torch.zeros(1, 1, 8, device=where))
            _runs[where] = True
        except (RuntimeError, NotImplementedError) as error:
            print(f"The GPU ({where}) cannot run the network, so using the CPU: {str(error).splitlines()[0]}", flush=True)
            _runs[where] = False
    return _runs[where]


def device() -> str:
    """Where to train and score: `LABEL_TRAINER_DEVICE` when set (a device that fails then fails loudly), else the GPU there
    is if it can run the network (MPS, then CUDA), else the CPU."""
    import torch

    wanted = os.environ.get("LABEL_TRAINER_DEVICE")
    if wanted:
        return wanted
    if torch.backends.mps.is_available() and _runs_on("mps"):
        return "mps"
    return "cuda" if torch.cuda.is_available() and _runs_on("cuda") else "cpu"


def _net():
    import torch
    from torch import nn

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            layers, c = [], CHANNELS
            for out, dilation in CONVOLUTIONS:
                layers += [nn.Conv1d(c, out, KERNEL, padding=dilation * (KERNEL - 1) // 2, dilation=dilation),
                           nn.BatchNorm1d(out), nn.ReLU()]
                c = out
            self.body = nn.Sequential(*layers)
            self.head = nn.Sequential(nn.Linear(2 * c, HIDDEN), nn.ReLU(), nn.Dropout(0.2), nn.Linear(HIDDEN, 1))

        def forward(self, x):
            h = self.body(x)
            return self.head(torch.cat([h.amax(2), h.mean(2)], 1)).squeeze(1)

    return Net()


class Model:
    """Trained networks, whose probabilities are averaged, with the scikit-learn-like `predict_proba` the trainer's
    evaluation uses."""

    def __init__(self, nets):
        self.nets = nets

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        import torch

        where = device()
        windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, LENGTH))
        p = np.zeros(len(windows))
        with torch.no_grad():
            for net in self.nets:
                net.to(where).eval()
                for i in range(0, len(windows), 4096):
                    p[i:i + 4096] += torch.sigmoid(net(windows[i:i + 4096].to(where))).cpu().numpy().astype(np.float64)
                net.to("cpu")
        p /= len(self.nets)
        return np.stack([1.0 - p, p], axis=1)


def fit(x: np.ndarray, y: np.ndarray, seed: int, keep: np.ndarray | None = None) -> Model:
    """Trains MEMBERS networks on `x` (decisions x 450 inputs) and `y` (1 or 0), each from its own seed. `keep` marks rows
    every network trains on (the false activations it is learning from), never left out to stay within MAX_NEGATIVES."""
    return fit_stages([(x, y, keep, EPOCHS)], seed)


def fit_stages(stages: list[tuple[np.ndarray, np.ndarray, np.ndarray | None, int]], seed: int) -> Model:
    """Trains MEMBERS networks through `stages` in order, each stage (x, y, keep, epochs) continuing from the weights the
    one before left: a training plan, such as pinches first and then everyday noise. A stage's rows are all it sees, so
    to keep what an earlier stage taught, its rows go into the later stage too (`label_train` does that, by rehearsal)."""
    nets = []
    for member in range(MEMBERS):
        member_seed = seed + member
        net, rng = _new_net(member_seed), np.random.default_rng(member_seed)
        for x, y, keep, epochs in stages:
            _train(net, x, y, keep, epochs, rng)
        net.to("cpu").eval()
        nets.append(net)
    return Model(nets)


def _fit_one(x: np.ndarray, y: np.ndarray, seed: int, keep: np.ndarray | None = None):
    """One network trained in a single stage, as each member of `fit` is."""
    net = _new_net(seed)
    _train(net, x, y, keep, EPOCHS, np.random.default_rng(seed))
    return net.eval()


def _new_net(seed: int):
    import torch

    torch.manual_seed(seed)
    torch.set_num_threads(max(1, torch.get_num_threads()))
    return _net()


def _train(net, x: np.ndarray, y: np.ndarray, keep: np.ndarray | None, epochs: int, rng: np.random.Generator) -> None:
    """`epochs` passes of `net` over all positives, every row `keep` marks, and up to MAX_NEGATIVES negatives in all."""
    import torch
    from torch import nn

    y = np.asarray(y)
    kept = np.zeros(len(y), dtype=bool) if keep is None else np.asarray(keep, dtype=bool)
    negatives = np.flatnonzero((y == 0) & ~kept)
    room = max(0, MAX_NEGATIVES - int(((y == 0) & kept).sum()))
    if len(negatives) > room:
        rows = np.sort(np.concatenate([np.flatnonzero((y == 1) | kept), rng.choice(negatives, room, replace=False)]))
        x, y = x[rows], y[rows]
    if len(y) < 2:
        return
    where = device()
    net.to(where)
    windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, LENGTH)).to(where)
    truth = torch.from_numpy(y.astype(np.float32)).to(where)
    optimiser = torch.optim.Adam(net.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    positives = max(1.0, float(y.sum()))
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(MAX_POSITIVE_WEIGHT, (len(y) - positives) / positives), device=where))
    for _ in range(epochs):
        net.train()
        order = torch.from_numpy(rng.permutation(len(y))).to(where)
        for b in range(0, len(order), BATCH):
            pick = order[b:b + BATCH]
            if len(pick) < 2:
                continue        # batch normalisation needs two
            loss = loss_fn(net(windows[pick]), truth[pick])
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()
    # Back to the CPU, where the file is written from and the trainer's numpy code reads it.
    net.to("cpu")


def to_bytes(model: Model) -> bytes:
    """The model file: per network, the convolutions with their batch normalisation folded in, and the dense layers."""
    members = [_member(net) for net in model.nets]
    file = {"format": FORMAT, "version": VERSION, "channels": CHANNELS, "length": LENGTH, "members": members}
    return (json.dumps(_single_precision(file), separators=(",", ":")) + "\n").encode()


def _single_precision(value):
    """Every number to 9 significant digits, all a single-precision weight holds (the network trains in single
    precision), which keeps the file about half the size."""
    if isinstance(value, float):
        return float(f"{value:.9g}")
    if isinstance(value, list):
        return [_single_precision(v) for v in value]
    if isinstance(value, dict):
        return {k: _single_precision(v) for k, v in value.items()}
    return value


def _member(net) -> dict:
    from torch import nn

    convs, dense = [], []
    layers = list(net.body)
    for conv, norm in ((layers[i], layers[i + 1]) for i in range(0, len(layers), 3)):
        assert isinstance(conv, nn.Conv1d) and isinstance(norm, nn.BatchNorm1d)
        scale = (norm.weight / (norm.running_var + norm.eps).sqrt()).detach().double().numpy()
        weight = conv.weight.detach().double().numpy() * scale[:, None, None]
        bias = (conv.bias.detach().double().numpy() - norm.running_mean.detach().double().numpy()) * scale \
            + norm.bias.detach().double().numpy()
        convs.append({"in": conv.in_channels, "out": conv.out_channels, "kernel": conv.kernel_size[0],
                      "dilation": conv.dilation[0], "weight": weight.ravel().tolist(), "bias": bias.tolist()})
    for layer in net.head:
        if isinstance(layer, nn.Linear):
            dense.append({"in": layer.in_features, "out": layer.out_features,
                          "weight": layer.weight.detach().double().numpy().ravel().tolist(),
                          "bias": layer.bias.detach().double().numpy().tolist()})
    return {"conv": convs, "dense": dense}


def predict(model_bytes: bytes, x: np.ndarray) -> np.ndarray:
    """The positive class's probability for each row of `x`, from the model file alone, as the runtime computes it."""
    file = json.loads(model_bytes)
    x = np.asarray(x, dtype=np.float64).reshape(-1, file["channels"], file["length"])
    return np.mean([_predict_member(member, x, file["length"]) for member in file["members"]], axis=0)


def _predict_member(member: dict, h: np.ndarray, length: int) -> np.ndarray:
    for c in member["conv"]:
        w = np.asarray(c["weight"]).reshape(c["out"], c["in"], c["kernel"])
        pad = c["dilation"] * (c["kernel"] - 1) // 2
        padded = np.pad(h, ((0, 0), (0, 0), (pad, pad)))
        out = np.repeat(np.asarray(c["bias"])[None, :, None], len(h), axis=0).astype(np.float64)
        for k in range(c["kernel"]):
            taps = padded[:, :, k * c["dilation"]:k * c["dilation"] + length]
            out = out + np.einsum("oi,nit->not", w[:, :, k], taps)
        h = np.maximum(out, 0.0)
    v = np.concatenate([h.max(axis=2), h.mean(axis=2)], axis=1)
    for n, d in enumerate(member["dense"]):
        v = v @ np.asarray(d["weight"]).reshape(d["out"], d["in"]).T + np.asarray(d["bias"])
        if n + 1 < len(member["dense"]):
            v = np.maximum(v, 0.0)
    return 1.0 / (1.0 + np.exp(-v[:, 0]))
