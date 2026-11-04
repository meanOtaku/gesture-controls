# The CNN trained on every camera-timed pinch day and the 4 Nov everyday noise, each day held out (pinch_in)

Budget 30 false activations an hour with no gesture under way. Pinch: caught / pinches · false activations an hour on the held-out pinch sessions. Noise: false activations an hour on the held-out noise (and fist) sessions, which hold no pinch. Each model at its own threshold.

| Held out | Model | Threshold | Pinch | Noise | Learnt from |
|---|---|---|---|---|---|
| 14 Oct | all days + noise, hard negatives | 0.96 | 16/153 (10%) · 0/h | 23/h (13 min) | 2 false activations |
| 14 Oct | live CNN | 0.75 | 99/153 (65%) · 0/h | 218/h (13 min) |  |
| 14 Oct | all days + noise | 0.97 | 7/153 (5%) · 0/h | 9/h (13 min) |  |
| 17 Oct | all days + noise, hard negatives | 0.60 | 5/47 (11%) · 71/h | 24/h (10 min) | 41 false activations |
| 17 Oct | live CNN | 0.75 | 9/47 (19%) · 35/h | 168/h (10 min) |  |
| 17 Oct | all days + noise | 0.75 | 5/47 (11%) · 71/h | 18/h (10 min) |  |
| 3 Nov | all days + noise, hard negatives | 0.65 | 48/70 (69%) · 176/h | 8/h (8 min) | 6 false activations |
| 3 Nov | live CNN | 0.75 | 47/70 (67%) · 183/h | 30/h (8 min) |  |
| 3 Nov | all days + noise | 0.60 | 56/70 (80%) · 176/h | 0/h (8 min) |  |
| 4 Nov | all days + noise, hard negatives | 0.96 | 15/36 (42%) · 64/h | 0/h (5 min) | 70 false activations |
| 4 Nov | live CNN | 0.75 | 23/36 (64%) · 64/h | 72/h (5 min) |  |
| 4 Nov | all days + noise | 0.99 | 26/36 (72%) · 64/h | 0/h (5 min) |  |

Over every fold (each pinch and noise session tested once, by a model that did not train on it):

| Model | Pinch caught | False an hour, pinch sessions | False an hour, noise |
|---|---|---|---|
| all days + noise, hard negatives | 84/306 (27%) | 110 | 17 |
| live CNN | 178/306 (58%) | 110 | 143 |
| all days + noise | 94/306 (31%) | 110 | 8 |

The live CNN trained on most of the 14 and 17 Oct sessions: its numbers on those folds are not on unseen data.

## What it shows (4 Nov 2026)

Trained on the M3's GPU: 3 to 8 minutes a model, about 45 minutes for all eight.

- **Everyday noise works: for the first time a model stays within the budget in ordinary use.** On held-out noise
  (5 sessions, about 36 minutes, and the fist sessions) the CNN trained with it fired 8 times an hour (17 with hard
  negatives), against 143 for the live CNN.
- **On the unseen November days it beats the live CNN:** 3 Nov 56/70 (80%) against 47/70 (67%), 4 Nov 26/36 (72%) against
  23/36 (64%), with the same false activations between pinches.
- **October is the problem.** Held out, 14 Oct is caught 5–10% and 17 Oct 11%. The live CNN, which trained on most of those
  sessions, still catches only 19% of 17 Oct. Something about the October sessions differs from November's: most likely
  where their labels sit (they were marked from the camera after the fact), or how they were recorded. Check their label
  timing before training on them again.
- **Between pinches it still fires too often** (110 an hour on the pinch sessions, for every model): most of it in the
  3 Nov sessions, around the pinches themselves.
- **Learning from its own false alarms did not help here.** With the fix it found 2 to 70 to learn from, and it caught fewer
  pinches (27% against 31%) for no fewer false activations. With noise in training, the model already makes few of the
  mistakes this is meant for. Leave it off by default.

These runs read the 14 Oct, 17 Oct and 3 Nov sessions from Model Lab. Its 3 Nov copies, added from the Recorder, had lost some of
their pinch starts: 300 ms marks saved as a range of rows, which shrank under the 200 ms training needs. `all_days_check.py`
now reads `data/recordings/`, whose exports kept most of them (388 pinch moments against 346 in the 3 Nov fold), so a new run
will differ a little. Sessions joining Datasets now get such marks back at their real length.
