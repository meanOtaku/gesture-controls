"""What is inside a trained model, for a person to look at: its inputs, weights, what it does with real windows, and what matters.

`build_inspection` writes everything the desktop's Inspect view shows into one JSON document, so the view needs neither
Python nor the training data:

* the **inputs**: each one's name, and the average and spread the model scales it by;
* the **network**: every layer's weights and biases (convolution filters, dense layers, the output layer);
* **importance**: for each input, how much the held-out ROC AUC falls when that input is shuffled between windows;
* a few **windows** from the held-out recordings, chosen to show what the model gets right and wrong (the clearest true
  positives, the missed ones, the clearest true negatives, the false alarms): the value each input took, what every layer
  produced, and how much each input (or, for a convolutional model, each stretch of each channel) moved the answer;
* the model's **scores** on every held-out window, with the recording each came from, for the charts of how well it works.

The numbers are computed here with a plain numpy forward pass over the extracted weights, which is checked against the
model itself (`forwardMaxAbsDifference`), so what the view shows is what the model computes. Everything is on windows from
recordings the model never trained on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

INSPECTION_VERSION = 1
SAMPLE_PER_CATEGORY = 4
PERMUTATION_REPEATS = 5
OCCLUSION_STEPS = 4  # a stretch of a channel this many steps wide is hidden at a time (convolutional models)
FORWARD_TOLERANCE = 1e-3


def _activation(name: str | None, z: np.ndarray) -> np.ndarray:
    if name in (None, "identity"):
        return z
    if name == "relu":
        return np.maximum(z, 0.0)
    if name == "tanh":
        return np.tanh(z)
    if name == "sigmoid":
        return 1.0 / (1.0 + np.exp(-z))
    if name == "leaky_relu":
        return np.where(z >= 0, z, 0.01 * z)
    raise ValueError(f"unknown activation {name!r}")


@dataclass
class Dense:
    weights: np.ndarray  # (in, out)
    bias: np.ndarray  # (out,)
    activation: str | None = None


@dataclass
class Conv:
    weights: np.ndarray  # (filters, channels, kernel)
    bias: np.ndarray  # (filters,)
    activation: str | None = "relu"


@dataclass
class Extracted:
    """A model's parameters, whatever trained it."""

    names: list[str]  # the inputs (statistics), or the channels
    mean: np.ndarray  # (n,) or (channels,)
    std: np.ndarray
    dense: list[Dense] = field(default_factory=list)  # hidden layers
    output: Dense = None  # type: ignore[assignment]  # the layer that gives the probability (1 or 2 outputs)
    conv: list[Conv] = field(default_factory=list)
    pooling: str = "mean_max"
    centre: bool = False
    steps: int = 0  # >0 for a convolutional model
    columns_steps: int = 0  # >0 for a dense model reading raw columns: every column at every one of this many steps

    @property
    def convolutional(self) -> bool:
        return self.steps > 0

    @property
    def grouped_steps(self) -> int:
        """The steps per channel when the inputs are channels over steps (convolutional, or raw columns), else 0."""
        return self.steps or self.columns_steps


def _activation_name(module: Any) -> str | None:
    kind = type(module).__name__
    return {"ReLU": "relu", "Tanh": "tanh", "Sigmoid": "sigmoid", "LeakyReLU": "leaky_relu"}.get(kind)


def extract(spec, model) -> Extracted:
    """Pulls the weights out of a trained model of any of the methods."""
    extracted = _extract(spec, model)
    if getattr(spec, "raw_columns", False) and spec.backend != "cnn1d":
        extracted.columns_steps = int(spec.grid_steps)
    return extracted


def _extract(spec, model) -> Extracted:
    backend = spec.backend
    names = list(spec.features)
    if backend == "logreg":
        scaler, final = model.named_steps["scale"], model.named_steps["model"]
        return Extracted(names, scaler.mean_.astype(np.float64), scaler.scale_.astype(np.float64), output=Dense(final.coef_.T.astype(np.float64), final.intercept_.astype(np.float64)))
    if backend == "mlp":
        scaler, final = model.named_steps["scale"], model.named_steps["model"]
        hidden = [Dense(w.astype(np.float64), b.astype(np.float64), "relu") for w, b in zip(final.coefs_[:-1], final.intercepts_[:-1])]
        return Extracted(names, scaler.mean_.astype(np.float64), scaler.scale_.astype(np.float64), dense=hidden, output=Dense(final.coefs_[-1].astype(np.float64), final.intercepts_[-1].astype(np.float64)))
    import torch

    def dense_layers(sequential) -> tuple[list[Dense], Dense]:
        layers: list[Dense] = []
        for module in sequential:
            if isinstance(module, torch.nn.Linear):
                layers.append(Dense(module.weight.detach().numpy().T.astype(np.float64), module.bias.detach().numpy().astype(np.float64)))
            elif (name := _activation_name(module)) and layers:
                layers[-1].activation = name
        return layers[:-1], layers[-1]

    if backend == "torch-mlp":
        hidden, output = dense_layers(model.net)
        return Extracted(names, model.mean.numpy().astype(np.float64), model.std.numpy().astype(np.float64), dense=hidden, output=output)
    if backend == "cnn1d":
        convolutions: list[Conv] = []
        for module in model.net:
            if isinstance(module, torch.nn.Conv1d):
                convolutions.append(Conv(module.weight.detach().numpy().astype(np.float64), module.bias.detach().numpy().astype(np.float64), None))
            elif (name := _activation_name(module)) and convolutions:
                convolutions[-1].activation = name
        hidden, output = dense_layers(model.head)
        return Extracted(
            names, model.mean.numpy().reshape(-1).astype(np.float64), model.std.numpy().reshape(-1).astype(np.float64),
            dense=hidden, output=output, conv=convolutions, pooling=model.network.pooling, centre=bool(model.centre), steps=int(model.steps),
        )
    raise ValueError(f"cannot inspect the {backend} method")


def _conv1d(x: np.ndarray, layer: Conv) -> np.ndarray:
    filters, _, kernel = layer.weights.shape
    n, _, steps = x.shape
    padded = np.pad(x, ((0, 0), (0, 0), (kernel // 2, kernel // 2)))
    out = np.zeros((n, filters, steps))
    for k in range(kernel):
        out += np.einsum("nct,fc->nft", padded[:, :, k : k + steps], layer.weights[:, :, k])
    return out + layer.bias[None, :, None]


def forward(p: Extracted, x: np.ndarray, keep: bool = False) -> tuple[np.ndarray, list[np.ndarray]]:
    """The probability of the label for each row of `x` (raw inputs, as the model is given them), and, with `keep`, what each layer produced."""
    x = np.asarray(x, dtype=np.float64)
    layers: list[np.ndarray] = []
    if p.convolutional:
        n = x.shape[0]
        channels = len(p.names)
        grid = x.reshape(n, channels, p.steps)
        grid = grid - (grid.mean(axis=2, keepdims=True) if p.centre else p.mean[None, :, None])
        a = grid / p.std[None, :, None]
        for layer in p.conv:
            a = _activation(layer.activation, _conv1d(a, layer))
            layers.append(a)
        mean, high = a.mean(axis=2), a.max(axis=2)
        a = {"mean": mean, "max": high}.get(p.pooling, np.concatenate([mean, high], axis=1))
        layers.append(a)
    else:
        a = (x - p.mean) / p.std
    for layer in p.dense:
        a = _activation(layer.activation, a @ layer.weights + layer.bias)
        layers.append(a)
    z = a @ p.output.weights + p.output.bias
    probability = 1.0 / (1.0 + np.exp(-z[:, 0])) if z.shape[1] == 1 else 1.0 / (1.0 + np.exp(-(z[:, 1] - z[:, 0])))
    return probability, layers if keep else []


def _round(array: np.ndarray, digits: int = 6) -> list:
    return np.round(np.asarray(array, dtype=np.float64), digits).tolist()


def _auc(y: np.ndarray, probability: np.ndarray) -> float:
    from sklearn.metrics import roc_auc_score

    return float(roc_auc_score(y, probability))


def permutation_importance(p: Extracted, model, x: np.ndarray, y: np.ndarray, seed: int) -> list[dict[str, Any]]:
    """How far the ROC AUC falls when one input is shuffled between windows (its channel, for a convolutional model)."""
    rng = np.random.default_rng(seed)
    base = _auc(y, model.predict_proba(x)[:, 1])
    out = []
    for index, name in enumerate(p.names):
        drops = []
        for _ in range(PERMUTATION_REPEATS):
            shuffled = x.copy()
            order = rng.permutation(x.shape[0])
            if p.grouped_steps:
                grid = shuffled.reshape(x.shape[0], len(p.names), p.grouped_steps)
                grid[:, index, :] = grid[order, index, :]
                shuffled = grid.reshape(x.shape[0], -1)
            else:
                shuffled[:, index] = shuffled[order, index]
            drops.append(base - _auc(y, model.predict_proba(shuffled)[:, 1]))
        out.append({"name": name, "aucDrop": float(np.mean(drops)), "aucDropStd": float(np.std(drops))})
    return out


def _input_rows(p: Extracted) -> list[dict[str, Any]]:
    """One row per input; for raw columns, one per column, with the average and spread of its neurons and how many it has."""
    if p.columns_steps:
        steps = p.columns_steps
        return [
            {"name": name, "mean": float(np.mean(p.mean[i * steps : (i + 1) * steps])), "std": float(np.mean(p.std[i * steps : (i + 1) * steps])), "neurons": steps}
            for i, name in enumerate(p.names)
        ]
    return [{"name": name, "mean": float(p.mean[i]), "std": float(p.std[i])} for i, name in enumerate(p.names)]


def _category(label: int, probability: float, threshold: float) -> str:
    if label == 1:
        return "truePositive" if probability >= threshold else "falseNegative"
    return "falsePositive" if probability >= threshold else "trueNegative"


def _pick(y: np.ndarray, probability: np.ndarray, threshold: float) -> list[tuple[int, str]]:
    """Windows that show what the model gets right and wrong: the clearest of each kind."""
    chosen: list[tuple[int, str]] = []
    order = np.argsort(probability)
    wanted = {
        "truePositive": lambda i: y[i] == 1 and probability[i] >= threshold,
        "falseNegative": lambda i: y[i] == 1 and probability[i] < threshold,
        "trueNegative": lambda i: y[i] == 0 and probability[i] < threshold,
        "falsePositive": lambda i: y[i] == 0 and probability[i] >= threshold,
    }
    for category, test in wanted.items():
        # Clearest first: the highest scores for what it called the gesture, the lowest for what it did not.
        candidates = [int(i) for i in (order[::-1] if category in ("truePositive", "falsePositive") else order) if test(int(i))]
        chosen += [(i, category) for i in candidates[:SAMPLE_PER_CATEGORY]]
    return chosen


def _window_view(p: Extracted, x: np.ndarray, index: int, probability: float) -> dict[str, Any]:
    row = x[index : index + 1]
    _, layers = forward(p, row, keep=True)
    view: dict[str, Any] = {
        "values": _round(row[0], 5),
        "activations": [_round(layer[0], 5) for layer in layers],
    }
    if p.columns_steps:
        # How much the answer falls when one column (at every step) takes the value it has on average in the training windows.
        steps = p.columns_steps
        variants = np.repeat(row, len(p.names), axis=0)
        for c in range(len(p.names)):
            variants[c, c * steps : (c + 1) * steps] = p.mean[c * steps : (c + 1) * steps]
        view["contributions"] = _round(probability - forward(p, variants)[0], 5)
    elif p.convolutional:
        # How much the answer falls when a stretch of one channel is replaced by that channel's own average.
        channels, steps, width = len(p.names), p.steps, OCCLUSION_STEPS
        grid = row.reshape(channels, steps)
        blocks = (steps + width - 1) // width
        variants = []
        for c in range(channels):
            for b in range(blocks):
                changed = grid.copy()
                changed[c, b * width : (b + 1) * width] = grid[c].mean()
                variants.append(changed.reshape(-1))
        drop = probability - forward(p, np.array(variants))[0]
        view["occlusion"] = {"blockSteps": width, "drop": _round(drop.reshape(channels, blocks), 5)}
    else:
        # How much the answer falls when one input takes the value it has on average in the training windows.
        variants = np.repeat(row, len(p.names), axis=0)
        for j in range(len(p.names)):
            variants[j, j] = p.mean[j]
        view["contributions"] = _round(probability - forward(p, variants)[0], 5)
    return view


def build_inspection(spec, model, x_eval: np.ndarray, y_eval: np.ndarray, eval_windows: list[dict[str, Any]], curve: list[dict[str, Any]], metrics: dict[str, Any], parameters: int | None) -> dict[str, Any] | None:
    """Everything the Inspect view shows, or None if the numpy forward pass does not agree with the model."""
    p = extract(spec, model)
    reference = model.predict_proba(x_eval)[:, 1]
    probability, _ = forward(p, x_eval)
    gap = float(np.max(np.abs(probability - reference))) if reference.size else 0.0
    if gap > FORWARD_TOLERANCE:
        return None
    threshold = float(metrics["activationThreshold"])
    windows = []
    for index, category in _pick(y_eval, probability, threshold):
        meta = eval_windows[index]
        windows.append({"category": category, "recording": meta["recording"], "startNs": meta["startNs"], "label": meta["label"], "target": int(y_eval[index]), "probability": float(probability[index]), **_window_view(p, x_eval, index, float(probability[index]))})
    network: dict[str, Any] = {
        "kind": "conv" if p.convolutional else "dense" if p.dense else "linear",
        "conv": [{"filters": int(c.weights.shape[0]), "kernel": int(c.weights.shape[2]), "activation": c.activation, "weights": _round(c.weights), "bias": _round(c.bias)} for c in p.conv],
        "pooling": p.pooling if p.convolutional else None,
        "dense": [{"units": int(d.weights.shape[1]), "activation": d.activation, "weights": _round(d.weights), "bias": _round(d.bias)} for d in p.dense],
        "output": {"outputs": int(p.output.weights.shape[1]), "weights": _round(p.output.weights), "bias": _round(p.output.bias)},
    }
    return {
        "version": INSPECTION_VERSION,
        "backend": spec.backend,
        "target": spec.target,
        "inputKind": "channels" if p.convolutional else "columns" if p.columns_steps else "features",
        "gridSteps": p.grouped_steps or None,
        "centreWindows": p.centre,
        "spikeMethod": spec.spike_method,
        "inputs": _input_rows(p),
        "network": network,
        "parameters": parameters,
        "importance": permutation_importance(p, model, x_eval, y_eval, spec.seed),
        "windows": windows,
        "curve": curve,
        "evaluation": {
            "threshold": threshold,
            "recordings": [meta["recording"] for meta in eval_windows],
            "labels": [int(v) for v in y_eval],
            "probabilities": _round(probability, 4),
            "metrics": metrics,
        },
        "forwardMaxAbsDifference": gap,
    }
