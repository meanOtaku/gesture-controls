"""The window as a grid: one row per channel, the same number of steps in every row. This is what a convolutional model reads.

A model that reads statistics sees a window as a short list of numbers; a convolutional one reads the window itself.
Each channel of the window (the pulse sensor's lights, the three axes of acceleration and of the gyroscope, the four
numbers of the orientation) is turned into `steps` values:

* only samples that really arrived in the window are used (the other rows of a recording carry a value forward, which is
  not a sample), the pulse channels from the pulse rows and the motion channels from the orientation rows;
* with `pulse_baseline_ms` (manifest `input.grid.pulse: "recentPast"`), a pulse channel is first put in units of its own
  recent past (`features.pulse_z` against the pulse samples in that many milliseconds before the window), which cancels
  the session's arbitrary level and swing;
* with a spike extraction method chosen, a pulse channel is then replaced by what the method leaves of it (see
  `features.extract_spike_series`);
* the samples are laid onto `steps` evenly spaced points by linear interpolation. With `timing="time"` (what training
  now uses) the points are evenly spaced in time from the channel's first sample to its last and each sample sits at its
  own timestamp, so a dropped sample or an uneven delivery does not bend the time axis; a spike method that leaves one
  value fewer (a difference between neighbours) places each value midway between the two samples it came from. With
  `timing="samples"` (models trained before; a manifest without `timing`) the samples are taken as evenly spaced instead.
  That was chosen while the watch stamped the samples of a pulse batch nanoseconds apart, which it no longer does;
* a channel with no samples in the window is all zeros, and one with a single sample is that value throughout; with a single
  step the one value is the latest sample (the "current reading" of a dataset column).

The result is the channels one after another (all the steps of the first, then the second...), so it is one flat row of
`channels x steps` numbers; the model's first layer folds it back into rows. `crates/pinch-inference/src/grid.rs` makes
the same numbers the same way, and `tests/fixtures/grid_cases.json` keeps the two equal.
"""

from __future__ import annotations

import numpy as np

from .csv_io import Recording
from .features import PPG_COLUMNS, baseline_rows, extract_spike_series, pulse_z
from .windowing import Window

GRID_CHANNELS: tuple[str, ...] = (
    "ppg_green", "ppg_red", "ppg_ir",
    "accel_x", "accel_y", "accel_z",
    "gyro_x", "gyro_y", "gyro_z",
    "quat_w", "quat_x", "quat_y", "quat_z",
)
DEFAULT_STEPS = 32
MIN_STEPS = 8
MAX_STEPS = 256
# A dense model reading raw columns may take as few as one step (the latest reading of each column), and at most this many.
MIN_RAW_STEPS = 1
MAX_RAW_STEPS = 64


def source_of_channel(channel: str) -> str:
    """The stream a grid channel comes from, in the trainer's own names."""
    return {"ppg": "watchPpg", "accel": "watchAcceleration", "gyro": "watchGyroscope", "quat": "watchOrientation"}[channel.split("_")[0]]


def channels_for(sources: list[str], ppg_channels: list[str] | tuple[str, ...]) -> list[str]:
    """The grid channels the chosen streams (and, for the pulse sensor, lights) provide, in canonical order."""
    return [
        channel
        for channel in GRID_CHANNELS
        if source_of_channel(channel) in sources and (not channel.startswith("ppg_") or channel.split("_")[1] in ppg_channels)
    ]


def resample(values: list[float], steps: int) -> list[float]:
    """`values` laid onto `steps` evenly spaced points by linear interpolation (first to first, last to last)."""
    n = len(values)
    if n == 0:
        return [0.0] * steps
    if steps == 1 or n == 1:
        return [values[-1]] * steps  # one step is the latest reading
    out = []
    for k in range(steps):
        position = (k * (n - 1)) / (steps - 1)
        low = min(int(position), n - 2)
        fraction = position - low
        out.append(values[low] + (values[low + 1] - values[low]) * fraction)
    return out


GRID_TIMINGS = ("time", "samples")


def resample_in_time(values: list[float], times: list[float], steps: int) -> list[float]:
    """`values`, taken at `times` (increasing), laid onto `steps` points evenly spaced in time from the first to the last by
    linear interpolation. Falls back to `resample` when the times give no span (one sample, or all at once)."""
    n = len(values)
    if n < 2 or steps == 1 or len(times) != n or times[-1] <= times[0]:
        return resample(values, steps)
    first, span = times[0], times[-1] - times[0]
    out = []
    low = 0
    for k in range(steps):
        at = first + span * k / (steps - 1)
        while low < n - 2 and times[low + 1] < at:
            low += 1
        gap = times[low + 1] - times[low]
        fraction = 0.0 if gap <= 0 else min(max((at - times[low]) / gap, 0.0), 1.0)
        out.append(values[low] + (values[low + 1] - values[low]) * fraction)
    return out


def _times_for(series: list[float], times: list[float]) -> list[float]:
    """The times of a channel's values: the samples' own, or for a series one shorter (differences between neighbours)
    the midpoints between consecutive samples."""
    if len(series) == len(times):
        return times
    if len(series) == len(times) - 1:
        return [(a + b) / 2.0 for a, b in zip(times, times[1:])]
    return []


def build_grid(
    recording: Recording,
    window: Window,
    channels: list[str],
    steps: int,
    spike_method: str | None = None,
    timing: str = "samples",
    pulse_baseline_ms: int | None = None,
) -> np.ndarray | None:
    """The window as one flat row of `len(channels) * steps` numbers, channel after channel. None when the pulse is put in
    units of its recent past and the window has too little past (the runtime does not score it either)."""
    rows = window.row_indices
    past_rows = None
    if pulse_baseline_ms is not None and any(channel in PPG_COLUMNS for channel in channels):
        past_rows = baseline_rows(recording, window, pulse_baseline_ms)
        if past_rows is None:
            return None
    ppg_rows = rows if recording.ppg_observed is None else rows[recording.ppg_observed[rows]]
    orient_rows = rows if recording.orient_observed is None else rows[recording.orient_observed[rows]]
    ppg_span_ms = 0.0
    if ppg_rows.shape[0] > 0:
        ppg_span_ms = float(recording.timestamps_ns[ppg_rows[-1]] - recording.timestamps_ns[ppg_rows[0]]) / 1_000_000.0
    out: list[float] = []
    for channel in channels:
        is_ppg = channel.startswith("ppg_")
        values = recording.channels[channel][ppg_rows if is_ppg else orient_rows]
        if is_ppg and past_rows is not None:
            values = pulse_z(values, recording.channels[channel][past_rows])
        series = [float(v) for v in values]
        if is_ppg and spike_method is not None and len(series) >= 4:
            series = extract_spike_series(spike_method, values, ppg_span_ms)
        elif is_ppg and spike_method is not None:
            series = []  # too short for the method to say anything: nothing, not the raw level
        if timing == "time":
            rows_of = ppg_rows if is_ppg else orient_rows
            stamps = [int(t) for t in recording.timestamps_ns[rows_of]]
            # Milliseconds from the channel's first sample: only differences matter, and they round the same whatever
            # clock the samples are on (a recording's, or the pulse sensor's own live).
            times = [(t - stamps[0]) / 1_000_000.0 for t in stamps]
            out.extend(resample_in_time(series, _times_for(series, times), steps))
        else:
            out.extend(resample(series, steps))
    return np.array(out, dtype=np.float64)
