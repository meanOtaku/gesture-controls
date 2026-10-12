"""Trains one binary model for one label and writes a bundle the desktop can import.

The desktop owns the decisions that must be recorded and cannot change afterwards, so this script does not make them:
which recordings train and which evaluate (never the same one), what each label in the data means (the target is
positive, everything else is negative or excluded), the streams the model may read, and the window. It receives them in
a `spec.json`, trains, evaluates on the held-out recordings, exports ONNX, checks the ONNX file reproduces the trained
model, and writes:

    <out>/bundle/manifest.json   what the desktop's bundle validator reads
    <out>/bundle/model.onnx
    <out>/evaluation.json        metrics on the held-out recordings: per window, and as a detector over whole recordings
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

from .csv_io import Recording, load_recording, repair_millisecond_ppg_timestamps, shift_labels
from .dataset import build_dataset_from_recordings
from .events import Policy, continuous_windows, detect, labelled_spans, match_events, summarise
from .features import (
    ALL_BASELINE_FEATURE_NAMES,
    BASELINE_CHOICES_MS,
    FEATURE_NAMES,
    MOTION_FEATURE_NAMES,
    SPIKE_FEATURE_NAMES,
    SPIKE_METHODS,
    baseline_rows,
    extract_features,
)
from .edits import EditRefused
from .nets import CnnModel, TorchModel
from .network import Network, NetworkRefused, parameter_count, parse_network
from .grid import DEFAULT_STEPS, GRID_TIMINGS, MAX_RAW_STEPS, MAX_STEPS, MIN_RAW_STEPS, MIN_STEPS, build_grid, channels_for
from .labels import LABEL_MAPPING_VERSION, load_label_mapping, missing_labels
from .windowing import Window, WindowConfig, label_by_overlap

SPEC_VERSION = 1
WINDOWINGS = ("continuous", "segments")
BACKENDS = ("logreg", "mlp", "torch-mlp", "cnn1d", "gbt")
SOURCES = ("watchOrientation", "watchAcceleration", "watchGyroscope", "watchPpg")
ONNX_OPSET = 15
TORCH_OPSET = 17
# The exported file must reproduce the trained model this closely, or it is not shipped.
PARITY_TOLERANCE = 1e-3
MIN_POSITIVE_TRAIN_WINDOWS = 10
MIN_WINDOWS_PER_CLASS_EVAL = 3
ACTIVATION = 0.8
# The cut-off is chosen from predictions on the training recordings by models that did not see them (grouped by recording),
# using at most this many folds.
MAX_THRESHOLD_FOLDS = 5


class TrainingRefused(Exception):
    """The data cannot give a model worth keeping. The message says what to record or change."""


def source_of(feature: str) -> str:
    """The stream a canonical feature is computed from (mirrors `source_of_feature` in the desktop's bundle validator)."""
    prefix = feature.split("_")[0]
    return {"accel": "watchAcceleration", "gyro": "watchGyroscope", "quat": "watchOrientation"}.get(prefix, "watchPpg")


def _channel_wanted(name: str, ppg_channels) -> bool:
    parts = name.split("_")
    if parts[0] == "ppg" and len(parts) > 1 and parts[1] in PPG_CHANNELS:
        return parts[1] in ppg_channels
    return True


def is_movement_feature(name: str) -> bool:
    """A feature about how a signal changes, not its absolute level.

    Absolute levels (means, minimums, maximums) carry how the watch happened to be held, or how well it touched the skin,
    in that session. A model can memorise those and then fail on any other session. Spread, change over the window and the
    PPG slope do not depend on that. (The desktop applies the same rule: keep the two in step.)
    """
    return (
        name.endswith("_std")
        or name == "quat_delta_angle_deg"
        or (name.startswith("ppg_") and name.endswith("_slope"))
        or name in SPIKE_FEATURE_NAMES  # the spike features are all about change: the baseline is already taken away
        or name in ALL_BASELINE_FEATURE_NAMES  # and these are the level against the recent past, not the level itself
        or name in MOTION_FEATURE_NAMES  # how fast and how often the motion changes
    )


PPG_CHANNELS = ("green", "red", "ir")

# How far the labels may be moved in time (see `csv_io.shift_labels`).
MAX_LABEL_OFFSET_MS = 1500


def features_for(
    sources: list[str],
    movement_only: bool = False,
    spikes: bool = False,
    ppg_channels: tuple[str, ...] | list[str] = PPG_CHANNELS,
    baseline: bool = False,
) -> list[str]:
    """Every canonical feature whose stream is in `sources`, in canonical order. The pulse-sensor spike features are only
    included when a spike extraction method is chosen (`spikes`), and only if the pulse sensor is one of the streams. A
    pulse sensor feature of a channel not in `ppg_channels` is left out; the window-level values that come with the pulse
    sensor (sample count, duration, contact quality) stay. The relative-level features are only included with a baseline (`baseline`)."""
    unknown = sorted(set(sources) - set(SOURCES))
    if unknown:
        raise TrainingRefused(f"unknown stream(s) {unknown}; choose from {list(SOURCES)}")
    chosen = [
        name
        for name in FEATURE_NAMES
        if source_of(name) in sources
        and (spikes or name not in SPIKE_FEATURE_NAMES)
        and (baseline or name not in ALL_BASELINE_FEATURE_NAMES)
        and (not movement_only or is_movement_feature(name))
        and _channel_wanted(name, ppg_channels)
    ]
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
    spike_method: str | None
    baseline_ms: int | None
    ppg_channels: list[str]
    grid_steps: int
    raw_columns: bool
    network: Network
    research: bool
    edit: dict[str, Any] | None
    window: WindowConfig
    backend: str
    seed: int
    params: dict[str, Any]
    label_offset_ms: int = 0
    # "continuous": windows slide across the whole recording and are labelled by how much the gesture covers them, as
    # the runtime meets them. "segments": the older way, windows only inside one label's stretch.
    windowing: str = "continuous"
    # How a grid lays samples onto its steps (see `grid.build_grid`): "time" for new models; an edit keeps its source's.
    grid_timing: str = "time"
    # A convolutional model can start its convolution layers from a pre-trained motion encoder (see `pretrain.py`), and
    # keep them as they are (`pretrained_freeze`) so only its head learns from the recordings.
    pretrained: Path | None = None
    pretrained_freeze: bool = False


def grid_pulse_baseline(spec: Spec) -> int | None:
    """For a model reading columns with a baseline and a pulse channel: how far back the pulse is measured against (see
    `grid.build_grid`); None otherwise."""
    if not reads_grid(spec) or spec.baseline_ms is None or not any(name.startswith("ppg_") for name in spec.features):
        return None
    return spec.baseline_ms


def reads_grid(spec: Spec) -> bool:
    """Whether the model reads the window as columns over steps (a convolutional model, or a dense one on raw columns)."""
    return spec.backend == "cnn1d" or spec.raw_columns


def input_count(spec: Spec) -> int:
    """How many numbers go into the model for one window: the statistics, or every column at every step."""
    return len(spec.features) * spec.grid_steps if reads_grid(spec) else len(spec.features)


def network_inputs(spec: Spec) -> int:
    """The number the network's first layer counts (a convolutional network counts channels: it slides over the steps)."""
    return len(spec.features) if spec.backend == "cnn1d" else input_count(spec)


def parse_spec(raw: dict[str, Any]) -> Spec:
    if raw.get("version") != SPEC_VERSION:
        raise TrainingRefused(f"unsupported spec version {raw.get('version')!r}; expected {SPEC_VERSION}")
    backend = raw.get("backend")
    if backend not in BACKENDS:
        raise TrainingRefused(f"unknown backend {backend!r}; choose from {list(BACKENDS)}")
    sources = list(raw.get("sources", []))
    spike_method = raw.get("spikeMethod") or None
    if spike_method == "none":
        spike_method = None
    if spike_method is not None and spike_method not in SPIKE_METHODS:
        raise TrainingRefused(f"unknown spike extraction method {spike_method!r}; choose from {list(SPIKE_METHODS)}")
    if spike_method is not None and "watchPpg" not in sources:
        spike_method = None  # nothing for it to read
    baseline_ms = raw.get("baselineMs") or None
    if baseline_ms is not None and baseline_ms not in BASELINE_CHOICES_MS:
        raise TrainingRefused(f"the baseline must be one of {list(BASELINE_CHOICES_MS)} milliseconds, got {baseline_ms!r}")
    if baseline_ms is not None and "watchPpg" not in sources:
        baseline_ms = None  # nothing for it to read
    chosen_channels = raw.get("ppgChannels")
    if chosen_channels is None:
        ppg_channels = list(PPG_CHANNELS)
    else:
        unknown = sorted(set(chosen_channels) - set(PPG_CHANNELS))
        if unknown:
            raise TrainingRefused(f"unknown pulse sensor channel(s) {unknown}; choose from {list(PPG_CHANNELS)}")
        ppg_channels = [channel for channel in PPG_CHANNELS if channel in chosen_channels]
        if "watchPpg" in sources and not ppg_channels:
            raise TrainingRefused("choose at least one pulse sensor channel for the model to read")
    grid_steps = int(raw.get("gridSteps", DEFAULT_STEPS))
    raw_columns = raw.get("inputMode") == "raw"
    if raw_columns and backend not in ("logreg", "mlp", "torch-mlp", "cnn1d", "gbt"):
        raise TrainingRefused(f"unknown training method {backend!r}")
    if raw_columns and backend != "cnn1d":
        if not MIN_RAW_STEPS <= grid_steps <= MAX_RAW_STEPS:
            raise TrainingRefused(f"the samples per window must be from {MIN_RAW_STEPS} to {MAX_RAW_STEPS}, got {grid_steps}")
    if backend == "cnn1d" or raw_columns:
        if backend == "cnn1d" and not MIN_STEPS <= grid_steps <= MAX_STEPS:
            raise TrainingRefused(f"gridSteps must be from {MIN_STEPS} to {MAX_STEPS}, got {grid_steps}")
        # These models read the window's columns (channels), not statistics: the "features" are the column names, and the
        # model's inputs are each column at each step.
        available = channels_for(sources, ppg_channels)
        if not available:
            raise TrainingRefused("no channels are available from the chosen streams")
        if not any(channel.startswith("ppg_") for channel in available):
            spike_method = None  # nothing for it to read
            baseline_ms = None  # with a pulse channel the baseline puts it in units of its recent past (see grid_pulse_baseline)
    else:
        available = features_for(sources, bool(raw.get("movementOnly", False)), spike_method is not None, ppg_channels, baseline_ms is not None)
    requested = raw.get("features")
    if requested:
        extra = [name for name in requested if name not in available]
        if extra:
            raise TrainingRefused(f"feature(s) {extra} are not computed from the chosen streams {sources}")
        features = [name for name in available if name in set(requested)]
    else:
        features = available
    params = dict(raw.get("params", {}))
    try:
        network = parse_network(raw.get("network"), backend)
    except NetworkRefused as refusal:
        raise TrainingRefused(str(refusal)) from refusal
    if "epochs" in params and "epochs" not in (raw.get("network") or {}):
        network = replace(network, epochs=max(5, int(params["epochs"])))  # the older way of asking for fewer rounds
    if "hidden" in params and "hidden" not in (raw.get("network") or {}):
        # The older way of asking for a dense shape: a list of layer sizes. A designed network's own layers win.
        try:
            sizes = list(params["hidden"])
            legacy = parse_network({"hidden": [{"units": units} for units in sizes]}, backend)
        except (NetworkRefused, TypeError) as refusal:
            raise TrainingRefused(f"params.hidden must be a list of layer sizes: {refusal}") from refusal
        network = replace(network, hidden=legacy.hidden)
    window = raw.get("window", {})
    window_ms = float(window.get("windowMs", 500))
    pretrained = Path(raw["pretrained"]) if raw.get("pretrained") else None
    movement_only = bool(raw.get("movementOnly", False))
    if pretrained is not None:
        network, movement_only = _pretrained_network(pretrained, backend, features, grid_steps, window_ms, network)
    recordings = {rid: Path(path) for rid, path in raw.get("recordings", {}).items()}
    train, evaluation = list(raw.get("train", [])), list(raw.get("evaluation", []))
    if set(train) & set(evaluation):
        raise TrainingRefused("a recording is in both the training and the evaluation set")
    if set(train) | set(evaluation) != set(recordings):
        raise TrainingRefused("every recording must be in exactly one of the training and evaluation sets")
    label_offset_ms = raw.get("labelOffsetMs", 0) or 0
    if isinstance(label_offset_ms, bool) or not isinstance(label_offset_ms, int) or abs(label_offset_ms) > MAX_LABEL_OFFSET_MS:
        raise TrainingRefused(f"the label offset must be a whole number of milliseconds from -{MAX_LABEL_OFFSET_MS} to {MAX_LABEL_OFFSET_MS}, got {label_offset_ms!r}")
    target = raw.get("target")
    if not target:
        raise TrainingRefused("the spec has no target label")
    windowing = raw.get("windowing", "continuous")
    if windowing not in WINDOWINGS:
        raise TrainingRefused(f"windowing must be one of {list(WINDOWINGS)}, got {windowing!r}")
    grid_timing = raw.get("gridTiming") or _source_grid_timing(raw.get("edit")) or "time"
    if grid_timing not in GRID_TIMINGS:
        raise TrainingRefused(f"gridTiming must be one of {list(GRID_TIMINGS)}, got {grid_timing!r}")
    if (backend == "cnn1d" or raw_columns) and not any(name.startswith("ppg_") for name in features):
        baseline_ms = None
    return Spec(
        target=target,
        negatives=list(raw.get("negatives", [])),
        excludes=list(raw.get("excludes", [])),
        recordings=recordings,
        train=train,
        evaluation=evaluation,
        sources=sources,
        features=features,
        movement_only=movement_only,
        spike_method=spike_method,
        baseline_ms=baseline_ms,
        ppg_channels=ppg_channels,
        grid_steps=grid_steps,
        raw_columns=raw_columns,
        network=network,
        research=bool(raw.get("research", False)),
        edit=raw.get("edit") or None,
        window=WindowConfig(
            window_ms=window_ms,
            stride_ms=float(window.get("strideMs", 150)),
            max_gap_ms=float(window.get("maxGapMs", 250)),
            min_samples_per_window=int(window.get("minSamples", 3)),
        ),
        backend=backend,
        seed=int(raw.get("seed", 7)),
        params=dict(raw.get("params", {})),
        label_offset_ms=int(label_offset_ms),
        windowing=windowing,
        grid_timing=grid_timing,
        pretrained=pretrained,
        pretrained_freeze=bool(raw.get("pretrainedFreeze", False)),
    )


def _pretrained_network(path: Path, backend: str, features: list[str], grid_steps: int, window_ms: float, network: Network) -> tuple[Network, bool]:
    """The network a model starting from the encoder at `path` must have (the encoder's convolution layers and pooling,
    the request's own training settings), after checking the model reads what the encoder was trained on. Such a model
    always takes each window's own mean away, as the encoder did (which also takes gravity away)."""
    from .pretrain import MOTION_CHANNELS, load_encoder

    if backend != "cnn1d":
        raise TrainingRefused("only the convolutional network can start from a pre-trained encoder")
    if not path.is_file():
        raise TrainingRefused(f"the pre-trained encoder {path} is not there; make it with --pretrain-microdpad")
    try:
        encoder = load_encoder(path)
    except (ValueError, ImportError) as error:
        raise TrainingRefused(str(error)) from error
    if features != MOTION_CHANNELS:
        raise TrainingRefused(f"the pre-trained encoder reads {MOTION_CHANNELS}; choose acceleration and gyroscope only (got {features})")
    if grid_steps != encoder["steps"] or int(window_ms) != encoder["windowMs"]:
        raise TrainingRefused(
            f"the pre-trained encoder reads {encoder['windowMs']} ms windows in {encoder['steps']} steps; "
            f"this model asks for {int(window_ms)} ms in {grid_steps}"
        )
    built = parse_network(encoder["network"], "cnn1d")
    return replace(network, conv=built.conv, pooling=built.pooling), True


def _source_grid_timing(edit: dict[str, Any] | None) -> str | None:
    """The grid timing of the model an edit starts from: what its manifest says, or "samples" for one from before the
    manifest said (it was trained that way). None when there is no edit or no grid."""
    if not edit or not edit.get("fromDir"):
        return None
    try:
        grid = json.loads((Path(edit["fromDir"]) / "bundle" / "manifest.json").read_text())["input"].get("grid")
    except (OSError, KeyError, ValueError):
        return None
    return None if grid is None else grid.get("timing", "samples")


def _mapping(spec: Spec):
    entries: dict[str, dict[str, Any]] = {spec.target: {"role": "target", "target": spec.target}}
    for label in spec.negatives:
        entries[label] = {"role": "negative"}
    for label in spec.excludes:
        entries[label] = {"role": "exclude"}
    return load_label_mapping({"version": LABEL_MAPPING_VERSION, "entries": entries})


def build_matrices(spec: Spec):
    """Windows and features for every recording, split by the recordings the desktop assigned."""
    return build_matrices_with_windows(spec)[:4]


def load_spec_recordings(spec: Spec) -> dict[str, Recording]:
    """Every recording the spec names, as training reads it: repaired if needed, labels moved by the chosen offset."""
    return {
        rid: replace(shift_labels(repair_millisecond_ppg_timestamps(load_recording(path)), spec.label_offset_ms), session_id=rid)
        for rid, path in spec.recordings.items()
    }


def window_inputs(spec: Spec, recording: Recording, windows: list[Window]) -> tuple[np.ndarray, list[Window]]:
    """The model's input for each window, made as for training; a window the runtime would not score (too little pulse
    history for the baseline) is left out. Returns the inputs and the windows kept."""
    columns = None if reads_grid(spec) else [FEATURE_NAMES.index(name) for name in spec.features]
    rows: list[np.ndarray] = []
    kept: list[Window] = []
    for window in windows:
        if columns is None:
            grid = build_grid(recording, window, spec.features, spec.grid_steps, spec.spike_method, spec.grid_timing, grid_pulse_baseline(spec))
            if grid is None:
                continue
            rows.append(grid)
        else:
            if spec.baseline_ms is not None and baseline_rows(recording, window, spec.baseline_ms) is None:
                continue
            rows.append(extract_features(recording, window, spec.spike_method, spec.baseline_ms)[columns])
        kept.append(window)
    width = input_count(spec)
    return (np.array(rows, dtype=np.float32) if rows else np.zeros((0, width), dtype=np.float32)), kept


def build_all(spec: Spec, recordings: dict[str, Recording] | None = None):
    """Every window of every recording: features, whether it is the target, the recording it came from, and where it is."""
    if spec.windowing == "continuous":
        return _build_continuous(spec, recordings or load_spec_recordings(spec))
    recordings = list((recordings or load_spec_recordings(spec)).values())
    if reads_grid(spec):
        dataset = build_dataset_from_recordings(
            recordings, spec.window, "exclude", label_mapping=_mapping(spec),
            feature_fn=lambda recording, window: build_grid(recording, window, spec.features, spec.grid_steps, spec.spike_method, spec.grid_timing, grid_pulse_baseline(spec)),
            baseline_ms=grid_pulse_baseline(spec),
        )
        x = dataset.features.astype(np.float32)
    else:
        dataset = build_dataset_from_recordings(recordings, spec.window, "exclude", label_mapping=_mapping(spec), spike_method=spec.spike_method, baseline_ms=spec.baseline_ms)
        columns = [FEATURE_NAMES.index(name) for name in spec.features]
        x = dataset.features[:, columns].astype(np.float32)
    y = (dataset.targets == spec.target).astype(np.int64)
    meta = [{"recording": str(dataset.groups[i]), "startNs": int(dataset.windows[i].start_ns), "label": str(dataset.raw_labels[i])} for i in range(len(dataset.groups))]
    return x, y, np.array([str(g) for g in dataset.groups]), meta


def _build_continuous(spec: Spec, recordings: dict[str, Recording]):
    """`build_all` with windows that slide across label changes, each labelled by `windowing.label_by_overlap`."""
    present = {label for recording in recordings.values() for label in recording.raw_labels.tolist()}
    unmapped = missing_labels(_mapping(spec), present)
    if unmapped:
        raise TrainingRefused(
            "the following collection label(s) have no explicit training role mapping "
            f"(target/negative/exclude): {', '.join(sorted(unmapped))}. Assign a role for each "
            "before training; unmapped labels are never silently treated as negative."
        )
    excluded_labels = list(spec.excludes)
    xs: list[np.ndarray] = []
    ys: list[int] = []
    groups: list[str] = []
    meta: list[dict[str, Any]] = []
    for rid, recording in recordings.items():
        labels = recording.raw_labels
        labelled = label_by_overlap(
            recording,
            continuous_windows(recording, spec.window),
            labels == spec.target,
            np.isin(labels, excluded_labels) if excluded_labels else np.zeros(labels.shape[0], dtype=bool),
        )
        answer = {id(window): y for window, y in labelled}
        x, kept = window_inputs(spec, recording, [window for window, _ in labelled])
        for row, window in zip(x, kept):
            window_labels = labels[window.row_indices].tolist()
            xs.append(row)
            ys.append(answer[id(window)])
            groups.append(rid)
            meta.append({"recording": rid, "startNs": int(window.start_ns), "label": max(set(window_labels), key=window_labels.count)})
    if not xs:
        raise TrainingRefused("no window could be made from the recordings; check the window length and gap against the recording rate")
    return np.stack(xs).astype(np.float32), np.array(ys, dtype=np.int64), np.array(groups), meta


def build_matrices_with_windows(spec: Spec):
    """`build_matrices`, and for each held-out window which recording it came from and where (for the inspection)."""
    return build_matrices_with_groups(spec)[:5]


def build_matrices_with_groups(spec: Spec, recordings: dict[str, Recording] | None = None):
    """`build_matrices_with_windows`, and last the recording each training window came from."""
    x, y, groups, meta = build_all(spec, recordings)
    train_mask = np.isin(groups, spec.train)
    eval_mask = np.isin(groups, spec.evaluation)
    eval_windows = [meta[i] for i in np.flatnonzero(eval_mask)]
    return x[train_mask], y[train_mask], x[eval_mask], y[eval_mask], eval_windows, groups[train_mask]


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


def make_model(backend: str, n_features: int, seed: int, params: dict[str, Any], network: Network | None = None):
    """An untrained model whose scaling (if any) is inside it, so the exported file needs no separate preprocessing."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.neural_network import MLPClassifier
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    network = network or parse_network(None, backend)
    if backend == "logreg":
        return Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=2000, class_weight="balanced", random_state=seed))])
    if backend == "mlp":
        # Exactly the layers asked for: none at all is a linear model, as the provenance then says.
        hidden = tuple(layer.units for layer in network.hidden)
        return Pipeline([("scale", StandardScaler()), ("model", MLPClassifier(hidden_layer_sizes=hidden, max_iter=network.epochs, early_stopping=True, random_state=seed))])
    raise TrainingRefused(f"{backend} is not a scikit-learn backend")


# Early stopping holds back this share of the training recordings (at least one) to find the best number of rounds.
EARLY_STOPPING_SHARE = 0.25
EARLY_STOPPING_MIN_RECORDINGS = 3


def early_stopping_epochs(spec: Spec, x_train: np.ndarray, y_train: np.ndarray, groups: np.ndarray, say=lambda _: None) -> int | None:
    """How many rounds a PyTorch network should train: some of the training recordings are held back, the network is trained
    on the rest for its full `epochs` while it is scored on the held-back ones, and the round where it told the gesture
    apart best there (ROC AUC; of those, the lowest loss) is returned. AUC, not loss alone: the loss rises as a network
    grows confident even while it separates the two better, and only the separation matters (the cut-off is fitted
    afterwards). Held back by recording, not window, so the loss says how it does on a session it has not seen.
    None (train the full `epochs`) with fewer than `EARLY_STOPPING_MIN_RECORDINGS` recordings or no split with both kinds
    of window on each side."""
    recordings = sorted(set(groups.tolist()))
    if len(recordings) < EARLY_STOPPING_MIN_RECORDINGS:
        return None
    both = lambda mask: 0 < int(y_train[mask].sum()) < int(mask.sum())  # noqa: E731
    wanted = max(1, int(round(EARLY_STOPPING_SHARE * len(recordings))))
    held: list[str] = []
    # In a random order, hold recordings back until the held-back ones have both kinds of window and are at least the
    # wanted share, never taking one the rest cannot spare (they must keep both kinds too).
    for index in np.random.default_rng(spec.seed).permutation(len(recordings)):
        if len(held) >= wanted and both(np.isin(groups, held)):
            break
        candidate = [*held, recordings[index]]
        if both(~np.isin(groups, candidate)):
            held = candidate
    validation = np.isin(groups, held)
    if not (both(validation) and both(~validation)):
        return None
    count = len(held)
    scores: list[tuple[int, float, float]] = []

    def watch(epoch: int, epochs: int, metrics: dict[str, float]) -> None:
        if "evalLoss" in metrics and "evalAuc" in metrics:
            scores.append((epoch, metrics["evalAuc"], metrics["evalLoss"]))

    fit(spec, x_train[~validation], y_train[~validation], x_train[validation], y_train[validation], watch)
    if not scores:
        return None
    best = min(scores, key=lambda point: (-round(point[1], 4), point[2], point[0]))[0]
    say(f"Early stopping: on {count} held-back training recording(s) it told the gesture apart best after {best} of {spec.network.epochs} rounds")
    return best


def with_early_stopping(spec: Spec, x_train: np.ndarray, y_train: np.ndarray, groups: np.ndarray, say=lambda _: None) -> Spec:
    """`spec` with a PyTorch network's rounds set by `early_stopping_epochs`, once for the run: the final model and every
    model that chooses the cut-off then train the same number. Unchanged for other methods or when it cannot tell."""
    if spec.backend not in ("torch-mlp", "cnn1d"):
        return spec
    best = early_stopping_epochs(spec, x_train, y_train, groups, say)
    return spec if best is None else replace(spec, network=replace(spec.network, epochs=best))


def fit(spec: Spec, x_train: np.ndarray, y_train: np.ndarray, x_eval: np.ndarray | None = None, y_eval: np.ndarray | None = None, on_epoch=None):
    """Trains the model. The held-out windows, when given, are only used to report progress, never to choose anything."""
    missing = "PyTorch is not installed. Run the trainer with the 'torch' extra to use this backend"
    if spec.backend == "cnn1d":
        try:
            model = CnnModel(len(spec.features), spec.grid_steps, spec.seed, spec.params, spec.movement_only, spec.network, names=list(spec.features))
        except ImportError as error:
            raise TrainingRefused(missing) from error
        if spec.pretrained is not None:
            from .pretrain import load_encoder

            model.load_encoder(load_encoder(spec.pretrained)["state"], spec.pretrained_freeze)
        return model.fit(x_train, y_train, x_eval, y_eval, on_epoch)
    if spec.backend == "torch-mlp":
        try:
            model = TorchModel(x_train.shape[1], spec.seed, spec.params, spec.network)
        except ImportError as error:
            raise TrainingRefused(missing) from error
        return model.fit(x_train, y_train, x_eval, y_eval, on_epoch)
    if spec.backend == "gbt":
        from sklearn.utils.class_weight import compute_sample_weight

        # Each kind of window counts as much in total however many there are of it, like the networks' class balancing.
        return make_gbt(spec.seed).fit(x_train, y_train, sample_weight=compute_sample_weight("balanced", y_train))
    model = make_model(spec.backend, x_train.shape[1], spec.seed, spec.params, spec.network).fit(x_train, y_train)
    if spec.backend == "mlp" and on_epoch is not None:
        final = model.named_steps["model"]
        scores = getattr(final, "validation_scores_", None) or []
        for index, loss in enumerate(final.loss_curve_, start=1):
            metrics = {"trainLoss": float(loss)}
            if index - 1 < len(scores):
                metrics["evalAccuracy"] = float(scores[index - 1])  # on windows the network itself held back
            on_epoch(index, len(final.loss_curve_), metrics)
    return model


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
    """The activation threshold that best tells the two kinds of window apart: the highest share of gesture windows found
    less the share of other windows flagged (Youden's J; ties go to fewer false alarms, then the higher threshold).

    A model's scores shift from one recording session to the next, so a fixed 0.8 can sit above every score of a model
    that ranks the windows perfectly; the threshold is therefore fitted (on predictions for recordings the model did not
    see, see `out_of_fold_threshold`). Not by F1: when most windows are the gesture, F1 is best at a threshold that flags
    everything, which is the one thing a detector must not do. J weighs the two kinds of window equally however many of
    each there are.
    """
    best = (-2.0, 0.0, 0.0)
    for threshold in np.round(np.arange(0.05, 0.96, 0.01), 2):
        rates = _rates(probability, y, float(threshold))
        key = (rates["recall"] - rates["falseActivationRate"], -rates["falseActivationRate"], float(threshold))
        if key > best:
            best = key
    return best[2]


def out_of_fold_threshold(spec: Spec, x_train: np.ndarray, y_train: np.ndarray, train_groups: np.ndarray, say=lambda _: None) -> tuple[float, str, float | None]:
    """The cut-off, chosen without looking at the held-out recordings: the training recordings are split into groups by
    recording, a model is trained on all groups but one and scores the one left out, for each in turn, and the cut-off with
    the best F1 on those scores is taken. Every score comes from a model that never saw that recording, as on the held-out
    ones, so the cut-off carries over and the held-out numbers at it are honest.

    Returns the cut-off, where it came from ("trainingRecordings", or "default" (`ACTIVATION`) when the training
    recordings are too few to judge each other: fewer than two, or no fold with both kinds of window to learn from), and
    the ROC AUC of those scores taken together: how well a model trained on some of the training recordings tells the
    gesture apart in the others, with one cut-off for all of them (None when there is nothing to judge)."""
    from sklearn.metrics import roc_auc_score

    groups = sorted(set(train_groups.tolist()))
    if len(groups) < 2:
        return ACTIVATION, "default", None
    folds = min(MAX_THRESHOLD_FOLDS, len(groups))
    fold_of = {group: index % folds for index, group in enumerate(groups)}
    fold = np.array([fold_of[g] for g in train_groups.tolist()])
    held_out = np.full(y_train.shape[0], np.nan)
    say(f"Choosing the cut-off on the training recordings: training {folds} more times, each without some of them")
    for k in range(folds):
        test = fold == k
        train = ~test
        if int(y_train[train].sum()) < MIN_POSITIVE_TRAIN_WINDOWS or int((y_train[train] == 0).sum()) < MIN_POSITIVE_TRAIN_WINDOWS:
            continue
        model = fit(spec, x_train[train], y_train[train])
        held_out[test] = model.predict_proba(x_train[test])[:, 1]
    judged = ~np.isnan(held_out)
    if not judged.any() or not 0 < int(y_train[judged].sum()) < int(judged.sum()):
        return ACTIVATION, "default", None
    scores, truth = held_out[judged], y_train[judged]
    return choose_threshold(scores, truth), "trainingRecordings", float(roc_auc_score(truth, scores))


def edited_threshold(source: Path) -> tuple[float, str]:
    """The cut-off of the model an edit started from (its manifest), or the default if it has none."""
    manifest = source / "bundle" / "manifest.json"
    try:
        return float(json.loads(manifest.read_text())["thresholds"]["activation"]), "editedFrom"
    except (OSError, KeyError, TypeError, ValueError):
        return ACTIVATION, "default"


def evaluate(probability: np.ndarray, y: np.ndarray, threshold: float, threshold_source: str) -> dict[str, Any]:
    """The held-out windows' numbers at `threshold`, which must not have been chosen on them (see `out_of_fold_threshold`)."""
    from sklearn.metrics import roc_auc_score

    chosen = _rates(probability, y, threshold)
    return {
        "windows": int(y.shape[0]),
        "positiveWindows": int(y.sum()),
        "negativeWindows": int((y == 0).sum()),
        # Does the model rank the gesture's windows above the rest at all? 0.5 is chance; under 0.5 it is backwards.
        "rocAuc": float(roc_auc_score(y, probability)),
        "activationThreshold": threshold,
        "thresholdSource": threshold_source,
        "thresholdChosenOnEvaluationRecordings": threshold_source == "evaluationRecordings",
        **{k: v for k, v in chosen.items() if k != "threshold"},
        # The share of each kind of window it gets right, averaged: unlike F1 or accuracy it does not look better just
        # because the held-out recordings happen to hold mostly one kind.
        "balancedAccuracy": (chosen["recall"] + 1.0 - chosen["falseActivationRate"]) / 2.0,
        "atDefaultThreshold": _rates(probability, y, ACTIVATION),
        **calibration(probability, y),
    }


CALIBRATION_BINS = 10


def calibration(probability: np.ndarray, y: np.ndarray) -> dict[str, float]:
    """Whether the scores can be read as probabilities on the held-out windows: the Brier score (the mean squared gap
    between score and truth; 0 is perfect, 0.25 is a constant 0.5) and the expected calibration error (scores split into
    ten equal bins, the gap between each bin's average score and its share of gesture windows, weighted by its size: 0.1
    means a score of 0.8 is right about 70% or 90% of the time). The cut-off does not need them; they say how much a
    score itself can be trusted, as the Inspect view's calibration chart shows."""
    probability = np.asarray(probability, dtype=np.float64)
    bins = np.minimum((probability * CALIBRATION_BINS).astype(int), CALIBRATION_BINS - 1)
    gap = 0.0
    for b in range(CALIBRATION_BINS):
        members = bins == b
        if members.any():
            gap += float(members.mean()) * abs(float(probability[members].mean()) - float(y[members].mean()))
    return {"brierScore": float(np.mean((probability - y) ** 2)), "expectedCalibrationError": gap}


def replay(spec: Spec, model, recordings: dict[str, Recording], threshold: float) -> dict[str, Any]:
    """The model as a detector over the held-out recordings: every window the runtime would score, in time order, through
    the runtime's detection rule, matched with the gestures in the labels (see `events.py`)."""
    policy = Policy.for_threshold(threshold)
    excluded = set(spec.excludes)
    per_recording = []
    for rid in sorted(spec.evaluation):
        recording = recordings[rid]
        x, windows = window_inputs(spec, recording, continuous_windows(recording, spec.window))
        if not windows:
            continue
        ends = np.array([w.end_ns for w in windows], dtype=np.int64)
        scores = model.predict_proba(x)[:, 1]
        detections = detect(ends, scores, policy)
        # Scored time: from one window's end to the next, unless the stream stopped in between.
        step = int(round(max(spec.window.stride_ms, spec.window.max_gap_ms) * 1_000_000))
        breaks = np.flatnonzero(np.diff(ends) > step) + 1
        bounds = [0, *breaks.tolist(), ends.shape[0]]
        observed = [(int(ends[a]), int(ends[b - 1])) for a, b in zip(bounds, bounds[1:])]
        labels = recording.raw_labels
        per_recording.append(match_events(
            detections,
            labelled_spans(recording, labels == spec.target),
            labelled_spans(recording, np.isin(labels, list(excluded))) if excluded else [],
            observed,
            spec.window.window_ms,
        ))
    return {**summarise(per_recording), "policy": {"activation": policy.activation, "release": policy.release}}


MIN_AUC = 0.7
MIN_BALANCED_ACCURACY = 0.7
# The share of held-out windows of something else it may flag.
MAX_FALSE_ACTIVATION_RATE = 0.1
# Over whole held-out recordings, how often it may fire when there is no gesture, and the least time without a gesture
# needed to say: fewer seconds than this and a model that fires once a minute could look perfect.
MAX_FALSE_ACTIVATIONS_PER_HOUR = 30.0
MIN_NEGATIVE_SECONDS = 60.0
MIN_GESTURE_RECALL = 0.5
MORE_DATA = ". Record more sessions of the gesture (at least three, in different positions), or change what the model may read"


def verdict(metrics: dict[str, Any]) -> str | None:
    """Why a model is not worth keeping, in words; None when it is good enough to review."""
    auc = metrics["rocAuc"]
    if auc < 0.5:
        return (
            f"It scored the gesture's windows *lower* than the others on recordings it had not seen (AUC {auc:.2f}; 0.5 is chance). "
            "It memorised the training recordings rather than the gesture" + MORE_DATA
        )
    if auc < MIN_AUC:
        return f"It could barely tell the gesture from the rest on recordings it had not seen (AUC {auc:.2f}; at least {MIN_AUC} is needed)" + MORE_DATA
    cross = metrics.get("crossCheckRocAuc")
    if cross is not None and cross < MIN_AUC:
        return (
            f"The training recordings do not agree with each other: trained on some of them, it could not tell the gesture "
            f"apart in the others (AUC {cross:.2f}; at least {MIN_AUC} is needed), so doing well on the test recordings was "
            "luck. It has probably learnt each session's levels rather than the gesture: try “Only how things change”, or "
            "record more sessions"
        )
    threshold = metrics["activationThreshold"]
    if metrics["balancedAccuracy"] < MIN_BALANCED_ACCURACY:
        return (
            f"At its cut-off ({threshold:.2f}) it found {metrics['recall']:.0%} of the gesture's windows and wrongly flagged "
            f"{metrics['falseActivationRate']:.0%} of the others on recordings it had not seen (balanced accuracy "
            f"{metrics['balancedAccuracy']:.2f}; at least {MIN_BALANCED_ACCURACY} is needed)" + MORE_DATA
        )
    if metrics["falseActivationRate"] > MAX_FALSE_ACTIVATION_RATE:
        return (
            f"At its cut-off ({threshold:.2f}) it wrongly flagged {metrics['falseActivationRate']:.0%} of the windows of "
            f"something else on recordings it had not seen (at most {MAX_FALSE_ACTIVATION_RATE:.0%} is allowed)" + MORE_DATA
        )
    events = metrics.get("events")
    if events is None:
        return None
    if events["negativeSeconds"] < MIN_NEGATIVE_SECONDS:
        already = (
            f" (it already went off {events['falseActivations']} time{'s' if events['falseActivations'] != 1 else ''} in them)"
            if events["falseActivations"]
            else ""
        )
        return (
            f"The held-out recordings hold only {events['negativeSeconds']:.0f} s without the gesture{already}, too little to tell "
            f"how often it would fire by mistake (at least {MIN_NEGATIVE_SECONDS:.0f} s is needed). Record a few minutes of "
            "ordinary activity (typing, using the mouse, resting, moving about) labelled as something else, in sessions of its own"
        )
    per_hour = events["falseActivationsPerHour"]
    if per_hour is not None and per_hour > MAX_FALSE_ACTIVATIONS_PER_HOUR:
        return (
            f"Replayed over the held-out recordings it fired {events['falseActivations']} times without the gesture, about "
            f"{per_hour:.0f} times an hour (at most {MAX_FALSE_ACTIVATIONS_PER_HOUR:.0f} is allowed). Record more ordinary "
            "activity labelled as something else, so it learns what to ignore"
        )
    recall = events["gestureRecall"]
    if recall is not None and recall < MIN_GESTURE_RECALL:
        return (
            f"Replayed over the held-out recordings it caught {events['caught']} of {events['gestures']} gestures "
            f"(at least {MIN_GESTURE_RECALL:.0%} is needed)" + MORE_DATA
        )
    return None


# The operators the desktop's runtime (tract) can run. An exported file using anything else is refused here, where the
# reason can be explained, instead of failing to load on the desktop. Notably absent: the scikit-learn converter's
# `Scaler`, `LinearClassifier` and (as exported by it) `TreeEnsembleClassifier`, so the dense models and the boosted trees
# are written by hand below.
RUNNABLE_OPERATORS = {
    ("", "Add"), ("", "Sub"), ("", "Mul"), ("", "Div"), ("", "MatMul"), ("", "Gemm"), ("", "Relu"), ("", "Sigmoid"),
    ("", "Softmax"), ("", "Concat"), ("", "Identity"), ("", "Constant"), ("", "Cast"), ("", "Reshape"), ("", "Flatten"),
    ("", "Transpose"), ("", "Unsqueeze"), ("", "Squeeze"),
    # What a tree ensemble adds (see `tree_ensemble_onnx`): the comparison at each split.
    ("", "LessOrEqual"),
    # What the convolutional model adds: convolutions, and pooling over time.
    ("", "Conv"), ("", "ReduceMean"), ("", "ReduceMax"),
    # The other activations a network can be given.
    ("", "Tanh"), ("", "LeakyRelu"),
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


# Gradient-boosted trees: small trees, many of them, each fitted to what the ones before got wrong. With few recordings they
# often beat a network on statistics, and they need no scaling.
GBT_TREES = 150
GBT_DEPTH = 3
GBT_LEARNING_RATE = 0.1
GBT_SUBSAMPLE = 0.8


def make_gbt(seed: int):
    from sklearn.ensemble import GradientBoostingClassifier

    return GradientBoostingClassifier(
        n_estimators=GBT_TREES, max_depth=GBT_DEPTH, learning_rate=GBT_LEARNING_RATE, subsample=GBT_SUBSAMPLE, random_state=seed,
    )


def tree_ensemble_onnx(model, x_sample: np.ndarray, path: Path) -> int:
    """Writes a scikit-learn `GradientBoostingClassifier` (two classes) as plain ONNX the desktop's runtime can run.

    scikit-learn's own converter writes `TreeEnsembleClassifier`, which the runtime cannot load, so the trees are written
    as matrix arithmetic instead. Every split k of every tree reads one feature f_k and goes left when x[f_k] <= t_k:
    `X @ A` (A one-hot, features x splits) picks each split's feature, and `LessOrEqual` against the thresholds gives 1
    for left, 0 for right. A leaf is reached when every split on its path went its way: with C (splits x leaves) +1 where
    the path goes left and -1 where it goes right, `went @ C` equals the number of left turns on the leaf's path only for
    the leaf that was reached and is at least 1 short of it for every other, so `Relu(went @ C - lefts + 1)` is 1 for the
    reached leaf of each tree and 0 elsewhere. Those times each leaf's value (already times the learning rate), plus the
    starting score, is the model's score, and a sigmoid makes it the probability. Every count is a small whole number, so
    it is exact in single precision.
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    features = x_sample.shape[1]
    splits: list[tuple[int, float]] = []
    leaves: list[tuple[float, dict[int, int]]] = []  # (value, {split: +1 left / -1 right})
    for estimator in model.estimators_[:, 0]:
        tree = estimator.tree_
        index_of: dict[int, int] = {}
        for node in range(tree.node_count):
            if tree.children_left[node] != -1:
                index_of[node] = len(splits)
                splits.append((int(tree.feature[node]), float(tree.threshold[node])))

        def walk(node: int, route: dict[int, int]) -> None:
            if tree.children_left[node] == -1:
                leaves.append((float(tree.value[node].ravel()[0]) * model.learning_rate, route))
                return
            walk(int(tree.children_left[node]), {**route, index_of[node]: 1})
            walk(int(tree.children_right[node]), {**route, index_of[node]: -1})

        walk(0, {})
    # The starting score (the prior's log-odds): what the decision function adds to the trees' sum.
    trees_sum = sum(model.learning_rate * estimator.predict(x_sample[:1]) for estimator in model.estimators_[:, 0])
    offset = float(model.decision_function(x_sample[:1])[0] - trees_sum[0])

    k, n_leaves = max(len(splits), 1), len(leaves)
    pick = np.zeros((features, k), dtype=np.float32)
    thresholds = np.full((1, k), np.float32(np.inf), dtype=np.float32)
    for index, (feature, threshold) in enumerate(splits):
        pick[feature, index] = 1.0
        thresholds[0, index] = np.float32(threshold)
    paths = np.zeros((k, n_leaves), dtype=np.float32)
    lefts = np.zeros((1, n_leaves), dtype=np.float32)
    values = np.zeros((n_leaves, 1), dtype=np.float32)
    for leaf, (value, route) in enumerate(leaves):
        for split, direction in route.items():
            paths[split, leaf] = direction
        lefts[0, leaf] = sum(1 for direction in route.values() if direction == 1)
        values[leaf, 0] = value
    arrays = {
        "PICK": pick, "THRESHOLDS": thresholds, "PATHS": paths, "LEFTS_LESS_ONE": lefts - 1.0, "VALUES": values,
        "OFFSET": np.array([[offset]], dtype=np.float32), "ONE": np.array([[1.0]], dtype=np.float32),
    }
    nodes = [
        helper.make_node("MatMul", ["X", "PICK"], ["PICKED"]),
        helper.make_node("LessOrEqual", ["PICKED", "THRESHOLDS"], ["LEFT"]),
        helper.make_node("Cast", ["LEFT"], ["WENT"], to=TensorProto.FLOAT),
        helper.make_node("MatMul", ["WENT", "PATHS"], ["AGREED"]),
        helper.make_node("Sub", ["AGREED", "LEFTS_LESS_ONE"], ["MARGIN"]),
        helper.make_node("Relu", ["MARGIN"], ["REACHED"]),
        helper.make_node("MatMul", ["REACHED", "VALUES"], ["SUMMED"]),
        helper.make_node("Add", ["SUMMED", "OFFSET"], ["SCORE"]),
        helper.make_node("Sigmoid", ["SCORE"], ["P"]),
        helper.make_node("Sub", ["ONE", "P"], ["Q"]),
        helper.make_node("Concat", ["Q", "P"], ["probabilities"], axis=1),
    ]
    graph = helper.make_graph(
        nodes,
        "label_model",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [None, features])],
        [helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [None, 2])],
        [numpy_helper.from_array(array, name) for name, array in arrays.items()],
    )
    exported = helper.make_model(graph, opset_imports=[helper.make_opsetid("", ONNX_OPSET)])
    exported.ir_version = 8
    onnx.checker.check_model(exported)
    path.write_bytes(exported.SerializeToString())
    return ONNX_OPSET


def export_onnx(spec: Spec, model, x_sample: np.ndarray, path: Path) -> int:
    """Writes the ONNX file and returns the opset it was written with."""
    if spec.backend in ("torch-mlp", "cnn1d"):
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
    if spec.backend == "gbt":
        opset = tree_ensemble_onnx(model, x_sample, path)
        check_runnable(path)
        return opset
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
    if spec.backend in ("torch-mlp", "cnn1d"):
        import torch

        return {"name": "pytorch", "version": torch.__version__.split("+")[0]}
    import sklearn

    return {"name": "scikit-learn", "version": sklearn.__version__}


# The range of values an input usually takes in the training windows: from the 1st to the 99th percentile. A live window
# whose inputs are far outside it is something this model has never seen, so its answer means little.
RANGE_LOW_PERCENT = 1
RANGE_HIGH_PERCENT = 99
RANGE_MIN_WINDOWS = 20


def training_range(spec: Spec, x_train: np.ndarray) -> dict[str, list[float]] | None:
    """Per input (per column, for a model that reads columns over steps), the usual low and high of its value in the training
    windows. None when there is too little to say, or when the model takes the window's own level away (the level is then
    nothing the model uses)."""
    if x_train.shape[0] < RANGE_MIN_WINDOWS:
        return None
    if spec.backend == "cnn1d" and spec.movement_only:
        return None
    if reads_grid(spec):
        channels = len(spec.features)
        values = x_train.reshape(x_train.shape[0], channels, spec.grid_steps)  # channel after channel, as the model reads it
        columns = [values[:, index, :].ravel() for index in range(channels)]
    else:
        columns = [x_train[:, index] for index in range(x_train.shape[1])]
    round_ = lambda value: float(f"{value:.8g}")  # noqa: E731
    return {
        "low": [round_(np.percentile(column, RANGE_LOW_PERCENT)) for column in columns],
        "high": [round_(np.percentile(column, RANGE_HIGH_PERCENT)) for column in columns],
    }


def write_bundle(spec: Spec, out: Path, model_bytes: bytes, opset: int, metrics: dict[str, Any], x_train: np.ndarray | None = None) -> str:
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
        "input": (
            # A convolutional model: the channels (one flat row of channels x steps numbers), and how many steps each has.
            {"name": "X", "shape": [None, input_count(spec)], "dtype": "float32", "features": spec.features, "grid": {"steps": spec.grid_steps, "timing": spec.grid_timing, **({"pulse": "recentPast"} if grid_pulse_baseline(spec) else {})}}
            if reads_grid(spec)
            else {"name": "X", "shape": [None, len(spec.features)], "dtype": "float32", "features": spec.features}
        ),
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
        "preprocessing": {
            **({"kind": "spike_extraction", "method": spec.spike_method} if spec.spike_method else {"kind": "none"}),
            **({"baselineMs": spec.baseline_ms} if spec.baseline_ms else {}),
        },
        "provenance": {
            "backend": spec.backend,
            "trainRecordings": sorted(spec.train),
            "evaluationRecordings": sorted(spec.evaluation),
            "seed": spec.seed,
            "evaluationF1": metrics["f1"],
            "evaluationFalseActivationRate": metrics["falseActivationRate"],
            "evaluationRocAuc": metrics["rocAuc"],
            "evaluationBalancedAccuracy": metrics["balancedAccuracy"],
            "evaluationFalseActivationsPerHour": (metrics.get("events") or {}).get("falseActivationsPerHour"),
            "thresholdSource": metrics["thresholdSource"],
            "thresholdChosenOnEvaluationRecordings": metrics["thresholdChosenOnEvaluationRecordings"],
            "movementOnly": spec.movement_only,
            "spikeMethod": spec.spike_method or "none",
            "baselineMs": spec.baseline_ms,
            "ppgChannels": spec.ppg_channels,
            "labelOffsetMs": spec.label_offset_ms,
            "windowing": spec.windowing,
            "pretrained": (
                {"file": spec.pretrained.name, "sha256": hashlib.sha256(spec.pretrained.read_bytes()).hexdigest(), "frozen": spec.pretrained_freeze}
                if spec.pretrained is not None
                else None
            ),
            "gridSteps": spec.grid_steps if reads_grid(spec) else None,
            "inputMode": "raw" if spec.raw_columns else ("grid" if spec.backend == "cnn1d" else "statistics"),
            "editedFrom": spec.edit.get("fromModel") if spec.edit else None,
            "edits": spec.edit["edits"] if spec.edit else None,
            "fineTune": spec.edit.get("fineTune") if spec.edit else None,
            "network": spec.network.as_dict() if spec.backend in ("mlp", "torch-mlp", "cnn1d") else None,
            "parameters": parameter_count(spec.network, network_inputs(spec), spec.backend) if spec.backend in ("mlp", "torch-mlp", "cnn1d") else None,
        },
    }
    usual = training_range(spec, x_train) if x_train is not None else None
    if usual is not None:
        manifest["input"]["trainingRange"] = usual
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return sha


def run_research_checks(spec: Spec) -> dict[str, Any] | None:
    """The learning curve and leave-one-recording-out (see `research.py`). An extra: if it fails the model is still shipped."""
    try:
        from .research import run_research

        x, y, groups, _ = build_all(spec)

        def say(message: str) -> None:
            print(message, flush=True)

        say("Running the research checks: they retrain the model several times, so this takes a while")
        return run_research(lambda xs, ys: fit(spec, xs, ys), x, y, groups, spec.train, spec.evaluation, spec.seed, say)
    except Exception as error:  # noqa: BLE001 - an extra must never stop a model being shipped
        print(f"could not run the research checks: {type(error).__name__}: {error}", flush=True)
        return None


def write_inspection(spec: Spec, model, x_eval, y_eval, eval_windows, curve, metrics, out: Path, research: dict[str, Any] | None = None, edit: dict[str, Any] | None = None) -> None:
    """Writes `inspection.json` for the Inspect view. It is an extra: if it cannot be made, the model is still shipped."""
    if spec.backend not in ("logreg", "mlp", "torch-mlp", "cnn1d"):
        return
    try:
        from .inspection import build_inspection

        parameters = parameter_count(spec.network, network_inputs(spec), spec.backend) if spec.backend in ("mlp", "torch-mlp", "cnn1d") else input_count(spec) + 1
        inspection = build_inspection(spec, model, x_eval, y_eval, eval_windows, curve, metrics, parameters)
        if inspection is not None:
            inspection["research"] = research
            inspection["edit"] = edit
            (out / "inspection.json").write_text(json.dumps(inspection) + "\n")
    except Exception as error:  # noqa: BLE001 - an extra must never stop a model being shipped
        print(f"could not write the inspection: {type(error).__name__}: {error}", flush=True)


def run(raw_spec: dict[str, Any], out: Path) -> dict[str, Any]:
    """Trains and writes everything under `out`. Returns the result (also written as `result.json`)."""
    out.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"outcome": "failed", "message": ""}
    try:
        spec = parse_spec(raw_spec)
        recordings = load_spec_recordings(spec)
        x_train, y_train, x_eval, y_eval, eval_windows, train_groups = build_matrices_with_groups(spec, recordings)
        check_enough(y_train, y_eval)
        curve: list[dict[str, Any]] = []

        def on_epoch(epoch: int, epochs: int, metrics: dict[str, float]) -> None:
            point = {"epoch": epoch, "epochs": epochs, **metrics}
            curve.append(point)
            print("@curve " + json.dumps(point), flush=True)  # the desktop draws these while the trainer runs

        edit_note: dict[str, Any] | None = None
        if spec.edit:
            # Not trained: an existing model, changed by hand, then scored on the same held-out windows like any other.
            from .edits import apply_edits, fine_tune_model, parameters_of, pins_from, restore_model

            source = Path(spec.edit["fromDir"])
            model = restore_model(spec, source)
            settings = spec.edit.get("fineTune")
            if not spec.edit["edits"] and settings is None:
                raise EditRefused("there is nothing to change")
            before_edit = parameters_of(spec, model) if settings and spec.backend in ("torch-mlp", "cnn1d") else None
            said = apply_edits(spec, model, spec.edit["edits"]) if spec.edit["edits"] else []
            for line in said:
                print(f"Edit: {line}", flush=True)
            if (source / "training_curve.json").is_file():
                curve = json.loads((source / "training_curve.json").read_text())
            if settings is not None:
                pins = pins_from(before_edit, parameters_of(spec, model)) if before_edit is not None else {}
                curve = []  # the curve of this run is the fine-tuning
                said.append(fine_tune_model(spec, model, x_train, y_train, x_eval, y_eval, settings, pins, on_epoch, train_groups))
                print(f"Edit: {said[-1]}", flush=True)
            before = json.loads((source / "evaluation.json").read_text()) if (source / "evaluation.json").is_file() else None
            edit_note = {"fromModel": spec.edit.get("fromModel"), "edits": spec.edit["edits"], "fineTune": settings, "said": said, "before": before}
        else:
            spec = with_early_stopping(spec, x_train, y_train, train_groups, lambda line: print(line, flush=True))
            model = fit(spec, x_train, y_train, x_eval, y_eval, on_epoch)
        if curve:
            (out / "training_curve.json").write_text(json.dumps(curve) + "\n")
        if spec.edit:
            # An edited model keeps the cut-off of the model it came from: retraining it on parts of the training
            # recordings would not be the edited model any more.
            threshold, source = edited_threshold(Path(spec.edit["fromDir"]))
            cross_check = None
        else:
            threshold, source, cross_check = out_of_fold_threshold(spec, x_train, y_train, train_groups, lambda line: print(line, flush=True))
        probability = model.predict_proba(x_eval)[:, 1]
        metrics = evaluate(probability, y_eval, threshold, source)
        metrics["crossCheckRocAuc"] = cross_check
        # Rounds actually trained (fewer than asked for when early stopping found the held-back loss lowest sooner).
        metrics["epochsTrained"] = curve[-1]["epochs"] if curve and spec.backend in ("torch-mlp", "cnn1d") and not spec.edit else None
        metrics["events"] = replay(spec, model, recordings, threshold)
        (out / "evaluation.json").write_text(json.dumps(metrics, indent=2) + "\n")
        poor = verdict(metrics)
        if poor is not None:
            result = {
                "outcome": "evaluationOnly",
                "message": poor,
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
        sha = write_bundle(spec, out, scratch.read_bytes(), opset, metrics, x_train)
        research = run_research_checks(spec) if spec.research else None
        if edit_note is not None:
            edit_note["after"] = metrics
        write_inspection(spec, model, x_eval, y_eval, eval_windows, curve, metrics, out, research, edit_note)
        if spec.backend in ("logreg", "mlp", "torch-mlp", "cnn1d"):
            from .edits import persist_model

            persist_model(spec, model, out)  # so this model can be edited in turn
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
    except EditRefused as refusal:
        result["message"] = str(refusal)
    except Exception as error:  # noqa: BLE001 - any failure must be reported, not crash without a result
        result["message"] = f"{type(error).__name__}: {error}"
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def backfill_range(raw_spec: dict[str, Any], manifests: list[Path]) -> dict[str, Any]:
    """Works out the usual range of each input of a model that was trained before the manifest recorded one, from the
    windows it was trained on, and writes it into the model's manifest(s). Nothing else about the model changes: the model
    file, its hash and its answers are untouched. Refused if the recordings are gone or the settings no longer name the
    inputs the manifest lists."""
    try:
        spec = parse_spec(raw_spec)
        x_train, *_ = build_matrices(spec)
    except FileNotFoundError as missing:
        raise TrainingRefused(f"a recording this model was trained on is no longer there ({Path(str(missing.filename)).name}), so its range cannot be worked out") from missing
    usual = training_range(spec, x_train)
    if usual is None:
        return {"outcome": "none", "message": "this model has no range to record: it either takes the window's own level away or was trained on too few windows"}
    for path in manifests:
        manifest = json.loads(path.read_text())
        if manifest["input"]["features"] != spec.features:
            raise TrainingRefused(f"the saved training settings do not name the inputs {path.parent.name} reads, so its range was not written")
        manifest["input"]["trainingRange"] = usual
        scratch = path.with_suffix(".json.tmp")
        scratch.write_text(json.dumps(manifest, indent=2) + "\n")
        scratch.replace(path)
    return {"outcome": "written", "message": f"recorded the range of {len(usual['low'])} inputs from {x_train.shape[0]} training windows", "inputs": len(usual["low"]), "windows": int(x_train.shape[0])}


# The label offsets (milliseconds) tried when looking for the timing that fits the recordings best.
OFFSET_CANDIDATES_MS: tuple[int, ...] = (-1000, -750, -500, -250, 0, 250, 500, 750, 1000, 1250, 1500)


def suggest_label_offset(raw_spec: dict[str, Any], candidates: tuple[int, ...] = OFFSET_CANDIDATES_MS) -> list[dict[str, Any]]:
    """How well the recordings separate the gesture from the rest at each label offset, so the one that fits best can be chosen.

    For each candidate the windows are rebuilt with the labels moved that far, then a logistic regression on the spec's inputs
    is trained on all recordings but one and scored on the one left out, for each recording in turn; the score is the ROC AUC
    over all the left-out windows together. Every recording is judged by a model that never saw it, so the offset that scores
    best is the one that carries over, not one that fits the training recordings. (It is chosen using all of them, so the
    score at the chosen offset is a little optimistic.)"""
    from sklearn.metrics import roc_auc_score

    base = {**raw_spec, "backend": "logreg", "research": False}
    base.pop("network", None)
    base.pop("edit", None)
    if raw_spec.get("backend") == "cnn1d":
        base.update({"inputMode": "raw", "gridSteps": 8})  # a convolutional model's columns, read by a simple model
    results: list[dict[str, Any]] = []
    for offset in candidates:
        spec = parse_spec({**base, "labelOffsetMs": offset})
        x, y, groups, _ = build_all(spec)
        held_out = np.full(y.shape[0], np.nan)
        for group in sorted(set(groups.tolist())):
            test = groups == group
            train = ~test
            if int(y[train].sum()) < MIN_POSITIVE_TRAIN_WINDOWS or int((y[train] == 0).sum()) < MIN_POSITIVE_TRAIN_WINDOWS:
                continue
            model = make_model("logreg", x.shape[1], spec.seed, {}, None).fit(x[train], y[train])
            held_out[test] = model.predict_proba(x[test])[:, 1]
        judged = ~np.isnan(held_out)
        scoreable = bool(judged.any()) and 0 < int(y[judged].sum()) < int(judged.sum())
        results.append({
            "offsetMs": offset,
            "auc": round(float(roc_auc_score(y[judged], held_out[judged])), 4) if scoreable else None,
            "windows": int(judged.sum()),
            "positives": int(y[judged].sum()),
        })
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, help="the training spec the desktop wrote")
    parser.add_argument("--pretrain-microdpad", type=Path, metavar="ROOT", help="pre-train a motion encoder on the MicroDPad dataset at ROOT and save it to --out (see pretrain.py)")
    parser.add_argument("--out", type=Path, help="directory for the results")
    parser.add_argument("--backfill-range", action="store_true", help="work out and record the training range of an existing model instead of training")
    parser.add_argument("--suggest-offset", action="store_true", help="try label offsets and say how well each fits the recordings, instead of training")
    parser.add_argument("--manifest", action="append", type=Path, default=[], help="with --backfill-range: a manifest to write the range into (repeatable)")
    parser.add_argument("--compare", action="store_true", help="train every method on the spec's recordings and split, and print them side by side (see compare.py)")
    args = parser.parse_args(argv)
    if args.pretrain_microdpad is not None:
        if args.out is None:
            parser.error("--out is required to pre-train (the encoder file)")
        from .pretrain import pretrain

        metrics = pretrain(args.pretrain_microdpad, args.out, say=lambda line: print(line, flush=True))
        print(json.dumps({"outcome": "ok", "metrics": {k: v for k, v in metrics.items() if k != "heldOutPeople"}}), flush=True)
        return 0
    if args.spec is None:
        parser.error("--spec is required")
    if args.compare:
        if args.out is None:
            parser.error("--out is required to compare")
        from .compare import compare, table

        print(table(compare(json.loads(args.spec.read_text()), args.out)), flush=True)
        return 0
    if args.backfill_range:
        try:
            done = backfill_range(json.loads(args.spec.read_text()), args.manifest)
        except TrainingRefused as refusal:
            done = {"outcome": "refused", "message": str(refusal)}
        print(json.dumps(done), flush=True)
        return 0 if done["outcome"] in ("written", "none") else 2
    if args.suggest_offset:
        try:
            scores = suggest_label_offset(json.loads(args.spec.read_text()))
            print(json.dumps({"outcome": "ok", "scores": scores}), flush=True)
            return 0
        except TrainingRefused as refusal:
            print(json.dumps({"outcome": "refused", "message": str(refusal)}), flush=True)
            return 2
    if args.out is None:
        parser.error("--out is required to train")
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
