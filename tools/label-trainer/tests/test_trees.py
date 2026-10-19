"""The tree-ensemble model file: it must give the trained model's answers, and refuse anything malformed."""

from __future__ import annotations

import numpy as np
import pytest
from sklearn.ensemble import ExtraTreesClassifier

from label_trainer import trees


def _model(features: int = 40):
    rng = np.random.default_rng(0)
    x = rng.normal(size=(600, features))
    y = (x[:, 3] + 0.5 * x[:, 7] + rng.normal(scale=0.5, size=600) > 0).astype(int)
    return ExtraTreesClassifier(n_estimators=50, min_samples_leaf=3, max_features=0.7, random_state=17).fit(x, y), rng


def test_the_file_gives_the_models_probabilities() -> None:
    model, rng = _model()
    data = trees.to_bytes(model, 40)
    x = rng.normal(size=(300, 40))
    assert np.abs(trees.predict(data, x) - model.predict_proba(x)[:, 1]).max() < 1e-6
    features, read = trees.read(data)
    assert features == 40 and len(read) == 50


def test_a_value_is_compared_in_single_precision() -> None:
    model, rng = _model()
    data = trees.to_bytes(model, 40)
    x = rng.normal(size=(50, 40))
    # scikit-learn rounds the inputs to float32 before comparing; so does the file's reader.
    assert np.array_equal(trees.predict(data, x), trees.predict(data, x.astype(np.float32)))


def test_broken_files_are_refused() -> None:
    model, _ = _model()
    data = trees.to_bytes(model, 40)
    with pytest.raises(ValueError, match="not a trees file"):
        trees.read(b"ONNX" + data[4:])
    with pytest.raises(ValueError, match="after its last tree"):
        trees.read(data + b"\0")
    with pytest.raises(ValueError, match="reads 40 features"):
        trees.predict(data, np.zeros((1, 39)))
