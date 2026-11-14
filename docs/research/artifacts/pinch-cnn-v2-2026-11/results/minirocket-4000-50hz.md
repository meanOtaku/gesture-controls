## minirocket-4000-50hz

MiniRocket (4000 kernels) + logistic regression on the trainer's 50 Hz CNN inputs; negatives subsampled to 8 per positive; no hard-negative pass. Threshold chosen out of fold on the training recordings.

| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |
|---|---|---|---|---|---|
| 0.999 | 3/20 | 45/102 | 22/57 | 1 (1.6/h) | 0 |
| 0.998 | 7/20 | 53/102 | 31/57 | 1 (1.6/h) | 0 |
| 0.995 | 11/20 | 55/102 | 37/57 | 2 (3.3/h) | 0 |
| 0.99 **(chosen)** | 11/20 | 61/102 | 42/57 | 4 (6.6/h) | 0 |
| 0.98 | 11/20 | 64/102 | 46/57 | 7 (11.5/h) | 0 |
| 0.97 | 11/20 | 68/102 | 48/57 | 8 (13.2/h) | 0 |
| 0.95 | 11/20 | 72/102 | 48/57 | 10 (16.4/h) | 0 |
| 0.9 | 12/20 | 77/102 | 50/57 | 11 (18.1/h) | 0 |
| 0.85 | 12/20 | 78/102 | 50/57 | 13 (21.4/h) | 0 |
| 0.8 | 14/20 | 81/102 | 53/57 | 21 (34.5/h) | 0 |
| 0.7 | 16/20 | 83/102 | 52/57 | 28 (46.0/h) | 0 |
| 0.6 | 18/20 | 83/102 | 52/57 | 29 (47.7/h) | 0 |
| 0.5 | 18/20 | 83/102 | 53/57 | 37 (60.8/h) | 0 |
