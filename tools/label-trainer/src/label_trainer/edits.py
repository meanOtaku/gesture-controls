"""Editing a trained model by hand: switch an input off, set a weight or a bias, silence a neuron or a filter.

An edit is applied to the model's own parameters, and the result is exported, re-evaluated on the same held-out windows
and shipped as a new Draft that says which model it came from and what was changed, exactly like a freshly trained one:
nothing about an edited model is trusted until it has been scored. The original model is never touched.

Edits are plain dictionaries (they come from the desktop as JSON):

* `{"kind": "disableInput", "input": "accel_x_std"}`: the model stops using that input (a convolutional model: that channel).
* `{"kind": "setWeight", "layer": 0, "row": 3, "column": 5, "value": 0.2}`: one weight of a dense layer. Layers are counted
  from the first dense layer; the last one is the layer that gives the probability. `row` is the input, `column` the neuron.
* `{"kind": "setBias", "layer": 0, "neuron": 5, "value": 0.1}`
* `{"kind": "setFilterWeight", "layer": 0, "filter": 2, "channel": 1, "tap": 3, "value": -0.4}`: one weight of a convolution filter.
* `{"kind": "silenceNeuron", "layer": 0, "neuron": 5}`: a hidden neuron (or a filter, with `"conv": true`) whose output nothing downstream
  listens to any more.
"""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any

import numpy as np

MAX_EDITS = 200
KINDS = ("disableInput", "setWeight", "setBias", "setFilterWeight", "silenceNeuron")


class EditRefused(ValueError):
    """An edit does not fit the model (an index out of range, an unknown kind)."""


# ---- saving and restoring a trained model, so it can be edited later --------------------------------------------------

def persist_model(spec, model, out: Path) -> None:
    """Writes the model's parameters next to its results (`model.pkl` for scikit-learn, `model.pt` for PyTorch)."""
    if spec.backend in ("logreg", "mlp"):
        (out / "model.pkl").write_bytes(pickle.dumps(model))
        return
    import torch

    state: dict[str, Any] = {"mean": model.mean, "std": model.std}
    if spec.backend == "torch-mlp":
        state["net"] = model.net.state_dict()
    else:
        state["net"], state["head"] = model.net.state_dict(), model.head.state_dict()
    torch.save(state, out / "model.pt")


def restore_model(spec, directory: Path):
    """The trained model of a run, from what `persist_model` wrote there."""
    if spec.backend in ("logreg", "mlp"):
        path = directory / "model.pkl"
        if not path.is_file():
            raise EditRefused("this model's parameters were not saved, so it cannot be edited (train it again)")
        return pickle.loads(path.read_bytes())
    import torch

    from .nets import CnnModel, TorchModel

    path = directory / "model.pt"
    if not path.is_file():
        raise EditRefused("this model's parameters were not saved, so it cannot be edited (train it again)")
    state = torch.load(path, weights_only=True)
    if spec.backend == "torch-mlp":
        model = TorchModel(len(spec.features), spec.seed, spec.params, spec.network)
        model.net.load_state_dict(state["net"])
    else:
        model = CnnModel(len(spec.features), spec.grid_steps, spec.seed, spec.params, spec.movement_only, spec.network)
        model.net.load_state_dict(state["net"])
        model.head.load_state_dict(state["head"])
    model.mean, model.std = state["mean"], state["std"]
    model.net.eval()
    if hasattr(model, "head"):
        model.head.eval()
    return model


# ---- the parameters, as numpy views a person's edit can change ------------------------------------------------------------

class _Params:
    """Dense layers as (inputs, outputs) matrices and biases, and convolution filters as (filters, channels, taps), whatever the backend."""

    def __init__(self, spec, model):
        self.spec, self.model = spec, model
        backend = spec.backend
        self.dense: list[tuple[np.ndarray, np.ndarray]] = []
        self.conv: list[np.ndarray] = []
        self.conv_bias: list[np.ndarray] = []
        if backend == "logreg":
            final = model.named_steps["model"]
            self.dense = [(final.coef_.T.copy(), final.intercept_.copy())]
        elif backend == "mlp":
            final = model.named_steps["model"]
            self.dense = [(w.copy(), b.copy()) for w, b in zip(final.coefs_, final.intercepts_)]
        else:
            import torch

            linears = [m for m in (model.net if backend == "torch-mlp" else model.head) if isinstance(m, torch.nn.Linear)]
            self._linears = linears
            self.dense = [(m.weight.detach().numpy().T.copy(), m.bias.detach().numpy().copy()) for m in linears]
            if backend == "cnn1d":
                convs = [m for m in model.net if isinstance(m, torch.nn.Conv1d)]
                self._convs = convs
                self.conv = [m.weight.detach().numpy().copy() for m in convs]
                self.conv_bias = [m.bias.detach().numpy().copy() for m in convs]

    def commit(self) -> None:
        """Writes the (changed) arrays back into the model."""
        backend = self.spec.backend
        if backend == "logreg":
            final = self.model.named_steps["model"]
            final.coef_ = self.dense[0][0].T.copy()
            final.intercept_ = self.dense[0][1].copy()
        elif backend == "mlp":
            final = self.model.named_steps["model"]
            final.coefs_ = [w.copy() for w, _ in self.dense]
            final.intercepts_ = [b.copy() for _, b in self.dense]
        else:
            import torch

            for module, (w, b) in zip(self._linears, self.dense):
                module.weight.data = torch.tensor(w.T.copy(), dtype=module.weight.dtype)
                module.bias.data = torch.tensor(b.copy(), dtype=module.bias.dtype)
            for module, w, b in zip(getattr(self, "_convs", []), self.conv, self.conv_bias):
                module.weight.data = torch.tensor(w.copy(), dtype=module.weight.dtype)
                module.bias.data = torch.tensor(b.copy(), dtype=module.bias.dtype)


def _int(edit: dict[str, Any], key: str, low: int, high: int, number: int) -> int:
    value = edit.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value < high:
        raise EditRefused(f"edit {number}: {key} must be a whole number from {low} to {high - 1}")
    return value


def _value(edit: dict[str, Any], number: int) -> float:
    value = edit.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or abs(value) > 1e4:
        raise EditRefused(f"edit {number}: value must be a finite number")
    return float(value)


def apply_edits(spec, model, edits: list[dict[str, Any]]) -> list[str]:
    """Changes the model as asked and says, in words, what was done. Refuses an edit that does not fit, changing nothing."""
    if not isinstance(edits, list) or not edits:
        raise EditRefused("there is nothing to change")
    if len(edits) > MAX_EDITS:
        raise EditRefused(f"at most {MAX_EDITS} edits at a time")
    params = _Params(spec, model)
    convolutional = spec.backend == "cnn1d"
    said: list[str] = []
    for number, edit in enumerate(edits, start=1):
        kind = edit.get("kind") if isinstance(edit, dict) else None
        if kind not in KINDS:
            raise EditRefused(f"edit {number}: unknown kind {kind!r}; choose from {list(KINDS)}")
        if kind == "disableInput":
            name = edit.get("input")
            if name not in spec.features:
                raise EditRefused(f"edit {number}: the model has no input {name!r}")
            index = spec.features.index(name)
            if convolutional:
                params.conv[0][:, index, :] = 0.0
            else:
                params.dense[0][0][index, :] = 0.0
            said.append(f"switched off {name}")
        elif kind == "setWeight":
            layer = _int(edit, "layer", 0, len(params.dense), number)
            weights, _ = params.dense[layer]
            row, column = _int(edit, "row", 0, weights.shape[0], number), _int(edit, "column", 0, weights.shape[1], number)
            old, weights[row, column] = float(weights[row, column]), _value(edit, number)
            said.append(f"set the weight from {row + 1} to {column + 1} in dense layer {layer + 1} from {old:.4g} to {weights[row, column]:.4g}")
        elif kind == "setBias":
            layer = _int(edit, "layer", 0, len(params.dense), number)
            bias = params.dense[layer][1]
            neuron = _int(edit, "neuron", 0, bias.shape[0], number)
            old, bias[neuron] = float(bias[neuron]), _value(edit, number)
            said.append(f"set the bias of neuron {neuron + 1} in dense layer {layer + 1} from {old:.4g} to {bias[neuron]:.4g}")
        elif kind == "setFilterWeight":
            if not convolutional:
                raise EditRefused(f"edit {number}: only a convolutional model has filters")
            layer = _int(edit, "layer", 0, len(params.conv), number)
            filters = params.conv[layer]
            f, c, k = _int(edit, "filter", 0, filters.shape[0], number), _int(edit, "channel", 0, filters.shape[1], number), _int(edit, "tap", 0, filters.shape[2], number)
            old, filters[f, c, k] = float(filters[f, c, k]), _value(edit, number)
            said.append(f"set tap {k + 1} of filter {f + 1}, channel {c + 1}, convolution layer {layer + 1} from {old:.4g} to {filters[f, c, k]:.4g}")
        else:  # silenceNeuron
            if edit.get("conv"):
                if not convolutional:
                    raise EditRefused(f"edit {number}: only a convolutional model has filters")
                layer = _int(edit, "layer", 0, len(params.conv), number)
                f = _int(edit, "neuron", 0, params.conv[layer].shape[0], number)
                if layer + 1 < len(params.conv):
                    params.conv[layer + 1][:, f, :] = 0.0
                else:
                    first = params.dense[0][0]
                    filters_in_last = params.conv[layer].shape[0]
                    rows = [f, f + filters_in_last] if spec.network.pooling == "mean_max" else [f]
                    for row in rows:
                        first[row, :] = 0.0
                said.append(f"silenced filter {f + 1} of convolution layer {layer + 1}")
            else:
                layer = _int(edit, "layer", 0, len(params.dense) - 1, number)  # the last layer has no neuron to silence: it is the answer
                neuron = _int(edit, "neuron", 0, params.dense[layer][1].shape[0], number)
                params.dense[layer + 1][0][neuron, :] = 0.0
                said.append(f"silenced neuron {neuron + 1} of dense layer {layer + 1}")
    params.commit()
    return said
