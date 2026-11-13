"""The motion half of the PPG + IMU pinch-start model's inputs: window summaries of the watch's accelerometer and gyroscope.

Mirrored exactly by `crates/pinch-inference/src/imu_onset.rs` (the shared cases in `tests/fixtures/imu_onset_cases.json`
keep the two equal). Research: `docs/research/artifacts/ppg-benchmark-2026-10/ppg-imu-fusion/`.

For a decision at time T (the PPG sample's timestamp, on the watch clock the motion samples share):

1. A grid of ticks ends at T, 50 Hz (`GRID_TICKS` ticks: tick k is at T - (GRID_TICKS - 1 - k) * 20 ms) or 100 Hz (twice the
   ticks, 10 ms apart), over the same spans either way (`GRIDS`), so the features keep their names. Each tick holds the last
   motion sample at or before it (zero-order hold); a tick before the first sample has none. The first models read 50 Hz;
   the trainer now makes 100 Hz ones (`MOTION_HZ`), and a model's manifest says which (`preprocessing.motionHz`).
2. The channels are the accelerometer's and gyroscope's three axes and each one's magnitude (`CHANNELS`), and each one's
   change from the tick before (`SIGNALS`: raw, diff).
3. Over the final 320, 640 and 1,280 ms (16, 32 and 64 ticks at 50 Hz), each channel and signal is summarised by the 21 statistics
   of `ppg_onset.STATS` (ages in seconds of this grid), and each channel's spread is compared with the 3 s before the
   longest window: log((sd of the window + 1e-6) / (sd of those ticks + 1e-6)).

That is 3 windows x (2 signals x 8 channels x 21 statistics + 8 spreads) = 1,032 features, named in `FEATURE_NAMES` in that
order. A decision whose 4.3 s holds a gap between motion samples longer than `MAX_GAP_MS`, or a tick before the first
sample, has no features (a row of NaN).
"""

from __future__ import annotations

import numpy as np

from .ppg_onset import STATS, summarize

TICK_NS = 20_000_000
WINDOWS = (16, 32, 64)             # 320, 640 and 1,280 ms
BACKGROUND = 150                   # the 3 s before the longest window
GRID_TICKS = BACKGROUND + max(WINDOWS)     # 214
MAX_GAP_MS = 250
AXES = ("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")
CHANNELS = (*AXES, "accel_mag", "gyro_mag")
SIGNALS = ("raw", "diff")
SPREAD_EPSILON = 1e-6
FEATURE_NAMES = tuple(
    name
    for window in WINDOWS
    for name in (
        *(f"imu_{channel}_{signal}_n{window * 20}ms_{stat}" for signal in SIGNALS for channel in CHANNELS for stat in STATS),
        *(f"imu_{channel}_spread_vs_3s_n{window * 20}ms" for channel in CHANNELS),
    )
)
FEATURE_COUNT = len(FEATURE_NAMES)
assert FEATURE_COUNT == 1032

# Each rate's grid: (tick spacing in ns, the three windows in ticks, the background in ticks). The same spans at either.
GRIDS = {50: (TICK_NS, WINDOWS, BACKGROUND), 100: (10_000_000, (32, 64, 128), 300)}
# The rate the trainer's motion models read: the watch's full rate (a Galaxy Watch4 sends at most 100 Hz). On the same
# recordings this caught about 10 more pinch ins and 20 more pinch outs than 50 Hz, with fewer false activations out
# (`docs/research/artifacts/paper-rylo-2022/`).
MOTION_HZ = 100


def grid_of(hz: int) -> tuple[int, tuple[int, int, int], int, int]:
    """(tick ns, windows, background, ticks) of a rate's grid."""
    if hz not in GRIDS:
        raise ValueError(f"no motion grid at {hz} Hz; there is one at {' and '.join(str(r) for r in sorted(GRIDS))}")
    tick, windows, background = GRIDS[hz]
    return tick, windows, background, background + max(windows)


def with_magnitudes(values: np.ndarray) -> np.ndarray:
    """(n, 8): the six axes, then the accelerometer's and gyroscope's magnitudes."""
    values = np.asarray(values, dtype=np.float64)
    return np.concatenate([values, np.linalg.norm(values[:, :3], axis=1, keepdims=True),
                           np.linalg.norm(values[:, 3:6], axis=1, keepdims=True)], axis=1)


def grid(ts_ns: np.ndarray, values: np.ndarray, decisions_ns: np.ndarray, hz: int = 50) -> np.ndarray:
    """(decisions, ticks, channels): the zero-order-held motion at each decision's ticks; NaN before the first sample."""
    tick, _, _, ticks = grid_of(hz)
    offsets = (np.arange(ticks, dtype=np.int64) - (ticks - 1)) * tick
    ticks = decisions_ns.astype(np.int64)[:, None] + offsets[None, :]
    index = np.searchsorted(ts_ns, ticks, side="right") - 1
    out = values[np.clip(index, 0, None)]
    out[index < 0] = np.nan
    return out


def _gap_free(ts_ns: np.ndarray, decisions_ns: np.ndarray, hz: int = 50) -> np.ndarray:
    """True where no two consecutive samples are further apart than MAX_GAP_MS where the later one is in (T - span, T]."""
    tick, _, _, ticks = grid_of(hz)
    span = (ticks - 1) * tick
    big = np.flatnonzero(np.diff(ts_ns) > MAX_GAP_MS * 1_000_000)
    if big.size == 0:
        return np.ones(len(decisions_ns), dtype=bool)
    after = ts_ns[big + 1]
    first = np.searchsorted(after, decisions_ns - span, side="right")
    last = np.searchsorted(after, decisions_ns, side="right")
    return last == first


def features(ts_ns: np.ndarray, axes: np.ndarray, decisions_ns: np.ndarray, chunk: int = 512, hz: int = 50) -> np.ndarray:
    """(decisions, FEATURE_COUNT) for motion samples `axes` (rows of accelerometer x/y/z, gyroscope x/y/z) at `ts_ns` (sorted,
    int64), on the `hz` grid; a row of NaN for a decision that has no features."""
    tick, windows, background, _ = grid_of(hz)
    ts_ns = np.asarray(ts_ns, dtype=np.int64)
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64)
    out = np.full((len(decisions_ns), FEATURE_COUNT), np.nan)
    if len(ts_ns) == 0 or len(decisions_ns) == 0:
        return out
    values = with_magnitudes(axes)
    dt = tick / 1e9
    ok = _gap_free(ts_ns, decisions_ns, hz)
    for start in range(0, len(decisions_ns), chunk):
        part = slice(start, start + chunk)
        g = grid(ts_ns, values, decisions_ns[part], hz)                     # (n, ticks, channels)
        d = np.diff(g, axis=1)                                              # d[:, k - 1] = g[:, k] - g[:, k - 1]
        background_sd = g[:, :background, :].std(axis=1)
        blocks = []
        for window in windows:
            for signal in (g[:, -window:, :], d[:, -window:, :]):
                blocks += [summarize(signal[:, :, c], dt) for c in range(g.shape[2])]
            blocks.append(np.log((g[:, -window:, :].std(axis=1) + SPREAD_EPSILON) / (background_sd + SPREAD_EPSILON)))
        block = np.concatenate(blocks, axis=1)
        block[~np.isfinite(block).all(axis=1)] = np.nan
        out[part] = block
    out[~ok] = np.nan
    return out
