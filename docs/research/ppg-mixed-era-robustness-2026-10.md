# PPG pinch onset: mixed-era robustness study, October 2026

**Status:** research only. These are offline, event-aligned model-selection results. They do not change the app feature contract or establish a deployable live pinch detector.

## Why this study exists

The original October PPG work was restricted to a small set of recordings and did not contain explicit non-pinch activity. A later 2026-10-14 collection added 15 recordings:

- nine pinch recordings;
- four fist recordings;
- two explicitly labelled `everything_else` recordings.

Each new recording was a separate session with a refitted strap. The study therefore evaluates generalisation across recording sessions and strap fits, not random windows from one continuous recording.

The original held-out-day experiment remains important: a model trained *only* on the 17 older recordings scored about 0.60--0.64 AUC on the new day. The mixed-era study answers a different question: whether a model trained on a **mixture** of old and refitted-session recordings transfers to other held-out sessions from that expanded corpus. It must not be interpreted as an untouched future-day acceptance test.

## Fixed data and evaluation contract

Every comparative result in this note uses:

- 32 recordings: 17 original usable recordings plus all 15 recordings from 2026-10-14;
- 1,117 frozen event examples;
- 20 deterministic, recording-disjoint 60/40 splits;
- every split: 19 training recordings (10 old, 9 new) and 13 test recordings (7 old, 6 new);
- pinch starts as positives; other marked or explicitly non-pinch moments as negatives;
- source sensor timestamps; causal 25 Hz zero-order-hold resampling; 2 s causal history for normalisation;
- event windows from -400 ms to +880 ms around the labelled onset.

The signal transforms are causal, but the event-aligned score uses 880 ms after onset. It is therefore not a zero-latency inference claim. Splits overlap, so their minimum/mean/maximum values are descriptive model-selection statistics, not confidence intervals or a future-data guarantee.

Selection priority is: **minimum AUC**, then lower-tail/mean AUC, then maximum AUC. A maximum is one favourable split and is not a deployment target by itself.

## Baseline algorithm and representation screen

A 45-combination screen compared five PPG representations with the previously tested classical and neural families. Raw RGB waveform models were weak: logistic regression averaged 0.546 AUC; CNN, LSTM, GRU, Transformer, autoencoder and CNN+GRU variants averaged about 0.47--0.58. Causal normalisation is essential.

The strongest mixed-era base representations were:

| Representation / model | Min | Mean | Max |
|---|---:|---:|---:|
| RGB z-score -> sigmoid -> `0.0001` -> robust waveform + quality / PyTorch dense MLP | 0.66109 | 0.75601 | 0.85333 |
| Robust RGB waveform + quality / HistGradientBoosting | 0.67589 | 0.74871 | 0.84246 |
| Robust RGB waveform + quality + shape / HistGradientBoosting | 0.66888 | 0.74604 | 0.86776 |
| Robust RGB waveform + quality + shape / PyTorch dense MLP | 0.65968 | 0.74255 | 0.86664 |

The robust waveform has 33 green/red/IR samples. Quality features are eight existing red/IR stability features. Shape features are per-channel first-difference energy, linear slope, and end-minus-start value.

## First robustness methods

Six methods from time-series and domain-generalisation research were tested against two frozen references:

- **A, HGB baseline:** robust RGB waveform + quality, HistGradientBoosting; `0.67589 / 0.74871 / 0.84246`.
- **B, dense baseline:** z-score/sigmoid/robust waveform + quality, PyTorch dense MLP; `0.66109 / 0.75601 / 0.85333`.

| Method | Min | Mean | Max | Result |
|---|---:|---:|---:|---|
| Group DRO | 0.61830 | 0.74150 | 0.83230 | Rejected |
| Causal morphology + HGB | 0.67460 | 0.78520 | 0.91350 | Highest mean; essentially ties A minimum |
| MiniROCKET-like | 0.65330 | 0.74520 | 0.85070 | Rejected |
| Constrained derivative DTW | 0.68210 | 0.73880 | 0.81630 | Best minimum then, but mean loss |
| Feature-space augmentation | 0.64250 | 0.74330 | 0.86250 | Rejected |
| CORAL target adaptation | 0.46200 | 0.53310 | 0.60570 | Rejected; transductive |

Morphology used causal timing and contour information: landmark validity, onset-to-peak/recovery timing where available, slope extrema, prominence, width and signed area. The full-morphology HGB raised mean substantially, but did not establish a clear minimum-AUC gain over the base HGB.

## Combined-method screen

The most useful method combinations were then tested with train-only inner recording-group folds for every blend, stack, calibration, and weight selection.

| Combination | Min | Mean | Max | Result |
|---|---:|---:|---:|---|
| Zsig + morphology dense | 0.68930 | 0.76098 | 0.86943 | Improved both frozen baselines |
| Constrained morphology HGB | 0.67127 | 0.78625 | 0.91788 | Highest maximum and mean in this screen, but lower minimum |
| Morphology + DTW distances + HGB | 0.67712 | 0.78373 | 0.91039 | Improved A minimum and mean |
| Calibrated morphology-HGB + DTW ensemble | 0.68280 | 0.77922 | 0.88901 | Balanced but not best |
| MiniROCKET-like + morphology | 0.65592 | 0.74881 | 0.84272 | Rejected |
| Morphology Group-DRO | 0.65818 | 0.72060 | 0.82654 | Rejected |

The best simple combined candidate at this stage was morphology + DTW distances + HGB. It showed that template distance and learned morphology can add complementary information.

## Further research techniques

The next experiments used a 353-feature input consisting of multiscale derivative/wavelet features plus zsig, quality and morphology inputs where applicable.

| Method | Min | Mean | Max | Result |
|---|---:|---:|---:|---|
| DA + multiscale | 0.72083 | 0.77017 | 0.82770 | Best weak-session protection |
| Multiscale derivative/wavelet morphology + HGB | 0.69051 | 0.81185 | 0.89873 | Best mean in the robust study |
| Change-point + zsig/morphology dense | 0.70009 | 0.75916 | 0.84466 | Improved dense baseline minimum |
| Self-supervised pretraining + dense | 0.69158 | 0.76159 | 0.85502 | Modest result |
| Domain-adversarial zsig/morphology dense | 0.70156 | 0.76238 | 0.83490 | Strong minimum before multiscale DA |
| Shapelets + zsig/morphology dense | 0.66364 | 0.77511 | 0.88374 | Mean gain, weak minimum |
| Shapelets + morphology/DTW HGB | 0.65726 | 0.79069 | 0.88549 | Mean gain, weak minimum |
| Hard-session curriculum | 0.68219 | 0.75593 | 0.85226 | Rejected |

Exact catch22 was not run: no verified implementation was installed, and no approximation was substituted. TENT-style test-time adaptation was separately tested as transductive and performed poorly (`0.52253 / 0.59311 / 0.62902`); it is not deployment-valid in this event-window protocol.

### Eight additional paper-derived techniques

| Method | Min | Mean | Max | Result |
|---|---:|---:|---:|---|
| Invariant Risk Minimization | 0.69855 | 0.77015 | 0.83058 | Rejected |
| Supervised contrastive learning | 0.70797 | 0.76831 | 0.82712 | Rejected |
| Prototypical metric classifier | 0.70827 | 0.76673 | 0.83023 | Rejected |
| Sharpness-Aware Minimization | 0.70578 | 0.77233 | 0.83519 | Rejected |
| Session-statistics MixStyle | 0.70739 | 0.77902 | 0.84821 | Best new variant; lower minimum than DA + multiscale |
| Strict session-stable feature selection + HGB | 0.50000 | 0.50663 | 0.63250 | Failed: zero features selected in 19/20 splits |

The strict feature selector required at least 80% nonzero sign consistency and positive worst-session inner-held-out permutation importance. That rule was too strict for this corpus; the prevalence fallback was correctly reported as AUC 0.5 rather than presented as a trained model.

## Pareto trade-off: weak sessions versus favourable sessions

No train-only stack achieved the high minimum of DA + multiscale and the high mean/maximum of multiscale HGB simultaneously.

| Method | Min | Mean | Max |
|---|---:|---:|---:|
| DA + multiscale | **0.72083** | 0.77017 | 0.82770 |
| Multiscale HGB | 0.69051 | **0.81185** | **0.89873** |
| DA + multiscale / HGB OOF stack | 0.70101 | 0.81114 | 0.88666 |
| DA_C + HGB OOF stack | 0.69204 | 0.81210 | 0.90378 |

The OOF stack combines complementary errors on favourable sessions and therefore has a high maximum. On difficult sessions, its inner-trained meta-model leans toward the less stable HGB ranking, so it cannot preserve the DA + multiscale minimum. Convex and three-model stacks did not improve this frontier.

The current choices are therefore explicit:

- choose **DA + multiscale** when worst-session robustness is the priority;
- choose **multiscale HGB** when average and favourable-session separation are the priority;
- choose the **DA + multiscale / HGB OOF stack** only when the small loss in minimum is acceptable in exchange for near-HGB mean and maximum.

## Operational methods: distinct from crop AUC

### Uncertainty rejection

An uncertainty score combined DA/HGB disagreement, entropy and nearest training-template DTW distance. The threshold was selected only inside training folds and required at least 80% acceptance in every inner fold.

- Mean coverage: 90.39%.
- DA + multiscale full-window AUC: 0.77017 mean.
- DA + multiscale accepted-window AUC: 0.79697 mean.
- Average rejections per split: 16.9 positives and 28.0 negatives.

Accepted-window AUC is measured on a different population and is not an ordinary AUC improvement. This is a future safety/abstention option, not a classifier selection result.

### Two-stage continuous gate

A causal trailing 160 ms derivative-energy gate before DA + multiscale reduced mean false activations from 11.91 to 5.73 per minute, but reduced recall from 42.22% to 21.37% and increased mean latency from 762.6 ms to 889.3 ms. Reject this gate configuration.

## Current conclusion

The expanded corpus provides meaningful evidence that PPG-only onset representations can transfer across the represented independent sessions and strap fits. It does **not** establish a production detector:

- every recording has now contributed to exploration;
- event scoring includes 880 ms of post-onset context;
- splits overlap and are not an untouched test;
- complete-stream recall, false activations and latency remain inadequate for live activation.

The strongest next evidence is a new, untouched refitted-strap collection evaluated once using frozen candidates. It should contain explicitly labelled pinch, fist, `everything_else`, neutral rest, motion without pinch and deliberate non-pinch finger activity.

## Reproduction and integrity

All experiments were disposable and generated outside the repository. They used deterministic seeds, recording-disjoint splits, train-only learned transforms, and source/data hash verification. No source labels, raw data, package inventory or tracked implementation files were modified.

The temporary benchmark artifacts were retained locally under:

- `/tmp/ppg-all-techniques-benchmark/`
- `/tmp/ppg-mixed-era-60-40/`
- `/tmp/ppg-six-methods/`
- `/tmp/ppg-six-combinations/`
- `/tmp/ppg-research-followup/`
- `/tmp/ppg-da-multiscale-followup/`
- `/tmp/ppg-pareto-followup/`
- `/tmp/ppg-eight-points/`

Every completed study independently recomputed its reported AUC summaries; the later studies also reproduced inherited baseline predictions. These artifacts are research evidence, not runtime assets.

## Primary-method references

- [Group DRO](https://arxiv.org/abs/1911.08731)
- [Domain-Adversarial Training](https://arxiv.org/abs/1505.07818)
- [Deep CORAL](https://arxiv.org/abs/1607.01719)
- [MiniROCKET](https://arxiv.org/abs/2012.08791)
- [Learning Time-Series Shapelets](https://doi.org/10.1007/s10618-013-0322-1)
- [Invariant Risk Minimization](https://arxiv.org/abs/1907.02893)
- [Supervised Contrastive Learning](https://arxiv.org/abs/2004.11362)
- [Sharpness-Aware Minimization](https://arxiv.org/abs/2010.01412)
- [MixStyle](https://arxiv.org/abs/2104.02008)
- [Prototypical Networks](https://arxiv.org/abs/1703.05175)
