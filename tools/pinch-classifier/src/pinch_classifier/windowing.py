"""Builds fixed-duration, overlapping windows from a parsed Recording.

Windows never cross a label boundary or a timing discontinuity: we first split
each recording into contiguous same-label segments (splitting wherever the
gap between consecutive samples exceeds `max_gap_ms`), then slide a
fixed-duration window across each segment independently.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .csv_io import Recording

MS_TO_NS = 1_000_000

# Defaults sized for the recorder's merged watch orientation (~50 Hz-class
# accel/gyro/quat) + PPG (~25 Hz-class) stream: a 500 ms window comfortably
# spans multiple samples of both, a 150 ms stride gives ~3x overlap, and a
# 250 ms gap threshold tolerates normal jitter while still splitting on real
# dropouts. Override via CLI flags for other capture rates.
DEFAULT_WINDOW_MS = 500.0
DEFAULT_STRIDE_MS = 150.0
DEFAULT_MAX_GAP_MS = 250.0
DEFAULT_MIN_SAMPLES_PER_WINDOW = 3


@dataclass(frozen=True)
class WindowConfig:
    window_ms: float = DEFAULT_WINDOW_MS
    stride_ms: float = DEFAULT_STRIDE_MS
    max_gap_ms: float = DEFAULT_MAX_GAP_MS
    min_samples_per_window: int = DEFAULT_MIN_SAMPLES_PER_WINDOW

    def __post_init__(self) -> None:
        if self.window_ms <= 0:
            raise ValueError("window_ms must be positive")
        if self.stride_ms <= 0:
            raise ValueError("stride_ms must be positive")
        if self.max_gap_ms <= 0:
            raise ValueError("max_gap_ms must be positive")
        if self.min_samples_per_window < 2:
            raise ValueError("min_samples_per_window must be at least 2")


@dataclass(frozen=True)
class Window:
    session_id: str
    label: str
    start_ns: int
    end_ns: int
    row_indices: np.ndarray  # indices into the source Recording's arrays


def _contiguous_same_label_segments(recording: Recording, max_gap_ns: int) -> list[np.ndarray]:
    timestamps = recording.timestamps_ns
    labels = recording.raw_labels
    row_count = timestamps.shape[0]

    boundaries = [0]
    for index in range(1, row_count):
        gap = timestamps[index] - timestamps[index - 1]
        if gap > max_gap_ns or labels[index] != labels[index - 1]:
            boundaries.append(index)
    boundaries.append(row_count)

    return [np.arange(boundaries[i], boundaries[i + 1]) for i in range(len(boundaries) - 1)]


def build_windows(recording: Recording, config: WindowConfig) -> list[Window]:
    window_ns = int(round(config.window_ms * MS_TO_NS))
    stride_ns = int(round(config.stride_ms * MS_TO_NS))
    max_gap_ns = int(round(config.max_gap_ms * MS_TO_NS))

    windows: list[Window] = []
    for segment in _contiguous_same_label_segments(recording, max_gap_ns):
        if segment.shape[0] < config.min_samples_per_window:
            continue
        segment_timestamps = recording.timestamps_ns[segment]
        label = str(recording.raw_labels[segment[0]])
        segment_start_ns = int(segment_timestamps[0])
        segment_end_ns = int(segment_timestamps[-1])

        window_start_ns = segment_start_ns
        while window_start_ns + window_ns <= segment_end_ns:
            window_end_ns = window_start_ns + window_ns
            in_window = segment[
                (segment_timestamps >= window_start_ns) & (segment_timestamps <= window_end_ns)
            ]
            if in_window.shape[0] >= config.min_samples_per_window:
                windows.append(
                    Window(
                        session_id=recording.session_id,
                        label=label,
                        start_ns=window_start_ns,
                        end_ns=window_end_ns,
                        row_indices=in_window,
                    )
                )
            window_start_ns += stride_ns

    return windows
