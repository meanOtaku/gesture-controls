# Conditions and checks for a double-pinch detector

278 camera-timed pinch contacts. Each rule's threshold keeps 98% of them; the cells give the share of each activity it removes (context: of moments every 0.25 s; checks: of candidate jolts).

Minutes: everything_else recordings 2.0, fist 6.8, wrist twist 0.7, rest (pinch sessions) 0.1, thumbs up 1.4, typing 1.0, mouse 0.8, arm movement 0.8.

## Context gates (from the second before)

| Rule | Pinch median | Threshold | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| arm movement (accel RMS, m/s²) | 0.259 | > 0.619 | 20% | 6% | 40% | 0% | 1% | 29% | 27% | 88% |
| wrist turning (gyro RMS, rad/s) | 0.104 | > 1.27 | 18% | 0% | 48% | 0% | 0% | 0% | 0% | 69% |
| stillness just before (jolt, m/s²) | 0.115 | > 0.45 | 14% | 8% | 25% | 4% | 1% | 43% | 32% | 88% |
| jolts in the last 3 s | 2 | > 4 | 8% | 0% | 0% | 0% | 0% | 43% | 18% | 27% |
| rhythm (autocorrelation 0.3-1.2 s) | 0.171 | > 0.42 | 29% | 2% | 23% | 4% | 8% | 6% | 5% | 4% |
| face tilt from level (°) | 55.9 | report only | median 47 | median 48 | median 61 | median 67 | median 82 | median 38 | median 42 | median 43 |

## Checks on a candidate jolt (as large as the smallest 5% of pinches: 0.360 m/s² or more)

| Check | Pinch median | Reject when | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| size (jolt peak, m/s²) | 0.813 | > 2.31 | 5% | 9% | 0% | 0% | 0% | 2% | 4% | 88% |
| width at half height (ms) | 40 | > 140 | 4% | 1% | 39% | 0% | 0% | 1% | 0% | 2% |
| accel-gyro lag (ms, absolute) | 60 | > 240 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| gyro jolt with it (rad/s) | 0.284 | < 0.074 | 0% | 2% | 4% | 0% | 7% | 0% | 2% | 0% |
| sharpness (60 ms part / jolt) | 0.744 | < 0.411 | 24% | 5% | 89% | 75% | 13% | 3% | 6% | 26% |
| accel direction match (|cos|) | 0.874 | < 0.0537 | 3% | 3% | 0% | 0% | 20% | 6% | 2% | 5% |
| gyro direction match (|cos|) | 0.984 | < 0.58 | 5% | 21% | 0% | 0% | 33% | 19% | 50% | 26% |

## All together

Pinches kept: 91% by the context gates, 89% by the checks.

| Activity | Time the gates leave open | Candidate jolts a minute | After the checks | After checks and gates |
|---|---:|---:|---:|---:|
| everything_else recordings | 53% | 53.4 | 36.9 | 19.5 |
| fist | 88% | 31.4 | 19.5 | 17.1 |
| wrist twist | 31% | 39.7 | 1.4 | 0.4 |
| rest (pinch sessions) | 92% | 40.5 | 10.1 | 9.3 |
| thumbs up | 91% | 10.9 | 5.8 | 5.3 |
| typing | 34% | 90.0 | 68.0 | 23.0 |
| mouse | 55% | 72.0 | 30.7 | 16.9 |
| arm movement | 12% | 76.0 | 5.3 | 0.6 |

## The cue buzz

Jolt averaged over 40 guided cues: 0.061 m/s² before; highest 0.124 at 160 ms within 160 ms of the cue (the 120 ms buzz, if it shows); highest 1.230 at 320 ms (the pinch, after the reaction time).

1.4 s.
