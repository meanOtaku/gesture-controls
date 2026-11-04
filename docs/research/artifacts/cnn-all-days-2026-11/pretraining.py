"""Teaching the CNN what wrist signals look like before it sees a pinch label.

Each network's convolutions first learn to fill in hidden stretches of a window, on the windows of the training recordings
with no labels, most of them everyday noise. The ordinary training then starts from those weights, with pinches and noise
mixed as usual. Nothing is frozen, and the network and its file are unchanged. `install` swaps `cnn._net` for the length of
a run, so every network of that run (the model and the threshold's cross-check) starts from pretrained convolutions; the
cross-check's networks saw, without labels, the recordings each leaves out. Held-out recordings are never used.
"""
from __future__ import annotations

import numpy as np

from label_trainer import cnn, label_train as lt

EVERY_NTH = 2           # of the 25 Hz decisions
MAX_WINDOWS = 80_000
EPOCHS = 20
BATCH = 256
LEARNING_RATE = 1e-3
HIDDEN_TICKS = 12       # each hidden stretch, about 0.25 s
STRETCHES = 2
NEUTRAL = 0.5           # the sigmoid of a value at its channel's recent mean


def windows(spec, recordings: dict) -> np.ndarray:
    """Windows from the training recordings, labels ignored."""
    out = []
    for rid in spec.train:
        ts, _ = lt.pulse_of(recordings[rid])
        x = lt.inputs(spec, recordings[rid], ts[::EVERY_NTH])
        out.append(x[np.isfinite(x).all(axis=1)].astype(np.float32))
    return np.concatenate(out)


def pretrained(x: np.ndarray, seed: int):
    """One network's convolutions, trained to reconstruct hidden stretches of `x`, and how much of the error it removed."""
    import torch
    from torch import nn

    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    if len(x) > MAX_WINDOWS:
        x = x[rng.choice(len(x), MAX_WINDOWS, replace=False)]
    where = cnn.device()
    data = torch.from_numpy(x.reshape(-1, cnn.CHANNELS, cnn.LENGTH)).to(where)
    net = cnn._net().to(where)
    decoder = nn.Conv1d(cnn.CONVOLUTIONS[-1][0], cnn.CHANNELS, 1).to(where)
    optimiser = torch.optim.Adam([*net.body.parameters(), *decoder.parameters()], lr=LEARNING_RATE, weight_decay=cnn.WEIGHT_DECAY)
    ticks = torch.arange(cnn.LENGTH, device=where)[None, None, :]
    first = last = None
    for epoch in range(EPOCHS):
        net.train()
        total, count = 0.0, 0
        order = torch.from_numpy(rng.permutation(len(data))).to(where)
        for b in range(0, len(order) - 1, BATCH):
            truth = data[order[b:b + BATCH]]
            if len(truth) < 2:
                continue
            starts = torch.from_numpy(rng.integers(0, cnn.LENGTH - HIDDEN_TICKS, (len(truth), STRETCHES, 1))).to(where)
            mask = ((ticks >= starts) & (ticks < starts + HIDDEN_TICKS)).any(1, keepdim=True).float()
            hidden = truth * (1 - mask) + NEUTRAL * mask
            error = ((decoder(net.body(hidden)) - truth) ** 2 * mask).sum() / (mask.sum() * cnn.CHANNELS)
            optimiser.zero_grad()
            error.backward()
            optimiser.step()
            total += float(error.detach()) * len(truth)
            count += len(truth)
        last = total / count
        first = first if first is not None else last
    net.to("cpu")
    return {k: v.clone() for k, v in net.body.state_dict().items()}, first, last


def install(spec, recordings: dict) -> callable:
    """From now until the returned function runs, each new network starts from pretrained convolutions, one set per member."""
    x = windows(spec, recordings)
    bodies = []
    for member in range(cnn.MEMBERS):
        body, first, last = pretrained(x, spec.seed + member)
        bodies.append(body)
        print(f"   pretrained on {len(x)} windows: reconstruction error {first:.4f} to {last:.4f}", flush=True)
    original = cnn._net
    made = iter(range(10**9))

    def start_pretrained():
        net = original()
        net.body.load_state_dict(bodies[next(made) % len(bodies)])
        return net

    cnn._net = start_pretrained

    def restore() -> None:
        cnn._net = original

    return restore
