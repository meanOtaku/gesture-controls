# A pinch in the pulse signal, with the heart beat removed (causal)

36 recordings; median heart rate 63 beats a minute; 87% of beats removed. In the green channel the heart beat (power within 0.12 Hz of the heart rate) is 24% of the 0.7-3.5 Hz band, and removal leaves 60% of it (medians per recording). Moments: {'pinch': 407, 'other': 230, 'random': 1493}.

## Single moments: does a window look like a pinch?

ROC AUC of each window's match (-0.5 to +1.5 s) with the other recordings' pinch average: pinch starts against random
moments, and against other gestures' starts. 0.5 is no better than chance.

| Signal | Pinch vs random, detrended | with heart beat removed | Pinch vs other, detrended | with heart beat removed |
|---|---:|---:|---:|---:|
| green | 0.736 | 0.725 | 0.622 | 0.626 |
| red | 0.745 | 0.740 | 0.714 | 0.720 |
| ir | 0.714 | 0.700 | 0.657 | 0.657 |
| green_minus_ir | 0.622 | 0.614 | 0.576 | 0.586 |

## Averages

Peak of the average (in units of each recording's spread) from 0 to 3 s after the moment, how many standard errors it
stands from zero, and how each recording's average matches the other recordings' pinch average (median correlation,
share positive).

| Moments | Signal | Stage | Peak at | Peak | Peak / SE | Median r | Share r > 0 |
|---|---|---|---:|---:|---:|---:|---:|
| pinch | green | detrended | +0.48 s | +1.285 | 6.0 | +0.76 | 83% |
| pinch | green | residual | +0.48 s | +1.249 | 5.9 | +0.76 | 83% |
| pinch | red | detrended | +0.40 s | +1.519 | 4.9 | +0.76 | 83% |
| pinch | red | residual | +0.40 s | +1.478 | 4.9 | +0.78 | 83% |
| pinch | ir | detrended | +0.44 s | +1.384 | 5.0 | +0.66 | 79% |
| pinch | ir | residual | +0.44 s | +1.296 | 4.9 | +0.65 | 79% |
| pinch | green_minus_ir | detrended | +0.64 s | +0.834 | 3.8 | +0.44 | 79% |
| pinch | green_minus_ir | residual | +0.64 s | +0.854 | 3.6 | +0.47 | 79% |
| other | green | detrended | +0.04 s | -0.434 | 1.6 | +0.77 | 60% |
| other | green | residual | +1.84 s | -0.375 | 2.0 | +0.76 | 60% |
| other | red | detrended | +0.08 s | -1.383 | 3.0 | -0.21 | 33% |
| other | red | residual | +0.12 s | -1.259 | 2.8 | -0.26 | 33% |
| other | ir | detrended | +0.08 s | -1.134 | 2.5 | -0.09 | 47% |
| other | ir | residual | +0.08 s | -1.001 | 2.4 | -0.12 | 47% |
| other | green_minus_ir | detrended | +1.88 s | -0.585 | 3.5 | +0.21 | 67% |
| other | green_minus_ir | residual | +1.68 s | -0.561 | 3.2 | +0.20 | 67% |
| random | green | detrended | +1.12 s | +0.197 | 2.3 | -0.07 | 44% |
| random | green | residual | +1.20 s | +0.215 | 2.1 | -0.04 | 44% |
| random | red | detrended | +2.96 s | +0.264 | 2.7 | +0.06 | 52% |
| random | red | residual | +2.96 s | +0.267 | 2.9 | +0.07 | 52% |
| random | ir | detrended | +2.96 s | +0.233 | 2.7 | -0.05 | 44% |
| random | ir | residual | +2.96 s | +0.230 | 2.8 | -0.04 | 48% |
| random | green_minus_ir | detrended | +1.12 s | +0.149 | 1.9 | +0.12 | 59% |
| random | green_minus_ir | residual | +1.20 s | +0.184 | 1.8 | +0.08 | 59% |
