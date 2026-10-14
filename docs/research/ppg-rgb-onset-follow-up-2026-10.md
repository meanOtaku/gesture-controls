# RGB PPG pinch-onset follow-up experiments, October 2026

**Status:** research only. This note records disposable offline experiments; no result changes the app's feature contract, training tooling, or runtime model.

## Question and evaluation boundary

The experiments compared variants of an RGB PPG pinch-onset classifier. Each candidate used source sensor timestamps, a causal 25 Hz resample, and a 2 s preceding normalization history. The candidate window contained 33 samples from -400 ms to +880 ms relative to the labelled onset. Therefore the *signal transforms* are causal, but this event-aligned score is **not deployable zero-latency onset inference**: it has 880 ms of post-onset lookahead.

The repeatable follow-up control used:

- 10 eligible recordings, with six training recordings and four held-out recordings per split;
- two deterministic rest-control draws and 10 recording-group splits for each draw (20 outer evaluations);
- complete recordings held out from training;
- train-only `StandardScaler` and sklearn `LogisticRegression` unless explicitly stated otherwise;
- raw green, red, and IR samples normalized independently with causal 2 s median/MAD normalization;
- the 33-sample RGB waveform and the existing eight red/IR quality features.

Repeated splits share recordings and are not independent confidence intervals. They are model-selection evidence only.

## Baseline protocols are not interchangeable

Two direct-RGB baselines were used during the study:

| Protocol | Mean AUC | Median | Min | Max | Notes |
|---|---:|---:|---:|---:|---|
| PyTorch linear classifier | 0.753800 | not recorded in this follow-up | not recorded in this follow-up | not recorded in this follow-up | Channel/time-wise scaling, clipping to +/-10, float32, Adam, and weighted BCE. |
| sklearn logistic-regression control | 0.734338 | 0.729552 | 0.610124 | 0.807550 | Per-feature `StandardScaler`; unweighted `C=1` logistic regression. |

The numerical difference is caused by different preprocessing and training protocols. It must not be attributed to rounding, and the two values must not be treated as a paired comparison.

## Preprocessing experiments

### Z-score, sigmoid, and quantization

The tested pipeline was:

```text
raw green/red/IR
-> per-channel causal 2 s mean/std z-score
-> sigmoid
-> decimal quantization
-> per-channel causal 2 s median/MAD normalization
-> RGB waveform + eight quality features
-> train-only standardization + logistic regression
```

| Quantization | Mean AUC | Median | Min | Max |
|---|---:|---:|---:|---:|
| `0.0001` | 0.634221 | 0.651604 | 0.531125 | 0.696096 |
| `0.000001` | 0.634323 | 0.651904 | 0.531054 | 0.696168 |

Changing the quantization level changed mean AUC by only 0.000102. Both variants were substantially weaker than the direct RGB control.

### Direct-RGB quantization control

Rounding the causal median/MAD-normalized RGB samples to six decimal places was neutral:

| Direct RGB control | Mean AUC | Std | Median | Min | Max |
|---|---:|---:|---:|---:|---:|
| Unrounded | 0.734337577 | 0.051060787 | 0.729552413 | 0.610124069 | 0.807549858 |
| Rounded to `0.000001` | 0.734347131 | 0.051020607 | 0.729552413 | 0.610322581 | 0.807621083 |

The paired mean change was +0.000009554 and the largest per-split AUC change was 0.000213675. Do not retain quantization as a performance technique.

## Regularization and class weighting

For every outer split, an inner recording-grouped CV selected `C` from `{0.01, 0.1, 1, 10, 100}` and `class_weight` from `{None, balanced}` by inner worst-fold AUC.

| Outer evaluation | Mean AUC | Median | Min | Max |
|---|---:|---:|---:|---:|
| Fixed `C=1`, unweighted | 0.734338 | 0.729552 | 0.610124 | 0.807550 |
| Nested-CV tuned | 0.735292 | 0.742898 | 0.595136 | 0.825291 |

The selected configurations were `(0.01, balanced)` eight times, `(0.01, None)` seven times, `(10, None)` twice, and `(0.1, None)`, `(1, None)`, and `(1, balanced)` once each. Tuning slightly increased mean AUC but made the worst split worse. It is rejected by the robustness objective.

## Feature ablation

The tested temporal shape family adds nine features: for each of green, red, and IR, first-difference RMS/energy, linear slope across the window, and end-minus-start. Pairwise Pearson correlations were separately tested. Existing features were inspected before the experiment so these additions did not duplicate them.

| Variant | Mean AUC | Median | Min | Max |
|---|---:|---:|---:|---:|
| Baseline | 0.734338 | 0.729552 | 0.610124 | 0.807550 |
| **Baseline + shape** | **0.734585** | **0.734098** | **0.622233** | **0.815171** |
| Baseline + correlation | 0.697989 | 0.694416 | 0.566168 | 0.843970 |
| Baseline + shape + correlation | 0.694266 | 0.690979 | 0.561254 | 0.839603 |

Shape features increased the minimum AUC by 0.012109 with a negligible mean increase of 0.000247. They are the only accepted model-side change from this follow-up. Correlation features are rejected.

## Training-only augmentation ablation

All augmentation was deterministic, applied only to training recordings before normalization, and never applied to held-out recordings. Variants were gain/offset (A), additive channel noise (B), and both (C). A result was accepted only if it improved minimum AUC without reducing mean AUC by more than 0.002 versus the shape model.

| Variant | Mean AUC | Median | Min | Max |
|---|---:|---:|---:|---:|
| Shape-only | 0.734585 | 0.734098 | 0.622233 | 0.815171 |
| Shape + A | 0.729967 | 0.730299 | 0.620149 | 0.809259 |
| Shape + B | 0.730484 | 0.728961 | 0.642990 | 0.813319 |
| Shape + C | 0.731422 | 0.729664 | 0.646274 | 0.814459 |

Noise improved the minimum, but every augmentation exceeded the permitted mean loss. Augmentation also doubles training rows, which changes effective regularization at fixed `C`. No augmentation variant is accepted.

## Dataset-label audit: current acceptance blocker

The audit found that the negative/rest class is not usable as an independently labelled non-pinch class:

- 243 of 292 unique rest windows overlapped recorded pinch holds;
- the remaining 49 windows came from missing source labels;
- all 12,017 source rows interpreted as rest came from blank labels;
- excluding every ambiguous negative left zero clean negative windows across the 10 eligible recordings;
- this removed 194 of 567 windows per rest seed (34.22%), leaving 373 positives and no evaluable binary split.

No source labels were changed. The current AUC values are exploratory separation scores against generated rest controls, not acceptance evidence for pinch-vs-non-pinch deployment.

The same flaw was then found in the step study's controls, and each kind of negative was tested separately: mid-pinch,
unmarked time, fist and thumbs-up starts, and their middles. See
[ppg-onset-open-questions-2026-10.md](ppg-onset-open-questions-2026-10.md). Against other gestures' starts, a green/red/IR
step scores only about 0.65. On an untouched new day the retained RGB candidate scored 0.62 [0.46–0.80] against all
non-pinch moments, no better than the plain steps, and was unusable as a continuous detector
([ppg-onset-heldout-test-2026-10-14.md](ppg-onset-heldout-test-2026-10-14.md)).

## Decision

For future **research-only** comparisons on this corpus, retain this candidate:

```text
causal 2 s median/MAD normalization per RGB channel
-> 33-sample RGB waveform
-> existing eight red/IR quality features
-> nine causal temporal shape features
-> train-only per-feature standardization
-> unweighted logistic regression
```

Do not deploy it, select a threshold, claim false-activation performance, or enable a quality-rejection gate from this corpus.

## Required next evidence

Collect explicitly labelled, clean non-pinch/rest recordings before further optimization. Include ordinary rest, arm/watch movement without pinch, loose-strap/contact changes, intentional non-pinch finger movement, and pinch while moving. Hold out a completely untouched capture set, then report event precision/recall, false activations per hour, onset latency, rejection coverage, and calibration in addition to AUC.

## Reproduction evidence

The disposable experiment reports were written outside the repository during the study:

- `/tmp/ppg-rgb-zsig-0001-results.txt`
- `/tmp/ppg-round-1e6-results.txt`
- `/tmp/ppg-direct-round-control.txt`
- `/tmp/ppg-robustness-c-classweight.txt`
- `/tmp/ppg-clean-negative-control.txt`
- `/tmp/ppg-shape-feature-ablation.txt`
- `/tmp/ppg-augmentation-ablation.txt`

Each experiment verified identical recording manifests and intended split/window controls where applicable; none changed source labels or tracked files. Those temporary reports are not durable artifacts. This note preserves their results and limitations.
