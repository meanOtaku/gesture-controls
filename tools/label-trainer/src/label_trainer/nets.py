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
    layers, and one layer that gives the two probabilities. While training, windows are (with `augment`) shifted a little
    in time, scaled a little and given a little noise, so the few windows of a few recordings are not simply memorised.
    """

    def __init__(self, channels: int, steps: int, seed: int, params: dict[str, Any], centre_windows: bool, network: Network | None = None):
        import torch

        torch.manual_seed(seed)
        self.torch, self.seed = torch, seed
        self.network = network or default_network("cnn1d")
        self.channels, self.steps, self.centre = channels, steps, centre_windows
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

    def _augment(self, batch, generator):
        torch = self.torch
        shifts = torch.randint(-2, 3, (batch.shape[0],), generator=generator)
        batch = torch.stack([torch.roll(row, int(shift), dims=1) for row, shift in zip(batch, shifts)])
        batch = batch * (0.9 + 0.2 * torch.rand(batch.shape[0], batch.shape[1], 1, generator=generator))
        return batch + 0.05 * torch.randn(batch.shape, generator=generator)

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
        eval_scaled = None if x_eval is None else self._scaled(torch.tensor(x_eval, dtype=torch.float32))
        eval_target = None if y_eval is None else torch.tensor(y_eval, dtype=torch.long)

        def modes(training: bool) -> None:
            self.net.train(training)
            self.head.train(training)

        self._loop(
            [*self.net.parameters(), *self.head.parameters()], self._logits, self._scaled(data), torch.tensor(y, dtype=torch.long),
            self._augment if self.network.augment else None, eval_scaled, eval_target, on_epoch, modes,
        )
        return self

    def fine_tune(self, x, y, x_eval, y_eval, on_epoch, network: Network, freeze_conv: set[int], freeze_dense: set[int], pins, sample_weights=None) -> None:
        """Carries on training from the weights it has: the scaling stays as it was, frozen layers do not move, pinned weights keep their values."""
        torch = self.torch
        data = torch.tensor(x, dtype=torch.float32)
        eval_scaled = None if x_eval is None else self._scaled(torch.tensor(x_eval, dtype=torch.float32))
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
            self._loop(trainable, self._logits, self._scaled(data), torch.tensor(y, dtype=torch.long),
                       self._augment if network.augment else None, eval_scaled, eval_target, on_epoch, modes,
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
