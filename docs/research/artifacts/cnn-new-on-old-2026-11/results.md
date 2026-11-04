# The CNN trained on 4 Nov (pinches and everyday noise), tested on every older recording (pinch_in)

Each cell: pinches caught / pinches (TAR) · false activations an hour with no gesture under way. Budget 30/h. Each model at its own threshold. Judged = the camera-timed sessions and the fist sessions together.

| Model | Threshold | Judged | 14 Oct pinch | 17 Oct pinch | 3 Nov pinch | 14 Oct fist (no pinch) | estimated pinch (no camera) |
|---|---|---|---|---|---|---|---|
| new | 0.30 | 44/270 (16%) · 78/h | 4/153 (3%) · 0/h | 0/47 (0%) · 0/h | 40/70 (57%) · 149/h | – · 0/h | 0/139 (0%) · 10/h |
| new, hard negatives | 0.30 | 44/270 (16%) · 78/h | 4/153 (3%) · 0/h | 0/47 (0%) · 0/h | 40/70 (57%) · 149/h | – · 0/h | 0/139 (0%) · 10/h |
| live CNN (trained on 14/17 Oct) | 0.75 | 155/270 (57%) · 173/h | 99/153 (65%) · 0/h | 9/47 (19%) · 35/h | 47/70 (67%) · 183/h | – · 385/h | 19/139 (14%) · 40/h |

Median latency (ms from a pinch's start to its catch), judged: new 450; new, hard negatives 450; live CNN (trained on 14/17 Oct) 478.

Diagnostic (never used to choose a threshold): the best threshold on the judged test recordings within the budget.

- new: 17/270 at 0.95 (28/h)
- new, hard negatives: 17/270 at 0.95 (28/h)
- live CNN (trained on 14/17 Oct): none within the budget

## What it shows (4 Nov 2026)

- **The everyday noise works against false activations.** On the 14 Oct fist sessions (no pinch) the CNN trained on the
  new sessions fired 0 times an hour, against 385 for the live CNN, and 0/h on the 14 and 17 Oct pinch sessions. Over
  everything judged it fired 78 times an hour against 173.
- **Two pinch sessions (38 pinches) are too few to learn the pinch.** Its scores stay low, so its threshold went to the
  lowest candidate (0.30), and it caught 16% of the judged pinches against the live CNN's 57%. It caught 57% of the 3 Nov
  sessions, recorded the same way as 4 Nov (arm resting, light pinch, same place), and almost none of the October ones:
  it has learnt one session's pinch, not the pinch.
- **The live CNN's 65% on 14 Oct is on its own training recordings**, so it is not a fair comparison there.
- **"Learn from its own false alarms" did nothing here**: it looks for false activations at the default cut-off (0.5),
  but this model never reached 0.5 on its training recordings, so it found none (0 added) and trained the same model.
  The search should use the lowest cut-off the threshold may be chosen at instead.

Next: train on every camera-timed pinch session (14 Oct, 17 Oct, 3 Nov, 4 Nov) together with the 4 Nov noise, and test on
a session none of them includes.
