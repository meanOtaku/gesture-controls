# PPG-only pinch-start benchmark artifacts — October 2026

This directory preserves the verified, compact research record for the current 37-recording PPG-only binary `pinch_start` studies. Runtime inputs are green/red/IR PPG and source timestamps only; IMU and gesture labels are never runtime features.

## Included studies

- `ppg-all-data-cv/`: frozen 26-method, recording-disjoint cross-validation baseline.
- `ppg-label-lag-audit/`: analysis of mapped-label timing uncertainty and false-activation proximity.
- `ppg-derivative-ablation/`: causal slope, curvature, and jerk ablation.
- `ppg-derivatives-all-techniques/`: joint causal derivative input across all 26 fresh technique adaptations.
- `ppg-zsig-mad-derivatives-all/`: 1-second causal z-score, sigmoid, MAD, and derivative benchmark across all 26 adaptations.
- `ppg-preprocess-component-ablation/`: controlled A/B/C/D study isolating z-score, sigmoid, and MAD effects for HGB and ExtraTrees.

Each study includes its report, ranking/score data, frozen protocol and method definitions, grouped splits, event metadata, causality/train-only/source-integrity checks, and independently recomputed verification output where applicable.

## Main finding

The component ablation establishes that causal 1-second z-score helped the leading tree models, while the final rolling median/MAD normalization caused the robustness decline.

| Pipeline / model | Minimum AUC | Mean AUC | Pooled OOF AUC |
|---|---:|---:|---:|
| Raw causal derivatives → HGB | 0.740207 | 0.810483 | 0.801637 |
| Causal 1-second z-score → derivatives → ExtraTrees | **0.769195** | 0.821477 | 0.810109 |
| Z-score → sigmoid → derivatives → ExtraTrees | 0.748586 | **0.823246** | **0.811181** |
| Z-score → sigmoid → MAD → derivatives → ExtraTrees | 0.703996 | 0.774866 | 0.763117 |

The MAD transition reduced mean AUC in all 20 paired held-out folds for both HGB and ExtraTrees. The current robust candidate is therefore `PPG → causal 1-second z-score → causal slope + curvature + jerk → ExtraTrees`.

## Reproducing the component ablation

The original study scripts were not versioned. `reproduce.py` is an independent reimplementation of the component ablation, written from this folder's archived specs (protocol, method ledger, feature schema, events, splits, inventory and mapped labels). It reads the recordings in `data/recordings/2026-10-downloads/`, rebuilds the four causal pipelines, fits HGB and ExtraTrees on the 20 splits, scores event AUCs and the continuous live-detection metrics, and compares every number with `ppg-preprocess-component-ablation/`. From the repository root (about 3 minutes):

```sh
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/reproduce.py [out_dir]
```

Result on 2026-10-18: the inputs match the archive exactly. That covers PPG row counts and timestamps for all 37 recordings, the eligible pinch starts in `mapped-labels.json`, the differentiator coefficients (to 8e-12), and the per-fold timeline minutes and start counts. HGB with z-score and sigmoid (stage C) reproduces bit-for-bit on all 20 folds, including activations and matches. The other results agree to within 0.001 mean AUC and 0.004 pooled recall:

| Model | Stage | Mean AUC (archived → reproduced) | Min AUC | Pooled recall | False activations/min |
|---|---|---:|---:|---:|---:|
| HGB | A raw | 0.8105 → 0.8100 | 0.7402 → 0.7402 | 0.3358 → 0.3364 | 17.96 → 17.93 |
| ExtraTrees | A raw | 0.8080 → 0.8081 | 0.7392 → 0.7386 | 0.3819 → 0.3784 | 15.62 → 15.69 |
| HGB | B z-score | 0.8126 → 0.8125 | 0.7595 → 0.7595 | 0.3422 → 0.3413 | 18.09 → 18.11 |
| ExtraTrees | B z-score | 0.8215 → 0.8213 | 0.7692 → 0.7689 | 0.3752 → 0.3770 | 15.02 → 15.02 |
| HGB | C + sigmoid | 0.8116 → 0.8116 | 0.7307 → 0.7307 | 0.3217 → 0.3217 | 17.48 → 17.48 |
| ExtraTrees | C + sigmoid | 0.8232 → 0.8231 | 0.7486 → 0.7479 | 0.3562 → 0.3589 | 14.37 → 14.35 |
| HGB | D + MAD | 0.7565 → 0.7569 | 0.6832 → 0.6832 | 0.3892 → 0.3916 | 18.50 → 18.46 |
| ExtraTrees | D + MAD | 0.7749 → 0.7748 | 0.7040 → 0.7040 | 0.3960 → 0.3998 | 14.90 → 14.94 |

The conclusions hold: the MAD step lowers mean AUC in all 20 paired folds for both models, and z-score → derivatives → ExtraTrees has the best minimum AUC. The remaining differences come from summary statistics whose exact definitions the archive doesn't pin down (MAD and energy scaling, zero-crossing and peak conventions) and from float rounding. HGB, which bins on quantiles, is almost unaffected. ExtraTrees draws random split thresholds on the scaled values, so it shifts slightly. The other 24 methods and the label-lag audit are not reimplemented.

## All 26 techniques without MAD

`ppg-no-mad-all-techniques/` reruns all 26 methods with `benchmark_all.py`. Run against stages A and D, the reimplementation lands within 0.0006 AUC of the archive for 20 of the 26 methods, and within 0.008 for the rest. Removing MAD helps nearly across the board: with z-score + sigmoid, 25 of 26 methods beat their MAD-pipeline mean AUC, and the median method goes from 0.711 to 0.742. ExtraTrees stays first: z-score alone gives the best worst-split AUC (0.769), and adding the sigmoid gives the best mean (0.823). Live-detection recall at the fixed 0.5 threshold doesn't rise with AUC, so threshold choice is the next thing to test.

```sh
uv run --project tools/label-trainer --extra torch python docs/research/artifacts/ppg-benchmark-2026-10/benchmark_all.py --stages B C
```

## Multi-scale z-score

`ppg-multiscale-zscore/` tackles the worst-split AUC. Z-scoring each channel against the previous 1, 2 and 4 s, with derivative summaries for each history, raises ExtraTrees' minimum AUC from 0.769 to 0.789 and its mean from 0.821 to 0.843. It beats the 1 s baseline on all 20 splits, and live recall rises from 0.377 to 0.413 with no extra false activations. No single history length helps on its own, and adding 8 s or a sigmoid makes it slightly worse. The current candidate is therefore `PPG → causal z-score (1 s + 2 s + 4 s) → causal slope + curvature + jerk → ExtraTrees`. It was picked on these same splits, so it needs new recordings to confirm.

**It is now the app's only model** (2026-10-19): `tools/label-trainer/src/label_trainer/ppg_onset.py` and `crates/pinch-inference/src/ppg_onset.rs` compute its inputs (kept equal by a shared fixture), and `app_definition_check.py` confirms the app's version, whose grid ends at each decision and which samples its own training moments, matches the research: worst-split AUC 0.7886, mean 0.848, recall 0.457, 14.0 false activations a minute on the same 20 splits (`ppg-multiscale-zscore/app-definition-check.json`).

```sh
uv run --project tools/label-trainer --extra torch python docs/research/artifacts/ppg-benchmark-2026-10/multiscale_zscore.py
```

## IMU fusion, trigger rules and label shifts

Three follow-up studies on 2026-10-21, written up in [`../../ppg-imu-fusion-and-triggers-2026-10.md`](../../ppg-imu-fusion-and-triggers-2026-10.md):

- `ppg-imu-fusion/` (`imu_fusion.py`): adding 1,032 causal IMU features to the app's model raises worst-split AUC from 0.789 to 0.837 (19/20 splits better) and cuts false activations on the no-pinch recordings at 0.5 from 19.0 to 12.0 a minute.
- `ppg-trigger-rules/` (`trigger_rules.py`): the frozen rising-edge rule fires early and its lockout blocks the right fire; firing one tick after the probability's peak (or on a 3-tick mean) adds 4–12 points of recall at the same false-activation budget with PPG + IMU.
- `ppg-label-shift/` (`label_shift.py`): re-scoring with the labels moved shows that at budgets of 2 a minute or fewer the remaining false activations are not near any pinch.

```sh
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/imu_fusion.py
```

**PPG + IMU with the peak trigger is now the model the app trains** (2026-10-21): `tools/label-trainer/src/label_trainer/imu_onset.py` and `crates/pinch-inference/src/imu_onset.rs` compute the motion inputs (kept equal by a shared fixture). `app_fusion_check.py` confirms the app's version, which decides at every PPG sample, trains on its own sample of moments and runs the runtime's peak rule, matches the research on the same 20 splits: worst-split AUC 0.853 and mean 0.898, and 0.236 / 0.373 of pinches caught within 1 / 2 false activations a minute (research 0.245 / 0.378; `ppg-imu-fusion/app-definition-check.json`).

```sh
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/app_fusion_check.py
```

## Scope and limitations

All results are grouped cross-validation progress evidence, not an untouched final generalization test. Source recordings, including the new 2026-10-17 datasets, are versioned under `data/recordings/`.

The local studies also produced re-generable prepared feature caches and exhaustive per-window continuous prediction exports. Those are deliberately not versioned here: together they exceed 2 GB, duplicate derivable results, and would bloat the Git history. The compact artifacts retained here provide frozen configurations, splits, event-level scores, aggregate continuous metrics, and independent verification for every reported finding.
