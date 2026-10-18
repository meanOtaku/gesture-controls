# All 26 techniques without the MAD step

Run 2026-10-18 with `../benchmark_all.py`. The archive ran all 26 derivative-input methods with the MAD step (stage D, `../ppg-zsig-mad-derivatives-all/`) and on raw PPG (stage A, `../ppg-derivatives-all-techniques/`). This run adds the two pipelines without MAD:

- **B:** causal 1-second z-score → derivatives
- **C:** z-score → sigmoid → derivatives

Inputs and protocol are unchanged: 37 recordings, 1,390 events (424 `pinch_start` positives), the same 20 recording-disjoint 22/15 splits, ranking by minimum fold AUC, and the same fixed live-detection rules (threshold 0.5, rising edges, 1,500 ms refractory period, matches 680–1,280 ms after onset). These are cross-validation results, not an untouched test.

## Checking the implementation first

The original scripts were not versioned, so `benchmark_all.py` rebuilds every method from the method ledger. To check it, I reran stages A and D and compared them with the archive:

- **20 of the 26 methods,** including both trees and all logistic-regression variants except the correlation ones: within 0.0006 of the archive on both min and mean AUC in both stages. Many match to four decimals.
- **Correlation variants (`retained_lr_09`, `_10`):** within 0.0043, because the archive doesn't say which window the correlations use.
- **MLP and CNN variants:** within 0.008 (`dense_mlp` is the largest), because PyTorch's random streams differ.

One detail had to be inferred: `equal_session_lr` matches only when its 1/n_session weights are normalised to a mean of 1.

Stage A and D results from this implementation are in `stage-A.json` and `stage-D.json`, next to B and C.

## Result

Removing MAD helps nearly every method. With z-score + sigmoid (C), mean AUC beats the MAD pipeline for 25 of 26 methods, and minimum AUC beats it for 23. C also beats raw input for 25 of 26 methods, and beats z-score alone (B) for 25. The median method's mean AUC goes from 0.711 with MAD (D) to 0.742 with C.

| Stage | Median method mean AUC | Median method min AUC | Methods beating D on mean AUC |
|---|---:|---:|---:|
| A raw | 0.712 | 0.630 | — |
| B z-score | 0.710 | 0.648 | 12 / 26 |
| C z-score + sigmoid | **0.742** | **0.677** | **25 / 26** |
| D z-score + sigmoid + MAD | 0.711 | 0.642 | — |

Both tree models remain at the top. ExtraTrees is first in B and in C:

- **B (z-score → ExtraTrees):** best worst-split AUC overall, 0.769 (mean 0.821, recall 0.377, 15.0 false/min).
- **C (z-score → sigmoid → ExtraTrees):** best mean AUC, 0.823 (min 0.748, recall 0.359, 14.4 false/min).

The other methods close only part of the gap. The best of them is the derivative shape/location subset (`retained_lr_04`, C: min 0.701), still about 0.07 below the trees.

The live-detection figures don't improve the way AUC does. In C, 22 of 26 methods have lower recall than with MAD, and false activations fall for only 15. The fixed 0.5 threshold is uncalibrated, so a ranking gain doesn't automatically become more detections at that threshold. Threshold choice is the next thing to test.

## Per-method results (min / mean AUC per stage, ranked by stage C)

| Method | A raw | B z-score | C z + sigmoid | D + MAD | C recall | C false/min |
|---|---:|---:|---:|---:|---:|---:|
| extra_trees | 0.739 / 0.808 | 0.769 / 0.821 | 0.748 / 0.823 | 0.704 / 0.775 | 0.359 | 14.35 |
| hgb_morphology | 0.740 / 0.810 | 0.760 / 0.813 | 0.731 / 0.812 | 0.683 / 0.757 | 0.322 | 17.48 |
| retained_lr_04 | 0.643 / 0.721 | 0.683 / 0.733 | 0.701 / 0.752 | 0.618 / 0.704 | 0.307 | 25.28 |
| retained_lr_08 | 0.662 / 0.747 | 0.695 / 0.754 | 0.699 / 0.775 | 0.668 / 0.756 | 0.278 | 21.45 |
| retained_lr_07 | 0.662 / 0.747 | 0.695 / 0.753 | 0.698 / 0.775 | 0.668 / 0.756 | 0.276 | 21.44 |
| retained_lr_10 | 0.651 / 0.729 | 0.693 / 0.740 | 0.696 / 0.759 | 0.629 / 0.715 | 0.300 | 25.02 |
| group_dro_mlp | 0.638 / 0.750 | 0.683 / 0.752 | 0.693 / 0.772 | 0.679 / 0.740 | 0.281 | 22.68 |
| dense_mlp | 0.628 / 0.757 | 0.704 / 0.754 | 0.688 / 0.768 | 0.675 / 0.740 | 0.278 | 22.93 |
| retained_lr_02 | 0.627 / 0.697 | 0.667 / 0.709 | 0.687 / 0.745 | 0.600 / 0.690 | 0.250 | 21.35 |
| retained_lr_09 | 0.650 / 0.712 | 0.627 / 0.701 | 0.685 / 0.740 | 0.647 / 0.713 | 0.284 | 25.38 |
| anova32_lr | 0.675 / 0.753 | 0.707 / 0.749 | 0.684 / 0.779 | 0.626 / 0.718 | 0.367 | 20.25 |
| leave_session_out_ensemble | 0.629 / 0.712 | 0.630 / 0.709 | 0.683 / 0.737 | 0.643 / 0.712 | 0.296 | 25.36 |
| equal_session_lr | 0.612 / 0.695 | 0.614 / 0.699 | 0.678 / 0.732 | 0.646 / 0.708 | 0.289 | 25.80 |
| augmented_waveform_lr | 0.631 / 0.720 | 0.638 / 0.711 | 0.677 / 0.738 | 0.651 / 0.709 | 0.303 | 25.51 |
| multiscale_lr | 0.578 / 0.640 | 0.655 / 0.725 | 0.676 / 0.748 | 0.598 / 0.693 | 0.308 | 19.17 |
| robust_scaler_lr | 0.567 / 0.686 | 0.640 / 0.704 | 0.675 / 0.735 | 0.644 / 0.708 | 0.291 | 25.20 |
| retained_lr_06 | 0.618 / 0.703 | 0.620 / 0.701 | 0.672 / 0.730 | 0.640 / 0.707 | 0.294 | 25.71 |
| retained_lr_05 | 0.618 / 0.703 | 0.620 / 0.701 | 0.672 / 0.730 | 0.640 / 0.707 | 0.295 | 25.70 |
| morphology_lr | 0.618 / 0.703 | 0.620 / 0.701 | 0.672 / 0.730 | 0.640 / 0.707 | 0.295 | 25.70 |
| coral_training_mlp | 0.664 / 0.769 | 0.701 / 0.752 | 0.671 / 0.764 | 0.682 / 0.741 | 0.274 | 22.46 |
| haar_lr | 0.627 / 0.697 | 0.624 / 0.703 | 0.660 / 0.724 | 0.630 / 0.700 | 0.317 | 27.42 |
| augmented_cnn | 0.643 / 0.733 | 0.669 / 0.730 | 0.637 / 0.751 | 0.666 / 0.743 | 0.255 | 19.68 |
| causal_cnn | 0.633 / 0.708 | 0.641 / 0.709 | 0.635 / 0.727 | 0.638 / 0.716 | 0.259 | 17.06 |
| retained_lr_01 | 0.606 / 0.657 | 0.592 / 0.644 | 0.625 / 0.680 | 0.602 / 0.690 | 0.456 | 15.25 |
| retained_lr_00 | 0.524 / 0.630 | 0.577 / 0.656 | 0.610 / 0.680 | 0.574 / 0.677 | 0.385 | 17.73 |
| retained_lr_03 | 0.556 / 0.638 | 0.588 / 0.652 | 0.610 / 0.670 | 0.582 / 0.667 | 0.399 | 19.56 |

## Files

- `stage-A.json`, `stage-B.json`, `stage-C.json`, `stage-D.json`: per method, min/mean/max fold AUC, pooled AUC, the 20 fold AUCs, pooled recall, precision, false activations per minute and latency.
- `ranked-results.csv`: the four stages' rankings in one table.
