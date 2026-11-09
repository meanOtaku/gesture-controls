"""The CNN pinch-start model's inputs: the last second of motion and pulse, each channel scaled by its own recent level.

Mirrored exactly by `crates/pinch-inference/src/cnn_input.rs` (the shared cases in `tests/fixtures/cnn_input_cases.json`
keep the two equal). Research: `docs/research/artifacts/double-pinch-2026-10/` steps 8, 9 and 12.

For a decision at time T (on the watch clock both streams share):

1. A 50 Hz grid of `GRID_TICKS` ticks ends at T: tick k is at T - (GRID_TICKS - 1 - k) * 20 ms. Each tick holds each
   stream's last sample at or before it (zero-order hold).
2. The channels are the accelerometer's and gyroscope's three axes and the pulse sensor's green, red and infrared
   (`CHANNELS`).
3. Each of the last `WINDOW_TICKS` ticks (1 s) is centred and scaled, then a sigmoid puts it in (0, 1). `scaling` says how:
   * `MEDIAN`, which new models use: against the median of the channel's grid ticks and 1.4826 x their median absolute
     deviation (as large as a standard deviation on normal data), leaving out the ticks where the wrist was turning fast
     (`moving_ticks`): the gyroscope's RMS over the `MOVING_RMS_TICKS` ending at a tick above `MOVING_GYRO`, and the
     `MOVING_MARGIN_TICKS` either side of such a tick. The window's own ticks are always kept. So arm motion before a
     pinch, however long, does not set its scale, and the pinch stands out as soon as the hand is steady again; on a still
     hand nothing is left out. Research: `docs/research/cnn-motion-hangover-2026-11.md`.
   * `ROLLING`, which models of the `ppg_imu_cnn` kind were trained on: z-scored against the `HISTORY_TICKS` ticks (10 s)
     ending at each tick, their population mean and standard deviation.
   Either way the spread is floored by `MOTION_FLOOR` (0.02 m/s² for the accelerometer, 0.01 rad/s for the gyroscope) or,
   for the pulse, 0.001 x (|centre| + 1).

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
MEDIAN, ROLLING = "median", "rolling"
MAD_TO_STD = 1.4826                # a median absolute deviation times this is a standard deviation, on normal data
MAX_Z = 500.0                      # far enough that the sigmoid is flat; keeps its exponential finite
MOVING_GYRO = 1.0                  # rad/s: a tick whose recent gyroscope RMS is above this is the wrist turning fast...
MOVING_RMS_TICKS = 15              # ...that RMS taken over the 0.3 s ending at the tick (fewer at the grid's start)...
MOVING_MARGIN_TICKS = 25           # ...and the 0.5 s either side of such a tick is left out of the median scaling too
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


def moving_ticks(motion_grid: np.ndarray) -> np.ndarray:
    """(decisions, GRID_TICKS): True on the ticks the median scaling leaves out. A tick is moving when the gyroscope's RMS
    magnitude over the MOVING_RMS_TICKS ending at it (as many as the grid has, at its start) is above MOVING_GYRO; a tick
    within MOVING_MARGIN_TICKS of a moving one is left out too. The last WINDOW_TICKS never are."""
    n, ticks = motion_grid.shape[:2]
    power = np.sum(motion_grid[:, :, 3:6] ** 2, axis=2)
    total = np.concatenate([np.zeros((n, 1)), np.cumsum(power, axis=1)], axis=1)
    end = np.arange(1, ticks + 1)
    begin = np.maximum(end - MOVING_RMS_TICKS, 0)
    moving = (total[:, end] - total[:, begin]) / (end - begin) > MOVING_GYRO * MOVING_GYRO
    count = np.concatenate([np.zeros((n, 1), dtype=np.int64), np.cumsum(moving, axis=1)], axis=1)
    k = np.arange(ticks)
    near = count[:, np.minimum(k + MOVING_MARGIN_TICKS + 1, ticks)] - count[:, np.maximum(k - MOVING_MARGIN_TICKS, 0)] > 0
    near[:, ticks - WINDOW_TICKS:] = False
    return near


def _median_scaled(grid: np.ndarray, pulse: bool, left_out: np.ndarray | None = None) -> np.ndarray:
    """(decisions, WINDOW_TICKS, channels): the last ticks against each channel's median and median absolute deviation over
    the grid's ticks less those `left_out` (decisions, GRID_TICKS), through the sigmoid."""
    centre = np.median(grid, axis=1, keepdims=True)
    spread = MAD_TO_STD * np.median(np.abs(grid - centre), axis=1, keepdims=True)
    rows = np.flatnonzero(left_out.any(axis=1)) if left_out is not None else ()
    if len(rows):  # only where something is left out: the median of what remains, the mean of the middle two if even
        kept = np.where(left_out[rows][:, :, None], np.nan, grid[rows])
        centre[rows] = np.nanmedian(kept, axis=1, keepdims=True)
        spread[rows] = MAD_TO_STD * np.nanmedian(np.abs(kept - centre[rows]), axis=1, keepdims=True)
    floor = PULSE_FLOOR_SCALE * (np.abs(centre) + 1.0) if pulse else MOTION_FLOOR[None, None, :]
    z = (grid[:, -WINDOW_TICKS:, :] - centre) / (spread + floor)
    return 1.0 / (1.0 + np.exp(-np.clip(z, -MAX_Z, MAX_Z)))


def inputs(motion_ts_ns: np.ndarray, motion: np.ndarray, pulse_ts_ns: np.ndarray, pulse: np.ndarray,
           decisions_ns: np.ndarray, chunk: int = 1024, scaling: str = MEDIAN) -> np.ndarray:
    """(decisions, FEATURE_COUNT) from motion samples (rows of accelerometer x/y/z, gyroscope x/y/z) and pulse samples (rows
    of green, red, IR), each at its sorted int64 timestamps on the decisions' clock; a row of NaN where there are none."""
    motion_ts_ns = np.asarray(motion_ts_ns, dtype=np.int64)
    pulse_ts_ns = np.asarray(pulse_ts_ns, dtype=np.int64)
    motion = np.asarray(motion, dtype=np.float64)
    pulse = np.asarray(pulse, dtype=np.float64)
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64)
    if scaling not in (MEDIAN, ROLLING):
        raise ValueError(f"unknown scaling {scaling!r}")
    out = np.full((len(decisions_ns), FEATURE_COUNT), np.nan)
    if len(motion_ts_ns) == 0 or len(pulse_ts_ns) == 0:
        return out
    ok = _gap_free(motion_ts_ns, decisions_ns) & _gap_free(pulse_ts_ns, decisions_ns)
    whole = np.zeros(len(decisions_ns), dtype=bool)
    for start in range(0, len(decisions_ns), chunk):
        part = slice(start, start + chunk)
        d = decisions_ns[part]
        mg, pg = _held(motion_ts_ns, motion, d), _held(pulse_ts_ns, pulse, d)
        # A tick before either stream's first sample means no inputs (the median of what is left would hide it).
        whole[part] = np.isfinite(mg).all(axis=(1, 2)) & np.isfinite(pg).all(axis=(1, 2))
        if scaling == MEDIAN:
            left_out = moving_ticks(np.nan_to_num(mg))  # a grid with NaN has no inputs anyway
            m, p = _median_scaled(mg, False, left_out), _median_scaled(pg, True, left_out)
        else:
            m, p = _scaled(mg, pulse=False), _scaled(pg, pulse=True)
        # Channel by channel, oldest tick first.
        rows = np.concatenate([m, p], axis=2).transpose(0, 2, 1).reshape(len(d), FEATURE_COUNT)
        out[part] = rows
    bad = ~ok | ~np.isfinite(out).all(axis=1) | ~whole
    out[bad] = np.nan
    return out
