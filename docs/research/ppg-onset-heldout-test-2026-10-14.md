# PPG pinch onset: held-out test on the 2026-10-14 recordings

**Status:** research only. A one-shot test: the protocol, techniques and training were fixed before the run (written into
the script's docstring), and the test recordings were used once. **The 2026-10-14 recordings have now been seen;** they
can no longer serve as an untouched test set.

Script: [scripts/heldout_test_2026_10_14.py](ppg-step-study/scripts/heldout_test_2026_10_14.py). Output:
[scripts/heldout-2026-10-14-report.txt](ppg-step-study/scripts/heldout-2026-10-14-report.txt).

**Short answer.** On a new day, with labelled non-pinch activity, every PPG onset technique from the October work tells a
pinch start from everything else only at **about 0.60–0.64 AUC**, with intervals reaching down to about 0.45:

- **Fist starts** are not told apart from pinch starts at all (0.37–0.57).
- **No technique is better than another** beyond the uncertainty.
- **As continuous detectors, none is usable.**
- **The 0.78 on the original recordings** (where everything was explored) did not carry over to a new day.

## Data

- **Training:** the 17 usable recordings of the original manifest set (2026-09-23 to 2026-10-11), nothing else.
- **Test:** the 15 recordings of 2026-10-14:
  - 9 pinch and 4 fist recordings, each with its gesture marked;
  - 2 `everything_else` recordings: non-pinch activity throughout, identified by the file name, with no marks.

Test moments:

| Moment | Count |
|---|---:|
| pinch starts | 208 |
| everything_else | 80 |
| mid-pinch | 73 |
| unmarked time in pinch and fist recordings | 140 |
| fist starts | 68 |
| mid-fist | 39 |

Pinch and fist starts are marked stretches merged across gaps under 400 ms and at least 200 ms long. Each moment has 2.5 s
of signal before it and 1.5 s after.

## Techniques

As defined in [ppg-green-onset-experiments-2026-10.md](ppg-green-onset-experiments-2026-10.md) and
[ppg-rgb-onset-follow-up-2026-10.md](ppg-rgb-onset-follow-up-2026-10.md). The features are computed as in
`evaluate_green_onset_60_40.py`: causal 2 s median/MAD, zero-order hold on a 40 ms grid from −400 to +880 ms.

| # | Technique | Features |
|---|---|---|
| 1 | green robust step | 1 |
| 2 | two-stage green (z-score → sigmoid → round 1e-5 → median/MAD → step) | 1 |
| 3 | green step + red/IR quality | 9 |
| 4 | green/red/IR robust steps (the app's `rel_z_step` idea) | 3 |
| 5 | RGB candidate: 33-sample RGB waveform, 8 red/IR quality and 9 shape features | 116 |

Each is fitted with a train-only `StandardScaler` and `LogisticRegression` (C = 1), trained two ways:

- **A, as documented:** pinch recordings only, with controls at least 1.5 s from any mark; rest draws 0–9, scores
  averaged.
- **B, all other moments:** every original recording; mid-pinch, unmarked time, and other gestures' starts and middles.

## Results

### Pinch start vs each kind of moment

Training B; AUC with a 95% interval from resampling test recordings. Training A gives the same picture within the
intervals; techniques 1 and 2 have a single feature, so their ranking, and therefore their AUC, is identical either way.

| Technique | everything_else | mid-pinch | unmarked time | fist starts | mid-fist | all non-start |
|---|---|---|---|---|---|---|
| 1 green robust step | 0.65 [0.52–0.77] | 0.65 [0.30–0.93] | 0.65 [0.46–0.81] | 0.41 [0.22–0.64] | 0.79 [0.58–0.93] | 0.62 [0.48–0.77] |
| 2 two-stage green | 0.60 [0.48–0.72] | 0.77 [0.52–0.95] | 0.59 [0.42–0.74] | 0.39 [0.22–0.62] | 0.67 [0.42–0.92] | 0.60 [0.45–0.74] |
| 3 green + red/IR quality | 0.63 [0.50–0.79] | 0.58 [0.33–0.83] | 0.63 [0.44–0.80] | 0.47 [0.21–0.72] | 0.74 [0.54–0.90] | 0.60 [0.46–0.75] |
| 4 RGB robust steps | 0.60 [0.46–0.78] | 0.67 [0.44–0.91] | 0.65 [0.43–0.84] | 0.57 [0.22–0.87] | 0.73 [0.51–0.93] | 0.64 [0.47–0.82] |
| 5 RGB candidate | 0.63 [0.49–0.80] | 0.66 [0.46–0.84] | 0.65 [0.45–0.83] | 0.51 [0.30–0.72] | 0.66 [0.48–0.87] | 0.62 [0.46–0.80] |

### As continuous detectors

Training B, deciding at +900 ms, every 80 ms over every test recording. A detection counts as found within ±600 ms of a
marked pinch start; detections are at least 1.5 s apart.

| Technique | Threshold | Pinch found | False per min, pinch recordings | False per min, fist recordings | False per min, everything_else |
|---|---|---|---|---|---|
| 1 green robust step | 0.5 | 29% | 3.4 | 12.6 | 9.1 |
| 1 green robust step | 0.9 | 3% | 0.2 | 2.1 | 1.1 |
| 4 RGB robust steps | 0.5 | 34% | 4.6 | 15.8 | 10.7 |
| 4 RGB robust steps | 0.9 | 7% | 0.4 | 4.0 | 4.8 |
| 5 RGB candidate | 0.5 | 52% | 10.0 | 24.6 | 17.7 |
| 5 RGB candidate | 0.9 | 15% | 3.4 | 12.6 | 5.4 |

Every technique and threshold is in the report; none finds a useful share of pinches without many false activations a
minute.

## What it means

- **The PPG onset step does not generalise to a new day well enough to detect pinches.** Against labelled non-pinch
  activity it is barely above chance, and during fist gestures it fires as readily as during pinches.
- **Technique choice does not matter on this evidence.** Z-score/sigmoid, quality features, the RGB waveform and shape
  features: the differences between them are smaller than their uncertainty, as the follow-up predicted.
- **This is not evidence that PPG carries no gesture information:**
  - It is one wearer.
  - Training covered only four days, mostly one.
  - Only a few simple models were tried.
  - The marks carry about ±250 ms of timing noise.
- **But a pinch detector built from these techniques would not work.**

## What next

These are options rather than a ranking; the evidence does not single one out.

- **Move PPG to a supporting role.** PPG does show *a* hand gesture starting, so use it beside the motion sensors (for
  example, to confirm an onset the motion model proposes) rather than as the main signal.
- **Use the 2026-10-14 recordings as training data now,** since they have been seen. Five days and labelled non-pinch
  activity may change a learned model's picture; it would then need yet another untouched day to be judged. The resulting
  mixed-era session/strap study is recorded in
  [ppg-mixed-era-robustness-2026-10.md](ppg-mixed-era-robustness-2026-10.md).
- **Before more feature work, test the single most informative remaining question on a new untouched day:** a PPG-only
  model trained on all five days, judged against pinches made with the arm deliberately still.
