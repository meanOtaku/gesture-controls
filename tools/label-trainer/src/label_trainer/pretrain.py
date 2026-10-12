"""A motion encoder pre-trained on many people, for a convolutional model to start from instead of from nothing.

MicroDPad (ETH SIPLab, ICMI '26: 65 people, 250 sessions, 11 wrist micro-gestures and "nothing", accelerometer and gyroscope
at about 112 Hz) is read into the same grid a convolutional model reads here: a window of the six motion channels laid onto
evenly spaced steps in time, the accelerometer in m/s^2 and the gyroscope in rad/s as the watch reports them. The same
convolution trunk `nets.CnnModel` uses is trained to tell the gestures apart, with the augmentation it uses (the watch
turned on the wrist, faster or slower, stronger or weaker), and saved. A model trained with `pretrained` set to that file
starts its convolution layers from it (`CnnModel.load_encoder`) and learns its own head on the user's recordings.

Differences the encoder is made robust to: MicroDPad's accelerometer includes gravity and the watch's does not (every window
is centred on its own mean, which takes a steady gravity away); its device is not the watch (the rotation augmentation);
and watch builds before October 2026 smoothed the motion before sending it, so half the sessions are smoothed the same way.

Licence: MicroDPad is CC BY-NC-ND 4.0 (non-commercial, no derivatives). Weights trained on it may count as a derivative,
so the encoder file stays on this computer (`data/external`, which git ignores) and is never committed or shipped.

    uv run --extra onnx --extra torch --with h5py label-classifier-train --pretrain-microdpad data/external/microdpad \\
        --out data/external/microdpad/encoders/motion-encoder.pt
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from .network import Conv, Network

MOTION_CHANNELS = ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"]
CLASSES = ["o", "p", "pc", "po", "c", "sp", "a", "d", "b", "pbd", "prl", "prr"]  # "o" is nothing
CLASS_NAMES = {
    "o": "nothing", "p": "fast pinch", "pc": "pinch hold", "po": "pinch open", "c": "swipe left", "sp": "side tap",
    "a": "swipe forward", "d": "swipe right", "b": "swipe backward", "pbd": "back to default", "prl": "rotate left",
    "prr": "rotate right",
}
RESAMPLE_HZ = 50.0  # the watch's motion rate
DEGREES_TO_RADIANS = np.pi / 180.0
# The smoothing watch builds before October 2026 applied (a running average, one step per sample at 50 Hz).
OLD_WATCH_ALPHA = {"accel": 0.2, "gyro": 0.15}
SMOOTHED_SHARE = 0.5
# Windows that span a gap in the session (four sessions have some) are left out.
MAX_GAP_S = 0.3
ENCODER_NETWORK = Network(
    hidden=(), conv=(Conv(32, 5), Conv(32, 5), Conv(32, 3)), pooling="mean_max", dropout=0.2,
    learning_rate=2e-3, epochs=40, batch_size=256, weight_decay=1e-3, balance_classes=True, augment=True,
)
ENCODER_FORMAT = 1


def _sessions(root: Path) -> list[Path]:
    return sorted((root / "sensor_data").glob("P*/S*/*.hdf5"))


def _load(path: Path) -> tuple[dict[str, np.ndarray], list[tuple[str, float, float]]]:
    import h5py

    with h5py.File(path, "r") as f:
        data = {name: f["data"][name][:] for name in ("timestamp", "acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z")}
        labels = []
        for name, group in f.items():
            if name == "data":
                continue
            code = group["label"][()]
            code = code.decode() if isinstance(code, bytes) else str(code)
            labels.append((code, float(group["start_time"][()]), float(group["end_time"][()])))
    return data, labels


def _smooth(values: np.ndarray, alpha: float) -> np.ndarray:
    """The watch's running average, starting from zero as it did: level += alpha * (value - level), per sample."""
    from scipy.signal import lfilter

    return lfilter([alpha], [1.0, alpha - 1.0], values, axis=0)


def microdpad_windows(root: Path, window_ms: int = 1000, steps: int = 32, seed: int = 7, smoothed_share: float = SMOOTHED_SHARE,
                      sessions: list[Path] | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every labelled MicroDPad window (but the start markers) as one flat row of the six motion channels over `steps`
    (channel after channel), its class index in `CLASSES`, and its participant. Each window is `window_ms` long, centred
    on the labelled one, read off the session resampled to 50 Hz."""
    rng = np.random.default_rng(seed)
    rows: list[np.ndarray] = []
    ys: list[int] = []
    people: list[str] = []
    half_s = window_ms / 2000.0
    for path in sessions or _sessions(root):
        data, labels = _load(path)
        t = data["timestamp"]
        grid = np.arange(t[0], t[-1], 1.0 / RESAMPLE_HZ)
        accel = np.stack([np.interp(grid, t, data[f"acc_{a}"]) for a in "xyz"], axis=1)
        gyro = np.stack([np.interp(grid, t, data[f"gyro_{a}"]) for a in "xyz"], axis=1) * DEGREES_TO_RADIANS
        if rng.random() < smoothed_share:
            accel, gyro = _smooth(accel, OLD_WATCH_ALPHA["accel"]), _smooth(gyro, OLD_WATCH_ALPHA["gyro"])
        signals = np.concatenate([accel, gyro], axis=1)  # (n, 6)
        gap_after = np.diff(t) > MAX_GAP_S
        for code, start, end in labels:
            if code not in CLASSES:
                continue
            centre = (start + end) / 2.0
            low, high = centre - half_s, centre + half_s
            if low < t[0] or high > t[-1]:
                continue
            inside = np.flatnonzero((t[:-1] >= low) & (t[:-1] < high))
            if inside.size and gap_after[inside].any():
                continue
            at = np.linspace(low, high, steps)
            window = np.stack([np.interp(at, grid, signals[:, c]) for c in range(6)])  # (6, steps)
            rows.append(window.reshape(-1).astype(np.float32))
            ys.append(CLASSES.index(code))
            people.append(path.parent.parent.name)
    return np.stack(rows), np.array(ys, dtype=np.int64), np.array(people)


def train_encoder(x: np.ndarray, y: np.ndarray, people: np.ndarray, steps: int, seed: int = 7, held_out_share: float = 0.15,
                  network: Network = ENCODER_NETWORK, say=print) -> tuple[Any, dict[str, Any]]:
    """Trains the convolution trunk of a `CnnModel` (with a head for every MicroDPad class) and returns the model and how it
    did on the people held out."""
    import torch
    from sklearn.metrics import roc_auc_score

    from .nets import CnnModel

    torch.manual_seed(seed)
    participants = sorted(set(people.tolist()))
    order = np.random.default_rng(seed).permutation(len(participants))
    held = {participants[i] for i in order[: max(1, int(round(held_out_share * len(participants))))]}
    test = np.isin(people, list(held))
    model = CnnModel(len(MOTION_CHANNELS), steps, seed, {}, centre_windows=True, network=network, names=MOTION_CHANNELS)
    data = torch.tensor(x[~test])
    grid = data.reshape(-1, model.channels, steps)
    model.std = (grid - grid.mean(dim=2, keepdim=True)).std(dim=(0, 2), keepdim=True).clamp_min(1e-6)
    width = network.conv[-1].filters * (2 if network.pooling == "mean_max" else 1)
    head = torch.nn.Sequential(torch.nn.Dropout(network.dropout), torch.nn.Linear(width, len(CLASSES)))
    target = torch.tensor(y[~test])
    counts = torch.bincount(target, minlength=len(CLASSES)).float()
    loss_fn = torch.nn.CrossEntropyLoss(weight=counts.sum() / (len(CLASSES) * counts.clamp_min(1)))
    optimiser = torch.optim.Adam([*model.net.parameters(), *head.parameters()], lr=network.learning_rate, weight_decay=network.weight_decay)
    generator = torch.Generator().manual_seed(seed)

    def logits(raw):
        return head(model._pool(model.net(model._scaled(raw))))

    def evaluate() -> dict[str, Any]:
        model.net.eval(), head.eval()
        with torch.no_grad():
            probability = torch.softmax(logits(torch.tensor(x[test])), dim=1).numpy()
        model.net.train(), head.train()
        truth = y[test]
        gesture = 1.0 - probability[:, CLASSES.index("o")]
        pinch = [CLASSES.index(c) for c in ("p", "pc", "po")]
        is_pinch = np.isin(truth, pinch)
        others = truth != CLASSES.index("o")
        return {
            "accuracy": float((probability.argmax(1) == truth).mean()),
            "gestureVsNothingAuc": float(roc_auc_score(truth != CLASSES.index("o"), gesture)),
            "pinchVsOtherGesturesAuc": float(roc_auc_score(is_pinch[others], probability[others][:, pinch].sum(1))),
            "perClassRecall": {CLASS_NAMES[c]: float((probability.argmax(1)[truth == i] == i).mean()) for i, c in enumerate(CLASSES) if (truth == i).any()},
        }

    say(f"Pre-training on {int((~test).sum())} windows from {len(participants) - len(held)} people; {int(test.sum())} windows from {len(held)} people held out")
    for epoch in range(1, network.epochs + 1):
        model.net.train(), head.train()
        order = torch.randperm(data.shape[0], generator=generator)
        for start in range(0, data.shape[0], network.batch_size):
            index = order[start : start + network.batch_size]
            optimiser.zero_grad()
            loss = loss_fn(logits(model._augment(data[index], generator)), target[index])
            loss.backward()
            optimiser.step()
        if epoch % 5 == 0 or epoch == network.epochs:
            metrics = evaluate()
            say(f"  round {epoch}/{network.epochs}: held-out people accuracy {metrics['accuracy']:.2f}, gesture vs nothing AUC "
                f"{metrics['gestureVsNothingAuc']:.2f}, pinch vs other gestures AUC {metrics['pinchVsOtherGesturesAuc']:.2f}")
    return model, {**evaluate(), "heldOutPeople": sorted(held), "trainWindows": int((~test).sum()), "heldOutWindows": int(test.sum())}


def save_encoder(model, metrics: dict[str, Any], network: Network, window_ms: int, steps: int, out: Path) -> str:
    import torch

    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "format": ENCODER_FORMAT,
            "channels": MOTION_CHANNELS,
            "steps": steps,
            "windowMs": window_ms,
            "network": network.as_dict(),
            "state": model.net.state_dict(),
            "classes": [CLASS_NAMES[c] for c in CLASSES],
            "metrics": metrics,
            "source": "MicroDPad (ETH SIPLab), CC BY-NC-ND 4.0: for use on this computer only; do not commit or distribute",
        },
        out,
    )
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    (out.with_suffix(".json")).write_text(json.dumps({"sha256": digest, "windowMs": window_ms, "steps": steps, "metrics": metrics}, indent=2) + "\n")
    return digest


def load_encoder(path: Path) -> dict[str, Any]:
    """The saved encoder (see `save_encoder`), checked to be one this trainer can use."""
    import torch

    # weights_only: the file holds tensors and plain values only, so nothing in it can run code when it is read.
    encoder = torch.load(path, map_location="cpu", weights_only=True)
    if encoder.get("format") != ENCODER_FORMAT or encoder.get("channels") != MOTION_CHANNELS:
        raise ValueError(f"{path} is not a motion encoder this trainer can use")
    return encoder


def pretrain(root: Path, out: Path, window_ms: int = 1000, steps: int = 32, seed: int = 7, say=print) -> dict[str, Any]:
    say(f"Reading MicroDPad from {root}")
    x, y, people = microdpad_windows(root, window_ms, steps, seed)
    model, metrics = train_encoder(x, y, people, steps, seed, say=say)
    digest = save_encoder(model, metrics, ENCODER_NETWORK, window_ms, steps, out)
    say(f"Saved the encoder to {out} (sha256 {digest[:12]}...)")
    return metrics
