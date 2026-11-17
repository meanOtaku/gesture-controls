# The CNN trained on every camera-timed pinch day and the 4 Nov everyday noise, each day held out (pinch_in)

Budget 30 false activations an hour with no gesture under way. Pinch: caught / pinches · false activations an hour on the held-out pinch sessions. Noise: false activations an hour on the held-out noise (and fist) sessions, which hold no pinch. Each model at its own threshold.

| Held out | Model | Threshold | Pinch | Noise | Learnt from |
|---|---|---|---|---|---|
| 14 Oct | all days + noise | 0.90 | 30/171 (18%) · 0/h | 23/h (13 min) |  |
| 14 Oct | live CNN | 0.75 | 97/171 (57%) · 0/h | 218/h (13 min) |  |
| 14 Oct | all moments, no still-hand gate | 0.98 | 21/171 (12%) · 0/h | 14/h (13 min) |  |
| 14 Oct | all moments, gate when running | 0.98 | 18/171 (11%) · 0/h | 5/h (13 min) |  |
| 14 Oct | all moments, pretrained | 0.80 | 47/171 (27%) · 39/h | 68/h (13 min) |  |
| 14 Oct | all moments, 2 s window | 0.75 | 66/167 (40%) · 20/h | 142/h (13 min) |  |
| 14 Oct | all moments, 2 s window (seed 29) | 0.90 | 41/167 (25%) · 40/h | 73/h (13 min) |  |
| 14 Oct | all moments, no still-hand gate (seed 29) | 0.90 | 24/171 (14%) · 0/h | 32/h (13 min) |  |
| 17 Oct | all days + noise | 0.55 | 8/52 (15%) · 38/h | 48/h (10 min) |  |
| 17 Oct | live CNN | 0.75 | 10/52 (19%) · 38/h | 168/h (10 min) |  |
| 17 Oct | all moments, no still-hand gate | 0.75 | 37/52 (71%) · 378/h | 6/h (10 min) |  |
| 17 Oct | all moments, gate when running | 0.75 | 10/52 (19%) · 0/h | 6/h (10 min) |  |
| 17 Oct | all moments, pretrained | 0.85 | 27/52 (52%) · 151/h | 6/h (10 min) |  |
| 17 Oct | all moments, 2 s window | 0.75 | 34/50 (68%) · 466/h | 48/h (10 min) |  |
| 17 Oct | all moments, 2 s window (seed 29) | 0.85 | 27/50 (54%) · 194/h | 24/h (10 min) |  |
| 17 Oct | all moments, no still-hand gate (seed 29) | 0.85 | 29/52 (56%) · 227/h | 12/h (10 min) |  |
| 3 Nov | all days + noise | 0.65 | 65/92 (71%) · 28/h | 8/h (8 min) |  |
| 3 Nov | live CNN | 0.75 | 60/92 (65%) · 35/h | 30/h (8 min) |  |
| 3 Nov | all moments, no still-hand gate | 0.95 | 67/92 (73%) · 28/h | 0/h (8 min) |  |
| 3 Nov | all moments, gate when running | 0.95 | 66/92 (72%) · 28/h | 0/h (8 min) |  |
| 3 Nov | all moments, pretrained | 0.90 | 73/92 (79%) · 28/h | 0/h (8 min) |  |
| 3 Nov | all moments, 2 s window | 0.95 | 85/90 (94%) · 29/h | 0/h (8 min) |  |
| 3 Nov | all moments, 2 s window (seed 29) | 0.95 | 84/90 (93%) · 36/h | 0/h (8 min) |  |
| 3 Nov | all moments, no still-hand gate (seed 29) | 0.95 | 71/92 (77%) · 28/h | 0/h (8 min) |  |
| 4 Nov | all days + noise | 0.65 | 43/57 (75%) · 11/h | 0/h (5 min) |  |
| 4 Nov | live CNN | 0.75 | 37/57 (65%) · 11/h | 72/h (5 min) |  |
| 4 Nov | all moments, no still-hand gate | 0.96 | 36/57 (63%) · 11/h | 0/h (5 min) |  |
| 4 Nov | all moments, gate when running | 0.96 | 36/57 (63%) · 11/h | 0/h (5 min) |  |
| 4 Nov | all moments, pretrained | 0.80 | 30/57 (53%) · 11/h | 0/h (5 min) |  |
| 4 Nov | all moments, 2 s window | 0.96 | 53/55 (96%) · 11/h | 0/h (5 min) |  |
| 4 Nov | all moments, 2 s window (seed 29) | 0.98 | 53/55 (96%) · 11/h | 0/h (5 min) |  |
| 4 Nov | all moments, no still-hand gate (seed 29) | 0.95 | 42/57 (74%) · 11/h | 0/h (5 min) |  |

Over every fold (each pinch and noise session tested once, by a model that did not train on it):

| Model | Pinch caught | False an hour, pinch sessions | False an hour, noise |
|---|---|---|---|
| all days + noise | 146/372 (39%) | 20 | 23 |
| live CNN | 204/372 (55%) | 23 | 143 |
| all moments, no still-hand gate | 161/372 (43%) | 49 | 7 |
| all moments, gate when running | 130/372 (35%) | 16 | 3 |
| all moments, pretrained | 177/372 (48%) | 36 | 27 |
| all moments, 2 s window | 238/362 (66%) | 59 | 65 |
| all moments, 2 s window (seed 29) | 205/362 (57%) | 43 | 33 |
| all moments, no still-hand gate (seed 29) | 166/372 (45%) | 36 | 15 |

The live CNN trained on most of the 14 and 17 Oct sessions: its numbers on those folds are not on unseen data.
