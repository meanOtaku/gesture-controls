# Pinch-start v2: findings so far (14–15 Nov 2026)

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

## Round 2 (14–15 Nov): raw-signal inputs, InceptionTime, ensembles

New inputs come from the raw samples (`inputs_v2.py`), scaled exactly as the trainer scales its channels; with nothing
added it reproduces the trainer's inputs to 0.0. InceptionTime is `nets_extra.py`. Combinations average saved test
scores (`ensemble.py`).

**Inputs, 3 seeds each, at most 5 everyday false activations per hour:**

| Network | Inputs | Live (20) | Moving (102) | Resting (57) |
|---|---|---|---|---|
| Trainer network | trainer's 9 channels | 12.3 | 71.7 | 43.0 |
| Trainer network | + **jerk envelope** | **14.3** | 75.3 | 46.3 |
| Trainer network | + raw jerk | 8.3 | 71.3 | 46.0 |
| Branches + warping | trainer's 9 channels | 13.7 | 75.0 | 40.0 |
| Branches + warping | + **jerk envelope** | **16.0** | 76.0 | 43.0 |
| Branches + warping | + raw jerk | 15.0 | 78.7 | 45.7 |
| Branches + warping | + jerk + envelope | 14.7 | 77.7 | 46.7 |
| InceptionTime | trainer's 9 channels | 15.3 | 74.7 | **50.0** |

The orientation-independent sizes and smoothing over 3 ticks were roughly neutral (within ±1 of the row without them);
all new channels together were no better than jerk alone. **The jerk envelope (the spike-peaks idea) is the one
addition that helps both networks in every group.** Raw jerk helps the branch network and hurts the trainer network,
where its three channels share one stack with everything else.

**Shipping form: 3 networks averaged (one run each), at most 5/h:**

| Model | Live (20) | Moving (102) | Resting (57) | Everyday FA |
|---|---|---|---|---|
| `ae0a22bf` (active) | 5 | 58 | 44 | 4.9/h |
| **Branches + warping + envelope, 3 networks** | **17** | 77 | 44 | 3.3/h |
| Branches + warping + raw jerk, 3 networks | 15 | **82** | 48 | 4.9/h |
| InceptionTime, 3 networks | 13 | 78 | **51** | **0.0/h** |
| MiniRocket 50 + 100 Hz, hard negatives, jerk | 12 | 79 | 48 | 0.0/h |
| Ensemble: branches-envelope + InceptionTime | 16 | 78 | 47 | 3.3/h |
| Ensemble: branches-envelope + MiniRocket hard | 15 | 81 | 49 | 4.9/h |
| Ensemble: all five above | 13 | 82 | 51 | 1.6/h |

- **Best for live pinches: branches + warping + jerk envelope** (17 of 20, against 5 for `ae0a22bf`, with fewer false
  activations). It is the leading candidate to port in phase 2.
- **Best at the lowest false-activation rates: InceptionTime** (no everyday false activation at its best threshold), and
  the five-model ensemble (1.6/h, best moving and resting together).
- Mixing model types trades live recall for moving and resting; no mixture beat the best single model on live pinches.
- Several best thresholds sit at the bottom of the sweep (0.5–0.6), so the sweep should go lower for these models.
- InceptionTime takes about 6 minutes a network on the M3, against 1–1.5 for the branch network, and has 80 k parameters
  against 30 k; its runtime cost is a consideration for porting.

## Next (updated)

1. Choose the phase 2 candidate: branches + warping + envelope (best live) or a branches + InceptionTime pair (best
   balance). Both need a threshold rule that works without the test set (the trainer's lands far too high for them).
2. Noise-overlay augmentation (recorded everyday wrist motion added to pinches), now possible with the raw-signal builder.
3. Peak gating in front of the chosen model.
4. More real-use sessions and everyday noise: still the largest lever, and the only way to widen the 20-pinch live test.

## Round 3 (15 Nov): peak gating, a threshold rule without the test set, noise overlay

**Peak gating** (`gate.py`): a decision may fire only if the raw accelerometer jerk reached a level in the last 600 ms.
The level is the 10th percentile of the training pinch moments (157 m/s^3). On the 3-network branches + envelope model it
removed **every** everyday false activation at every threshold from 0.9 to 0.5, and lost **no** test pinch; it passes about
13% of moments, so the network would run far less often live.

**Noise overlay** (`exp_final.py --copies 2`): each training pinch recording got two copies with wrist motion from the
training everyday-noise recordings (never the test noise) added to its raw accelerometer and gyroscope.

**Threshold rule** (`bench.choose_threshold_v2`): chosen out of fold on the training recordings only, the highest-catching
threshold with at most 5 false activations an hour on the training no-gesture recordings (unlabelled time inside pinch
recordings is not counted), gate applied.

**The honest result: each model at the threshold it chose without seeing the test set**

| Model | Threshold | Live (20) | Moving (102) | Resting (57) | Everyday FA |
|---|---|---|---|---|---|
| `ae0a22bf` (active) | 0.99 (its manifest) | 7 | 58 | 47 | 9 (14.8/h) |
| Branches + warping + envelope, 3 networks, gate | 0.998 | 10 | 69 | 39 | 0 |
| **+ noise overlay** | **0.995** | **13** | **80** | 44 | **0** |

The candidate with noise overlay catches almost twice the live pinches and 22 more moving pinches than the active model,
with no everyday false activation against 14.8 an hour; it catches 3 fewer resting pinches.

**At lower thresholds the candidate does better still:**

| Threshold | Live | Moving | Resting | Everyday FA |
|---|---|---|---|---|
| no overlay, 0.3 | 17 | 80 | 44 | 0 |
| overlay, 0.9 | 16 | 81 | 47 | 0 |
| overlay, 0.7 | 18 | 80 | 49 | 3 (4.9/h) |

**The rule is too cautious, and why.** Out of fold, the held-out no-gesture recordings fire about 11–19 times an hour at
0.9, where the test noise fires none. The training set has only 30 minutes of everyday noise in two recordings, so a fold
that holds one out trains on a third to two thirds of it, and over-estimates the false activations the full model makes.
More everyday-noise recordings would fix this directly; stratified folds that never hold out more than one everyday
recording would help a little.

**The noise overlay** improves moving (+11) and resting (+5) pinches at the chosen threshold, and live (+3); at the lowest
thresholds it raises everyday false activations (4.9/h at 0.7), since the copies teach the network that pinches come with
motion. The gate keeps that in check down to 0.9.

## Phase 2 candidate

Per-sensor branches (accelerometer with its jerk envelope, gyroscope, pulse), warping, noise-overlay augmentation, three
networks averaged, behind the 600 ms peak gate, at a threshold chosen out of fold. What porting it needs in the app: the
jerk-envelope channel and the gate in the Rust input code, the branch network in the model file and runtime, and the
overlay and threshold rule in the trainer, all as a new model type beside the current CNN.

Before porting: record more everyday noise (an hour or more) so the threshold rule stops being cautious, and another
real-use session for a second live test.
