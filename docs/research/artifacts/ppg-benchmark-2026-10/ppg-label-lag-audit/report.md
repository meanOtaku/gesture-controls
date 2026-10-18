# Disposable PPG label-lag audit

No retraining, prediction averaging, calibration, or prediction changes. Positive shifts move labels later; negative shifts move labels earlier. All shifts are global within each evaluation, from -2000 to +2000 ms in 50 ms steps. The pooled optimum applies one common shift to all recordings; per-recording optima are descriptive and are not combined.

Frozen evaluation: probability >=0.5; first above-threshold sample counts as a rising edge; later edges require a previous below-threshold sample. Accept an edge only >=1500 ms after the last accepted edge (a rejected edge does not reset the refractory clock). Decisions are anchor +880 ms. Chronological greedy one-to-one matching uses the inclusive start +680..+1280 ms window, choosing the closest start +880 ms, then earliest label index. False activations are unmatched accepted edges; rate denominator is (last anchor - first anchor +40 ms)/60000. This is not a false-positive rate over verified background.

Raw labels use the exact frozen parser/holds mapping (pinching -> pinch, merge same-label holds across gaps <400 ms, retain holds >=200 ms). No clock repair. Shifted labels are filtered to the original anchor range at every shift. A fixed zero-shift label cohort sensitivity is also provided; neither approach changes predictions or duration. Proximity uses all raw mapped pinch starts in the same recording, including those outside the evaluation anchor range.

Verified 37 recordings, 300 held-out appearances and 389778 saved prediction rows. All raw sampled events, every zero-shift fold/session metric, and the CV aggregate reproduce. Repeated appearances count repeatedly, including in proximity statistics; they are correlated observations.

| Pool | Zero-shift matched recall | Zero false / min | Best shift ms | Best matched recall | Best false / min |
|---|---|---|---|---|---|
| all | 894/3422 (26.13%) | 4961 / 19.092 | -350 | 1599/3389 (47.18%) | 4256 / 16.379 |
| labelled | 894/3422 (26.13%) | 2948 / 17.282 | -350 | 1599/3389 (47.18%) | 2243 / 13.149 |
| zero_label | N/A (zero starts) | 2013 / 22.551 | -2000..2000 | N/A (zero starts) | 2013 / 22.551 |

## Flatness and uncertainty

Optima maximize matched starts, then minimize false activations. All tied shifts are retained; the representative minimizes absolute shift, then signed shift. Because activation counts are fixed, fewer false activations is algebraically equivalent to more matches and adds no independent tie-breaking information. Near-optimal means a loss of at most max(1 match, 1% of best matches); this is a descriptive tolerance, not a confidence interval.
- all: optimal shifts -350 ms; near-optimal shifts -350 ms; matched-count range [449, 1599]; start-denominator range [3297, 3436]; optimum touches search boundary: False.
- labelled: optimal shifts -350 ms; near-optimal shifts -350 ms; matched-count range [449, 1599]; start-denominator range [3297, 3436]; optimum touches search boundary: False.
- zero_label: optimal shifts -2000..2000 ms; near-optimal shifts -2000..2000 ms; matched-count range [0, 0]; start-denominator range [0, 0]; optimum touches search boundary: True.

Fixed zero-shift cohort: optimal shifts -350 ms, best 1613/3422 (47.14%), 4242 false activations. Full sensitivity sweep is in audit.json.
Leave-one-labelled-recording-out optimal shifts span -350 to -350 ms. Individual omission results are in audit.json.

The 50 ms grid, 600 ms matching window, repeated CV appearances, and selection of the best shift on these same predictions limit timing precision. Per-recording differences and broad near-optimal regions measure sensitivity, not statistical confidence. No independent physical timing reference is available. An optimum shift is only evidence compatible with a label delay and can be confounded by model bias or repeated gestures. Activations do not establish physical ground truth; an unmatched activation need not be a true unintended gesture.

## Per-recording results

Counts and minutes pool that recording’s held-out appearances. Unique labels and appearance counts expose that repetition.

### Recordings with labelled pinch starts

| Recording | Unique starts / appearances | Zero recall | Zero false / min | Optimal shifts ms | Best recall | Best false / min | Near-optimal shifts ms |
|---|---|---|---|---|---|---|---|
| gesture-dataset-pinch-2026-10-04T11-43-31.691Z | 24 / 11 | 60/264 (22.73%) | 159 / 15.476 | -350 | 112/253 (44.27%) | 107 / 10.415 | -350 |
| gesture-dataset-pinch-2026-10-11T02-54-10.616Z | 5 / 11 | 24/55 (43.64%) | 81 / 16.889 | -150 | 30/55 (54.55%) | 75 / 15.638 | -150 |
| gesture-dataset-pinch-2026-10-11T03-23-55.502Z | 8 / 6 | 40/48 (83.33%) | 15 / 5.769 | -50, 50..100 | 41/48 (85.42%) | 14 / 5.385 | -50..100 |
| gesture-dataset-pinch-2026-10-11T03-25-53.983Z | 9 / 10 | 10/90 (11.11%) | 86 / 19.907 | -500 | 72/90 (80.00%) | 24 / 5.556 | -550..-500 |
| gesture-dataset-pinch-2026-10-11T08-25-29.427Z | 11 / 5 | 14/55 (25.45%) | 100 / 21.444 | -550, -450 | 33/55 (60.00%) | 81 / 17.370 | -550, -450..-400 |
| gesture-dataset-pinch-2026-10-11T08-35-42.008Z | 12 / 9 | 14/108 (12.96%) | 200 / 23.810 | -1400..-1350 | 50/108 (46.30%) | 164 / 19.524 | -1400..-1350 |
| gesture-dataset-pinch-2026-10-11T08-53-30.484Z | 27 / 9 | 28/243 (11.52%) | 201 / 23.963 | -500..-450 | 134/243 (55.14%) | 95 / 11.326 | -500..-400 |
| gesture-dataset-pinch-2026-10-11T12-05-39.593Z | 15 / 9 | 64/135 (47.41%) | 123 / 14.643 | -150 | 89/135 (65.93%) | 98 / 11.667 | -250, -150 |
| gesture-dataset-pinch-2026-10-11T12-08-32.241Z | 19 / 8 | 28/152 (18.42%) | 133 / 17.812 | -450..-400 | 116/152 (76.32%) | 45 / 6.027 | -450..-350 |
| gesture-dataset-pinch-2026-10-14T00-54-06.988Z | 21 / 7 | 52/147 (35.37%) | 97 / 14.826 | -350 | 81/154 (52.60%) | 68 / 10.393 | -400..-350 |
| gesture-dataset-pinch-2026-10-14T00-55-38.245Z | 24 / 5 | 46/120 (38.33%) | 56 / 11.966 | 0..50 | 46/120 (38.33%) | 56 / 11.966 | -50..50 |
| gesture-dataset-pinch-2026-10-14T00-57-01.701Z | 21 / 10 | 115/210 (54.76%) | 95 / 10.164 | -300, -200 | 158/210 (75.24%) | 52 / 5.563 | -300..-150 |
| gesture-dataset-pinch-2026-10-14T00-58-20.761Z | 24 / 11 | 62/264 (23.48%) | 199 / 19.369 | -350 | 216/264 (81.82%) | 45 / 4.380 | -400..-300 |
| gesture-dataset-pinch-2026-10-14T00-59-37.623Z | 17 / 7 | 44/119 (36.97%) | 97 / 14.794 | -250..-200 | 70/119 (58.82%) | 71 / 10.829 | -300..-200 |
| gesture-dataset-pinch-2026-10-14T01-00-54.801Z | 23 / 7 | 1/161 (0.62%) | 152 / 23.232 | 850 | 133/154 (86.36%) | 20 / 3.057 | 850 |
| gesture-dataset-pinch-2026-10-14T01-04-14.013Z | 27 / 5 | 19/135 (14.07%) | 93 / 19.900 | -1100 | 47/135 (34.81%) | 65 / 13.909 | -1100..-1050, 700 |
| gesture-dataset-pinch-2026-10-14T01-05-31.133Z | 27 / 8 | 71/216 (32.87%) | 128 / 17.118 | -250 | 141/216 (65.28%) | 58 / 7.757 | -300..-250 |
| gesture-dataset-pinch-2026-10-14T01-13-08.108Z | 24 / 6 | 73/144 (50.69%) | 53 / 9.458 | -250..-200 | 79/138 (57.25%) | 47 / 8.387 | -250..-150 |
| gesture-dataset-pinch-2026-10-17T12-21-44.346Z | 14 / 3 | 2/42 (4.76%) | 53 / 18.929 | -650..-400 | 27/42 (64.29%) | 28 / 10.000 | -650..-400 |
| gesture-dataset-pinch-2026-10-17T12-23-03.399Z | 14 / 9 | 5/126 (3.97%) | 148 / 17.594 | -700 | 82/126 (65.08%) | 71 / 8.440 | -800, -700 |
| gesture-dataset-pinch-2026-10-17T12-25-10.832Z | 13 / 9 | 24/117 (20.51%) | 163 / 19.363 | -1150 | 44/108 (40.74%) | 143 / 16.987 | -1200..-1150 |
| gesture-dataset-pinch-2026-10-17T12-26-46.748Z | 20 / 9 | 15/180 (8.33%) | 157 / 18.624 | -1300 | 63/171 (36.84%) | 109 / 12.930 | -1300 |
| gesture-dataset-pinch-2026-10-17T12-40-50.602Z | 9 / 11 | 10/99 (10.10%) | 185 / 17.994 | -700 | 40/99 (40.40%) | 155 / 15.076 | -700 |
| gesture-dataset-pinching-2026-09-23T02-26-28.273Z | 16 / 12 | 73/192 (38.02%) | 174 / 15.480 | 0 | 73/192 (38.02%) | 174 / 15.480 | 0 |

### Zero-labelled-start recordings

| Recording | Unique starts / appearances | Zero recall | Zero false / min | Optimal shifts ms | Best recall | Best false / min | Near-optimal shifts ms |
|---|---|---|---|---|---|---|---|
| gesture-dataset-everything_else-2026-10-14T01-09-05.948Z | 0 / 4 | N/A (zero starts) | 70 / 18.710 | -2000..2000 | N/A (zero starts) | 70 / 18.710 | -2000..2000 |
| gesture-dataset-everything_else-2026-10-14T01-14-16.596Z | 0 / 4 | N/A (zero starts) | 84 / 22.468 | -2000..2000 | N/A (zero starts) | 84 / 22.468 | -2000..2000 |
| gesture-dataset-fist-2026-10-04T12-09-26.941Z | 0 / 5 | N/A (zero starts) | 97 / 20.682 | -2000..2000 | N/A (zero starts) | 97 / 20.682 | -2000..2000 |
| gesture-dataset-fist-2026-10-11T03-26-47.633Z | 0 / 8 | N/A (zero starts) | 71 / 20.481 | -2000..2000 | N/A (zero starts) | 71 / 20.481 | -2000..2000 |
| gesture-dataset-fist-2026-10-11T09-11-54.466Z | 0 / 9 | N/A (zero starts) | 178 / 21.145 | -2000..2000 | N/A (zero starts) | 178 / 21.145 | -2000..2000 |
| gesture-dataset-fist-2026-10-11T12-11-54.033Z | 0 / 9 | N/A (zero starts) | 202 / 24.013 | -2000..2000 | N/A (zero starts) | 202 / 24.013 | -2000..2000 |
| gesture-dataset-fist-2026-10-11T12-13-10.266Z | 0 / 11 | N/A (zero starts) | 222 / 21.654 | -2000..2000 | N/A (zero starts) | 222 / 21.654 | -2000..2000 |
| gesture-dataset-fist-2026-10-14T01-02-50.880Z | 0 / 13 | N/A (zero starts) | 278 / 22.831 | -2000..2000 | N/A (zero starts) | 278 / 22.831 | -2000..2000 |
| gesture-dataset-fist-2026-10-14T01-06-46.525Z | 0 / 9 | N/A (zero starts) | 210 / 24.964 | -2000..2000 | N/A (zero starts) | 210 / 24.964 | -2000..2000 |
| gesture-dataset-fist-2026-10-14T01-10-16.565Z | 0 / 9 | N/A (zero starts) | 196 / 23.317 | -2000..2000 | N/A (zero starts) | 196 / 23.317 | -2000..2000 |
| gesture-dataset-fist-2026-10-14T01-11-31.499Z | 0 / 6 | N/A (zero starts) | 129 / 22.970 | -2000..2000 | N/A (zero starts) | 129 / 22.970 | -2000..2000 |
| gesture-dataset-thumbs_up-2026-10-11T03-28-55.957Z | 0 / 6 | N/A (zero starts) | 67 / 25.809 | -2000..2000 | N/A (zero starts) | 67 / 25.809 | -2000..2000 |
| gesture-dataset-thumbs_up-2026-10-11T09-13-46.511Z | 0 / 10 | N/A (zero starts) | 209 / 22.377 | -2000..2000 | N/A (zero starts) | 209 / 22.377 | -2000..2000 |

## Zero-shift false-activation proximity

Primary signed offset is activation decision minus nearest mapped pinch start: negative means before the label. The secondary anchor offset subtracts the fixed 880 ms decision delay, then independently finds the nearest start. Ties select the earlier start. These are two different time references. Sessions without a mapped pinch start have undefined proximity, not zero offset. Each activation and signed offset is saved in false-activation-proximity.json; per-recording proportions and signed quantiles are in audit.json.

| Pool / time reference | False / with nearest start | <=250 ms | <=500 ms | <=1000 ms | <=1500 ms | <=3000 ms | Signed median ms |
|---|---|---|---|---|---|---|---|
| all / signed_decision_minus_start_ms | 4961 / 2948 | 523 (17.74%) | 1187 (40.26%) | 2198 (74.56%) | 2384 (80.87%) | 2719 (92.23%) | 221.32135400000152 |
| all / signed_anchor_minus_start_ms | 4961 / 2948 | 233 (7.90%) | 983 (33.34%) | 1890 (64.11%) | 2404 (81.55%) | 2703 (91.69%) | -325.89781799999946 |
| labelled / signed_decision_minus_start_ms | 2948 / 2948 | 523 (17.74%) | 1187 (40.26%) | 2198 (74.56%) | 2384 (80.87%) | 2719 (92.23%) | 221.32135400000152 |
| labelled / signed_anchor_minus_start_ms | 2948 / 2948 | 233 (7.90%) | 983 (33.34%) | 1890 (64.11%) | 2404 (81.55%) | 2703 (91.69%) | -325.89781799999946 |
| zero_label / signed_decision_minus_start_ms | 2013 / 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| zero_label / signed_anchor_minus_start_ms | 2013 / 0 | N/A | N/A | N/A | N/A | N/A | N/A |

Percentages above use false activations with an available same-recording pinch start. JSON also supplies proportions of all false activations, including those without a start. Zero-start sessions are separated using their zero-shift eligible labels.

## Files and verification

audit.py is the executable audit; audit.json contains all 81 shifts for every recording and pool, sensitivity summaries and proximity aggregates. mapped-labels.json retains the raw-label mapping; false-activation-proximity.json retains each zero-shift false activation. self-check.json records successful reproduction. source-hashes.json verifies every consumed source before and after; artifact-hashes.json hashes generated deliverables. All writes are confined to /tmp/ppg-label-lag-audit.
