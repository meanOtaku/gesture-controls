# CNN blind spot after wrist motion, November 2026

**Result:** the rolling-scaled CNN (`ppg_imu_cnn`) nearly stopped detecting pinches for 8–10 s after heavy wrist motion.
Scaling by the median and median absolute deviation (`ppg_imu_cnn_median`) removes this for bursts up to about 4 s, with
no loss on quiet pinches. Motion lasting 6 s or more still causes a shorter blackout of about 3–6 s after it ends.

These are replays with spliced motion. Nothing here has been measured live on the watch yet.

## Cause

Each input tick was z-scored against the 10 s ending at it. One burst inflates that standard deviation until the burst
leaves the history, from about 0.03 rad/s to, by estimate, about 1 rad/s, so a pinch looks some 30 times smaller. No training
pinch had seen this: across 229 pinch in and 230 pinch out starts, the largest 1 s gyro RMS in the 10 s before was 0.62 rad/s.
The everyday-noise recordings reach 14 rad/s at a single sample.

Ruled out: the still-hand gate was off, and the recordings show no gap over 250 ms and no contact-quality flag, even during
20 minutes of everyday noise. Injecting pulse alone changed little (pinch in 93% to 87–89%, pinch out unchanged), so the
motion channels carry the effect. The pulse injection does not model a lasting strap-pressure shift.

## Method

Models retrained with the same split, seed and settings as the active versions (`run-6cf09be4a7`, `run-8b5d89b90f`), research
checks off. 55 held-out pinches per label (recordings the models did not train on), with a real burst from the held-out
everyday-noise recording spliced into both streams before each one. A pinch counts when the peak score from 0.1 to 1 s after
its labelled start reaches the threshold. This is a window check, so its rates run higher than the event replay's recall below.

## Pinches detected, by seconds between the burst ending and the pinch

Each model is at its own trained threshold: rolling 0.9 (in) and 0.35 (out), median 0.96 (in) and 0.97 (out).

| Burst | Pinch in, rolling | Pinch in, median | Pinch out, rolling | Pinch out, median |
|---|---|---|---|---|
| None | 92% | 92% | 98% | 98% |
| 1–2 rad/s, 2 s, 1 s after | 31% | 89% | 44% | 96% |
| 3–6 rad/s, 2 s, 1 s after | 0% | 93% | 5% | 98% |
| 3–6 rad/s, 2 s, 6 s after | 0% | 93% | 7% | 98% |
| 2.5–6 rad/s, 4 s, 1 s after | 0% | 87% | 4% | 89% |
| 2–6 rad/s, 6 s, 1 s after | 0% | 58% | 6% | 28% |
| 2–6 rad/s, 8 s, 1 s after | 0% | 16% | 0% | 4% |
| 2–6 rad/s, 8 s, 6 s after | 18% | 84% | 25% | 94% |

Past half of the history the median follows the motion, which is the remaining limit. It is closed by leaving fast turning
out of the scaling (below).

## Event replay on held-out recordings

| | Threshold | Recall | False activations/hour | Median latency |
|---|---|---|---|---|
| Pinch in, rolling | 0.90 | 48/57 (84%) | 4.1 | 439 ms |
| Pinch in, median | 0.96 | 50/57 (88%) | 4.1 | 491 ms |
| Pinch out, rolling | 0.35 | 54/59 (92%) | 26.3 | 445 ms |
| Pinch out, median | 0.97 | 49/59 (83%) | 0 | 426 ms |

Pinch out traded recall for false activations because its threshold came out much higher. The held-out sets are small, so
differences of a few pinches are not significant. Cross-check recall on the training recordings fell (pinch in 86% to 81%, pinch
out 84% to 77%) at similar false-activation rates, so watch recall on quiet pinches in live use.

## Runtime

Building one decision's inputs takes 31 µs with median scaling and 28 µs with rolling scaling (Apple silicon, release build).

## Leaving fast turning out of the scaling, 9 November 2026

**Result:** the median scaling now leaves out the ticks where the wrist was turning fast. That removes the remaining blackout
after long motion: the live pinch-in model catches 40–46 of 50 pinches from 0.5 s after 6–10 s of heavy motion, against 0–19
of 50 before. On a still hand nothing is left out, so the inputs are unchanged; the live models need no retraining, and their
event replays are identical. These are replays with spliced motion, not live measurements.

**Rule** (`cnn_input.moving_ticks`, mirrored in `crates/pinch-inference/src/cnn_input.rs`): a grid tick is moving when the
gyroscope's RMS magnitude over the 0.3 s (15 ticks) ending at it is above 1.0 rad/s. It and every tick within 0.5 s (25 ticks)
of a moving tick are left out of the median and the median absolute deviation, for all nine channels. The last second, which
the model sees, is never left out. The remaining ticks' median is the mean of the middle two when there is an even number.

**Method.** Live pinch-in model `pinch_in-ae0a22bf` at its 0.99 threshold, the 50 pinch-in starts of its three evaluation pinch
recordings with 25 s before them, and the three most intense non-overlapping segments of the held-out everyday-noise recording
(11-04T04-27, mean gyroscope 1.7–3.2 rad/s) spliced into both streams (pulse level-matched), ending a gap before each start. A
pinch counts when the peak score 0.1–1 s after its start reaches the threshold.

| Motion before the pinch | Before (median of all ticks) | After (fast turning left out) |
|---|---|---|
| None | 43/50 | 43/50 |
| 2 or 4 s, any gap 0.5–8 s | 41–44/50 | 41–45/50 |
| 6 s, 0.5 / 1 / 2 / 3 / 5 s before | 8 / 11 / 14 / 19 / 30 | 40 / 41 / 42 / 45 / 44 |
| 8 s, 0.5–3 s before; 5 s before | 0; 31 | 40–45; 44 |
| 10 s, 0.5–3 s before; 5 s before | 0; 27 | 43–46; 46 |

**Event replay** (the trainer's detection and accounting, still-hand rule off as in the app):

| | Before | After |
|---|---|---|
| Pinch in, 8 evaluation recordings | 47/57, 0 false, 442 ms | 47/57, 0 false, 442 ms |
| Pinch out (`pinch_out-4ba930b3`), 8 evaluation recordings | 49/59, 0 false, 425 ms | 49/59, 0 false, 425 ms |
| Pinch in, training everyday noise (11-03T03-44, 10 min) | 0 false, peak 0.846 | 0 false, peak 0.981 |

**The cost:** during everyday motion the scale now comes from the calmer moments, so movement looks larger. On the training
noise session the highest score rose to 0.981 against the 0.99 threshold; the held-out noise session's stayed at 0.970. Watch
false activations in live use.

**Thresholds tried:** 0.5 rad/s, and using only the ticks since the motion last stopped, each caused one or two false
activations on the training noise session. 2.0 rad/s recovered only 25–31 of 50 just after 10 s of motion. 1.0 rad/s was the
best of these. Only pinch in was spliced; pinch out was checked by event replay only.
