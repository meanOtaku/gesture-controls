# Fresh PPG derivative ablations

CV progress evidence only; not an untouched test. All 14 methods are fresh derivative ablations, with no claim of historical recovery.

37 recordings; 1,390 events (424 pinch_start positives); exact prior 20 fixed recording-disjoint 22/15 splits. Pooled OOF counts repeated held-out appearances repeatedly. Ranking: descending minimum, then mean, then maximum fold AUC.

| Method | Min AUC | Mean AUC | Max AUC | Pooled OOF AUC | Continuous recall | Precision | False/min | Mean latency ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| B_hgb | 0.7435 | 0.8094 | 0.8847 | 0.7999 | 0.3095 | 0.1796 | 18.6144 | 866.1505 |
| D_hgb | 0.7402 | 0.8105 | 0.8743 | 0.8016 | 0.3358 | 0.1976 | 17.9602 | 857.7318 |
| C_hgb | 0.7392 | 0.8103 | 0.8723 | 0.8011 | 0.3337 | 0.1957 | 18.0564 | 854.3237 |
| A+C_hgb | 0.7028 | 0.8008 | 0.8774 | 0.7889 | 0.2610 | 0.1807 | 15.5819 | 851.8713 |
| A+D_hgb | 0.7009 | 0.7981 | 0.8649 | 0.7863 | 0.2577 | 0.1776 | 15.7128 | 856.5457 |
| A+B_hgb | 0.6957 | 0.8008 | 0.8785 | 0.7876 | 0.2516 | 0.1761 | 15.5050 | 856.5420 |
| A_hgb | 0.6664 | 0.7756 | 0.8596 | 0.7614 | 0.2095 | 0.1615 | 14.3312 | 871.8338 |
| B_lr | 0.6587 | 0.7224 | 0.7951 | 0.7152 | 0.3302 | 0.1580 | 23.1747 | 897.0537 |
| C_lr | 0.6241 | 0.7102 | 0.7839 | 0.7017 | 0.3276 | 0.1522 | 24.0329 | 893.6874 |
| D_lr | 0.6181 | 0.7036 | 0.7828 | 0.6978 | 0.3358 | 0.1501 | 25.0412 | 910.2728 |
| A+B_lr | 0.5524 | 0.7241 | 0.8233 | 0.7135 | 0.2890 | 0.1531 | 21.0543 | 902.8106 |
| A+C_lr | 0.5435 | 0.7139 | 0.8124 | 0.7031 | 0.2773 | 0.1437 | 21.7547 | 913.2448 |
| A+D_lr | 0.5404 | 0.7157 | 0.8101 | 0.7046 | 0.2984 | 0.1505 | 22.1819 | 916.1090 |
| A_lr | 0.4905 | 0.6760 | 0.7706 | 0.6647 | 0.2715 | 0.1690 | 17.5831 | 882.1365 |

A: raw ZOH morphology. B: slope. C: slope + curvature. D: slope + curvature + jerk. A+B/A+C/A+D concatenate baseline. Both estimators use identical features per representation. 189 features per order. See frozen method-ledger.json for every statistic and fixed parameter.

Causal preprocessing: 25Hz zero-order hold on source timestamps; degree-3 fit to previous nine samples, excluding current, evaluated at current grid time. Full features become valid at 1,600ms. Windows contain the final 8/16/32 samples at or before decision time. No centered filters, future interpolation, recording-wide learned normalization, or retrospective clock repair.

Continuous evaluation preserves prior semantics: 40ms anchor spacing; decisions at anchor+880ms; fixed .5 threshold; rising edges with 1,500ms refractory; greedy one-to-one match within onset+680..1280ms. Duration denominator follows prior protocol. This is delayed detection, not onset-time prediction.

Checks: future-value perturbation and truncated-prefix invariance across all 37 recordings; exact event/split reuse; training-only scaler fits; models immutable during prediction; independent process recomputed all event AUCs and continuous metrics from saved outputs and checked polynomial derivatives independently. Verification is independently implemented, not an external reviewer.

No execution blockers. Limitations: repeated CV is selection/progress evidence; correlated repeats are not independent observations. Legacy timestamp compression remains; unmarked controls are not verified non-pinch. Labels (including annotation timestamps in IMU files where inherited) are used only for unchanged event/metric definitions, never as predictors. Repository snapshot excludes dependency/build/cache directories (node_modules, .venv, __pycache__, target, .tools); all other repository/data/git files and all non-cache prior study artifacts were hashed before and after. No neural models or feature selection were used.
