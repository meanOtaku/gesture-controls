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

## Scope and limitations

All results are grouped cross-validation progress evidence, not an untouched final generalization test. Source recordings, including the new 2026-10-17 datasets, are versioned under `data/recordings/`.

The local studies also produced re-generable prepared feature caches and exhaustive per-window continuous prediction exports. Those are deliberately not versioned here: together they exceed 2 GB, duplicate derivable results, and would bloat the Git history. The compact artifacts retained here provide frozen configurations, splits, event-level scores, aggregate continuous metrics, and independent verification for every reported finding.
