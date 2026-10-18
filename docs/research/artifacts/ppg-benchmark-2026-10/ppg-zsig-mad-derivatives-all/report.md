# Fresh z-score / sigmoid / MAD derivative benchmark: all 26 families

Progress evidence only, not an untouched test. No historical-method claim.

37 recordings, 1,390 sampled events, 424 binary pinch_start positives; exact prior 20 fixed recording-disjoint 22/15 recording splits (60/40 requested fraction). All 26 families adapted; 520 outer fits completed, plus the frozen LOSO member fits. No method exclusions and no raw-PPG input exceptions. The pre-scoring ledger records the zero-SD convention and preserves rounding only in designated model-feature variants. Nine inherited recording exclusions remain exactly as inventory.json documents.

Ranking is descending minimum, then mean, then maximum fold AUC. Pooled OOF concatenates repeated held-out appearances, without averaging. Continuous metrics also pool repeated held-out appearances.

| Rank | Fresh adaptation | Min AUC | Mean AUC | Max AUC | Pooled OOF AUC | Recall | Precision | False/min | Latency ms |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | extra_trees | 0.703996 | 0.774866 | 0.852347 | 0.763117 | 0.395967 | 0.259281 | 14.896941 | 830.292409 |
| 2 | hgb_morphology | 0.683154 | 0.756526 | 0.816102 | 0.745771 | 0.389246 | 0.216973 | 18.498992 | 843.652726 |
| 3 | coral_training_mlp | 0.682051 | 0.740582 | 0.800288 | 0.736300 | 0.356809 | 0.170626 | 22.839924 | 872.029135 |
| 4 | dense_mlp | 0.681216 | 0.739144 | 0.795172 | 0.734639 | 0.361192 | 0.166982 | 23.728892 | 875.635988 |
| 5 | group_dro_mlp | 0.679356 | 0.740493 | 0.810539 | 0.735944 | 0.365868 | 0.169763 | 23.563413 | 878.035652 |
| 6 | retained_lr_08 | 0.668345 | 0.755916 | 0.815508 | 0.749191 | 0.384863 | 0.190153 | 21.585364 | 865.131026 |
| 7 | retained_lr_07 | 0.668331 | 0.755811 | 0.815543 | 0.749113 | 0.385739 | 0.190559 | 21.577667 | 864.453330 |
| 8 | augmented_cnn | 0.666321 | 0.742662 | 0.815577 | 0.733372 | 0.270310 | 0.150873 | 20.034481 | 877.381369 |
| 9 | augmented_waveform_lr | 0.650679 | 0.709465 | 0.775436 | 0.702572 | 0.336645 | 0.148205 | 25.479889 | 897.462930 |
| 10 | equal_session_lr | 0.645941 | 0.707959 | 0.753281 | 0.701595 | 0.323495 | 0.138948 | 26.399643 | 910.473122 |
| 11 | retained_lr_09 | 0.645842 | 0.710180 | 0.765272 | 0.704337 | 0.324372 | 0.141509 | 25.914751 | 912.056470 |
| 12 | robust_scaler_lr | 0.643858 | 0.708488 | 0.762364 | 0.703021 | 0.335476 | 0.146242 | 25.791604 | 898.479701 |
| 13 | leave_session_out_ensemble | 0.643049 | 0.712028 | 0.760569 | 0.706052 | 0.337814 | 0.146794 | 25.857026 | 914.186485 |
| 14 | causal_cnn | 0.640641 | 0.717364 | 0.779355 | 0.704182 | 0.231151 | 0.158485 | 16.163047 | 874.562424 |
| 15 | retained_lr_06 | 0.640141 | 0.706872 | 0.758673 | 0.700927 | 0.338399 | 0.146083 | 26.049444 | 915.613823 |
| 16 | retained_lr_05 | 0.640037 | 0.706866 | 0.758617 | 0.700941 | 0.338399 | 0.146046 | 26.057140 | 914.892834 |
| 17 | morphology_lr | 0.640037 | 0.706866 | 0.758617 | 0.700941 | 0.338399 | 0.146046 | 26.057140 | 914.892834 |
| 18 | haar_lr | 0.630203 | 0.699972 | 0.754490 | 0.694921 | 0.345996 | 0.140818 | 27.800440 | 928.921986 |
| 19 | anova32_lr | 0.626377 | 0.718138 | 0.772308 | 0.705845 | 0.400643 | 0.220206 | 18.683712 | 866.516107 |
| 20 | retained_lr_10 | 0.624979 | 0.711189 | 0.765092 | 0.703287 | 0.334892 | 0.149141 | 25.160476 | 904.463572 |
| 21 | retained_lr_04 | 0.618289 | 0.703631 | 0.744860 | 0.696112 | 0.354471 | 0.157840 | 24.906485 | 903.919040 |
| 22 | retained_lr_01 | 0.601779 | 0.689758 | 0.764116 | 0.669331 | 0.369082 | 0.290011 | 11.899081 | 858.626496 |
| 23 | retained_lr_02 | 0.599562 | 0.689553 | 0.757075 | 0.679495 | 0.271186 | 0.177880 | 16.505549 | 834.993232 |
| 24 | multiscale_lr | 0.598147 | 0.693285 | 0.763352 | 0.684538 | 0.352718 | 0.212388 | 17.225190 | 847.055967 |
| 25 | retained_lr_03 | 0.581559 | 0.667136 | 0.742295 | 0.651462 | 0.331093 | 0.214787 | 15.939843 | 874.239489 |
| 26 | retained_lr_00 | 0.574428 | 0.677206 | 0.758226 | 0.657062 | 0.322326 | 0.244297 | 13.130551 | 867.585246 |

## Explicit coverage table

Every entry below is a fresh derivative-input adaptation. All representations include slope, curvature and jerk of green, red and IR; subsets select summary statistics, never exclude a derivative order or physical PPG channel.

| Prior method | Prior input | Status | Derivative adaptation | Raw exception |
|---|---|---|---|---|
| retained_lr_00 | green robust step | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Late-minus-early mean for all nine derivative channels; replaces green-only step with joint input. | none |
| retained_lr_01 | two-stage green | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Same joint derivative step statistics; sigmoid after training-only standardization replaces raw-PPG two-stage normalization. | none |
| retained_lr_02 | green + red/IR quality | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Derivative variability/energy/absolute-peak/change summaries replace green step and red/IR quality. | none |
| retained_lr_03 | RGB robust steps | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. End-minus-start and late-minus-early for every derivative/channel/window. | none |
| retained_lr_04 | RGB candidate + shape | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Derivative shape/location/change subset from frozen summaries. | none |
| retained_lr_05 | RGB waveform + quality / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summary features replace raw waveform/quality. | none |
| retained_lr_06 | RGB rounded 1e-6 / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All summaries rounded to 1e-6 after training-only standardization. | none |
| retained_lr_07 | RGB zsig 1e-4 / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Sigmoid of train-standardized summaries rounded to 1e-4; no raw-PPG zsig. | none |
| retained_lr_08 | RGB zsig 1e-6 / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Sigmoid of train-standardized summaries rounded to 1e-6; no raw-PPG zsig. | none |
| retained_lr_09 | RGB + correlation / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All summaries plus within-order RGB correlations of derivative traces. | none |
| retained_lr_10 | RGB + shape + correlation / LR | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Shape summary subset plus within-order RGB derivative correlations. | none |
| haar_lr | haar | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen summaries plus 279 Haar block differences on nine derivative traces, scales 1/2/4/8/16, final32 samples. | none |
| morphology_lr | morph | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| multiscale_lr | multi | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Frozen mean/std/end-minus-start/mean-absolute-change summaries at ablation windows 8/16/32 for all nine derivative channels (108 features); replaces prior 4/8/16/32 windows. | none |
| hgb_morphology | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| extra_trees | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| robust_scaler_lr | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| anova32_lr | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| equal_session_lr | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| leave_session_out_ensemble | combined | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| augmented_waveform_lr | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Training-only derivative-trace augmentation, then recompute all 567 frozen summary statistics; inference summarizes unaugmented traces. | none |
| dense_mlp | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| causal_cnn | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Real temporal causal CNN on derivative-major 9 channels x 33 chronological steps; first convolution 9->24; all other frozen neural settings retained. | none |
| augmented_cnn | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. Real temporal causal CNN on derivative-major 9 channels x 33 chronological steps; first convolution 9->24; all other frozen neural settings retained. | none |
| group_dro_mlp | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |
| coral_training_mlp | wave | adapted | Fresh z-score -> unrounded sigmoid -> MAD -> joint derivatives. All 567 frozen derivative summaries; frozen estimator, seed and training settings retained. | none |

retained_lr_05 and morphology_lr intentionally converge to the same full-summary LR under the requested derivative summary representation. Both remain in the coverage ledger and are freshly fitted; they are not independent evidence. Feature dimensions in scores.json describe inputs before ANOVA or augmented-LR summarization (ANOVA selects 32; augmented LR summarizes 297 ordered values into 567 features).

## Input and training protocol

25Hz zero-order hold from integer source timestamps, anchored at each recording origin. Each channel independently uses the previous 25 ticks (minimum 20) for population z-score, then unrounded sigmoid, then the previous 25 sigmoid ticks (minimum 20 finite values) for median/MAD normalization with scale 1.4826. Both windows exclude the current sample. Zero SD and zero MAD emit zero; insufficient history stays unavailable. First complete 9×33 derivative input is tick 81 (3240ms). The exact ablation cubic differentiator fits the strictly previous nine samples and evaluates first/second/third derivatives at the current grid time. No raw amplitudes enter any estimator. Ordered CNN input is derivative-major 9×33 chronological samples; convolution kernels run over time with left-only padding. Static summaries preserve the ablation 21 statistics at 8/16/32 samples (567 features); variants select documented subsets, add derivative Haar/correlations, or apply train-standardized nonlinear/rounding transforms.

All scalers, ANOVA selection, augmentation scales, session balancing, LOSO member fitting, Group DRO weights and covariance penalties are training-only. The frozen 80 neural epochs, architecture widths, optimizer, tree/LR hyperparameters and seed remain unchanged apart from input dimensions. Augmentation uses gains shared across derivative orders for a physical channel, training-scaled noise, and physical-channel dropout; augmented LR recomputes frozen summaries afterward. These derivative-space perturbations need not correspond to a single integrable raw waveform.

Fixed continuous rules: threshold 0.5; anchors every 40ms; decision at anchor+880ms; rising edges; 1,500ms refractory; greedy one-to-one onset matching in +680..1280ms. False activations/min uses full evaluated duration. This is delayed detection. Thresholds are uncalibrated and were not tuned.

## Verification

Before any scores, method-ledger.json and code/splits/events were hashed in frozen.json. All transform stages passed exact prefix checks at warmup boundaries and recording midpoints; no imputation, clock repair or centered processing was used. Every recording passed future-perturbation checks for all 26 representations and truncated ordered-prefix invariance. All 520 outer fits recomputed training scaler/selector checks, including LOSO member scalers; full serialized estimator state stayed unchanged during predictions.

A separate process independently recomputed event AUCs and continuous metrics from saved predictions, checked exact split/event coverage, and compared the full transform and polynomial derivative fits with an independent scalar implementation and PPG-only source reads on all 37 recordings. This is independently implemented verification by the same agent, not an external reviewer. See independent-verification.json, train-only-checks.json, and self-check.json. Repository/data/git and prior PPG artifact hashes matched before/after. Snapshot excludes dependency/build/cache directories named node_modules, .venv, __pycache__, target and .tools.

## Blockers and limits

No execution blockers. This reuses all available data and known splits: progress/selection evidence only, with correlated repeats and no untouched test. No confidence intervals or independent seed replicates were requested or run. Legacy compressed timestamps remain unchanged; unmarked controls are not verified non-pinches. Source labels (including inherited annotation timestamps from IMU files) serve only event/metric definitions, never predictors. Raw PPG is read solely to calculate the causal z-score/sigmoid/MAD signal and its derivatives. No repository/data/git or prior artifact edits were made.

## Artifacts

- ranked-results.csv: all ranked AUC and pooled continuous metrics.
- coverage.csv and method-ledger.json: complete 26-row mapping and explicit zero method exclusions/input exceptions.
- scores.json: all fold AUCs, per-fold pooled continuous metrics, pooled OOF and continuous counts/metrics.
- *-events.csv.gz and *-continuous.csv.gz: saved held-out predictions.
- frozen.json, source-integrity.json, before-hashes.json: protocol and source integrity evidence.
- study.py, features.py, estimators.py, common.py, verify.py: runnable disposable implementation.
