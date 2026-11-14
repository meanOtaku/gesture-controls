# Pinch-start v2: findings so far (14 Nov 2026)

All numbers are on the fixed test set ([README.md](README.md)): 20 live pinches (13 Nov session 1), 102 moving (9 Nov),
57 resting, 0.61 h of everyday activity. Models are compared at **matched everyday false-activation rates** (the
highest-recall threshold at most 5/h or 10/h), which picks the threshold on the test set, so these compare methods; they
are not deployable results. CNN rows are the mean of 3 seeds (one network each); MiniRocket rows are one run.
Full tables: [RESULTS.md](RESULTS.md) (`summarize.py`).

## At most 10 everyday false activations per hour

| Model | Live (20) | Moving (102) | Resting (57) |
|---|---|---|---|
| `ae0a22bf` (active) | 7 | 58 | 46 |
| Current trainer, `ae0a22bf`'s data (model A) | 1 | 75 | 47 |
| CNN, trainer network | 12.7 | 72.0 | 42.7 |
| CNN, trainer network + warping | 13.7 | 72.3 | 45.7 |
| **CNN, per-sensor branches** | 14.0 | 75.0 | 40.7 |
| **CNN, per-sensor branches + warping** | **15.3** | 74.3 | 42.3 |
| MiniRocket 100 Hz | 11 | 79 | 49 |
| **MiniRocket 100 Hz + hard negatives** | **16** | 79 | 49 |
| MiniRocket 100 Hz + jerk | 11 | **84** | **50** |
| MiniRocket 50 + 100 Hz | 12 | 78 | 49 |
| MiniRocket 50 + 100 Hz + hard negatives + jerk | 14 | 79 | 48 |

At **at most 5/h**, MiniRocket 50 + 100 Hz with hard negatives and jerk catches 12 / 79 / 48 with **no** everyday false
activation at all, the best low-rate operating point so far; branches catch 14.0 / 74.7 / 39.3 at 2.7/h.

## What we learned

1. **Training data is the biggest lever.** The same CNN trained on `ae0a22bf`'s recordings only catches 3.0/20 live;
   adding the second 13 Nov live session (10 pinches) gives 5.7, adding the 20-minute noise gives 7.3, and both 12.7.
   Real-use sessions and everyday noise each help, and together far more than either. This, not the 100 Hz grid, is
   most of why the current trainer's models missed live pinches.
2. **100 Hz is not the problem.** MiniRocket and the CNNs reach 11–16 live pinches from the same 100 Hz inputs.
3. **Per-sensor branches** (your idea, as one branch per sensor joined partway and at the end) are the best CNN on live
   pinches (14–15 against 12.7), with moving the same and resting about 2–4 lower.
4. **Warping** (time and magnitude, Um et al. 2017) helps a little: about +1 live and +2–3 resting.
5. **Hard negatives** help MiniRocket a lot (11 → 16 live at the same rate) but not the CNN (12.7 → 10.7 for the trainer
   network; branches unchanged on live, 6 fewer moving).
6. **Jerk on the scaled signal** is mixed: it helps MiniRocket on moving pinches (79 → 84) and hurt the CNN (one seed).
   It is a rough version: the change of the already-scaled signal. A proper jerk from the raw accelerometer is next.
7. **50 + 100 Hz together** (your ensemble idea, as one MiniRocket per rate) gives the best result at low false-activation
   rates.
8. **The trainer's threshold rule does not suit the new models.** Chosen out of fold on the training recordings, it lands
   at 0.97–0.99, too strict for them (MiniRocket 100 Hz: 3/20 live there). Threshold choice needs work before phase 2.

## Caveats

- 20 live test pinches from one session and 0.61 h of everyday activity: differences of 1–3 are within chance.
- MiniRocket rows are single runs; the CNN spread across seeds is about ±1–2 pinches.
- The test set is used to pick the matched thresholds, so every row is optimistic by the same rule.

## Next

1. Confirm the two leaders with more seeds: branches + warping (3 networks averaged, as the trainer ships), and MiniRocket
   50 + 100 Hz + hard negatives (+ jerk).
2. Inputs from the raw signal: proper jerk and jerk envelope; orientation-independent magnitudes; smoothing before 100 Hz.
3. Augmentation by overlaying recorded everyday wrist motion onto pinches (needs the raw-signal input builder too).
4. InceptionTime; then an ensemble of the best CNN and MiniRocket; peak gating in front.
5. A threshold rule that suits the new models, chosen without the test set.
6. More real-use sessions and everyday noise: point 1 says this pays most.
