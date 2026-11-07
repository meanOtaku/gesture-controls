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

Past half of the history the median follows the motion, which is the remaining limit.

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
