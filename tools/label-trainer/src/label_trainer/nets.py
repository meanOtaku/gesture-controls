"""The two PyTorch networks (dense and convolutional), built from a `network.Network`, with their scaling inside them.

While training they report how it is going every few rounds (`on_epoch`): the loss on the training windows and, only to be
looked at and never to choose anything, the loss and the ROC AUC on the held-out ones. Imported lazily: PyTorch is an
optional extra.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

from .network import Network, default_network

EpochCallback = Callable[[int, int, dict[str, float]], None]


def _activation(torch, name: str):
    return {"relu": torch.nn.ReLU, "tanh": torch.nn.Tanh, "sigmoid": torch.nn.Sigmoid, "leaky_relu": lambda: torch.nn.LeakyReLU(0.01)}[name]()


def _report_every(epochs: int) -> int:
    return max(1, epochs // 60)


# How far `CnnModel._augment` varies a window.
ROTATION_DEG = 15.0
STRETCH = 0.1
SHIFT_STEPS = 2
SCALE = 0.1
NOISE = 0.05


def _random_rotations(torch, count: int, generator, max_degrees: float):
    """`count` 3x3 rotations, each about a random axis by a random angle of up to `max_degrees` (Rodrigues' formula)."""
    axis = torch.randn(count, 3, generator=generator)
    axis = axis / axis.norm(dim=1, keepdim=True).clamp_min(1e-9)
    angle = torch.deg2rad(max_degrees * (2 * torch.rand(count, generator=generator) - 1))
    x, y, z = axis[:, 0], axis[:, 1], axis[:, 2]
    zero = torch.zeros(count)
    cross = torch.stack([torch.stack([zero, -z, y], 1), torch.stack([z, zero, -x], 1), torch.stack([-y, x, zero], 1)], 1)
    sin, cos = torch.sin(angle).view(-1, 1, 1), torch.cos(angle).view(-1, 1, 1)
    return torch.eye(3).expand(count, 3, 3) + sin * cross + (1 - cos) * torch.bmm(cross, cross)


def _hold_pins(torch, module, pins, prefix: str = "") -> None:
    """Puts every pinned weight back to the value it was given by hand, after each step of training."""
    if not pins:
        return
    with torch.no_grad():
        for name, parameter in module.named_parameters():
            pinned = pins.get(prefix + name)
            if pinned is not None:
                mask, values = pinned
                parameter.copy_(torch.where(mask, values, parameter))


class _Trainer:
    """What the two networks share: the loop, the balancing of classes, and the progress reports."""

    torch: Any
    network: Network
    seed: int

    def _loop(self, parameters, logits, scaled, target, augment, eval_scaled, eval_target, on_epoch, modes, after_step=None, sample_weights=None) -> None:
        torch = self.torch
        network = self.network
        counts = torch.bincount(target, minlength=2).float()
        weights = counts.sum() / (2 * counts.clamp_min(1)) if network.balance_classes else torch.ones(2)
        loss_fn = torch.nn.CrossEntropyLoss(weight=weights)
        plain_loss = torch.nn.CrossEntropyLoss()
        optimiser = torch.optim.Adam(parameters, lr=network.learning_rate, weight_decay=network.weight_decay)
        generator = torch.Generator().manual_seed(self.seed)
        count = scaled.shape[0]
        batch_size = network.batch_size or count
        every = _report_every(network.epochs)
        for epoch in range(1, network.epochs + 1):
            modes(True)
            order = torch.randperm(count, generator=generator) if network.batch_size else torch.arange(count)
            for start in range(0, count, batch_size):
                index = order[start : start + batch_size]
                batch = scaled[index]
                if augment is not None:
                    batch = augment(batch, generator)
                optimiser.zero_grad()
                if sample_weights is None:
                    loss = loss_fn(logits(batch), target[index])
                else:
                    # Windows from the extra recordings count more: the same weighted mean the plain loss takes, with each window's own weight.
                    per_window = torch.nn.functional.cross_entropy(logits(batch), target[index], weight=weights, reduction="none")
                    own = sample_weights[index]
                    loss = (per_window * own).sum() / (weights[target[index]] * own).sum()
                loss.backward()
                optimiser.step()
                if after_step is not None:
                    after_step()
            if on_epoch is not None and (epoch % every == 0 or epoch == network.epochs or epoch == 1):
                modes(False)
                with torch.no_grad():
                    metrics = {"trainLoss": float(plain_loss(logits(scaled), target))}
                    if eval_scaled is not None and eval_target is not None:
                        eval_logits = logits(eval_scaled)
                        metrics["evalLoss"] = float(plain_loss(eval_logits, eval_target))
                        probability = torch.softmax(eval_logits, dim=1)[:, 1].numpy()
                        from sklearn.metrics import roc_auc_score

                        labels = eval_target.numpy()
                        if 0 < labels.sum() < labels.shape[0]:
                            metrics["evalAuc"] = float(roc_auc_score(labels, probability))
                on_epoch(epoch, network.epochs, metrics)
        modes(False)


class TorchModel(_Trainer):
    """A dense network: the chosen hidden layers, then two outputs. The feature scaling is inside it."""

    def __init__(self, n_features: int, seed: int, params: dict[str, Any], network: Network | None = None):
        import torch

        torch.manual_seed(seed)
        self.torch, self.seed = torch, seed
        self.network = network or default_network("torch-mlp")
        self.n_features = n_features
        self.mean = torch.zeros(n_features)
        self.std = torch.ones(n_features)
        layers, width = [], n_features
        for layer in self.network.hidden:
            layers += [torch.nn.Linear(width, layer.units), _activation(torch, layer.activation)]
            width = layer.units
        if self.network.dropout > 0:
            layers.append(torch.nn.Dropout(self.network.dropout))
        layers.append(torch.nn.Linear(width, 2))
        self.net = torch.nn.Sequential(*layers)

    def fit(self, x: np.ndarray, y: np.ndarray, x_eval: np.ndarray | None = None, y_eval: np.ndarray | None = None, on_epoch: EpochCallback | None = None) -> "TorchModel":
        torch = self.torch
        data = torch.tensor(x, dtype=torch.float32)
        self.mean = data.mean(dim=0)
        self.std = data.std(dim=0).clamp_min(1e-6)
        scaled = (data - self.mean) / self.std
        eval_scaled = None if x_eval is None else (torch.tensor(x_eval, dtype=torch.float32) - self.mean) / self.std
        eval_target = None if y_eval is None else torch.tensor(y_eval, dtype=torch.long)
        self._loop(
            self.net.parameters(), self.net, scaled, torch.tensor(y, dtype=torch.long), None, eval_scaled, eval_target, on_epoch,
            lambda training: self.net.train(training),
        )
        return self

    def fine_tune(self, x, y, x_eval, y_eval, on_epoch, network: Network, freeze_dense: set[int], pins, sample_weights=None) -> None:
        """Carries on training from the weights it has: the scaling stays as it was, frozen layers do not move, pinned weights keep their values."""
        torch = self.torch
        from dataclasses import replace  # noqa: F401  (kept local: only fine-tuning needs it)

        data = torch.tensor(x, dtype=torch.float32)
        scaled = (data - self.mean) / self.std
        eval_scaled = None if x_eval is None else (torch.tensor(x_eval, dtype=torch.float32) - self.mean) / self.std
        eval_target = None if y_eval is None else torch.tensor(y_eval, dtype=torch.long)
        linears = [m for m in self.net if isinstance(m, torch.nn.Linear)]
        for index, module in enumerate(linears):
            for parameter in module.parameters():
                parameter.requires_grad_(index not in freeze_dense)
        trainable = [p for p in self.net.parameters() if p.requires_grad]
        if not trainable:
            raise ValueError("every layer is frozen, so there is nothing to train")
        previous, self.network = self.network, network
        try:
            self._loop(trainable, self.net, scaled, torch.tensor(y, dtype=torch.long), None, eval_scaled, eval_target, on_epoch,
                       lambda training: self.net.train(training), after_step=lambda: _hold_pins(torch, self.net, pins),
                       sample_weights=None if sample_weights is None else torch.tensor(sample_weights, dtype=torch.float32))
        finally:
            self.network = previous
            for parameter in self.net.parameters():
                parameter.requires_grad_(True)

    def module(self):
        torch = self.torch

        class Wrapped(torch.nn.Module):
            def __init__(self, net, mean, std):
                super().__init__()
                self.net = net
                self.register_buffer("mean", mean)
                self.register_buffer("std", std)

            def forward(self, features):
                return torch.softmax(self.net((features - self.mean) / self.std), dim=1)

        return Wrapped(self.net, self.mean, self.std).eval()

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.no_grad():
            return self.module()(torch.tensor(x, dtype=torch.float32)).numpy()


class CnnModel(_Trainer):
    """A 1D convolutional network over the window's grid (channels x steps), with its scaling inside it.

    The input is the grid as one flat row (`channels x steps` numbers, channel after channel); the first thing the model
    does is fold it back into rows. Then, per channel, it takes the window's own mean away (with `centre_windows`, so only
    how a signal changes is left, never its level) or the training mean, and divides by the training spread. The chosen
    convolution layers follow, then the pooling over time (the average, the maximum, or both, of each filter), any dense
    layers, and one layer that gives the two probabilities. While training, windows are (with `augment`) varied in ways a
    real window could be, so the few windows of a few recordings are not simply memorised (see `_augment`).
    """

    def __init__(self, channels: int, steps: int, seed: int, params: dict[str, Any], centre_windows: bool, network: Network | None = None, names: list[str] | None = None):
        import torch

        torch.manual_seed(seed)
        self.torch, self.seed = torch, seed
        self.network = network or default_network("cnn1d")
        self.channels, self.steps, self.centre = channels, steps, centre_windows
        # The (x, y, z) channel positions of each motion sensor in the grid, turned together by the rotation augmentation.
        names = names or []
        self.triplets = [
            [names.index(f"{sensor}_{axis}") for axis in "xyz"]
            for sensor in ("accel", "gyro")
            if all(f"{sensor}_{axis}" in names for axis in "xyz")
        ]
        self.mean = torch.zeros(1, channels, 1)
        self.std = torch.ones(1, channels, 1)
        convolution, width = [], channels
        for layer in self.network.conv:
            convolution += [torch.nn.Conv1d(width, layer.filters, layer.kernel, padding=layer.kernel // 2), _activation(torch, layer.activation)]
            width = layer.filters
        self.net = torch.nn.Sequential(*convolution)
        width *= 2 if self.network.pooling == "mean_max" else 1
        head = []
        for layer in self.network.hidden:
            head += [torch.nn.Linear(width, layer.units), _activation(torch, layer.activation)]
            width = layer.units
        if self.network.dropout > 0:
            head.append(torch.nn.Dropout(self.network.dropout))
        head.append(torch.nn.Linear(width, 2))
        self.head = torch.nn.Sequential(*head)

    def load_encoder(self, state: dict, freeze: bool) -> None:
        """Starts the convolution layers from a pre-trained encoder's (see `pretrain.py`); with `freeze` they stay as they
        are and only the head learns."""
        self.net.load_state_dict(state)
        for parameter in self.net.parameters():
            parameter.requires_grad_(not freeze)

    def _scaled(self, flat):
        grid = flat.reshape(-1, self.channels, self.steps)
        grid = grid - (grid.mean(dim=2, keepdim=True) if self.centre else self.mean)
        return grid / self.std

    def _pool(self, features):
        torch = self.torch
        pooling = self.network.pooling
        if pooling == "mean":
            return features.mean(dim=2)
        if pooling == "max":
            return features.amax(dim=2)
        return torch.cat([features.mean(dim=2), features.amax(dim=2)], dim=1)

    def _logits(self, scaled):
        return self.head(self._pool(self.net(scaled)))

    def _augment(self, flat, generator):
        """A batch of windows (in the sensors' own units, before scaling) varied the ways a real window could be:

        * the watch sitting a little differently on the wrist: each motion sensor's three axes turned together by up to
          `ROTATION_DEG` about a random axis;
        * the gesture a little faster or slower, or a little earlier or later: the time axis stretched by up to
          `STRETCH` about its middle and shifted by up to `SHIFT_STEPS` steps, read by linear interpolation; beyond the
          window's ends the first or last value carries on (the old circular shift wrapped the end round to the start);
        * a little stronger or weaker: each channel's swing about its own mean scaled by up to `SCALE` (its level is not
          scaled, so a pulse reading of 50,000 is not moved by thousands);
        * a little noise, a twentieth of each channel's spread.
        """
        torch = self.torch
        count = flat.shape[0]
        grid = flat.reshape(count, self.channels, self.steps).clone()
        for triplet in self.triplets:
            grid[:, triplet, :] = torch.bmm(_random_rotations(torch, count, generator, ROTATION_DEG), grid[:, triplet, :])
        positions = torch.arange(self.steps, dtype=torch.float32)
        middle = (self.steps - 1) / 2.0
        stretch = 1.0 + STRETCH * (2 * torch.rand(count, 1, generator=generator) - 1)
        shift = torch.randint(-SHIFT_STEPS, SHIFT_STEPS + 1, (count, 1), generator=generator).float()
        source = ((positions - middle) * stretch + middle + shift).clamp(0, self.steps - 1)
        low = source.floor().long().clamp(max=self.steps - 2) if self.steps > 1 else source.floor().long()
        high = (low + 1).clamp(max=self.steps - 1)
        fraction = (source - low.float()).unsqueeze(1)
        gather = lambda index: torch.gather(grid, 2, index.unsqueeze(1).expand(-1, self.channels, -1))  # noqa: E731
        grid = gather(low) * (1 - fraction) + gather(high) * fraction
        mean = grid.mean(dim=2, keepdim=True)
        grid = mean + (grid - mean) * (1.0 + SCALE * (2 * torch.rand(count, self.channels, 1, generator=generator) - 1))
        grid = grid + NOISE * self.std * torch.randn(grid.shape, generator=generator)
        return grid.reshape(count, -1)

    def fit(self, x: np.ndarray, y: np.ndarray, x_eval: np.ndarray | None = None, y_eval: np.ndarray | None = None, on_epoch: EpochCallback | None = None) -> "CnnModel":
        torch = self.torch
        data = torch.tensor(x, dtype=torch.float32)
        grid = data.reshape(-1, self.channels, self.steps)
        if self.centre:
            centred = grid - grid.mean(dim=2, keepdim=True)
        else:
            self.mean = grid.mean(dim=(0, 2), keepdim=True)
            centred = grid - self.mean
        self.std = centred.std(dim=(0, 2), keepdim=True).clamp_min(1e-6)
        eval_raw = None if x_eval is None else torch.tensor(x_eval, dtype=torch.float32)
        eval_target = None if y_eval is None else torch.tensor(y_eval, dtype=torch.long)

        def modes(training: bool) -> None:
            self.net.train(training)
            self.head.train(training)

        # The windows go in unscaled and are scaled on the way into the network, so the augmentation works in the
        # sensors' own units (a rotation of acceleration is only a rotation before each axis is scaled on its own).
        self._loop(
            [p for p in [*self.net.parameters(), *self.head.parameters()] if p.requires_grad], lambda raw: self._logits(self._scaled(raw)), data,
            torch.tensor(y, dtype=torch.long), self._augment if self.network.augment else None, eval_raw, eval_target,
            on_epoch, modes,
        )
        return self

    def fine_tune(self, x, y, x_eval, y_eval, on_epoch, network: Network, freeze_conv: set[int], freeze_dense: set[int], pins, sample_weights=None) -> None:
        """Carries on training from the weights it has: the scaling stays as it was, frozen layers do not move, pinned weights keep their values."""
        torch = self.torch
        data = torch.tensor(x, dtype=torch.float32)
        eval_raw = None if x_eval is None else torch.tensor(x_eval, dtype=torch.float32)
        eval_target = None if y_eval is None else torch.tensor(y_eval, dtype=torch.long)
        convs = [m for m in self.net if isinstance(m, torch.nn.Conv1d)]
        linears = [m for m in self.head if isinstance(m, torch.nn.Linear)]
        for index, module in enumerate(convs):
            for parameter in module.parameters():
                parameter.requires_grad_(index not in freeze_conv)
        for index, module in enumerate(linears):
            for parameter in module.parameters():
                parameter.requires_grad_(index not in freeze_dense)
        trainable = [p for p in [*self.net.parameters(), *self.head.parameters()] if p.requires_grad]
        if not trainable:
            raise ValueError("every layer is frozen, so there is nothing to train")

        def modes(training: bool) -> None:
            self.net.train(training)
            self.head.train(training)

        previous, self.network = self.network, network
        try:
            self._loop(trainable, lambda raw: self._logits(self._scaled(raw)), data, torch.tensor(y, dtype=torch.long),
                       self._augment if network.augment else None, eval_raw, eval_target, on_epoch, modes,
                       after_step=lambda: (_hold_pins(torch, self.net, pins, "net."), _hold_pins(torch, self.head, pins, "head.")),
                       sample_weights=None if sample_weights is None else torch.tensor(sample_weights, dtype=torch.float32))
        finally:
            self.network = previous
            for parameter in [*self.net.parameters(), *self.head.parameters()]:
                parameter.requires_grad_(True)

    def module(self):
        torch = self.torch
        outer = self

        class Wrapped(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.net, self.head = outer.net, outer.head
                self.register_buffer("mean", outer.mean)
                self.register_buffer("std", outer.std)

            def forward(self, flat):
                grid = flat.reshape(-1, outer.channels, outer.steps)
                grid = grid - (grid.mean(dim=2, keepdim=True) if outer.centre else self.mean)
                features = self.net(grid / self.std)
                return torch.softmax(self.head(outer._pool(features)), dim=1)

        return Wrapped().eval()

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.no_grad():
            return self.module()(torch.tensor(x, dtype=torch.float32)).numpy()
