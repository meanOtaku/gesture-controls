"""Reproduce the 60/40 complete-recording pinch-onset comparison.

Run from tools/label-trainer:
  uv run --with numpy --with scikit-learn python \
    ../../docs/research/ppg-step-study/scripts/evaluate_green_onset_60_40.py .
"""
import sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, sys.argv[1])
from load import recordings

GRID = np.arange(-400, 901, 40)
BEFORE = (GRID >= -400) & (GRID <= -100)
AFTER = (GRID >= 400) & (GRID <= 900)


def robust_signal(times, values):
    out = np.zeros(len(values)); left = 0
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


def two_stage_green(times, values):
    first = np.zeros(len(values)); left = 0
    for i, now in enumerate(times):
        while times[left] < now - 2000:
            left += 1
        past = values[left:i]
        if len(past) >= 20 and (std := past.std()):
            z = (values[i] - past.mean()) / std
            first[i] = round(1 / (1 + np.exp(-np.clip(z, -60, 60))), 5)
    return robust_signal(times, first)


def trace_at(times, signal, at):
    return signal[np.clip(np.searchsorted(times, at + GRID, side="right") - 1, 0, len(times) - 1)]


def step(times, signal, at):
    trace = trace_at(times, signal, at)
    return float(trace[AFTER].mean() - trace[BEFORE].mean())


def quality_features(g, r, ir):
    return [
        g[AFTER].mean() - g[BEFORE].mean(), np.diff(r).std(), np.diff(ir).std(),
        np.abs(np.diff(r)).mean(), np.abs(np.diff(ir)).mean(), np.abs(g-r).mean(),
        np.abs(g-ir).mean(), (r+ir).mean()/2, (r[AFTER].mean()+ir[AFTER].mean())/2,
    ]


def pinch_holds(rec):
    times, labels = rec.timestamps_ns / 1e6, rec.raw_labels
    result, start = [], None
    for index, label in enumerate(labels):
        if label == "pinch" and start is None:
            start = times[index]
        elif label != "pinch" and start is not None:
            result.append((start, times[index - 1])); start = None
    return result + ([(start, times[-1])] if start is not None else [])


def build_rows(rest_seed):
    rng, rows = np.random.default_rng(rest_seed), []
    for name, gesture, _day, rec in recordings():
        if gesture != "pinch":
            continue
        source = rec.timestamps_ns / 1e6
        if not (np.all(np.diff(source) >= 0) and source[-1] - source[0] < 3_600_000):
            continue
        seen, times = rec.ppg_observed, source[rec.ppg_observed]
        holds = pinch_holds(rec)
        starts = [start for start, _ in holds if times[0] + 2500 < start < times[-1] - 1500]
        bounds = np.array([value for hold in holds for value in hold])
        candidates = times[(times > times[0] + 2500) & (times < times[-1] - 1500)]
        rest = [x for x in candidates if len(bounds) and np.min(np.abs(bounds - x)) > 1500]
        rest = list(rng.choice(rest, size=min(len(rest), max(len(starts), 10)), replace=False)) if rest else []
        green, red, ir = [rec.channels[channel][seen] for channel in ("ppg_green", "ppg_red", "ppg_ir")]
        g, r, i, two = robust_signal(times, green), robust_signal(times, red), robust_signal(times, ir), two_stage_green(times, green)
        for target, moments in ((1, starts), (0, rest)):
            for at in moments:
                gt, rt, it = trace_at(times, g, at), trace_at(times, r, at), trace_at(times, i, at)
                rows.append((name, target, [step(times, two, at)], [step(times, g, at), step(times, r, at), step(times, i, at)], quality_features(gt, rt, it), [step(times, g, at)]))
    return rows


scores = {name: [] for name in ("two-stage green", "RGB robust steps", "green + red/IR quality", "green robust step")}
for rest_seed in range(10):
    rows = build_rows(rest_seed)
    groups, y = np.array([row[0] for row in rows]), np.array([row[1] for row in rows])
    features = {"two-stage green": np.array([row[2] for row in rows]), "RGB robust steps": np.array([row[3] for row in rows]), "green + red/IR quality": np.array([row[4] for row in rows]), "green robust step": np.array([row[5] for row in rows])}
    recording_ids = np.unique(groups)
    assert len(recording_ids) == 10, len(recording_ids)
    for split_seed in range(50):
        test_ids = np.random.default_rng(split_seed).choice(recording_ids, size=4, replace=False)
        test = np.isin(groups, test_ids)
        for name, x in features.items():
            model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, random_state=0))
            model.fit(x[~test], y[~test])
            scores[name].append(roc_auc_score(y[test], model.predict_proba(x[test])[:, 1]))

print("60/40 complete-recording split: 6 train / 4 unseen test; 50 splits x 10 rest draws = 500 tests")
for name, values in scores.items():
    values = np.array(values)
    print(f"{name}: mean={values.mean():.3f} median={np.median(values):.3f} min={values.min():.3f} max={values.max():.3f} std={values.std():.3f}")
