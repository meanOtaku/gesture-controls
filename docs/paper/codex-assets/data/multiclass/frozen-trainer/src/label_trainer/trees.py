"""The model file of a tree ensemble: `model.trees`, read by `crates/label-inference/src/trees.rs`.

ONNX cannot carry the model the app trains: the runtime (tract) has no tree-ensemble operator, and writing hundreds of deep
trees as matrix arithmetic (as boosted trees once were) needs gigabytes. So the trees are written as plain data, which is
all a bundle may hold, and the runtime walks them.

Little-endian:

    b"PPGTREES"  u32 version (1)  u32 features  u32 trees
    per tree:    u32 nodes, then per node: i32 feature (-1 for a leaf)  f64 threshold  u32 left  u32 right  f32 probability

A sample goes left at a node when its feature, rounded to single precision, is at most the threshold (as scikit-learn
compares). The probability of the positive class is the mean, over the trees, of the leaf each reaches.
"""

from __future__ import annotations

import struct

import numpy as np

MAGIC = b"PPGTREES"
VERSION = 1
NODE = struct.Struct("<idIIf")


def to_bytes(model, n_features: int) -> bytes:
    """A fitted two-class scikit-learn forest (ExtraTreesClassifier, RandomForestClassifier) as a `model.trees` file."""
    if list(model.classes_) != [0, 1]:
        raise ValueError(f"the model must have classes [0, 1], not {list(model.classes_)}")
    parts = [MAGIC, struct.pack("<III", VERSION, n_features, len(model.estimators_))]
    for estimator in model.estimators_:
        tree = estimator.tree_
        values = tree.value[:, 0, :]
        totals = values.sum(axis=1)
        probability = np.where(totals > 0, values[:, 1] / np.where(totals > 0, totals, 1), 0.0)
        parts.append(struct.pack("<I", tree.node_count))
        for node in range(tree.node_count):
            leaf = tree.children_left[node] == -1
            parts.append(NODE.pack(
                -1 if leaf else int(tree.feature[node]),
                0.0 if leaf else float(tree.threshold[node]),
                0 if leaf else int(tree.children_left[node]),
                0 if leaf else int(tree.children_right[node]),
                float(probability[node]) if leaf else 0.0,
            ))
    return b"".join(parts)


def read(data: bytes) -> tuple[int, list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]]]:
    """(features, trees): each tree as arrays of feature, threshold, left, right and probability."""
    if data[:8] != MAGIC:
        raise ValueError("not a trees file")
    version, n_features, n_trees = struct.unpack_from("<III", data, 8)
    if version != VERSION:
        raise ValueError(f"trees file version {version} is not {VERSION}")
    offset, trees = 20, []
    for _ in range(n_trees):
        (count,) = struct.unpack_from("<I", data, offset)
        offset += 4
        nodes = np.frombuffer(data, dtype=np.dtype([("f", "<i4"), ("t", "<f8"), ("l", "<u4"), ("r", "<u4"), ("p", "<f4")]), count=count, offset=offset)
        offset += count * NODE.size
        trees.append((nodes["f"].copy(), nodes["t"].copy(), nodes["l"].copy(), nodes["r"].copy(), nodes["p"].astype(np.float64)))
    if offset != len(data):
        raise ValueError("the trees file has bytes after its last tree")
    return n_features, trees


def predict(data: bytes, x: np.ndarray) -> np.ndarray:
    """The positive class's probability for each row of `x`, as the runtime computes it from the file."""
    n_features, trees = read(data)
    x = np.asarray(x, dtype=np.float32).astype(np.float64)
    if x.shape[1] != n_features:
        raise ValueError(f"the model reads {n_features} features, not {x.shape[1]}")
    total = np.zeros(x.shape[0])
    rows = np.arange(x.shape[0])
    for feature, threshold, left, right, probability in trees:
        node = np.zeros(x.shape[0], dtype=np.int64)
        while True:
            internal = feature[node] >= 0
            if not internal.any():
                break
            at = node[internal]
            goes_left = x[rows[internal], feature[at]] <= threshold[at]
            node[internal] = np.where(goes_left, left[at], right[at])
        total += probability[node]
    return total / len(trees)
