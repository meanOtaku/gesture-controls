## minirocket-4000-multihz

MiniRocket (4000 kernels per rate) + logistic regression on the trainer's 50 Hz and 100 Hz (one MiniRocket each, features joined) CNN inputs; negatives subsampled to 8 per positive. Threshold chosen out of fold on the training recordings.

| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |
|---|---|---|---|---|---|
| 0.999 | 3/20 | 41/102 | 30/57 | 0 (0.0/h) | 0 |
| 0.998 | 5/20 | 50/102 | 35/57 | 0 (0.0/h) | 0 |
| 0.995 | 8/20 | 59/102 | 41/57 | 0 (0.0/h) | 0 |
| 0.99 **(chosen)** | 10/20 | 63/102 | 42/57 | 0 (0.0/h) | 0 |
| 0.98 | 11/20 | 69/102 | 45/57 | 1 (1.6/h) | 0 |
| 0.97 | 11/20 | 69/102 | 47/57 | 2 (3.3/h) | 0 |
| 0.95 | 11/20 | 72/102 | 48/57 | 3 (4.9/h) | 0 |
| 0.9 | 12/20 | 78/102 | 49/57 | 6 (9.9/h) | 0 |
| 0.85 | 15/20 | 82/102 | 50/57 | 9 (14.8/h) | 0 |
| 0.8 | 16/20 | 82/102 | 50/57 | 11 (18.1/h) | 0 |
| 0.7 | 17/20 | 83/102 | 52/57 | 16 (26.3/h) | 0 |
| 0.6 | 17/20 | 84/102 | 54/57 | 22 (36.2/h) | 0 |
| 0.5 | 18/20 | 85/102 | 53/57 | 28 (46.0/h) | 0 |
