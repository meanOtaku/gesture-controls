"""Builds fixed-duration, overlapping windows from a parsed Recording.

Two ways. `continuous_windows` slides across the whole recording whatever the labels, as the runtime does, and
`label_by_overlap` then says what each window is from how much of it the gesture covers: what training uses, so it sees the
windows half in and half out of a gesture that it meets live. `build_windows` (the older way, kept for `windowing:
"segments"`) never crosses a label boundary: it splits each recording into contiguous same-label segments and slides a
window across each. Both split wherever the gap between consecutive samples exceeds `max_gap_ms`.
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

    # A new segment starts wherever the gap to the previous row exceeds `max_gap_ns` or the
    # label changes. Computed over whole arrays instead of one Python iteration per row.
    breaks = np.flatnonzero((np.diff(timestamps) > max_gap_ns) | (labels[1:] != labels[:-1])) + 1
    boundaries = [0, *breaks.tolist(), row_count]

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
            # Timestamps are non-decreasing (the loader rejects anything else), so the rows in
            # [start, end] are one contiguous run found by binary search. Masking the whole
            # segment for every window made this quadratic in the segment length.
            first = np.searchsorted(segment_timestamps, window_start_ns, side="left")
            last = np.searchsorted(segment_timestamps, window_end_ns, side="right")
            in_window = segment[first:last]
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


def continuous_windows(recording: Recording, config: WindowConfig) -> list[Window]:
    """Windows as the runtime makes them: sliding across the whole recording whatever the labels, split only where the
    samples stop for longer than the allowed gap. A window's `label` is empty; the labels are matched afterwards."""
    stamps = recording.timestamps_ns
    window_ns = int(round(config.window_ms * MS_TO_NS))
    stride_ns = int(round(config.stride_ms * MS_TO_NS))
    max_gap_ns = int(round(config.max_gap_ms * MS_TO_NS))
    breaks = np.flatnonzero(np.diff(stamps) > max_gap_ns) + 1
    bounds = [0, *breaks.tolist(), stamps.shape[0]]
    windows: list[Window] = []
    for begin, end in zip(bounds, bounds[1:]):
        segment = np.arange(begin, end)
        if segment.shape[0] < config.min_samples_per_window:
            continue
        times = stamps[segment]
        start = int(times[0])
        while start + window_ns <= int(times[-1]):
            first = np.searchsorted(times, start, side="left")
            last = np.searchsorted(times, start + window_ns, side="right")
            rows = segment[first:last]
            if rows.shape[0] >= config.min_samples_per_window:
                windows.append(Window(session_id=recording.session_id, label="", start_ns=start, end_ns=start + window_ns, row_indices=rows))
            start += stride_ns
    return windows


# Stretches of one label closer than this are one stretch. A row's label is the one in force when it reached the
# desktop, up to a batch (~100 ms) after it was taken, so around each change of label a few pulse rows, placed at the
# time they were taken, carry the neighbouring label; without bridging, one pinch would count as several.
SPAN_BRIDGE_MS = 250.0


def labelled_spans(recording: Recording, wanted: np.ndarray, bridge_ms: float = SPAN_BRIDGE_MS) -> list[tuple[int, int]]:
    """The (first, last) timestamps of each stretch of rows for which `wanted` holds, joining stretches less than
    `bridge_ms` apart (see `SPAN_BRIDGE_MS`)."""
    if not wanted.any():
        return []
    edges = np.diff(np.r_[0, wanted.astype(np.int8), 0])
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1) - 1
    stamps = recording.timestamps_ns
    bridge_ns = int(round(bridge_ms * 1_000_000))
    spans: list[tuple[int, int]] = []
    for s, e in zip(starts, ends):
        start, end = int(stamps[s]), int(stamps[e])
        if spans and start - spans[-1][1] < bridge_ns:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return spans


# A window is the gesture when the gesture fills at least this share of it...
POSITIVE_WINDOW_SHARE = 0.5
# ...or holds at least this share of a gesture shorter than that (a quick tap can never fill half a long window).
POSITIVE_GESTURE_SHARE = 0.8


def label_by_overlap(recording: Recording, windows: list[Window], target: np.ndarray, excluded: np.ndarray) -> list[tuple[Window, int]]:
    """Each window that can be trained on, with 1 if it is the gesture and 0 if it is not.

    `target` and `excluded` say, row by row, which rows are the gesture and which belong to a label left out of training.
    A window that touches an excluded row is dropped. One that holds no gesture is 0. One that the gesture fills by
    `POSITIVE_WINDOW_SHARE`, or that holds `POSITIVE_GESTURE_SHARE` of a gesture, is 1. Anything in between (the edge of a
    gesture) is dropped: neither answer is right for it, and forcing one would teach the model to be unsure exactly where
    it matters. A gesture's span runs from its first row to one typical row spacing past its last."""
    stamps = recording.timestamps_ns
    spacing = int(np.median(np.diff(stamps))) if stamps.shape[0] > 1 else 0
    gestures = [(start, end + spacing) for start, end in labelled_spans(recording, target)]
    labelled: list[tuple[Window, int]] = []
    for window in windows:
        rows = window.row_indices
        if excluded[rows].any():
            continue
        if not target[rows].any():
            labelled.append((window, 0))
            continue
        length = window.end_ns - window.start_ns
        covered = 0
        mostly_inside = False
        for start, end in gestures:
            overlap = min(end, window.end_ns) - max(start, window.start_ns)
            if overlap <= 0:
                continue
            covered += overlap
            mostly_inside = mostly_inside or overlap >= POSITIVE_GESTURE_SHARE * (end - start)
        if covered >= POSITIVE_WINDOW_SHARE * length or mostly_inside:
            labelled.append((window, 1))
    return labelled
