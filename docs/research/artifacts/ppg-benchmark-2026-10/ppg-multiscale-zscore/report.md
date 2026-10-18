# Multi-scale causal z-score → ExtraTrees

Run 2026-10-18 with `../multiscale_zscore.py`. The aim was to raise the worst-split AUC of the best pipeline from the no-MAD benchmark (`../ppg-no-mad-all-techniques/`): 1-second z-score → derivatives → ExtraTrees, min AUC 0.769.

Each configuration z-scores every PPG channel against one or more past windows (1, 2, 4 or 8 s; current sample excluded; at least 20 ticks of history). Each window's z-score gets its own causal cubic derivatives and 567 summaries, and the blocks are concatenated. ExtraTrees keeps its frozen settings. The 37 recordings, 1,390 events, 20 recording-disjoint splits and live-detection rules are unchanged.

## Why the worst split is low

A diagnosis run on the baseline (out-of-fold scores averaged over each event's held-out appearances) found:

- **Starts of other gestures** (fist, thumbs-up, hand-open) average 0.365, against 0.505 for pinch starts and about 0.2 for mid-gesture and unmarked events. The fist recording `2026-10-14T01-02-50` averages 0.478 on its negatives; removing it raises pooled AUC the most (+0.012).
- **The 09-23 recording and the 10-17 recordings** separate poorly even within themselves (AUC 0.56 and 0.64–0.73). The label-lag audit found the 10-17 labels 700–1,300 ms late.

## Result

| Configuration | Features | Min AUC | Mean AUC | Max AUC | Folds better than baseline | Worst-5-fold mean | Recall | Precision | False/min |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **z 1s+2s+4s** | 1701 | **0.7885** | **0.8426** | 0.8939 | **20/20** | **0.8100** | 0.413 | 0.265 | 15.09 |
| z 2s+4s | 1134 | 0.7820 | 0.8356 | 0.8848 | 17/20 | 0.8042 | 0.406 | 0.252 | 15.89 |
| z+sigmoid 1s+2s+4s | 1701 | 0.7813 | 0.8410 | 0.8936 | 19/20 | 0.8042 | 0.380 | 0.248 | 15.18 |
| z 1s+2s+4s+8s | 2268 | 0.7785 | 0.8396 | 0.9007 | 18/20 | 0.8042 | 0.381 | 0.246 | 15.43 |
| z+sigmoid 1s+2s+4s+8s | 2268 | 0.7770 | 0.8356 | 0.8911 | 18/20 | 0.7982 | 0.352 | 0.231 | 15.39 |
| z 1s (baseline) | 567 | 0.7689 | 0.8213 | 0.8715 | — | 0.7857 | 0.377 | 0.248 | 15.02 |
| z 4s | 567 | 0.7684 | 0.8200 | 0.8715 | 10/20 | 0.7931 | 0.406 | 0.246 | 16.39 |
| z 2s | 567 | 0.7632 | 0.8267 | 0.8732 | 14/20 | 0.7949 | 0.422 | 0.258 | 16.02 |
| z 8s | 567 | 0.7523 | 0.8243 | 0.8813 | 12/20 | 0.7917 | 0.387 | 0.236 | 16.49 |

- **Combining scales is what helps.** No single history beats 1 s on worst-split AUC; 2, 4 and 8 s alone are level or worse. Every combination beats every single scale.
- **1 s + 2 s + 4 s is best on every AUC measure.** Worst split +0.020, mean +0.021, worst-five-fold mean +0.024, and better than the baseline on all 20 paired splits. Live recall rises from 0.377 to 0.413, and precision from 0.248 to 0.265 (the highest precision of any configuration), while false activations stay about the same (15.0 → 15.1 per minute).
- **Adding 8 s, or a sigmoid, makes it slightly worse.** Both still beat the baseline, but they lose to 1 s + 2 s + 4 s on every measure.

The likely reason: a pinch and the starts of other gestures move the PPG baseline differently over a few seconds. Z-scoring against several horizons lets the trees see how far the onset departs from both the very recent and the slightly older baseline. This is an interpretation, not something the study isolates.

**New candidate:** PPG → causal z-score against the previous 1, 2 and 4 s → causal slope + curvature + jerk → 1,701 summaries → ExtraTrees.

## Limits

These are cross-validation results, not an untouched test. This study and the five-candidate screen before it (ensembles, B+C features, 1,000 trees) picked the winner on these same 20 splits. All 20 folds improving makes a fluke unlikely, but the size of the gain is likely a little optimistic.

Confirming it needs recordings that no study has seen. Live recall at the fixed 0.5 threshold is still about 41%, with about 15 false activations a minute. Other gestures' starts remain the main confusion, and the late 10-17 labels are a data problem that no feature change fixes.

## Files

- `results.json`: per configuration, stage, history lengths, feature count, min/mean/max fold AUC, the 20 fold AUCs and pooled live-detection metrics.
- `results.md`: the results table as the script writes it.
