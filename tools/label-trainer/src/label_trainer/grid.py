"""The window as a grid: one row per channel, the same number of steps in every row. This is what a convolutional model reads.

A model that reads statistics sees a window as a short list of numbers; a convolutional one reads the window itself.
Each channel of the window (the pulse sensor's lights, the three axes of acceleration and of the gyroscope, the four
numbers of the orientation) is turned into `steps` values:

* only samples that really arrived in the window are used (the other rows of a recording carry a value forward, which is
  not a sample), the pulse channels from the pulse rows and the motion channels from the orientation rows;
* with a spike extraction method chosen, a pulse channel is first replaced by what the method leaves of it (see
  `features.extract_spike_series`);
* the samples are taken as evenly spaced across the window, and laid onto `steps` evenly spaced points by linear
  interpolation. No timestamps are used: the watch stamps the samples of a batch a few nanoseconds apart, and a model
  trained on one clock must see the same thing on another;
* a channel with no samples in the window is all zeros, and one with a single sample is that value throughout; with a single
  step the one value is the latest sample (the "current reading" of a dataset column).

The result is the channels one after another (all the steps of the first, then the second...), so it is one flat row of
`channels x steps` numbers; the model's first layer folds it back into rows. `crates/pinch-inference/src/grid.rs` makes
the same numbers the same way, and `tests/fixtures/grid_cases.json` keeps the two equal.
"""

from __future__ import annotations

import numpy as np

from .csv_io import Recording
from .features import extract_spike_series
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


def build_grid(
    recording: Recording,
    window: Window,
    channels: list[str],
    steps: int,
    spike_method: str | None = None,
) -> np.ndarray:
    """The window as one flat row of `len(channels) * steps` numbers, channel after channel."""
    rows = window.row_indices
    ppg_rows = rows if recording.ppg_observed is None else rows[recording.ppg_observed[rows]]
    orient_rows = rows if recording.orient_observed is None else rows[recording.orient_observed[rows]]
    ppg_span_ms = 0.0
    if ppg_rows.shape[0] > 0:
        ppg_span_ms = float(recording.timestamps_ns[ppg_rows[-1]] - recording.timestamps_ns[ppg_rows[0]]) / 1_000_000.0
    out: list[float] = []
    for channel in channels:
        is_ppg = channel.startswith("ppg_")
        values = recording.channels[channel][ppg_rows if is_ppg else orient_rows]
        series = [float(v) for v in values]
        if is_ppg and spike_method is not None and len(series) >= 4:
            series = extract_spike_series(spike_method, values, ppg_span_ms)
        elif is_ppg and spike_method is not None:
            series = []  # too short for the method to say anything: nothing, not the raw level
        out.extend(resample(series, steps))
    return np.array(out, dtype=np.float64)
