"""Trains one binary model for one label and writes a bundle the desktop can import.

The desktop owns the decisions that must be recorded and cannot change afterwards, so this script does not make them:
which recordings train and which evaluate (never the same one), what each label in the data means (the target is
positive, everything else is negative or excluded), the streams the model may read, and the window. It receives them in
a `spec.json`, trains, evaluates on the held-out recordings, exports ONNX, checks the ONNX file reproduces the trained
model, and writes:

    <out>/bundle/manifest.json   what the desktop's bundle validator reads
    <out>/bundle/model.onnx
    <out>/evaluation.json        metrics on the held-out recordings
    <out>/result.json            the outcome: deployable, evaluationOnly or failed, and why

Features are the same 55 canonical statistics the desktop computes while running (`features.FEATURE_NAMES`), restricted
to the streams the model is allowed to read, so a model never depends on a stream it was not declared to use.

    uv run --extra onnx label-classifier-train --spec spec.json --out run-dir
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np

from .csv_io import load_recording
from .dataset import build_dataset_from_recordings
from .features import FEATURE_NAMES
from .labels import LABEL_MAPPING_VERSION, load_label_mapping
from .windowing import WindowConfig

SPEC_VERSION = 1
BACKENDS = ("logreg", "mlp", "torch-mlp")
SOURCES = ("watchOrientation", "watchAcceleration", "watchGyroscope", "watchPpg")
ONNX_OPSET = 15
TORCH_OPSET = 17
# The exported file must reproduce the trained model this closely, or it is not shipped.
PARITY_TOLERANCE = 1e-3
MIN_POSITIVE_TRAIN_WINDOWS = 10
MIN_WINDOWS_PER_CLASS_EVAL = 3
ACTIVATION = 0.8


class TrainingRefused(Exception):
    """The data cannot give a model worth keeping. The message says what to record or change."""


def source_of(feature: str) -> str:
    """The stream a canonical feature is computed from (mirrors `source_of_feature` in the desktop's bundle validator)."""
    prefix = feature.split("_")[0]
    return {"accel": "watchAcceleration", "gyro": "watchGyroscope", "quat": "watchOrientation"}.get(prefix, "watchPpg")


def is_movement_feature(name: str) -> bool:
    """A feature about how a signal changes, not its absolute level.

    Absolute levels (means, minimums, maximums) carry how the watch happened to be held, or how well it touched the skin,
    in that session. A model can memorise those and then fail on any other session. Spread, change over the window and the
    PPG slope do not depend on that. (The desktop applies the same rule: keep the two in step.)
    """
    return name.endswith("_std") or name == "quat_delta_angle_deg" or (name.startswith("ppg_") and name.endswith("_slope"))


def features_for(sources: list[str], movement_only: bool = False) -> list[str]:
    """Every canonical feature whose stream is in `sources`, in canonical order."""
    unknown = sorted(set(sources) - set(SOURCES))
    if unknown:
        raise TrainingRefused(f"unknown stream(s) {unknown}; choose from {list(SOURCES)}")
    chosen = [name for name in FEATURE_NAMES if source_of(name) in sources and (not movement_only or is_movement_feature(name))]
    if not chosen:
        raise TrainingRefused("no features are available from the chosen streams")
    return chosen


@dataclass(frozen=True)
class Spec:
    target: str
    negatives: list[str]
    excludes: list[str]
    recordings: dict[str, Path]
    train: list[str]
    evaluation: list[str]
    sources: list[str]
    features: list[str]
    movement_only: bool
    window: WindowConfig
    backend: str
    seed: int
    params: dict[str, Any]


def parse_spec(raw: dict[str, Any]) -> Spec:
    if raw.get("version") != SPEC_VERSION:
        raise TrainingRefused(f"unsupported spec version {raw.get('version')!r}; expected {SPEC_VERSION}")
    backend = raw.get("backend")
    if backend not in BACKENDS:
        raise TrainingRefused(f"unknown backend {backend!r}; choose from {list(BACKENDS)}")
    sources = list(raw.get("sources", []))
    available = features_for(sources, bool(raw.get("movementOnly", False)))
    requested = raw.get("features")
    if requested:
        extra = [name for name in requested if name not in available]
        if extra:
            raise TrainingRefused(f"feature(s) {extra} are not computed from the chosen streams {sources}")
        features = [name for name in available if name in set(requested)]
    else:
        features = available
    window = raw.get("window", {})
    recordings = {rid: Path(path) for rid, path in raw.get("recordings", {}).items()}
    train, evaluation = list(raw.get("train", [])), list(raw.get("evaluation", []))
    if set(train) & set(evaluation):
        raise TrainingRefused("a recording is in both the training and the evaluation set")
    if set(train) | set(evaluation) != set(recordings):
        raise TrainingRefused("every recording must be in exactly one of the training and evaluation sets")
    target = raw.get("target")
    if not target:
        raise TrainingRefused("the spec has no target label")
    return Spec(
        target=target,
        negatives=list(raw.get("negatives", [])),
        excludes=list(raw.get("excludes", [])),
        recordings=recordings,
        train=train,
        evaluation=evaluation,
        sources=sources,
        features=features,
        movement_only=bool(raw.get("movementOnly", False)),
        window=WindowConfig(
            window_ms=float(window.get("windowMs", 500)),
            stride_ms=float(window.get("strideMs", 150)),
            max_gap_ms=float(window.get("maxGapMs", 250)),
            min_samples_per_window=int(window.get("minSamples", 3)),
        ),
        backend=backend,
        seed=int(raw.get("seed", 7)),
        params=dict(raw.get("params", {})),
    )


def _mapping(spec: Spec):
    entries: dict[str, dict[str, Any]] = {spec.target: {"role": "target", "target": spec.target}}
    for label in spec.negatives:
        entries[label] = {"role": "negative"}
    for label in spec.excludes:
        entries[label] = {"role": "exclude"}
    return load_label_mapping({"version": LABEL_MAPPING_VERSION, "entries": entries})


def build_matrices(spec: Spec):
    """Windows and features for every recording, split by the recordings the desktop assigned."""
    recordings = []
    for rid, path in spec.recordings.items():
        recording = load_recording(path)
        recordings.append(replace(recording, session_id=rid))
    dataset = build_dataset_from_recordings(recordings, spec.window, "exclude", label_mapping=_mapping(spec))
    columns = [FEATURE_NAMES.index(name) for name in spec.features]
    x = dataset.features[:, columns].astype(np.float32)
    y = (dataset.targets == spec.target).astype(np.int64)
    train_mask = np.isin(dataset.groups, spec.train)
    eval_mask = np.isin(dataset.groups, spec.evaluation)
    return x[train_mask], y[train_mask], x[eval_mask], y[eval_mask]


def check_enough(y_train: np.ndarray, y_eval: np.ndarray) -> None:
    if int(y_train.sum()) < MIN_POSITIVE_TRAIN_WINDOWS:
        raise TrainingRefused(
            f"only {int(y_train.sum())} windows of the target label are in the training recordings "
            f"(at least {MIN_POSITIVE_TRAIN_WINDOWS} are needed). Record more of it, or longer"
        )
    if int((y_train == 0).sum()) < MIN_POSITIVE_TRAIN_WINDOWS:
        raise TrainingRefused("the training recordings have too few windows of anything else for the model to learn the difference")
    positives, negatives = int(y_eval.sum()), int((y_eval == 0).sum())
    if positives < MIN_WINDOWS_PER_CLASS_EVAL or negatives < MIN_WINDOWS_PER_CLASS_EVAL:
        raise TrainingRefused(
            f"the held-out recordings have {positives} windows of the target and {negatives} of everything else; "
            f"each needs at least {MIN_WINDOWS_PER_CLASS_EVAL} to be tested fairly. Record more sessions"
        )


def make_model(backend: str, n_features: int, seed: int, params: dict[str, Any]):
    """An untrained model whose scaling (if any) is inside it, so the exported file needs no separate preprocessing."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.neural_network import MLPClassifier
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    if backend == "logreg":
        return Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=2000, class_weight="balanced", random_state=seed))])
    if backend == "mlp":
        hidden = tuple(params.get("hidden", (32, 16)))
        return Pipeline([("scale", StandardScaler()), ("model", MLPClassifier(hidden_layer_sizes=hidden, max_iter=600, early_stopping=True, random_state=seed))])
    raise TrainingRefused(f"{backend} is not a scikit-learn backend")


class TorchModel:
    """A small neural network with the feature scaling inside it. Imported lazily: PyTorch is an optional extra."""

    def __init__(self, n_features: int, seed: int, params: dict[str, Any]):
        import torch

        torch.manual_seed(seed)
        self.torch = torch
        hidden = int(params.get("hidden", 32))
        self.epochs = int(params.get("epochs", 200))
        self.mean = torch.zeros(n_features)
        self.std = torch.ones(n_features)
        self.net = torch.nn.Sequential(
            torch.nn.Linear(n_features, hidden), torch.nn.ReLU(), torch.nn.Linear(hidden, hidden // 2 or 1), torch.nn.ReLU(), torch.nn.Linear(hidden // 2 or 1, 2)
        )

    def fit(self, x: np.ndarray, y: np.ndarray) -> "TorchModel":
        torch = self.torch
        data = torch.tensor(x, dtype=torch.float32)
        self.mean = data.mean(dim=0)
        self.std = data.std(dim=0).clamp_min(1e-6)
        target = torch.tensor(y, dtype=torch.long)
        counts = torch.bincount(target, minlength=2).float()
        weights = counts.sum() / (2 * counts.clamp_min(1))
        loss_fn = torch.nn.CrossEntropyLoss(weight=weights)
        optimiser = torch.optim.Adam(self.net.parameters(), lr=float(0.01))
        scaled = (data - self.mean) / self.std
        for _ in range(self.epochs):
            optimiser.zero_grad()
            loss_fn(self.net(scaled), target).backward()
            optimiser.step()
        return self

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


def fit(spec: Spec, x_train: np.ndarray, y_train: np.ndarray):
    if spec.backend == "torch-mlp":
        try:
            return TorchModel(x_train.shape[1], spec.seed, spec.params).fit(x_train, y_train)
        except ImportError as error:
            raise TrainingRefused("PyTorch is not installed. Run the trainer with the 'torch' extra to use this backend") from error
    return make_model(spec.backend, x_train.shape[1], spec.seed, spec.params).fit(x_train, y_train)


def _rates(probability: np.ndarray, y: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = probability >= threshold
    tp = int(((predicted == 1) & (y == 1)).sum())
    fp = int(((predicted == 1) & (y == 0)).sum())
    fn = int(((predicted == 0) & (y == 1)).sum())
    tn = int(((predicted == 0) & (y == 0)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": threshold,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "accuracy": (tp + tn) / max(y.shape[0], 1),
        # How often a window of something else is wrongly called the target: the number that decides whether it is annoying.
        "falseActivationRate": fp / max(fp + tn, 1),
        "confusion": {"truePositive": tp, "falsePositive": fp, "falseNegative": fn, "trueNegative": tn},
    }


def choose_threshold(probability: np.ndarray, y: np.ndarray) -> float:
    """The activation threshold with the best F1 on these windows (ties go to fewer false alarms, then the higher one).

    A model's scores shift from one recording session to the next, so a fixed 0.8 can sit above every score of a model
    that ranks the windows perfectly. The threshold is therefore fitted, but it is fitted on the held-out recordings, so
    the rates reported at it are a little optimistic. `evaluation.json` says so, and also reports the default.
    """
    best = (-1.0, 0.0, 0.0)
    for threshold in np.round(np.arange(0.05, 0.96, 0.01), 2):
        rates = _rates(probability, y, float(threshold))
        key = (rates["f1"], -rates["falseActivationRate"], float(threshold))
        if key > best:
            best = key
    return best[2]


def evaluate(probability: np.ndarray, y: np.ndarray) -> dict[str, Any]:
    from sklearn.metrics import roc_auc_score

    threshold = choose_threshold(probability, y)
    chosen = _rates(probability, y, threshold)
    return {
        "windows": int(y.shape[0]),
        "positiveWindows": int(y.sum()),
        "negativeWindows": int((y == 0).sum()),
        # Does the model rank the gesture's windows above the rest at all? 0.5 is chance; under 0.5 it is backwards.
        "rocAuc": float(roc_auc_score(y, probability)),
        "activationThreshold": threshold,
        "thresholdChosenOnEvaluationRecordings": True,
        **{k: v for k, v in chosen.items() if k != "threshold"},
        "atDefaultThreshold": _rates(probability, y, ACTIVATION),
    }


MIN_AUC = 0.7
MIN_F1 = 0.5


def verdict(metrics: dict[str, Any]) -> str | None:
    """Why a model is not worth keeping, in words; None when it is good enough to review."""
    auc, f1 = metrics["rocAuc"], metrics["f1"]
    if auc < 0.5:
        return (
            f"It scored the gesture's windows *lower* than the others on recordings it had not seen (AUC {auc:.2f}; 0.5 is chance). "
            "It memorised the training recordings rather than the gesture"
        )
    if auc < MIN_AUC:
        return f"It could barely tell the gesture from the rest on recordings it had not seen (AUC {auc:.2f}; at least {MIN_AUC} is needed)"
    if f1 < MIN_F1:
        return f"Even with the best cut-off it only reached an F1 of {f1:.2f} on recordings it had not seen (at least {MIN_F1} is needed)"
    return None


# The operators the desktop's runtime (tract) can run. An exported file using anything else is refused here, where the
# reason can be explained, instead of failing to load on the desktop. Notably absent: the scikit-learn converter's
# `Scaler`, `LinearClassifier` and (as exported by it) `TreeEnsembleClassifier`, so the dense models are written by hand
# below and tree models are not offered.
RUNNABLE_OPERATORS = {
    ("", "Add"), ("", "Sub"), ("", "Mul"), ("", "Div"), ("", "MatMul"), ("", "Gemm"), ("", "Relu"), ("", "Sigmoid"),
    ("", "Softmax"), ("", "Concat"), ("", "Identity"), ("", "Constant"), ("", "Cast"), ("", "Reshape"), ("", "Flatten"),
    ("", "Transpose"), ("", "Unsqueeze"), ("", "Squeeze"),
}


def check_runnable(path: Path) -> None:
    import onnx

    model = onnx.load(str(path))
    unsupported = sorted({f"{node.domain or 'ai.onnx'}.{node.op_type}" for node in model.graph.node if (node.domain, node.op_type) not in RUNNABLE_OPERATORS})
    if unsupported:
        raise TrainingRefused(f"the exported model uses {unsupported}, which the desktop's model runtime cannot run, so it is not shipped")


def dense_network_onnx(layers: list[tuple[np.ndarray, np.ndarray]], mean: np.ndarray, scale: np.ndarray, path: Path) -> int:
    """Writes `ReLU` hidden layers and a sigmoid output as plain ONNX, with the feature scaling folded into layer one.

    `layers` are (weights (in, out), bias (out,)); the last layer has one output, the logit of the target.
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    first_w, first_b = layers[0]
    # (x - mean) / scale @ W + b  ==  x @ (W / scale[:, None]) + (b - (mean / scale) @ W)
    folded = [((first_w / scale[:, None]).astype(np.float32), (first_b - (mean / scale) @ first_w).astype(np.float32))]
    folded += [(w.astype(np.float32), b.astype(np.float32)) for w, b in layers[1:]]
    nodes, inits = [], []
    current = "X"
    for index, (weights, bias) in enumerate(folded):
        inits += [numpy_helper.from_array(weights, f"W{index}"), numpy_helper.from_array(bias, f"B{index}")]
        nodes.append(helper.make_node("MatMul", [current, f"W{index}"], [f"M{index}"]))
        nodes.append(helper.make_node("Add", [f"M{index}", f"B{index}"], [f"A{index}"]))
        current = f"A{index}"
        if index < len(folded) - 1:
            nodes.append(helper.make_node("Relu", [current], [f"R{index}"]))
            current = f"R{index}"
    inits.append(numpy_helper.from_array(np.array([[1.0]], dtype=np.float32), "ONE"))
    nodes += [
        helper.make_node("Sigmoid", [current], ["P"]),
        helper.make_node("Sub", ["ONE", "P"], ["Q"]),
        helper.make_node("Concat", ["Q", "P"], ["probabilities"], axis=1),
    ]
    graph = helper.make_graph(
        nodes,
        "label_model",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [None, folded[0][0].shape[0]])],
        [helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [None, 2])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", ONNX_OPSET)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    path.write_bytes(model.SerializeToString())
    return ONNX_OPSET


def export_onnx(spec: Spec, model, x_sample: np.ndarray, path: Path) -> int:
    """Writes the ONNX file and returns the opset it was written with."""
    if spec.backend == "torch-mlp":
        import torch

        module = model.module()
        torch.onnx.export(
            module,
            torch.tensor(x_sample[:1], dtype=torch.float32),
            str(path),
            input_names=["X"],
            output_names=["probabilities"],
            dynamic_axes={"X": {0: "batch"}, "probabilities": {0: "batch"}},
            opset_version=TORCH_OPSET,
            dynamo=False,
        )
        check_runnable(path)
        return TORCH_OPSET
    if spec.backend in ("logreg", "mlp"):
        scaler, final = model.named_steps["scale"], model.named_steps["model"]
        if spec.backend == "logreg":
            layers = [(final.coef_.T.astype(np.float64), final.intercept_.astype(np.float64))]
        else:
            layers = [(w.astype(np.float64), b.astype(np.float64)) for w, b in zip(final.coefs_, final.intercepts_)]
        opset = dense_network_onnx(layers, scaler.mean_, scaler.scale_, path)
    else:
        raise TrainingRefused(f"{spec.backend} cannot be exported")
    check_runnable(path)
    return opset


def onnx_probabilities(path: Path, x: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {session.get_inputs()[0].name: x.astype(np.float32)})
    # The probabilities are the output shaped (n, 2); a scikit-learn graph also has the predicted label.
    for output in outputs:
        array = np.asarray(output)
        if array.ndim == 2 and array.shape[1] == 2:
            return array
    raise TrainingRefused("the exported model has no two-class probability output")


def framework_of(spec: Spec) -> dict[str, str]:
    if spec.backend == "torch-mlp":
        import torch

        return {"name": "pytorch", "version": torch.__version__.split("+")[0]}
    import sklearn

    return {"name": "scikit-learn", "version": sklearn.__version__}


def write_bundle(spec: Spec, out: Path, model_bytes: bytes, opset: int, metrics: dict[str, Any]) -> str:
    bundle = out / "bundle"
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "model.onnx").write_bytes(model_bytes)
    sha = hashlib.sha256(model_bytes).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "modelId": f"{spec.target}-{sha[:8]}",
        "targetLabel": spec.target,
        "model": {"file": "model.onnx", "sha256": sha, "format": "onnx", "opset": opset},
        "framework": framework_of(spec),
        "input": {"name": "X", "shape": [None, len(spec.features)], "dtype": "float32", "features": spec.features},
        "output": {"name": "probabilities", "shape": [None, 2], "dtype": "float32", "positiveIndex": 1},
        "sources": spec.sources,
        "window": {
            "durationMs": int(spec.window.window_ms),
            "strideMs": int(spec.window.stride_ms),
            "maxGapMs": int(spec.window.max_gap_ms),
            "minSamples": spec.window.min_samples_per_window,
        },
        "quality": {"maxContactQuality": 0.0, "minSampleCount": 3},
        "thresholds": {"activation": metrics["activationThreshold"], "release": round(max(0.05, metrics["activationThreshold"] - 0.15), 2)},
        "preprocessing": {"kind": "none"},
        "provenance": {
            "backend": spec.backend,
            "trainRecordings": sorted(spec.train),
            "evaluationRecordings": sorted(spec.evaluation),
            "seed": spec.seed,
            "evaluationF1": metrics["f1"],
            "evaluationFalseActivationRate": metrics["falseActivationRate"],
            "evaluationRocAuc": metrics["rocAuc"],
            "thresholdChosenOnEvaluationRecordings": True,
            "movementOnly": spec.movement_only,
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return sha


def run(raw_spec: dict[str, Any], out: Path) -> dict[str, Any]:
    """Trains and writes everything under `out`. Returns the result (also written as `result.json`)."""
    out.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"outcome": "failed", "message": ""}
    try:
        spec = parse_spec(raw_spec)
        x_train, y_train, x_eval, y_eval = build_matrices(spec)
        check_enough(y_train, y_eval)
        model = fit(spec, x_train, y_train)
        probability = model.predict_proba(x_eval)[:, 1]
        metrics = evaluate(probability, y_eval)
        (out / "evaluation.json").write_text(json.dumps(metrics, indent=2) + "\n")
        poor = verdict(metrics)
        if poor is not None:
            result = {
                "outcome": "evaluationOnly",
                "message": poor + ". Record more sessions of the gesture (at least three, in different positions), or change what the model may read",
                "backend": spec.backend,
                "features": spec.features,
                "trainWindows": int(y_train.shape[0]),
                "evaluationWindows": int(y_eval.shape[0]),
                "metrics": metrics,
            }
            (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            return result

        scratch = out / "model.onnx"
        opset = export_onnx(spec, model, x_train, scratch)
        exported = onnx_probabilities(scratch, x_eval)[:, 1]
        parity = float(np.max(np.abs(exported - probability))) if probability.size else 0.0
        (out / "parity.json").write_text(json.dumps({"maxAbsDifference": parity, "tolerance": PARITY_TOLERANCE, "windows": int(x_eval.shape[0])}, indent=2) + "\n")
        if parity > PARITY_TOLERANCE:
            raise TrainingRefused(f"the exported ONNX model differs from the trained one by {parity:.4f} (the limit is {PARITY_TOLERANCE}), so it is not shipped")
        sha = write_bundle(spec, out, scratch.read_bytes(), opset, metrics)
        result = {
            "outcome": "deployable",
            "message": "",
            "bundleDir": "bundle",
            "modelSha256": sha,
            "backend": spec.backend,
            "features": spec.features,
            "trainWindows": int(y_train.shape[0]),
            "evaluationWindows": int(y_eval.shape[0]),
            "metrics": metrics,
            "parityMaxAbsDifference": parity,
        }
    except TrainingRefused as refusal:
        result["message"] = str(refusal)
    except Exception as error:  # noqa: BLE001 - any failure must be reported, not crash without a result
        result["message"] = f"{type(error).__name__}: {error}"
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", required=True, type=Path, help="the training spec the desktop wrote")
    parser.add_argument("--out", required=True, type=Path, help="directory for the results")
    args = parser.parse_args(argv)
    result = run(json.loads(args.spec.read_text()), args.out)
    print(json.dumps({"outcome": result["outcome"], "message": result["message"]}), flush=True)
    return 0 if result["outcome"] == "deployable" else 2


def cli() -> None:
    code = main()
    # PyTorch and ONNX Runtime can abort while the interpreter shuts down, after the results are safely written; leave
    # without that teardown so the exit status reflects the training, not the shutdown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    cli()
