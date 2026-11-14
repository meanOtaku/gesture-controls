## minirocket-4000-multihz-hard-jerk

MiniRocket (4000 kernels per rate) + logistic regression on the trainer's 50 Hz and 100 Hz (one MiniRocket each, features joined) CNN inputs; accelerometer jerk channels added; refitted with hard negatives; negatives subsampled to 8 per positive. Threshold chosen out of fold on the training recordings.

| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |
|---|---|---|---|---|---|
| 0.999 | 0/20 | 33/102 | 28/57 | 0 (0.0/h) | 0 |
| 0.998 | 0/20 | 44/102 | 32/57 | 0 (0.0/h) | 0 |
| 0.995 | 0/20 | 49/102 | 36/57 | 0 (0.0/h) | 0 |
| 0.99 **(chosen)** | 0/20 | 59/102 | 39/57 | 0 (0.0/h) | 0 |
| 0.98 | 1/20 | 61/102 | 41/57 | 0 (0.0/h) | 0 |
| 0.97 | 4/20 | 63/102 | 43/57 | 0 (0.0/h) | 0 |
| 0.95 | 7/20 | 64/102 | 44/57 | 0 (0.0/h) | 0 |
| 0.9 | 8/20 | 73/102 | 45/57 | 0 (0.0/h) | 0 |
| 0.85 | 9/20 | 77/102 | 46/57 | 0 (0.0/h) | 0 |
| 0.8 | 10/20 | 79/102 | 46/57 | 0 (0.0/h) | 0 |
| 0.7 | 12/20 | 79/102 | 48/57 | 0 (0.0/h) | 0 |
| 0.6 | 13/20 | 79/102 | 47/57 | 1 (1.6/h) | 0 |
| 0.5 | 14/20 | 79/102 | 48/57 | 4 (6.6/h) | 0 |
