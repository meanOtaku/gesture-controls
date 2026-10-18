# Causal preprocessing component ablation

37 recordings; 1,390 frozen events (424 binary pinch_start positives); the same 20 recording-disjoint 22/15 train/test splits. Exactly 160 fresh outer fits. No tuning, calibration, event filtering, or split changes. All features use green/red/IR PPG only. Labels establish targets and continuous matching only.

A = raw; B = past-only z-score; C = B then unrounded sigmoid; D = C then past-only median/MAD. Each is followed by the identical causal cubic first/second/third derivatives and 567 summary features. HistGradientBoosting and ExtraTrees retain the original settings and training-fold StandardScaler.

The 25 Hz grid uses timestamp ZOH. Z/MAD windows contain strictly previous 25 ticks, minimum 20 (finite values for MAD); population SD, 1.4826 MAD, zero scales emit zero. The current value is normalized using those past statistics; derivative fitting uses strictly previous nine transformed samples. No future, global/session normalization, or rounding. Original common decision schedule is retained, so warm-up differences do not change the evaluated events.

## Results

| Model | Stage | Min AUC | Mean AUC | Pooled AUC | Recall | Precision | False/min |
|---|---|---:|---:|---:|---:|---:|---:|
| hgb_morphology | A | 0.740207 | 0.810483 | 0.801637 | 0.335769 | 0.197558 | 17.960224 |
| extra_trees | A | 0.739217 | 0.808029 | 0.798614 | 0.381940 | 0.243525 | 15.624278 |
| hgb_morphology | B | 0.759503 | 0.812619 | 0.802147 | 0.342198 | 0.199455 | 18.087219 |
| extra_trees | B | 0.769195 | 0.821477 | 0.810109 | 0.375219 | 0.247494 | 15.023937 |
| hgb_morphology | C | 0.730750 | 0.811598 | 0.800065 | 0.321742 | 0.195074 | 17.483029 |
| extra_trees | C | 0.748586 | 0.823246 | 0.811181 | 0.356224 | 0.246113 | 14.369718 |
| hgb_morphology | D | 0.683154 | 0.756526 | 0.745771 | 0.389246 | 0.216973 | 18.498992 |
| extra_trees | D | 0.703996 | 0.774866 | 0.763117 | 0.395967 | 0.259281 | 14.896941 |

Recall, precision, and false/min above are continuous pooled operating metrics at probability >= 0.5, rising-edge triggers, 1,500 ms refractory, and matching decisions 680–1,280 ms after onset. Pooled figures concatenate held-out appearances; recordings/events repeated across folds are counted repeatedly. All fold counts, rates, minutes, and mean latency are in per-fold-results.csv and each stage scores.json. results.csv additionally gives min/mean/max/pooled for each rate.

## Component attribution

Delta is later minus earlier; positive false/min means worse. Signs count exact numerical positive/zero/negative fold deltas. Min delta compares stage minima (which need not belong to the same fold); the paired median is a separate quantity.

| Model | Step | Metric | Δ min | Δ mean | Δ pooled | + / 0 / − folds | Median paired Δ |
|---|---|---|---:|---:|---:|---:|---:|
| hgb_morphology | A->B | auc | +0.019295 | +0.002136 | +0.000511 | 9/0/11 | -0.006606 |
| hgb_morphology | A->B | recall | -0.048485 | +0.001347 | +0.006429 | 8/0/12 | -0.011498 |
| hgb_morphology | A->B | precision | -0.011180 | +0.003421 | +0.001896 | 11/0/9 | +0.002412 |
| hgb_morphology | A->B | false_activations_per_minute | -0.399723 | +0.138773 | +0.126995 | 10/0/10 | -0.115156 |
| hgb_morphology | B->C | auc | -0.028753 | -0.001021 | -0.002082 | 11/0/9 | +0.002892 |
| hgb_morphology | B->C | recall | -0.012321 | -0.021350 | -0.020456 | 9/0/11 | -0.019410 |
| hgb_morphology | B->C | precision | -0.032161 | -0.003812 | -0.004381 | 10/0/10 | +0.000484 |
| hgb_morphology | B->C | false_activations_per_minute | -0.016488 | -0.612974 | -0.604190 | 5/0/15 | -0.507200 |
| hgb_morphology | C->D | auc | -0.047595 | -0.055072 | -0.054294 | 0/0/20 | -0.057409 |
| hgb_morphology | C->D | recall | +0.115351 | +0.072460 | +0.067504 | 17/1/2 | +0.075583 |
| hgb_morphology | C->D | precision | +0.027483 | +0.019998 | +0.021899 | 16/0/4 | +0.031323 |
| hgb_morphology | C->D | false_activations_per_minute | +1.531091 | +1.025506 | +1.015963 | 14/0/6 | +1.239676 |
| extra_trees | A->B | auc | +0.029978 | +0.013447 | +0.011495 | 13/0/7 | +0.009930 |
| extra_trees | A->B | recall | -0.071859 | -0.010038 | -0.006721 | 9/0/11 | -0.032814 |
| extra_trees | A->B | precision | -0.029012 | +0.005721 | +0.003969 | 11/0/9 | +0.007694 |
| extra_trees | A->B | false_activations_per_minute | -0.399723 | -0.592946 | -0.600342 | 5/0/15 | -0.495719 |
| extra_trees | B->C | auc | -0.020609 | +0.001770 | +0.001071 | 12/0/8 | +0.006222 |
| extra_trees | B->C | recall | +0.002825 | -0.019777 | -0.018995 | 7/0/13 | -0.010327 |
| extra_trees | B->C | precision | -0.019071 | -0.001908 | -0.001381 | 10/0/10 | -0.001140 |
| extra_trees | B->C | false_activations_per_minute | +0.239834 | -0.661434 | -0.654219 | 7/0/13 | -0.499395 |
| extra_trees | C->D | auc | -0.044590 | -0.048380 | -0.048063 | 0/0/20 | -0.049722 |
| extra_trees | C->D | recall | +0.069033 | +0.043060 | +0.039743 | 16/0/4 | +0.046684 |
| extra_trees | C->D | precision | +0.022584 | +0.014262 | +0.013167 | 12/0/8 | +0.015400 |
| extra_trees | C->D | false_activations_per_minute | -0.075364 | +0.541667 | +0.527223 | 10/0/10 | +0.076742 |

## Mechanistic interpretation

A→B changes both scale and waveform: the rolling mean and SD evolve over time, so derivatives of the z-score include changes in the local baseline and scale as well as the PPG change. This can reduce sensitivity to absolute amplitude while amplifying fluctuations when recent SD is small. It is not equivalent to the training-only feature scaler.

B→C compresses large positive and negative z values. The sigmoid slope is largest near zero and small in the tails. Differentiating after sigmoid therefore suppresses saturated excursions and changes second/third derivatives through nonlinear curvature; a monotone transform before derivatives and summary statistics need not preserve model rankings.

C→D re-centers and rescales the bounded sigmoid signal using a moving median and MAD. This can expand locally compressed changes; small nonzero MAD can magnify them, while exactly zero MAD emits zero. The changing reference window can itself alter derivative shape.

For hgb_morphology, the largest observed mean-AUC decrease is C->D (-0.055072); the largest increase is A->B (+0.002136). These identify the conditional contribution of each added component in this specific pipeline order and fixed evaluation.
For extra_trees, the largest observed mean-AUC decrease is C->D (-0.048380); the largest increase is A->B (+0.013447). These identify the conditional contribution of each added component in this specific pipeline order and fixed evaluation.

The controlled ablation isolates changes to this computational pipeline, conditional on these recordings, splits, models, and component order. It does not establish physiological causality, isolate interactions independently of order, or provide an untouched test set. Overlapping grouped folds are not independent replications; sign counts are descriptive, not significance tests. Threshold metrics may move differently from rank-based AUC.

## Verification and blockers

All four stages passed causal future-perturbation and prefix-truncation checks on all 37 recordings, independent source-PPG parsing, scalar transform checks, independent polynomial-fit spot checks, exact split/event membership, binary-target assertions, train-only scaler checks, and immutable prediction-state checks. All 160 model fits used training fold rows only. A and D reproduce every original score and exported event/continuous prediction within 1e-12; reproduction.json gives maximum differences.

A separate verification process recomputed every fold and pooled metric from exported predictions, with rank-sum AUC and an independently written continuous event-matching implementation. Verification was implemented by the same agent, not an external reviewer. Derived result tables and contrasts are separately checked by verify_report.py. SHA-256 snapshots establish that repository, data, git, and earlier artifacts were unchanged.

Blockers: none. No external validation or alternate component orders were evaluated.
