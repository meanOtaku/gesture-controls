"""The CNN pinch-start model's inputs: the last second of motion and pulse, each channel scaled by its own recent level.

Mirrored exactly by `crates/pinch-inference/src/cnn_input.rs` (the shared cases in `tests/fixtures/cnn_input_cases.json`
keep the two equal). Research: `docs/research/artifacts/double-pinch-2026-10/` steps 8, 9 and 12.

For a decision at time T (on the watch clock both streams share):

1. A 50 Hz grid of `GRID_TICKS` ticks ends at T: tick k is at T - (GRID_TICKS - 1 - k) * 20 ms. Each tick holds each
   stream's last sample at or before it (zero-order hold).
2. The channels are the accelerometer's and gyroscope's three axes and the pulse sensor's green, red and infrared
   (`CHANNELS`).
3. Each of the last `WINDOW_TICKS` ticks (1 s) is z-scored against the `HISTORY_TICKS` ticks (10 s) ending at it: the
   population mean and standard deviation of those ticks, the deviation floored by `motion_floor` (0.02 m/s² for the
   accelerometer, 0.01 rad/s for the gyroscope) or, for the pulse, 0.001 x (|mean| + 1). Then a sigmoid puts it in (0, 1).

That is 9 channels x 50 ticks = 450 inputs, channel by channel, oldest tick first (`FEATURE_NAMES`). A decision with a tick
before either stream's first sample, or a gap between consecutive samples of either stream longer than `MAX_GAP_MS` within
its span, has no inputs (a row of NaN).
"""

from __future__ import annotations

import numpy as np

TICK_NS = 20_000_000
WINDOW_TICKS = 50                  # the second the CNN sees
HISTORY_TICKS = 500                # the 10 s each tick is scaled against
GRID_TICKS = WINDOW_TICKS + HISTORY_TICKS - 1     # 549 (10.98 s)
SPAN_NS = (GRID_TICKS - 1) * TICK_NS
MAX_GAP_MS = 250
MOTION_CHANNELS = ("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")
PULSE_CHANNELS = ("ppg_green", "ppg_red", "ppg_ir")
CHANNELS = (*MOTION_CHANNELS, *PULSE_CHANNELS)
MOTION_FLOOR = np.array([0.02, 0.02, 0.02, 0.01, 0.01, 0.01])
PULSE_FLOOR_SCALE = 1e-3
FEATURE_NAMES = tuple(f"cnn_{channel}_t{tick:02d}" for channel in CHANNELS for tick in range(WINDOW_TICKS))
FEATURE_COUNT = len(FEATURE_NAMES)
assert FEATURE_COUNT == 450 and GRID_TICKS == 549


def _held(ts_ns: np.ndarray, values: np.ndarray, decisions_ns: np.ndarray) -> np.ndarray:
    """(decisions, GRID_TICKS, channels): the zero-order-held stream at each decision's ticks; NaN before its first sample."""
    offsets = (np.arange(GRID_TICKS, dtype=np.int64) - (GRID_TICKS - 1)) * TICK_NS
    ticks = decisions_ns[:, None] + offsets[None, :]
    index = np.searchsorted(ts_ns, ticks, side="right") - 1
    out = values[np.clip(index, 0, None)]
    out[index < 0] = np.nan
    return out


def _gap_free(ts_ns: np.ndarray, decisions_ns: np.ndarray) -> np.ndarray:
    """True where no two consecutive samples are further apart than MAX_GAP_MS where the later one is in (T - span, T]."""
    big = np.flatnonzero(np.diff(ts_ns) > MAX_GAP_MS * 1_000_000)
    if big.size == 0:
        return np.ones(len(decisions_ns), dtype=bool)
    after = ts_ns[big + 1]
    return np.searchsorted(after, decisions_ns, side="right") == np.searchsorted(after, decisions_ns - SPAN_NS, side="right")


def _scaled(grid: np.ndarray, pulse: bool) -> np.ndarray:
    """(decisions, WINDOW_TICKS, channels): each of the last ticks z-scored against the HISTORY_TICKS ending at it, through
    the sigmoid."""
    n = grid.shape[0]
    # Sums of the values less each channel's first tick, so the pulse's large level does not swamp its variance.
    first = grid[:, :1, :]
    shifted = grid - first
    zero = np.zeros((n, 1, grid.shape[2]))
    total = np.concatenate([zero, np.cumsum(shifted, axis=1)], axis=1)
    squares = np.concatenate([zero, np.cumsum(shifted * shifted, axis=1)], axis=1)
    last = np.arange(HISTORY_TICKS - 1, GRID_TICKS)          # the window's ticks
    mean = (total[:, last + 1] - total[:, last + 1 - HISTORY_TICKS]) / HISTORY_TICKS
    variance = (squares[:, last + 1] - squares[:, last + 1 - HISTORY_TICKS]) / HISTORY_TICKS - mean * mean
    std = np.sqrt(np.maximum(variance, 0.0))
    floor = PULSE_FLOOR_SCALE * (np.abs(mean + first) + 1.0) if pulse else MOTION_FLOOR[None, None, :]
    return 1.0 / (1.0 + np.exp(-(shifted[:, last] - mean) / (std + floor)))


def inputs(motion_ts_ns: np.ndarray, motion: np.ndarray, pulse_ts_ns: np.ndarray, pulse: np.ndarray,
           decisions_ns: np.ndarray, chunk: int = 1024) -> np.ndarray:
    """(decisions, FEATURE_COUNT) from motion samples (rows of accelerometer x/y/z, gyroscope x/y/z) and pulse samples (rows
    of green, red, IR), each at its sorted int64 timestamps on the decisions' clock; a row of NaN where there are none."""
    motion_ts_ns = np.asarray(motion_ts_ns, dtype=np.int64)
    pulse_ts_ns = np.asarray(pulse_ts_ns, dtype=np.int64)
    motion = np.asarray(motion, dtype=np.float64)
    pulse = np.asarray(pulse, dtype=np.float64)
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64)
    out = np.full((len(decisions_ns), FEATURE_COUNT), np.nan)
    if len(motion_ts_ns) == 0 or len(pulse_ts_ns) == 0:
        return out
    ok = _gap_free(motion_ts_ns, decisions_ns) & _gap_free(pulse_ts_ns, decisions_ns)
    for start in range(0, len(decisions_ns), chunk):
        part = slice(start, start + chunk)
        d = decisions_ns[part]
        m = _scaled(_held(motion_ts_ns, motion, d), pulse=False)
        p = _scaled(_held(pulse_ts_ns, pulse, d), pulse=True)
        # Channel by channel, oldest tick first.
        rows = np.concatenate([m, p], axis=2).transpose(0, 2, 1).reshape(len(d), FEATURE_COUNT)
        out[part] = rows
    bad = ~ok | ~np.isfinite(out).all(axis=1)
    out[bad] = np.nan
    return out
