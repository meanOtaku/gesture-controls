## minirocket-4000-100hz

MiniRocket (4000 kernels) + logistic regression on the trainer's 100 Hz CNN inputs; negatives subsampled to 8 per positive; no hard-negative pass. Threshold chosen out of fold on the training recordings.

| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |
|---|---|---|---|---|---|
| 0.999 | 1/20 | 42/102 | 17/57 | 0 (0.0/h) | 0 |
| 0.998 | 1/20 | 49/102 | 26/57 | 0 (0.0/h) | 0 |
| 0.995 | 1/20 | 57/102 | 34/57 | 1 (1.6/h) | 0 |
| 0.99 **(chosen)** | 3/20 | 65/102 | 39/57 | 2 (3.3/h) | 0 |
| 0.98 | 7/20 | 72/102 | 43/57 | 2 (3.3/h) | 0 |
| 0.97 | 7/20 | 73/102 | 44/57 | 3 (4.9/h) | 0 |
| 0.95 | 8/20 | 76/102 | 44/57 | 4 (6.6/h) | 0 |
| 0.9 | 11/20 | 79/102 | 49/57 | 6 (9.9/h) | 0 |
| 0.85 | 13/20 | 81/102 | 50/57 | 11 (18.1/h) | 0 |
| 0.8 | 13/20 | 82/102 | 51/57 | 13 (21.4/h) | 0 |
| 0.7 | 15/20 | 85/102 | 52/57 | 13 (21.4/h) | 0 |
| 0.6 | 15/20 | 87/102 | 52/57 | 15 (24.7/h) | 0 |
| 0.5 | 15/20 | 88/102 | 53/57 | 21 (34.5/h) | 0 |
