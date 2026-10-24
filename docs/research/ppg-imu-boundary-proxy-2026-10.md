# Pinch boundaries with PPG and IMU: proxy evaluation, October 2026

**Status:** research only. This evaluates the current recordings' generic `pinch` label boundaries, not independently observed physical contact or release. It does not establish a deployable pinch state machine or a force/intensity measure.

## Question

Can the watch IMU identify when a pinch starts and stops while PPG describes the held pinch?

The data contains no force, pinch-intensity, or hold-power labels. Therefore only the boundary part can be tested. PPG cannot be claimed to estimate force from this study.

## Method

The analysis used the repository's existing October study recordings and loader. `pinching` was normalized to `pinch`; same-label stretches separated by less than 400 ms were merged and holds shorter than 200 ms were discarded.

For each retained pinch hold:

- A **start proxy** was the marked hold start.
- An **end proxy** was the marked hold end.
- A **stable-hold control** was sampled at least 1.5 s from either boundary inside the same labelled pinch hold.
- Features at each proxy/control used only samples from the decision time through the next 900 ms. This is causal with a 900 ms decision delay.
- PPG features were causal two-second median/MAD-normalized green, red, and IR summary features.
- IMU features were accelerometer and gyroscope magnitude mean, spread, maximum, step magnitude, and recent-to-baseline spread ratio.
- An ExtraTrees classifier was evaluated leave-one-recording-out. Recordings without sufficient stable-hold controls could not be evaluated.

This is an exploratory proxy benchmark. Feature/model selection and scoring use the same dataset, so it is not an untouched test.

## Result

Seven recordings had enough valid stable-hold controls: 143 evaluation rows, comprising 62 controls and the relevant marked boundaries.

| Target versus stable labelled hold | PPG AUC | IMU AUC | PPG + IMU AUC |
|---|---:|---:|---:|
| Marked pinch start | 0.798 | 0.835 | **0.865** |
| Marked pinch end | 0.795 | 0.793 | **0.870** |

The IMU was stronger than PPG for the **start** proxy. Neither modality alone clearly dominated at the **end** proxy, but fusion was stronger for both. This supports a combined boundary detector, not an IMU-only start/stop detector.

The preceding 37-recording onset benchmark independently found the same general direction: IMU separated pinch starts from other gesture starts better than PPG (0.807 versus 0.695 AUC), while PPG+IMU was strongest overall. Its full protocol and continuous false-activation results are in [PPG + IMU fusion, trigger rules and label shifts](ppg-imu-fusion-and-triggers-2026-10.md).

## Interpretation and decision

Use a fused boundary probability for both entry and release candidates:

`IDLE → candidate onset → PINCHED → candidate release → IDLE`

A held pinch should not require persistent IMU movement: a static hold can have little motion. It needs hysteresis and a separately trained release rule rather than treating low motion as release.

Do not expose a `strength`, `hold power`, or other force value from PPG. Wrist PPG varies with strap fit, contact pressure, posture, perfusion, and arm motion; this dataset supplies no target against which to validate such a value.

## Required next evidence

1. Capture camera-timed start and release labels, including static holds, fist/open-close, wrist rotation, arm swing, watch adjustment, and ordinary movement.
2. Freeze the selected boundary pipeline and test it on a later, untouched recording day.
3. To test force, record light/normal/firm pinches against a calibrated force reference for a subset. Split by recording/session and assess unseen-day calibration before presenting a force-like output.
