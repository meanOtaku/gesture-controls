## minirocket-4000-100hz-jerk

MiniRocket (4000 kernels per rate) + logistic regression on the trainer's 100 Hz CNN inputs; accelerometer jerk channels added; negatives subsampled to 8 per positive. Threshold chosen out of fold on the training recordings.

| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |
|---|---|---|---|---|---|
| 0.999 | 0/20 | 36/102 | 33/57 | 0 (0.0/h) | 0 |
| 0.998 | 0/20 | 44/102 | 38/57 | 0 (0.0/h) | 0 |
| 0.995 | 4/20 | 57/102 | 39/57 | 0 (0.0/h) | 0 |
| 0.99 **(chosen)** | 6/20 | 64/102 | 40/57 | 0 (0.0/h) | 0 |
| 0.98 | 6/20 | 68/102 | 45/57 | 1 (1.6/h) | 0 |
| 0.97 | 8/20 | 71/102 | 45/57 | 2 (3.3/h) | 0 |
| 0.95 | 8/20 | 80/102 | 46/57 | 2 (3.3/h) | 0 |
| 0.9 | 8/20 | 81/102 | 47/57 | 3 (4.9/h) | 0 |
| 0.85 | 9/20 | 83/102 | 48/57 | 3 (4.9/h) | 0 |
| 0.8 | 11/20 | 84/102 | 50/57 | 5 (8.2/h) | 0 |
| 0.7 | 13/20 | 84/102 | 52/57 | 7 (11.5/h) | 0 |
| 0.6 | 14/20 | 84/102 | 52/57 | 12 (19.7/h) | 0 |
| 0.5 | 14/20 | 85/102 | 52/57 | 16 (26.3/h) | 0 |
