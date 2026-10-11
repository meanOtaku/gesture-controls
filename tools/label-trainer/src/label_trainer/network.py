"""The shape of a neural network, and how it is trained, as a person can set it.

`parse_network` turns the `network` part of a training spec into a checked `Network`; anything not given takes the default
for the method, which is exactly what the method used before these could be set. The limits here are the same as the
desktop's (`NetworkSpec` in `label_training.rs`): a network outside them is refused with the reason, and every operator
a choice here produces is one the desktop's runtime can run.

* A dense network (`mlp`, `torch-mlp`): `hidden` layers of `units` neurons each with an `activation`, then a layer that
  gives the two probabilities. (The scikit-learn network uses only the layer sizes; its activation is always ReLU.)
* A convolutional network (`cnn1d`): `conv` layers of `filters` filters each `kernel` steps wide, `pooling` over time, then
  any `hidden` dense layers and the output layer.
* `dropout` is the share of the last layer's inputs switched off while training (never when the model runs).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ACTIVATIONS = ("relu", "tanh", "sigmoid", "leaky_relu")
POOLINGS = ("mean_max", "mean", "max")

MAX_HIDDEN_LAYERS = 6
MAX_CONV_LAYERS = 4
MAX_UNITS = 512
MAX_FILTERS = 128
KERNELS = (3, 5, 7, 9, 11, 13, 15)
MAX_EPOCHS = 1000
MIN_EPOCHS = 5
MAX_BATCH = 256
MIN_LEARNING_RATE, MAX_LEARNING_RATE = 1e-4, 0.1


class NetworkRefused(ValueError):
    """The network settings are outside what can be trained or run."""


@dataclass(frozen=True)
class Layer:
    units: int
    activation: str = "relu"


@dataclass(frozen=True)
class Conv:
    filters: int
    kernel: int = 5
    activation: str = "relu"


@dataclass(frozen=True)
class Network:
    hidden: tuple[Layer, ...] = field(default_factory=tuple)
    conv: tuple[Conv, ...] = field(default_factory=tuple)
    pooling: str = "mean_max"
    dropout: float = 0.0
    learning_rate: float = 0.01
    epochs: int = 200
    batch_size: int = 0  # 0: the whole training set at once
    weight_decay: float = 0.0
    balance_classes: bool = True
    augment: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "hidden": [{"units": layer.units, "activation": layer.activation} for layer in self.hidden],
            "conv": [{"filters": c.filters, "kernel": c.kernel, "activation": c.activation} for c in self.conv],
            "pooling": self.pooling,
            "dropout": self.dropout,
            "learningRate": self.learning_rate,
            "epochs": self.epochs,
            "batchSize": self.batch_size,
            "weightDecay": self.weight_decay,
            "balanceClasses": self.balance_classes,
            "augment": self.augment,
        }


def default_network(backend: str) -> Network:
    """What each method trained with before it could be set."""
    if backend == "cnn1d":
        return Network(
            hidden=(), conv=(Conv(16, 5), Conv(16, 5)), pooling="mean_max", dropout=0.2,
            learning_rate=3e-3, epochs=80, batch_size=64, weight_decay=1e-3, balance_classes=True, augment=True,
        )
    if backend == "mlp":
        return Network(hidden=(Layer(32), Layer(16)), epochs=600)
    return Network(hidden=(Layer(32), Layer(16)))  # torch-mlp


def _number(raw: dict[str, Any], key: str, kind: type, low: float, high: float, default: float):
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NetworkRefused(f"{key} must be a number")
    value = kind(value)
    if not low <= value <= high:
        raise NetworkRefused(f"{key} must be from {low:g} to {high:g}, got {value:g}")
    return value


def _activation(name: Any) -> str:
    if name not in ACTIVATIONS:
        raise NetworkRefused(f"unknown activation {name!r}; choose from {list(ACTIVATIONS)}")
    return name


def parse_network(raw: dict[str, Any] | None, backend: str) -> Network:
    base = default_network(backend)
    if not raw:
        return base
    if not isinstance(raw, dict):
        raise NetworkRefused("the network settings must be an object")
    hidden = base.hidden
    if raw.get("hidden") is not None:
        layers = raw["hidden"]
        if not isinstance(layers, list) or len(layers) > MAX_HIDDEN_LAYERS:
            raise NetworkRefused(f"a network has at most {MAX_HIDDEN_LAYERS} hidden layers")
        hidden = tuple(
            Layer(_number(layer, "units", int, 1, MAX_UNITS, 1), _activation(layer.get("activation", "relu")))
            for layer in layers
        )
    conv = base.conv
    if raw.get("conv") is not None:
        if backend != "cnn1d":
            raise NetworkRefused("convolution layers only apply to the convolutional method")
        layers = raw["conv"]
        if not isinstance(layers, list) or not 1 <= len(layers) <= MAX_CONV_LAYERS:
            raise NetworkRefused(f"a convolutional network has from 1 to {MAX_CONV_LAYERS} convolution layers")
        parsed = []
        for layer in layers:
            kernel = _number(layer, "kernel", int, 3, 15, 5)
            if kernel not in KERNELS:
                raise NetworkRefused(f"a kernel must be an odd width from 3 to 15, got {kernel}")
            parsed.append(Conv(_number(layer, "filters", int, 1, MAX_FILTERS, 16), kernel, _activation(layer.get("activation", "relu"))))
        conv = tuple(parsed)
    pooling = raw.get("pooling", base.pooling)
    if pooling not in POOLINGS:
        raise NetworkRefused(f"unknown pooling {pooling!r}; choose from {list(POOLINGS)}")
    return Network(
        hidden=hidden,
        conv=conv,
        pooling=pooling,
        dropout=_number(raw, "dropout", float, 0.0, 0.7, base.dropout),
        learning_rate=_number(raw, "learningRate", float, MIN_LEARNING_RATE, MAX_LEARNING_RATE, base.learning_rate),
        epochs=_number(raw, "epochs", int, MIN_EPOCHS, MAX_EPOCHS, base.epochs),
        batch_size=_number(raw, "batchSize", int, 0, MAX_BATCH, base.batch_size),
        weight_decay=_number(raw, "weightDecay", float, 0.0, 0.1, base.weight_decay),
        balance_classes=bool(raw.get("balanceClasses", base.balance_classes)),
        augment=bool(raw.get("augment", base.augment)),
    )


def parameter_count(network: Network, inputs: int, backend: str, steps: int = 0) -> int:
    """How many numbers the network learns: every weight and bias, counted layer by layer."""
    total, width = 0, inputs
    if backend == "cnn1d":
        channels = inputs
        for layer in network.conv:
            total += layer.filters * channels * layer.kernel + layer.filters
            channels = layer.filters
        width = channels * (2 if network.pooling == "mean_max" else 1)
    for layer in network.hidden:
        total += width * layer.units + layer.units
        width = layer.units
    return total + width * 2 + 2
