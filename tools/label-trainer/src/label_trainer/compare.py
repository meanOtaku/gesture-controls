"""Trains every method on the same recordings, split and settings, and puts the numbers that matter side by side.

    uv run --extra onnx --extra torch label-classifier-train --compare --spec spec.json --out compare-dir

Each method gets the spec's target, roles, recordings, train/evaluation split, streams, window, label offset, pulse
channels, baseline and "only how things change", and its own default inputs and network (a convolutional network reads
the window's channels, the others its statistics). Each run is an ordinary training run in `<out>/<method>`; `compare.json`
holds the table. The PyTorch methods are left out when PyTorch is not installed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import label_train as lt

METHODS = ("logreg", "gbt", "mlp", "torch-mlp", "cnn1d")
# The settings every method shares; anything else (chosen inputs, input mode, network, an edit) belongs to one method.
SHARED_KEYS = (
    "version", "target", "negatives", "excludes", "recordings", "train", "evaluation", "sources", "window", "seed",
    "labelOffsetMs", "ppgChannels", "baselineMs", "movementOnly", "spikeMethod", "windowing",
)


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


def spec_for_method(raw_spec: dict[str, Any], method: str) -> dict[str, Any]:
    spec = {key: raw_spec[key] for key in SHARED_KEYS if key in raw_spec}
    spec["backend"] = method
    return spec


def row(method: str, result: dict[str, Any]) -> dict[str, Any]:
    metrics = result.get("metrics") or {}
    events = metrics.get("events") or {}
    return {
        "method": method,
        "outcome": result["outcome"],
        "rocAuc": metrics.get("rocAuc"),
        "crossCheckRocAuc": metrics.get("crossCheckRocAuc"),
        "balancedAccuracy": metrics.get("balancedAccuracy"),
        "falseActivationRate": metrics.get("falseActivationRate"),
        "brierScore": metrics.get("brierScore"),
        "gesturesCaught": f"{events['caught']}/{events['gestures']}" if events else None,
        "falseActivationsPerHour": events.get("falseActivationsPerHour"),
        "message": result.get("message", ""),
    }


def compare(raw_spec: dict[str, Any], out: Path, methods: tuple[str, ...] = METHODS) -> list[dict[str, Any]]:
    out.mkdir(parents=True, exist_ok=True)
    torch = _torch_available()
    rows = []
    for method in methods:
        if method in ("torch-mlp", "cnn1d") and not torch:
            rows.append({"method": method, "outcome": "skipped", "message": "PyTorch is not installed (add --extra torch)"})
            continue
        print(f"Training {method}", flush=True)
        rows.append(row(method, lt.run(spec_for_method(raw_spec, method), out / method)))
    (out / "compare.json").write_text(json.dumps(rows, indent=2) + "\n")
    return rows


def table(rows: list[dict[str, Any]]) -> str:
    """The rows as a plain-text table, best first by cross-check AUC (how well the training recordings agree)."""
    def number(value, digits=2):
        return "-" if value is None else f"{value:.{digits}f}"

    header = f"{'method':<10} {'outcome':<15} {'AUC':>5} {'cross':>5} {'bal.acc':>7} {'FA rate':>7} {'Brier':>5} {'caught':>7} {'FA/hour':>8}"
    ordered = sorted(rows, key=lambda r: -(r.get("crossCheckRocAuc") or -1))
    lines = [header, "-" * len(header)]
    for r in ordered:
        lines.append(
            f"{r['method']:<10} {r['outcome']:<15} {number(r.get('rocAuc')):>5} {number(r.get('crossCheckRocAuc')):>5} "
            f"{number(r.get('balancedAccuracy')):>7} {number(r.get('falseActivationRate')):>7} {number(r.get('brierScore')):>5} "
            f"{r.get('gesturesCaught') or '-':>7} {number(r.get('falseActivationsPerHour'), 0):>8}"
        )
    return "\n".join(lines)
