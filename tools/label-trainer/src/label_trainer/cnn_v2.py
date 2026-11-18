"""The v2 CNN pinch-start model: one branch per sensor, joined partway and at the end, its file (`model.cnn`, format
`ppg-imu-cnn-branches`), and a plain evaluation of that file.

Research: `docs/research/artifacts/pinch-cnn-v2-2026-11/` (FINDINGS.md). The network reads `cnn_input`'s ten v2 channels x
100 ticks (`envelope=True`: the nine of the first CNN and the accelerometer's jerk envelope) in three groups (`GROUPS`):
the accelerometer with its jerk envelope, the gyroscope, and the pulse. Each group goes through its own two convolutions
(16 channels, kernel 5, dilation 1 then 2, each with batch normalisation and a ReLU); the three groups' maps, side by side,
go through two shared convolutions (32 then 64 channels, dilation 4 then 8). Each branch's maps and the shared maps are
pooled over time (maximum, then mean), all of it side by side into a dense layer of 32 with a ReLU and dropout, and one
output through a sigmoid. `MEMBERS` networks from different seeds are averaged.

A multi-gesture network (`classes`) has one output for "nothing" and one for each gesture, through a softmax: the gestures
compete, so two cannot both be likely at once. Its file names them (`"outputs": ["nothing", gesture, ...]`), and each
gesture's model reads its own output (the manifest's `positiveIndex`).

Training is the first CNN's (`cnn._train`: epochs, batch, optimiser, cosine schedule, positive weight, negative cap, size
scaling, noise, 40 ms shift and pulse blanking), plus smooth time warping and magnitude warping of every batch (Um et al.
2017). Noise-overlay copies of the training recordings are made by the trainer (`label_train.overlay_copies`), not here.

The file is JSON with batch normalisation folded into the convolutions, read by `crates/label-inference/src/cnn.rs`:
`{"format": "ppg-imu-cnn-branches", "version": 1, "channels", "length", "members": [{"branches": [{"channels": [...],
"conv": [...]}, ...], "shared": [...], "dense": [...]}]}`, each convolution and dense layer as in the first CNN's file.
"""

from __future__ import annotations

import json

import numpy as np

from . import cnn, cnn_input

FORMAT = "ppg-imu-cnn-branches"
VERSION = 1
CHANNELS = len(cnn_input.V2_CHANNELS)
LENGTH = cnn_input.grid_of(100).window       # the default rate's window; a model's own is `Model.length`
LENGTHS = {cnn_input.grid_of(hz).window: hz for hz in cnn_input.V2_RATES}
# The channels of each branch, as indices into the v2 inputs: accelerometer (and its jerk envelope), gyroscope, pulse.
GROUPS = ((0, 1, 2, 9), (3, 4, 5), (6, 7, 8))
PULSE = slice(6, 9)
BRANCH = ((16, 1), (16, 2))       # (channels, dilation) of each branch's convolutions
SHARED = ((32, 4), (64, 8))       # and of the shared ones
MEMBERS = 3
# Warping (`_augmented`): a smooth curve through WARP_KNOTS random points around 1 multiplies each channel (spread
# MAGNITUDE_WARP) and sets the speed time runs at (spread TIME_WARP).
WARP_KNOTS = 4
MAGNITUDE_WARP = 0.2
TIME_WARP = 0.25
PARITY_TOLERANCE = cnn.PARITY_TOLERANCE
# Continuing from a trained model (`fit(start=...)`): fewer passes at a lower learning rate, so the new recordings adjust
# what it learnt instead of overwriting it. Its batch normalisation stays as the saved file folded it (`load`).
CONTINUE_EPOCHS = 8
CONTINUE_LEARNING_RATE_SCALE = 0.3


NOTHING = "nothing"     # the first output of a multi-gesture network


def _net(outputs: int = 1):
    import torch
    from torch import nn

    def stack(c_in, layers):
        out = []
        for width, dilation in layers:
            out += [nn.Conv1d(c_in, width, cnn.KERNEL, padding=dilation * (cnn.KERNEL - 1) // 2, dilation=dilation),
                    nn.BatchNorm1d(width), nn.ReLU()]
            c_in = width
        return nn.Sequential(*out), c_in

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.groups = [list(g) for g in GROUPS]
            made = [stack(len(g), BRANCH) for g in GROUPS]
            self.branches = nn.ModuleList([m for m, _ in made])
            joined = sum(c for _, c in made)
            self.shared, c = stack(joined, SHARED)
            self.head = nn.Sequential(nn.Linear(2 * joined + 2 * c, cnn.HIDDEN), nn.ReLU(), nn.Dropout(0.2),
                                      nn.Linear(cnn.HIDDEN, outputs))
            self.outputs = outputs

        def forward(self, x):
            maps = [b(x[:, g, :]) for b, g in zip(self.branches, self.groups)]
            h = self.shared(torch.cat(maps, 1))
            pooled = [torch.cat([m.amax(2), m.mean(2)], 1) for m in maps] + [torch.cat([h.amax(2), h.mean(2)], 1)]
            out = self.head(torch.cat(pooled, 1))
            return out.squeeze(1) if self.outputs == 1 else out

    return Net()


class Model:
    """Trained networks, averaged, with the `predict_proba` the trainer's evaluation uses: [nothing, gesture] for one
    gesture, [nothing, each gesture...] for a multi-gesture network (`classes`, its gestures in output order)."""

    def __init__(self, nets, classes: tuple[str, ...] | None = None, length: int = LENGTH):
        self.nets = nets
        self.classes = classes
        self.length = length    # ticks per channel: the window of the rate it was trained at

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        import torch

        where = cnn.device()
        windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, self.length))
        width = 1 if self.classes is None else len(self.classes) + 1
        p = np.zeros((len(windows), width))
        with torch.no_grad():
            for net in self.nets:
                net.to(where).eval()
                for i in range(0, len(windows), 4096):
                    out = net(windows[i:i + 4096].to(where))
                    out = torch.sigmoid(out)[:, None] if self.classes is None else torch.softmax(out, 1)
                    p[i:i + 4096] += out.cpu().numpy().astype(np.float64)
                net.to("cpu")
        p /= len(self.nets)
        return np.concatenate([1.0 - p, p], axis=1) if self.classes is None else p


def _smooth_curves(n, channels, ticks, spread, generator, device):
    import torch
    from torch import nn

    knots = 1.0 + spread * torch.randn(n, channels, WARP_KNOTS, generator=generator, device=device)
    return nn.functional.interpolate(knots, size=ticks, mode="linear", align_corners=True)


def _augmented(windows, generator):
    """`cnn._augmented` for the v2 channels (pulse = channels 6-8), with time and magnitude warping."""
    import torch

    logit = torch.logit(windows.clamp(1e-5, 1 - 1e-5))
    n, channels, ticks = logit.shape
    low, high = cnn.AUGMENT_SCALE
    logit = logit * torch.empty(n, channels, 1, device=logit.device).uniform_(low, high, generator=generator)
    logit = logit + cnn.AUGMENT_NOISE * torch.randn(logit.shape, device=logit.device, generator=generator)
    logit = logit * _smooth_curves(n, channels, ticks, MAGNITUDE_WARP, generator, logit.device)
    speed = _smooth_curves(n, 1, ticks, TIME_WARP, generator, logit.device).clamp(0.3, 3.0)[:, 0, :]
    position = torch.cumsum(speed, 1)
    position = (position - position[:, :1]) / (position[:, -1:] - position[:, :1]).clamp_min(1e-6) * (ticks - 1)
    source = position.round().long().clamp(0, ticks - 1)
    logit = torch.gather(logit, 2, source[:, None, :].expand(-1, channels, -1))
    most = round(cnn.AUGMENT_SHIFT_MS * ticks / 1000)
    shifts = torch.randint(-most, most + 1, (n,), device=logit.device, generator=generator)
    source = (torch.arange(ticks, device=logit.device)[None, :] - shifts[:, None]).clamp(0, ticks - 1)
    logit = torch.gather(logit, 2, source[:, None, :].expand(-1, channels, -1))
    blank = torch.rand(n, device=logit.device, generator=generator) < cnn.AUGMENT_PULSE_BLANK
    logit[blank, PULSE, :] = 0.0
    return torch.sigmoid(logit)


def _train(net, x: np.ndarray, y: np.ndarray, rng: np.random.Generator, epochs: int = cnn.EPOCHS,
           learning_rate: float = cnn.LEARNING_RATE, frozen_norm: bool = False) -> None:
    """`cnn._train` with `_augmented` and the v2 shape. With `frozen_norm` (a network from `load`), its batch
    normalisation keeps the statistics it has instead of taking each batch's."""
    import torch
    from torch import nn

    negatives = np.flatnonzero(y == 0)
    if len(negatives) > cnn.MAX_NEGATIVES:
        rows = np.sort(np.concatenate([np.flatnonzero(y >= 1), rng.choice(negatives, cnn.MAX_NEGATIVES, replace=False)]))
        x, y = x[rows], y[rows]
    where = cnn.device()
    net.to(where)
    windows = torch.from_numpy(np.asarray(x, dtype=np.float32).reshape(-1, CHANNELS, np.asarray(x).shape[1] // CHANNELS)).to(where)
    optimiser = torch.optim.Adam(net.parameters(), lr=learning_rate, weight_decay=cnn.WEIGHT_DECAY)
    if net.outputs == 1:
        truth = torch.from_numpy(np.asarray(y, dtype=np.float32)).to(where)
        positives = max(1.0, float(y.sum()))
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(cnn.MAX_POSITIVE_WEIGHT, (len(y) - positives) / positives), device=where))
    else:
        # Each gesture weighted as the one-gesture network weights its starts: by how rare it is, at most MAX_POSITIVE_WEIGHT.
        truth = torch.from_numpy(np.asarray(y, dtype=np.int64)).to(where)
        counts = np.bincount(np.asarray(y, dtype=np.int64), minlength=net.outputs).astype(np.float64)
        weights = [1.0] + [min(cnn.MAX_POSITIVE_WEIGHT, counts[0] / max(1.0, c)) for c in counts[1:]]
        loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(weights, dtype=torch.float32, device=where))
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, max(1, epochs * ((len(y) + cnn.BATCH - 1) // cnn.BATCH)))
    generator = torch.Generator(device=where).manual_seed(int(rng.integers(2**31)))
    for _ in range(epochs):
        net.train()
        if frozen_norm:
            for layer in net.modules():
                if isinstance(layer, nn.BatchNorm1d):
                    layer.eval()
        order = torch.from_numpy(rng.permutation(len(y))).to(where)
        for b in range(0, len(order), cnn.BATCH):
            pick = order[b:b + cnn.BATCH]
            if len(pick) < 2:
                continue
            loss = loss_fn(net(_augmented(windows[pick], generator)), truth[pick])
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()
            schedule.step()
    net.to("cpu")


def fit(x: np.ndarray, y: np.ndarray, seed: int, epochs: int | None = None, start: bytes | None = None,
        classes: tuple[str, ...] | None = None) -> Model:
    """MEMBERS networks trained on `x` (decisions x 1000 v2 inputs) and `y`, each from its own seed, for `epochs` passes
    (the CNN's EPOCHS when None). With `start` (a saved model file), each of its networks trains on from where it was
    instead of from scratch, for CONTINUE_EPOCHS passes (when None) at CONTINUE_LEARNING_RATE_SCALE of the rate. With
    `classes`, a multi-gesture network: `y` is 0 for nothing and i + 1 for `classes[i]`."""
    import torch

    width = np.asarray(x).shape[1]
    if width % CHANNELS or width // CHANNELS not in LENGTHS:
        raise ValueError(f"the v2 CNN reads {CHANNELS} channels of {' or '.join(str(n) for n in sorted(LENGTHS))} ticks, not {width} inputs")
    length = width // CHANNELS
    if classes is not None and start is not None:
        raise ValueError("a multi-gesture network trains from scratch")
    begun = load(start, length) if start is not None else None
    nets = []
    for member in range(len(begun) if begun is not None else MEMBERS):
        torch.manual_seed(seed + member)
        torch.set_num_threads(max(1, torch.get_num_threads()))
        if begun is None:
            net = _net(1 if classes is None else len(classes) + 1)
            _train(net, np.asarray(x), np.asarray(y), np.random.default_rng(seed + member), epochs or cnn.EPOCHS)
        else:
            net = begun[member]
            _train(net, np.asarray(x), np.asarray(y), np.random.default_rng(seed + member), epochs or CONTINUE_EPOCHS,
                   cnn.LEARNING_RATE * CONTINUE_LEARNING_RATE_SCALE, frozen_norm=True)
        nets.append(net.eval())
    return Model(nets, classes, length)


def load(model_bytes: bytes, length: int = LENGTH) -> list:
    """The networks of a saved model file, ready to train on: each convolution takes the file's weights (batch
    normalisation already folded in) and its batch normalisation is set to pass values through unchanged, so before any
    training they score exactly as the file does. Refused when the file is not a v2 CNN of this shape."""
    import torch

    file = json.loads(model_bytes)
    if file.get("format") != FORMAT or file.get("version") != VERSION:
        raise ValueError(f"the model to start from is not a {FORMAT} file of version {VERSION}")
    if "outputs" in file:
        raise ValueError("a multi-gesture model cannot be trained on from where it is: train it from scratch")
    if file.get("channels") != CHANNELS or file.get("length") != length or not file.get("members"):
        raise ValueError(f"the model to start from reads {file.get('channels')} x {file.get('length')}, not {CHANNELS} x {length}")

    def set_conv(seq, convs):
        layers = list(seq)
        if len(convs) * 3 != len(layers):
            raise ValueError("the model to start from has a different number of convolutions")
        for i, c in enumerate(convs):
            conv, norm = layers[3 * i], layers[3 * i + 1]
            shape = tuple(conv.weight.shape)
            if (c["out"], c["in"], c["kernel"]) != shape or c["dilation"] != conv.dilation[0]:
                raise ValueError(f"the model to start from has a convolution of {c['out']} x {c['in']} x {c['kernel']}, not {shape}")
            conv.weight.copy_(torch.tensor(c["weight"], dtype=torch.float32).reshape(shape))
            conv.bias.copy_(torch.tensor(c["bias"], dtype=torch.float32))
            norm.weight.fill_(1.0)
            norm.bias.zero_()
            norm.running_mean.zero_()
            norm.running_var.fill_(1.0 - norm.eps)

    nets = []
    with torch.no_grad():
        for member in file["members"]:
            net = _net()
            if [b["channels"] for b in member["branches"]] != [list(g) for g in GROUPS]:
                raise ValueError("the model to start from groups its channels differently")
            for branch, saved in zip(net.branches, member["branches"]):
                set_conv(branch, saved["conv"])
            set_conv(net.shared, member["shared"])
            dense = [layer for layer in net.head if isinstance(layer, torch.nn.Linear)]
            if len(dense) != len(member["dense"]):
                raise ValueError("the model to start from has a different number of dense layers")
            for layer, d in zip(dense, member["dense"]):
                if (d["out"], d["in"]) != tuple(layer.weight.shape):
                    raise ValueError("the model to start from has dense layers of another size")
                layer.weight.copy_(torch.tensor(d["weight"], dtype=torch.float32).reshape(d["out"], d["in"]))
                layer.bias.copy_(torch.tensor(d["bias"], dtype=torch.float32))
            nets.append(net.eval())
    return nets


def _conv(conv, norm) -> dict:
    """A convolution with its batch normalisation folded in (`cnn._member`)."""
    scale = (norm.weight / (norm.running_var + norm.eps).sqrt()).detach().double().numpy()
    weight = conv.weight.detach().double().numpy() * scale[:, None, None]
    bias = (conv.bias.detach().double().numpy() - norm.running_mean.detach().double().numpy()) * scale \
        + norm.bias.detach().double().numpy()
    return {"in": conv.in_channels, "out": conv.out_channels, "kernel": conv.kernel_size[0],
            "dilation": conv.dilation[0], "weight": weight.ravel().tolist(), "bias": bias.tolist()}


def _convs(seq) -> list[dict]:
    layers = list(seq)
    return [_conv(layers[i], layers[i + 1]) for i in range(0, len(layers), 3)]


def _member(net) -> dict:
    from torch import nn

    dense = [{"in": l.in_features, "out": l.out_features, "weight": l.weight.detach().double().numpy().ravel().tolist(),
              "bias": l.bias.detach().double().numpy().tolist()} for l in net.head if isinstance(l, nn.Linear)]
    return {"branches": [{"channels": list(g), "conv": _convs(b)} for g, b in zip(GROUPS, net.branches)],
            "shared": _convs(net.shared), "dense": dense}


def to_bytes(model: Model) -> bytes:
    file = {"format": FORMAT, "version": VERSION, "channels": CHANNELS, "length": model.length,
            **({"outputs": [NOTHING, *model.classes]} if model.classes is not None else {}),
            "members": [_member(net) for net in model.nets]}
    return (json.dumps(cnn._single_precision(file), separators=(",", ":")) + "\n").encode()


def _run_convs(convs, h, length):
    for c in convs:
        w = np.asarray(c["weight"]).reshape(c["out"], c["in"], c["kernel"])
        pad = c["dilation"] * (c["kernel"] - 1) // 2
        padded = np.pad(h, ((0, 0), (0, 0), (pad, pad)))
        out = np.repeat(np.asarray(c["bias"])[None, :, None], len(h), axis=0).astype(np.float64)
        for k in range(c["kernel"]):
            out = out + np.einsum("oi,nit->not", w[:, :, k], padded[:, :, k * c["dilation"]:k * c["dilation"] + length])
        h = np.maximum(out, 0.0)
    return h


def _predict_member(member: dict, x: np.ndarray, length: int) -> np.ndarray:
    maps = [_run_convs(b["conv"], x[:, b["channels"], :], length) for b in member["branches"]]
    shared = _run_convs(member["shared"], np.concatenate(maps, axis=1), length)
    v = np.concatenate([np.concatenate([m.max(axis=2), m.mean(axis=2)], axis=1) for m in maps + [shared]], axis=1)
    for n, d in enumerate(member["dense"]):
        v = v @ np.asarray(d["weight"]).reshape(d["out"], d["in"]).T + np.asarray(d["bias"])
        if n + 1 < len(member["dense"]):
            v = np.maximum(v, 0.0)
    if v.shape[1] == 1:
        return 1.0 / (1.0 + np.exp(-v[:, 0]))
    e = np.exp(v - v.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)


def predict(model_bytes: bytes, x: np.ndarray) -> np.ndarray:
    """The positive class's probability for each row of `x`, from the model file alone, as the runtime computes it; for a
    multi-gesture file, every output's (rows x [nothing, gestures...])."""
    file = json.loads(model_bytes)
    if file.get("format") != FORMAT:
        raise ValueError(f"not a {FORMAT} file")
    x = np.asarray(x, dtype=np.float64).reshape(-1, file["channels"], file["length"])
    return np.mean([_predict_member(m, x, file["length"]) for m in file["members"]], axis=0)
