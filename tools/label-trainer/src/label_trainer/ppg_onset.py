"""The PPG pinch-start model's inputs: multi-scale causal z-score, cubic derivatives, and their window summaries.

Mirrored exactly by `crates/pinch-inference/src/ppg_onset.rs` (the shared cases in `tests/fixtures/ppg_onset_cases.json`
keep the two equal). Research: `docs/research/artifacts/ppg-benchmark-2026-10/ppg-multiscale-zscore/`.

For a decision at time T (the newest PPG sample's timestamp):

1. A 25 Hz grid of `GRID_TICKS` ticks ends at T: tick k is at T - (GRID_TICKS - 1 - k) * 40 ms. Each tick holds the last PPG
   sample at or before it (zero-order hold); a tick before the first sample has none.
2. Each channel (green, red, IR) is z-scored, at every tick, against each of `HISTORIES` previous ticks (the tick itself
   excluded): population mean and standard deviation of those that hold a sample, at least `MIN_HISTORY` of them; no
   spread gives 0.
3. Each z-series is differentiated by a least-squares cubic over its previous nine ticks (the tick itself excluded),
   evaluated at the tick: slope, curvature and jerk.
4. The final 8, 16 and 32 ticks of each derivative are summarised by the 21 statistics in `STATS`.

That is 3 histories x 3 orders x 3 windows x 21 statistics x 3 channels = 1,701 features, named in `FEATURE_NAMES` in that
order (history, order, window, statistic, channel). A decision whose 5.6 s holds a gap between PPG samples longer than
`MAX_GAP_MS`, or not enough history for every value, has no features (a row of NaN).
"""

from __future__ import annotations

import numpy as np

TICK_NS = 40_000_000
HISTORIES = (25, 50, 100)          # 1, 2 and 4 s of previous ticks
MIN_HISTORY = 20
DIFF_TAPS = 9
WINDOWS = (8, 16, 32)
GRID_TICKS = max(HISTORIES) + DIFF_TAPS + max(WINDOWS)   # 141: every value used has its full history
MAX_GAP_MS = 250
CHANNELS = ("green", "red", "ir")
STATS = ("q10", "q25", "median", "q75", "q90", "mad", "mean", "std", "energy", "min", "max", "positive_peak",
         "negative_peak", "absolute_peak", "zero_crossings", "max_age_seconds", "min_age_seconds",
         "absolute_peak_age_seconds", "end_minus_start", "late_minus_early_mean", "mean_absolute_change")
FEATURE_NAMES = tuple(
    f"ppg_z{h * 40}ms_d{order}_{channel}_n{window}_{stat}"
    for h in HISTORIES for order in (1, 2, 3) for window in WINDOWS for stat in STATS for channel in CHANNELS
)
FEATURE_COUNT = len(FEATURE_NAMES)
assert FEATURE_COUNT == 1701


def diff_coefficients() -> np.ndarray:
    """(3, 9): slope, curvature and jerk at the current tick from the previous nine, by a least-squares cubic."""
    t = np.arange(-DIFF_TAPS, 0) * (TICK_NS / 1e9)
    fit = np.linalg.pinv(np.vander(t, 4, increasing=True))     # coefficients of 1, t, t^2, t^3
    return (fit * np.array([1.0, 1.0, 2.0, 6.0])[:, None])[1:]


COEFFICIENTS = diff_coefficients()


def grid(ts_ns: np.ndarray, values: np.ndarray, decisions_ns: np.ndarray) -> np.ndarray:
    """(decisions, GRID_TICKS, 3): the zero-order-held PPG at each decision's ticks; NaN before the first sample."""
    offsets = (np.arange(GRID_TICKS, dtype=np.int64) - (GRID_TICKS - 1)) * TICK_NS
    ticks = decisions_ns.astype(np.int64)[:, None] + offsets[None, :]
    index = np.searchsorted(ts_ns, ticks, side="right") - 1
    out = values[np.clip(index, 0, None)]
    out[index < 0] = np.nan
    return out


def _gap_free(ts_ns: np.ndarray, decisions_ns: np.ndarray) -> np.ndarray:
    """True where no two consecutive samples inside a decision's span are further apart than MAX_GAP_MS."""
    span = (GRID_TICKS - 1) * TICK_NS
    big = np.flatnonzero(np.diff(ts_ns) > MAX_GAP_MS * 1_000_000)     # gap between ts[i] and ts[i+1]
    if big.size == 0:
        return np.ones(len(decisions_ns), dtype=bool)
    after = ts_ns[big + 1]
    # A gap counts when its later sample falls inside (T - span, T].
    first = np.searchsorted(after, decisions_ns - span, side="right")
    last = np.searchsorted(after, decisions_ns, side="right")
    return last == first


def zscores(g: np.ndarray, history: int) -> np.ndarray:
    """(n, GRID_TICKS - history, 3): ticks `history`.. of `g` against their previous `history` ticks."""
    n_ticks = g.shape[1]
    out = np.full((g.shape[0], n_ticks - history, g.shape[2]), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for i, t in enumerate(range(history, n_ticks)):
                past = g[:, t - history:t, :]
                count = np.sum(np.isfinite(past), axis=1)
                mean = np.nanmean(past, axis=1)
                sd = np.nanstd(past, axis=1)
                z = np.where(sd > 0, (g[:, t, :] - mean) / sd, 0.0)
                z[(count < MIN_HISTORY) | ~np.isfinite(g[:, t, :])] = np.nan
                out[:, i, :] = z
    return out


def derivatives(z: np.ndarray, length: int) -> np.ndarray:
    """(n, 3 orders, 3 channels, length): derivatives at the last `length` ticks of `z` from each one's previous nine."""
    n_ticks = z.shape[1]
    out = np.empty((z.shape[0], 3, z.shape[2], length))
    for j, t in enumerate(range(n_ticks - length, n_ticks)):
        segment = z[:, t - DIFF_TAPS:t, :]                       # (n, 9, 3)
        out[:, :, :, j] = np.einsum("ok,nkc->noc", COEFFICIENTS, segment)
    return out


def _zero_crossings(w: np.ndarray) -> np.ndarray:
    sign = np.sign(w)
    last = sign[:, 0].copy()
    count = np.zeros(len(w))
    for j in range(1, w.shape[1]):
        current = sign[:, j]
        count += (current != 0) & (last != 0) & (current != last)
        last = np.where(current != 0, current, last)
    return count


def summarize(w: np.ndarray) -> np.ndarray:
    """(rows, 21): the statistics of each row of `w`, in `STATS` order."""
    n = w.shape[1]
    dt = TICK_NS / 1e9
    half = n // 2
    rows = np.arange(len(w))
    q = np.quantile(w, [0.1, 0.25, 0.5, 0.75, 0.9], axis=1)
    magnitude = np.abs(w)
    return np.stack([
        *q,
        np.median(np.abs(w - q[2][:, None]), axis=1),
        w.mean(axis=1), w.std(axis=1), np.mean(w ** 2, axis=1),
        w.min(axis=1), w.max(axis=1), np.maximum(w.max(axis=1), 0.0), np.minimum(w.min(axis=1), 0.0), magnitude.max(axis=1),
        _zero_crossings(w),
        (n - 1 - w.argmax(axis=1)) * dt, (n - 1 - w.argmin(axis=1)) * dt, (n - 1 - magnitude.argmax(axis=1)) * dt,
        w[rows, -1] - w[rows, 0], w[:, half:].mean(axis=1) - w[:, :half].mean(axis=1),
        np.abs(np.diff(w, axis=1)).mean(axis=1),
    ], axis=1)


def features(ts_ns: np.ndarray, values: np.ndarray, decisions_ns: np.ndarray, chunk: int = 512) -> np.ndarray:
    """(decisions, FEATURE_COUNT) for PPG samples `values` (rows of green, red, IR) at `ts_ns` (sorted, int64); a row of NaN
    for a decision that has no features."""
    ts_ns = np.asarray(ts_ns, dtype=np.int64)
    values = np.asarray(values, dtype=np.float64)
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64)
    out = np.full((len(decisions_ns), FEATURE_COUNT), np.nan)
    if len(ts_ns) == 0 or len(decisions_ns) == 0:
        return out
    ok = _gap_free(ts_ns, decisions_ns)
    longest = max(WINDOWS)
    for start in range(0, len(decisions_ns), chunk):
        part = slice(start, start + chunk)
        g = grid(ts_ns, values, decisions_ns[part])
        blocks = []
        for history in HISTORIES:
            z = zscores(g[:, GRID_TICKS - (history + DIFF_TAPS + longest):, :], history)
            d = derivatives(z, longest)                               # (n, order, channel, 32)
            for order in range(3):
                for window in WINDOWS:
                    per_channel = [summarize(d[:, order, c, -window:]) for c in range(3)]   # each (n, 21)
                    blocks.append(np.stack(per_channel, axis=2).reshape(len(g), -1))      # stat-major, then channel
        block = np.concatenate(blocks, axis=1)
        block[~np.isfinite(block).all(axis=1)] = np.nan
        out[part] = block
    out[~ok] = np.nan
    return out


# ---------- what the model is trained on ----------

ONSET_DELAY_MS = 880          # a decision this long after a hold starts is that hold's start
NEAREST_SAMPLE_MS = 60        # the PPG sample taken for it must be this close
EDGE_CLEARANCE_MS = 1500      # a mid-hold or unlabelled decision is at least this far from a hold's edges
PER_KIND = 20                 # the most mid-hold, and unlabelled, decisions taken from one recording, of each kind
UNLABELLED_ONLY = 40          # the most from a recording with no holds at all
MATCH_EARLIEST_MS = 680       # a detection this long after a start, up to MATCH_LATEST_MS, catches it
MATCH_LATEST_MS = 1280
COOLDOWN_MS = 1500            # after a detection, the next one is ignored for this long
HOLD_MERGE_GAP_MS = 400       # two holds of the same label closer than this are one
MIN_HOLD_MS = 200             # a shorter hold is ignored


def holds(timestamps_ns: np.ndarray, labels: np.ndarray) -> list[tuple[int, int, str]]:
    """(start, end, label) of each hold: a run of rows with one label, in time order, joined to the previous hold of the
    same label when the gap between them is under HOLD_MERGE_GAP_MS, and kept when it lasts at least MIN_HOLD_MS. Rows
    without a label hold nothing."""
    runs: list[list] = []
    for ts, label in zip(timestamps_ns.tolist(), labels.tolist()):
        if runs and runs[-1][2] == label:
            runs[-1][1] = ts
        else:
            runs.append([ts, ts, label])
    merged: list[list] = []
    for start, end, label in runs:
        if not label:
            continue
        if merged and merged[-1][2] == label and start - merged[-1][1] < HOLD_MERGE_GAP_MS * 1_000_000:
            merged[-1][1] = end
        else:
            merged.append([start, end, label])
    return [(int(a), int(b), str(label)) for a, b, label in merged if b - a >= MIN_HOLD_MS * 1_000_000]


def _evenly(items: list[int], most: int) -> list[int]:
    """At most `most` of `items`, spread evenly over them (all of them when there are no more)."""
    if len(items) <= most:
        return items
    return [items[i] for i in sorted(set(np.linspace(0, len(items) - 1, most).round().astype(int).tolist()))]


def sample_decisions(ppg_ts_ns: np.ndarray, all_holds: list[tuple[int, int, str]], target: str, excluded: set[str]) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """The decisions a model trains on in one recording, whether each is a start of `target` (1) or not (0), and what each is.

    Decisions are PPG sample times, as the runtime scores them. Every hold of a label that is not excluded gives a
    decision ONSET_DELAY_MS after it starts (the nearest sample, within NEAREST_SAMPLE_MS): `start`, a positive, for the
    target; `other_start`, a negative, for another label. The hard part is telling a pinch's start from another gesture's,
    so every one of those is kept. Then, as negatives, up to PER_KIND decisions inside holds (`target_mid`, `other_mid`)
    and up to PER_KIND with no hold near (`unlabelled`; UNLABELLED_ONLY in a recording with no holds), each at least
    EDGE_CLEARANCE_MS from every hold edge, measured from the decision less ONSET_DELAY_MS, spread evenly. A decision whose
    span touches an excluded hold is left out."""
    ts = np.asarray(ppg_ts_ns, dtype=np.int64)
    if ts.size == 0:
        return ts, np.zeros(0, dtype=np.int64), []
    ms = 1_000_000
    delay, clearance = ONSET_DELAY_MS * ms, EDGE_CLEARANCE_MS * ms
    kept_holds = [h for h in all_holds if h[2] not in excluded]
    span = (GRID_TICKS - 1) * TICK_NS
    allowed = np.ones(ts.size, dtype=bool)        # a decision whose span touches an excluded hold is never taken
    for start, end, label in all_holds:
        if label in excluded:
            allowed &= ~((ts >= start) & (ts - span <= end))
    picked: list[tuple[int, int, str]] = []
    for start, _, label in kept_holds:
        want = start + delay
        i = int(np.argmin(np.abs(ts - want)))
        if abs(int(ts[i]) - want) <= NEAREST_SAMPLE_MS * ms and allowed[i]:
            picked.append((int(ts[i]), int(label == target), "start" if label == target else "other_start"))
    anchors = ts - delay
    for kind, wanted in (("target_mid", lambda label: label == target), ("other_mid", lambda label: label != target)):
        inside = np.zeros(ts.size, dtype=bool)
        for start, end, label in kept_holds:
            if wanted(label):
                inside |= (anchors >= start + clearance) & (anchors <= end - clearance)
        picked += [(t, 0, kind) for t in _evenly(ts[inside & allowed].tolist(), PER_KIND)]
    clear = allowed.copy()
    for start, end, _ in all_holds:
        clear &= (anchors < start - clearance) | (anchors > end + clearance)
    picked += [(t, 0, "unlabelled") for t in _evenly(ts[clear].tolist(), PER_KIND if all_holds else UNLABELLED_ONLY)]
    priority = {"start": 0, "other_start": 1}
    by_time: dict[int, tuple[int, int, str]] = {}
    for p in sorted(picked, key=lambda p: priority.get(p[2], 2)):
        by_time.setdefault(p[0], p)        # one decision per sample; a start wins
    out = [p for _, p in sorted(by_time.items())]
    return (np.array([p[0] for p in out], dtype=np.int64), np.array([p[1] for p in out], dtype=np.int64), [p[2] for p in out])


def detect(decisions_ns: np.ndarray, scores: np.ndarray, threshold: float) -> list[int]:
    """Detection times: a score reaching `threshold` after one below it, at least COOLDOWN_MS after the last detection."""
    above = np.asarray(scores) >= threshold
    out: list[int] = []
    for i in np.flatnonzero(above & ~np.concatenate([[False], above[:-1]])):
        t = int(decisions_ns[i])
        if not out or t - out[-1] >= COOLDOWN_MS * 1_000_000:
            out.append(t)
    return out


def match(detections_ns: list[int], onsets_ns: list[int]) -> tuple[int, list[int]]:
    """(caught starts, latency in ns of each catch): each detection, in order, takes the unmatched start it is
    MATCH_EARLIEST_MS..MATCH_LATEST_MS after, the one closest to ONSET_DELAY_MS (then the earliest)."""
    used: set[int] = set()
    latencies: list[int] = []
    lo, hi, target = MATCH_EARLIEST_MS * 1_000_000, MATCH_LATEST_MS * 1_000_000, ONSET_DELAY_MS * 1_000_000
    for d in detections_ns:
        candidates = [(abs(d - s - target), j) for j, s in enumerate(onsets_ns) if j not in used and lo <= d - s <= hi]
        if candidates:
            j = min(candidates)[1]
            used.add(j)
            latencies.append(d - onsets_ns[j])
    return len(used), latencies
