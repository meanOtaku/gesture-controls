"""Input builders for v2 experiments: the trainer's 9 channels (`cnn_input.inputs`), optionally smoothed, plus channels
derived from the raw samples before any scaling, each scaled exactly as the trainer scales its channels (median and
MAD of the 11 s grid, fast-turning ticks left out, sigmoid).

Derived channels (all from the raw zero-order-held grid):
  jerk  the accelerometer's change per second on each axis (m/s^3): sharp events stand out, slow arm motion does not
  env   the jerk's size, as an envelope: the largest |jerk| over the last `ENV_TICKS` ticks (the spikes' peaks joined)
  mag   orientation-independent sizes: |accelerometer| and |gyroscope|
Smoothing (`smooth=k`) averages each motion channel over the last k ticks before anything else (a causal low-pass).

Channel order: the trainer's 9 (accelerometer x/y/z, gyroscope x/y/z, pulse green/red/IR), then jerk x/y/z, envelope,
|accelerometer|, |gyroscope| for those asked for. `channel_groups` says which sensor each belongs to (for branches).
"""
from __future__ import annotations

import numpy as np

from label_trainer import cnn_input, label_train

ENV_TICKS_MS = 50


def _scaled(grid, floor, left_out):
    """`cnn_input._median_scaled` with a floor per channel given."""
    centre = np.median(grid, axis=1, keepdims=True)
    spread = cnn_input.MAD_TO_STD * np.median(np.abs(grid - centre), axis=1, keepdims=True)
    rows = np.flatnonzero(left_out.any(axis=1))
    if len(rows):
        kept = np.where(left_out[rows][:, :, None], np.nan, grid[rows])
        centre[rows] = np.nanmedian(kept, axis=1, keepdims=True)
        spread[rows] = cnn_input.MAD_TO_STD * np.nanmedian(np.abs(kept - centre[rows]), axis=1, keepdims=True)
    return spread, centre


def _sigmoid_window(grid, centre, spread, floor, window):
    z = (grid[:, -window:, :] - centre) / (spread + floor)
    return 1.0 / (1.0 + np.exp(-np.clip(z, -cnn_input.MAX_Z, cnn_input.MAX_Z)))


def _smooth(grid, k):
    """Causal moving average over the last k ticks (fewer at the grid's start)."""
    if k <= 1:
        return grid
    c = np.cumsum(np.concatenate([np.zeros_like(grid[:, :1]), grid], axis=1), axis=1)
    idx = np.arange(1, grid.shape[1] + 1)
    lo = np.maximum(idx - k, 0)
    return (c[:, idx] - c[:, lo]) / (idx - lo)[None, :, None]


def channel_groups(jerk=False, env=False, mag=False):
    """Indices per sensor: accelerometer (with its derived channels), gyroscope (with |gyroscope|), pulse."""
    accel, gyro, n = [0, 1, 2], [3, 4, 5], 9
    if jerk:
        accel += [n, n + 1, n + 2]; n += 3
    if env:
        accel += [n]; n += 1
    if mag:
        accel += [n]; gyro += [n + 1]; n += 2
    return [accel, gyro, [6, 7, 8]], n


def make(jerk=False, env=False, mag=False, smooth=1):
    """An input builder for `bench` and its cache name."""
    name = "v2" + ("-jerk" if jerk else "") + ("-env" if env else "") + ("-mag" if mag else "") + (f"-sm{smooth}" if smooth > 1 else "")

    def build(spec, rec, decisions, chunk=1024):
        hz = spec.motion_hz
        g = cnn_input.grid_of(hz)
        pulse_ts, pulse = label_train.pulse_of(rec)
        motion_ts, motion = label_train.motion_of(rec)
        motion_ts = np.asarray(motion_ts, dtype=np.int64); pulse_ts = np.asarray(pulse_ts, dtype=np.int64)
        motion = np.asarray(motion, dtype=np.float64); pulse = np.asarray(pulse, dtype=np.float64)
        d_all = np.asarray(decisions, dtype=np.int64)
        _, channels = channel_groups(jerk, env, mag)
        out = np.full((len(d_all), channels * g.window), np.nan)
        if len(motion_ts) == 0 or len(pulse_ts) == 0:
            return out
        ok = cnn_input._gap_free(motion_ts, d_all, g) & cnn_input._gap_free(pulse_ts, d_all, g)
        env_ticks = max(1, round(ENV_TICKS_MS * hz / 1000))
        for start in range(0, len(d_all), chunk):
            part = slice(start, start + chunk)
            d = d_all[part]
            mg, pg = cnn_input._held(motion_ts, motion, d, g), cnn_input._held(pulse_ts, pulse, d, g)
            whole = np.isfinite(mg).all(axis=(1, 2)) & np.isfinite(pg).all(axis=(1, 2))
            mg = np.nan_to_num(mg); pg = np.nan_to_num(pg)
            left_out = cnn_input.moving_ticks(mg, g)          # from the unsmoothed gyroscope, as the trainer does
            mg = _smooth(mg, smooth)
            grids, floors = [mg], [cnn_input.MOTION_FLOOR]
            if jerk or env:
                j = np.diff(mg[:, :, 0:3], axis=1, prepend=mg[:, :1, 0:3]) * hz
                if jerk:
                    grids.append(j); floors.append(np.full(3, 0.02 * hz))
                if env:
                    size = np.linalg.norm(j, axis=2, keepdims=True)
                    # Running maximum over the last env_ticks: the peaks joined.
                    padded = np.concatenate([np.zeros((len(d), env_ticks - 1, 1)), size], axis=1)
                    win = np.lib.stride_tricks.sliding_window_view(padded, env_ticks, axis=1)
                    grids.append(win.max(axis=-1)); floors.append(np.array([0.02 * hz]))
            if mag:
                grids.append(np.linalg.norm(mg[:, :, 0:3], axis=2, keepdims=True)); floors.append(np.array([0.02]))
                grids.append(np.linalg.norm(mg[:, :, 3:6], axis=2, keepdims=True)); floors.append(np.array([0.01]))
            motion_grid = np.concatenate(grids, axis=2)
            floor = np.concatenate(floors)[None, None, :]
            spread, centre = _scaled(motion_grid, floor, left_out)
            m = _sigmoid_window(motion_grid, centre, spread, floor, g.window)
            p = cnn_input._median_scaled(pg, True, left_out, g)
            # Trainer channel order (accelerometer, gyroscope, pulse), then the derived ones.
            rows = np.concatenate([m[:, :, :6], p, m[:, :, 6:]], axis=2)
            out[part] = rows.transpose(0, 2, 1).reshape(len(d), channels * g.window)
            out[part][~whole] = np.nan
        out[~ok | ~np.isfinite(out).all(axis=1)] = np.nan
        return out

    return build, name
