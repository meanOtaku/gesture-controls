"""The CNN pinch-start model: training, its file (`model.cnn`), and a plain evaluation of that file.

Research: `docs/research/artifacts/double-pinch-2026-10/` steps 3, 8, 9 and 12. The network reads `cnn_input`'s 9 channels
x 50 ticks (100 on the 100 Hz grid, the trainer's default, with a fourth convolution: 32, 32, 32, 64 channels, dilation 1, 2,
4, 8; `CONVOLUTIONS_FOR`): three dilated convolutions (32, 32, 64 channels, kernel 5, dilation 1, 2, 4), each with batch normalisation
and a ReLU; each channel's maximum and mean over time; a dense layer of 32 with a ReLU and dropout; one output through a
sigmoid. `MEMBERS` such networks are trained from different seeds and their probabilities averaged, which steadies the
score (step 12 averaged three). It learns the decisions `POSITIVE_FROM_MS`..`POSITIVE_TO_MS` after a start (the touch near the middle of its
second) against the decisions with no start from `CLEAR_BEFORE_MS` before to `CLEAR_AFTER_MS` after.

Training (`_train`): `EPOCHS` passes with Adam, the learning rate following a cosine down to zero over them, gesture moments
weighted at most `MAX_POSITIVE_WEIGHT` times, and every batch changed a little as another wearing of the watch might change
it (`_augmented`: its size scaled, noise added, moved up to 40 ms in time, the pulse blanked in some windows). Against the
earlier loop (12 passes, a weight of up to 20, no changes to the batches) it caught 99 of 120 held-out pinches against 95
within 5 false activations an hour, over six seeds, and its best cut-off came down from 0.97-0.995 to 0.7-0.98
(`docs/research/artifacts/training-improvements-2026-11/`).

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
CONVOLUTIONS = ((32, 1), (32, 2), (64, 4))         # (channels, dilation), for the 50 ticks of the 50 Hz grid
# Per window length (its ticks): on the 100 Hz grid's 100, a fourth convolution, so the filters reach as far in time.
CONVOLUTIONS_FOR = {LENGTH: CONVOLUTIONS, 100: ((32, 1), (32, 2), (32, 4), (64, 8))}


def length_of(x: np.ndarray) -> int:
    """The window's ticks, from the inputs' width (channel by channel)."""
    width = np.asarray(x).shape[1]
    if width % CHANNELS or width // CHANNELS not in CONVOLUTIONS_FOR:
        raise ValueError(f"{width} inputs are not {CHANNELS} channels of a window this network knows")
    return width // CHANNELS
KERNEL = 5
HIDDEN = 32
MEMBERS = 3
EPOCHS = 20
BATCH = 256
LEARNING_RATE = 1e-3
WEIGHT_DECAY = 1e-4
MAX_POSITIVE_WEIGHT = 3.0
# What `_augmented` does to a batch: each channel's size scaled by a factor in this range, this much noise added (both
# on the scaled values before their sigmoid), the window moved by up to this long, and the pulse blanked in this share.
AUGMENT_SCALE = (0.8, 1.25)
AUGMENT_NOISE = 0.15
AUGMENT_SHIFT_MS = 40
AUGMENT_PULSE_BLANK = 0.15
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


def _net(length: int = LENGTH):
    import torch
    from torch import nn

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            layers, c = [], CHANNELS
            for out, dilation in CONVOLUTIONS_FOR[length]:
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

    def __init__(self, nets, length: int = LENGTH):
        self.nets = nets
        self.length = length

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        import torch

        where = device()
        windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, self.length))
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
    length = length_of(stages[0][0])
    nets = []
    for member in range(MEMBERS):
        member_seed = seed + member
        net, rng = _new_net(member_seed, length), np.random.default_rng(member_seed)
        for x, y, keep, epochs in stages:
            _train(net, x, y, keep, epochs, rng)
        net.to("cpu").eval()
        nets.append(net)
    return Model(nets, length)


def _fit_one(x: np.ndarray, y: np.ndarray, seed: int, keep: np.ndarray | None = None):
    """One network trained in a single stage, as each member of `fit` is."""
    net = _new_net(seed, length_of(x))
    _train(net, x, y, keep, EPOCHS, np.random.default_rng(seed))
    return net.eval()


def _new_net(seed: int, length: int = LENGTH):
    import torch

    torch.manual_seed(seed)
    torch.set_num_threads(max(1, torch.get_num_threads()))
    return _net(length)


def _augmented(windows, generator):
    """A batch (windows x channels x ticks, each value in 0..1) changed as another wearing of the watch might change it:
    a tighter or looser strap changes each signal's size, the labelled start is never exact to the tick, and the pulse
    sensor sometimes loses the skin. The last `len(cnn_input.PULSE_CHANNELS)` channels are the pulse's."""
    import torch

    logit = torch.logit(windows.clamp(1e-5, 1 - 1e-5))
    n, channels, ticks = logit.shape
    low, high = AUGMENT_SCALE
    scale = torch.empty(n, channels, 1, device=logit.device).uniform_(low, high, generator=generator)
    logit = logit * scale + AUGMENT_NOISE * torch.randn(logit.shape, device=logit.device, generator=generator)
    most = round(AUGMENT_SHIFT_MS * ticks / 1000)    # the window is 1 s, so a tick is 1000 / ticks ms
    shifts = torch.randint(-most, most + 1, (n,), device=logit.device, generator=generator)
    # Moved in time, the tick at the edge repeated where the window has nothing.
    source = (torch.arange(ticks, device=logit.device)[None, :] - shifts[:, None]).clamp(0, ticks - 1)
    logit = torch.gather(logit, 2, source[:, None, :].expand(-1, channels, -1))
    blank = torch.rand(n, device=logit.device, generator=generator) < AUGMENT_PULSE_BLANK
    logit[blank, channels - len(cnn_input.PULSE_CHANNELS):, :] = 0.0
    return torch.sigmoid(logit)


def _train(net, x: np.ndarray, y: np.ndarray, keep: np.ndarray | None, epochs: int, rng: np.random.Generator) -> None:
    """`epochs` passes of `net` over all positives, every row `keep` marks, and up to MAX_NEGATIVES negatives in all, each
    batch through `_augmented`, the learning rate following a cosine down to zero over the passes."""
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
    windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, length_of(x))).to(where)
    truth = torch.from_numpy(y.astype(np.float32)).to(where)
    optimiser = torch.optim.Adam(net.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    positives = max(1.0, float(y.sum()))
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(MAX_POSITIVE_WEIGHT, (len(y) - positives) / positives), device=where))
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, max(1, epochs * ((len(y) + BATCH - 1) // BATCH)))
    generator = torch.Generator(device=where).manual_seed(int(rng.integers(2**31)))
    for _ in range(epochs):
        net.train()
        order = torch.from_numpy(rng.permutation(len(y))).to(where)
        for b in range(0, len(order), BATCH):
            pick = order[b:b + BATCH]
            if len(pick) < 2:
                continue        # batch normalisation needs two
            loss = loss_fn(net(_augmented(windows[pick], generator)), truth[pick])
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()
            schedule.step()
    # Back to the CPU, where the file is written from and the trainer's numpy code reads it.
    net.to("cpu")


def to_bytes(model: Model) -> bytes:
    """The model file: per network, the convolutions with their batch normalisation folded in, and the dense layers."""
    members = [_member(net) for net in model.nets]
    file = {"format": FORMAT, "version": VERSION, "channels": CHANNELS, "length": model.length, "members": members}
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
