"""A dense network has exactly the shape asked for: a designed shape, the older `params.hidden`, or no hidden layers at all."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from label_trainer import label_train as lt

from .test_label_train import spec_for


def test_the_older_params_hidden_is_used_when_no_design_gives_a_shape(tmp_path: Path) -> None:
    raw = spec_for(tmp_path, "mlp", params={"hidden": [12]})
    assert [layer.units for layer in lt.parse_spec(raw).network.hidden] == [12]


def test_a_designed_shape_wins_over_the_older_params_hidden(tmp_path: Path) -> None:
    raw = spec_for(tmp_path, "mlp", params={"hidden": [12]}, network={"hidden": [{"units": 6}, {"units": 3}]})
    assert [layer.units for layer in lt.parse_spec(raw).network.hidden] == [6, 3]


def test_a_malformed_params_hidden_is_refused_with_the_reason(tmp_path: Path) -> None:
    with pytest.raises(lt.TrainingRefused, match="params.hidden"):
        lt.parse_spec(spec_for(tmp_path, "mlp", params={"hidden": [0]}))


def test_no_hidden_layers_builds_a_network_with_none_rather_than_the_default(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, "mlp", network={"hidden": []}))
    assert spec.network.hidden == ()
    rng = np.random.default_rng(0)
    x = rng.normal(size=(60, 4))
    y = (x[:, 0] > 0).astype(int)
    model = lt.make_model("mlp", 4, 0, {}, spec.network).fit(x, y)
    # One weight matrix, inputs straight to the output: what the provenance says, not the 32-16 default.
    assert [w.shape for w in model.named_steps["model"].coefs_] == [(4, 1)]
