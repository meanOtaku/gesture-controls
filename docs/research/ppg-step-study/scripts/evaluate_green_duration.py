"""Event-locked check: does causal green PPG event duration match labelled pinch duration?

Run from tools/label-trainer:
  uv run --with numpy python ../../docs/research/ppg-step-study/scripts/evaluate_green_duration.py .
"""
import sys
import numpy as np

sys.path.insert(0, sys.argv[1])
from load import recordings

STEP_MS = 40.0


def pinch_holds(rec):
    times, labels = rec.timestamps_ns / 1e6, np.asarray(rec.raw_labels)
    cuts = [0, *(np.flatnonzero(labels[1:] != labels[:-1]) + 1), len(labels)]
    runs = [(times[a], times[b - 1], labels[a]) for a, b in zip(cuts, cuts[1:]) if labels[a] != "rest"]
    merged = []
    for start, end, label in runs:
        if merged and merged[-1][2] == label and start - merged[-1][1] < 400:
            merged[-1] = (merged[-1][0], end, label)
        else:
            merged.append((start, end, label))
    return [run for run in merged if run[1] - run[0] >= 200]


def causal_robust(times, values):
    out, left = np.full(len(values), np.nan), 0
    for i, now in enumerate(times):
        while times[left] < now - 2000:
            left += 1
        past = values[left:i]
        if len(past) >= 20:
            median = np.median(past)
            scale = np.median(np.abs(past - median)) * 1.4826
            if scale:
                out[i] = (values[i] - median) / scale
    return out


def rank(values):
    return np.argsort(np.argsort(values)).astype(float)


def estimate(times, z, start, end):
    """Labels select the evaluation event; they do not provide PPG landmarks."""
    grid = np.arange(start - 400, end + 1600 + STEP_MS, STEP_MS)
    index = np.clip(np.searchsorted(times, grid, side="right") - 1, 0, len(times) - 1)
    trace = np.nan_to_num(z[index], nan=0.0)
    smooth = np.array([trace[max(0, i - 2):i + 1].mean() for i in range(len(trace))])
    baseline = np.median(smooth[(grid >= start - 400) & (grid <= start - 100)])
    signal = smooth - baseline
    search = (grid >= start) & (grid <= min(end + 1200, start + 2500))
    if not np.any(search):
        return None
    peak = np.flatnonzero(search)[np.argmax(signal[search])]
    prominence = signal[peak]
    if prominence <= 0.5:
        return None
    before = np.flatnonzero((grid >= start - 400) & (grid <= grid[peak]))
    below = before[signal[before] <= 0.30 * prominence]
    if not len(below):
        return None
    onset = below[-1]
    recovery = next((i for i in np.flatnonzero(grid > grid[peak]) if i + 2 < len(signal) and np.all(signal[i:i + 3] <= 0.50 * prominence)), None)
    return None if recovery is None else (grid[onset], grid[peak], grid[recovery], prominence)


eligible, valid = [], []
for name, gesture, _day, rec in recordings():
    if gesture != "pinch":
        continue
    source = rec.timestamps_ns / 1e6
    if not (np.all(np.diff(source) >= 0) and source[-1] - source[0] < 3_600_000):
        continue
    seen, times = rec.ppg_observed, source[rec.ppg_observed]
    z = causal_robust(times, rec.channels["ppg_green"][seen])
    for start, end, _ in pinch_holds(rec):
        if start < times[0] + 2500 or end > times[-1] - 1600:
            continue
        eligible.append((name, start, end))
        result = estimate(times, z, start, end)
        if result:
            onset, peak, recovery, prominence = result
            valid.append((end - start, recovery - onset, recovery - end, peak - onset, prominence))

print(f"eligible labelled pinch events: {len(eligible)}")
print(f"valid green PPG rise+recovery estimates: {len(valid)} ({len(valid)/len(eligible):.1%})")
if valid:
    labelled, ppg_duration, release_offset, rise_duration, prominence = np.asarray(valid).T
    print(f"labelled duration ms: median={np.median(labelled):.0f}, range={labelled.min():.0f}..{labelled.max():.0f}")
    print(f"PPG event duration ms: median={np.median(ppg_duration):.0f}, range={ppg_duration.min():.0f}..{ppg_duration.max():.0f}")
    print(f"absolute duration error ms: median={np.median(np.abs(ppg_duration-labelled)):.0f}, mean={np.mean(np.abs(ppg_duration-labelled)):.0f}")
    print(f"recovery minus labelled release ms: median={np.median(release_offset):.0f}, mean={np.mean(release_offset):.0f}, within +/-200ms={np.mean(np.abs(release_offset)<=200):.1%}")
    print(f"duration Pearson r={np.corrcoef(labelled, ppg_duration)[0,1]:.3f}; Spearman r={np.corrcoef(rank(labelled), rank(ppg_duration))[0,1]:.3f}")
