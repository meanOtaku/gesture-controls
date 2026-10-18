# Fresh derivative-input adaptations: all 26 technique families

Progress evidence only, not an untouched test. No historical-method claim.

37 recordings, 1,390 sampled events, 424 binary pinch_start positives; exact prior 20 fixed recording-disjoint 22/15 recording splits (60/40 requested fraction). All 26 families adapted; 520 outer fits completed, plus the frozen LOSO member fits. No method exclusions and no raw-PPG input exceptions. Nine inherited recording exclusions remain exactly as inventory.json documents.

Ranking is descending minimum, then mean, then maximum fold AUC. Pooled OOF concatenates repeated held-out appearances, without averaging. Continuous metrics also pool repeated held-out appearances.

| Rank | Fresh adaptation | Min AUC | Mean AUC | Max AUC | Pooled OOF AUC | Recall | Precision | False/min | Latency ms |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | hgb_morphology | 0.740207 | 0.810483 | 0.874285 | 0.801637 | 0.335769 | 0.197558 | 17.960224 | 857.731777 |
| 2 | extra_trees | 0.739217 | 0.808029 | 0.873795 | 0.798614 | 0.381940 | 0.243525 | 15.624278 | 833.106797 |
| 3 | anova32_lr | 0.675276 | 0.753427 | 0.812203 | 0.742842 | 0.467271 | 0.218323 | 22.031772 | 897.285314 |
| 4 | coral_training_mlp | 0.666632 | 0.769886 | 0.830495 | 0.764186 | 0.386324 | 0.199879 | 20.365439 | 874.640917 |
| 5 | retained_lr_08 | 0.661897 | 0.747241 | 0.805083 | 0.739302 | 0.374635 | 0.190831 | 20.919600 | 881.269539 |
| 6 | retained_lr_07 | 0.661742 | 0.747211 | 0.805034 | 0.739355 | 0.377265 | 0.192199 | 20.881117 | 880.864024 |
| 7 | retained_lr_10 | 0.651682 | 0.728796 | 0.807012 | 0.724288 | 0.337522 | 0.157164 | 23.836645 | 900.565919 |
| 8 | retained_lr_09 | 0.650588 | 0.711865 | 0.780682 | 0.707387 | 0.301870 | 0.138046 | 24.821822 | 921.175212 |
| 9 | augmented_cnn | 0.647695 | 0.730744 | 0.809008 | 0.721904 | 0.199883 | 0.123332 | 18.710651 | 896.746156 |
| 10 | retained_lr_04 | 0.643007 | 0.720789 | 0.806143 | 0.714410 | 0.363530 | 0.164311 | 24.348475 | 895.479228 |
| 11 | group_dro_mlp | 0.637624 | 0.750732 | 0.811106 | 0.744202 | 0.360900 | 0.181511 | 21.431430 | 876.861357 |
| 12 | dense_mlp | 0.636215 | 0.752515 | 0.822319 | 0.746235 | 0.369667 | 0.185920 | 21.315980 | 879.997602 |
| 13 | causal_cnn | 0.630686 | 0.706276 | 0.823178 | 0.690669 | 0.171829 | 0.116274 | 17.198251 | 898.835607 |
| 14 | augmented_waveform_lr | 0.630678 | 0.720619 | 0.792282 | 0.709878 | 0.344828 | 0.159030 | 24.013669 | 899.925536 |
| 15 | leave_session_out_ensemble | 0.628790 | 0.712025 | 0.785951 | 0.706069 | 0.334015 | 0.150792 | 24.771793 | 908.884737 |
| 16 | haar_lr | 0.626996 | 0.697133 | 0.758498 | 0.691011 | 0.339860 | 0.143174 | 26.784477 | 923.218446 |
| 17 | retained_lr_02 | 0.626609 | 0.697096 | 0.765244 | 0.684440 | 0.243425 | 0.174304 | 15.185567 | 866.212742 |
| 18 | retained_lr_05 | 0.618085 | 0.703598 | 0.782754 | 0.697833 | 0.335769 | 0.150078 | 25.041177 | 910.272790 |
| 19 | morphology_lr | 0.618085 | 0.703598 | 0.782754 | 0.697833 | 0.335769 | 0.150078 | 25.041177 | 910.272790 |
| 20 | retained_lr_06 | 0.617992 | 0.703575 | 0.782802 | 0.697864 | 0.336061 | 0.150209 | 25.037329 | 909.738743 |
| 21 | equal_session_lr | 0.612206 | 0.695237 | 0.773598 | 0.689298 | 0.327878 | 0.145714 | 25.314410 | 915.830176 |
| 22 | retained_lr_01 | 0.606360 | 0.657346 | 0.737914 | 0.630981 | 0.170660 | 0.209019 | 8.504841 | 869.512132 |
| 23 | multiscale_lr | 0.577579 | 0.639818 | 0.723435 | 0.632839 | 0.354179 | 0.235294 | 15.158629 | 870.677218 |
| 24 | robust_scaler_lr | 0.567110 | 0.686527 | 0.753791 | 0.680162 | 0.307715 | 0.142490 | 24.386959 | 915.109032 |
| 25 | retained_lr_03 | 0.555870 | 0.637668 | 0.743686 | 0.622477 | 0.244009 | 0.178763 | 14.762249 | 904.858315 |
| 26 | retained_lr_00 | 0.523627 | 0.630310 | 0.758104 | 0.606422 | 0.180012 | 0.177266 | 11.002417 | 937.099380 |

## Explicit coverage table

Every entry below is a fresh derivative-input adaptation. All representations include slope, curvature and jerk of green, red and IR; subsets select summary statistics, never exclude a derivative order or physical PPG channel.

| Prior method | Prior input | Status | Derivative adaptation | Raw exception |
|---|---|---|---|---|
| retained_lr_00 | green robust step | adapted | Late-minus-early mean for all nine derivative channels; replaces green-only step with joint input. | none |
| retained_lr_01 | two-stage green | adapted | Same joint derivative step statistics; sigmoid after training-only standardization replaces raw-PPG two-stage normalization. | none |
| retained_lr_02 | green + red/IR quality | adapted | Derivative variability/energy/absolute-peak/change summaries replace green step and red/IR quality. | none |
| retained_lr_03 | RGB robust steps | adapted | End-minus-start and late-minus-early for every derivative/channel/window. | none |
| retained_lr_04 | RGB candidate + shape | adapted | Derivative shape/location/change subset from frozen summaries. | none |
| retained_lr_05 | RGB waveform + quality / LR | adapted | All 567 frozen derivative summary features replace raw waveform/quality. | none |
| retained_lr_06 | RGB rounded 1e-6 / LR | adapted | All summaries rounded to 1e-6 after training-only standardization. | none |
| retained_lr_07 | RGB zsig 1e-4 / LR | adapted | Sigmoid of train-standardized summaries rounded to 1e-4; no raw-PPG zsig. | none |
| retained_lr_08 | RGB zsig 1e-6 / LR | adapted | Sigmoid of train-standardized summaries rounded to 1e-6; no raw-PPG zsig. | none |
| retained_lr_09 | RGB + correlation / LR | adapted | All summaries plus within-order RGB correlations of derivative traces. | none |
| retained_lr_10 | RGB + shape + correlation / LR | adapted | Shape summary subset plus within-order RGB derivative correlations. | none |
| haar_lr | haar | adapted | All 567 frozen summaries plus 279 Haar block differences on nine derivative traces, scales 1/2/4/8/16, final32 samples. | none |
| morphology_lr | morph | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| multiscale_lr | multi | adapted | Frozen mean/std/end-minus-start/mean-absolute-change summaries at ablation windows 8/16/32 for all nine derivative channels (108 features); replaces prior 4/8/16/32 windows. | none |
| hgb_morphology | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| extra_trees | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| robust_scaler_lr | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| anova32_lr | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| equal_session_lr | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| leave_session_out_ensemble | combined | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| augmented_waveform_lr | wave | adapted | Training-only derivative-trace augmentation, then recompute all 567 frozen summary statistics; inference summarizes unaugmented traces. | none |
| dense_mlp | wave | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| causal_cnn | wave | adapted | Real temporal causal CNN on derivative-major 9 channels x 33 chronological steps; first convolution 9->24; all other frozen neural settings retained. | none |
| augmented_cnn | wave | adapted | Real temporal causal CNN on derivative-major 9 channels x 33 chronological steps; first convolution 9->24; all other frozen neural settings retained. | none |
| group_dro_mlp | wave | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| coral_training_mlp | wave | adapted | All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |

retained_lr_05 and morphology_lr intentionally converge to the same full-summary LR under the requested derivative summary representation. Both remain in the coverage ledger and are freshly fitted; they are not independent evidence. Feature dimensions in scores.json describe inputs before ANOVA or augmented-LR summarization (ANOVA selects 32; augmented LR summarizes 297 ordered values into 567 features).

## Input and training protocol

25Hz zero-order hold from integer source timestamps, anchored at each recording origin. The exact ablation cubic differentiator fits the strictly previous nine samples and evaluates first/second/third derivatives at the current grid time. No raw amplitudes enter any estimator. Ordered CNN input is derivative-major 9×33 chronological samples; convolution kernels run over time with left-only padding. Static summaries preserve the ablation 21 statistics at 8/16/32 samples (567 features); variants select documented subsets, add derivative Haar/correlations, or apply train-standardized nonlinear/rounding transforms.

All scalers, ANOVA selection, augmentation scales, session balancing, LOSO member fitting, Group DRO weights and covariance penalties are training-only. The frozen 80 neural epochs, architecture widths, optimizer, tree/LR hyperparameters and seed remain unchanged apart from input dimensions. Augmentation uses gains shared across derivative orders for a physical channel, training-scaled noise, and physical-channel dropout; augmented LR recomputes frozen summaries afterward. These derivative-space perturbations need not correspond to a single integrable raw waveform.

Fixed continuous rules: threshold 0.5; anchors every 40ms; decision at anchor+880ms; rising edges; 1,500ms refractory; greedy one-to-one onset matching in +680..1280ms. False activations/min uses full evaluated duration. This is delayed detection. Thresholds are uncalibrated and were not tuned.

## Verification

Before any scores, method-ledger.json and code/splits/events were hashed in frozen.json. A pre-scoring memory-layout correction, retained in frozen-prevalidation.json, restored exact ablation summary parity without changing mappings or hyperparameters. Every recording passed future-perturbation checks for all 26 representations and truncated ordered-prefix invariance. All 520 outer fits recomputed training scaler/selector checks, including LOSO member scalers; full serialized estimator state stayed unchanged during predictions.

A separate process independently recomputed event AUCs and continuous metrics from saved predictions, checked exact split/event coverage, and compared polynomial derivative fits with independently indexed source samples on all 37 recordings. This is independently implemented verification by the same agent, not an external reviewer. See independent-verification.json, train-only-checks.json, and self-check.json. Repository/data/git and prior PPG artifact hashes matched before/after. Snapshot excludes dependency/build/cache directories named node_modules, .venv, __pycache__, target and .tools.

## Blockers and limits

No execution blockers. This reuses all available data and known splits: progress/selection evidence only, with correlated repeats and no untouched test. No confidence intervals or independent seed replicates were requested or run. Legacy compressed timestamps remain unchanged; unmarked controls are not verified non-pinches. Source labels (including inherited annotation timestamps from IMU files) serve only event/metric definitions, never predictors. Raw PPG is read solely to calculate derivatives. No repository/data/git or prior artifact edits were made.

## Artifacts

- ranked-results.csv: all ranked AUC and pooled continuous metrics.
- coverage.csv and method-ledger.json: complete 26-row mapping and explicit zero method exclusions/input exceptions.
- scores.json: all fold AUCs, per-fold pooled continuous metrics, pooled OOF and continuous counts/metrics.
- *-events.csv.gz and *-continuous.csv.gz: saved held-out predictions.
- frozen.json, source-integrity.json, before-hashes.json: protocol and source integrity evidence.
- study.py, features.py, estimators.py, common.py, verify.py: runnable disposable implementation.
