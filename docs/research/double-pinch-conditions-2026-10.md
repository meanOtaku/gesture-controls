# Double pinch: the conditions it works in, and the rules around the model

The double pinch is detected mainly from the watch's motion sensors, with the pulse sensor only as a reference. A model
cannot be expected to find a pinch anywhere and anyhow: while the arm swings, the wrist turns, or the hand types, the
small jolt of a thumb meeting a finger is buried, and similar jolts come from everything else. So the detector works
only inside a stated **envelope** and abstains outside it, and a candidate must pass **checks** before the model's score
counts. This document lists those conditions and rules, with the evidence for each.

It follows the app's fail-closed rule ([Safety and fail-closed behavior](../architecture/safety-and-fail-closed-behavior.md)):
whenever a condition is not met, the detector does nothing, and any half-seen double pinch is forgotten.

Evidence comes from the studies in [`artifacts/double-pinch-2026-10/`](artifacts/double-pinch-2026-10/README.md):

* **Measured**: `filter_check.py` → [`filter/results.md`](artifacts/double-pinch-2026-10/filter/results.md) (the
  high-pass filter, C0), `stability_check.py` → [`stability/results.md`](artifacts/double-pinch-2026-10/stability/results.md)
  (the steadiness rule, B0), and `conditions_check.py` → [`conditions/results.md`](artifacts/double-pinch-2026-10/conditions/results.md). It
  uses 278 camera-timed pinch contacts and the everyday activities in the repository's recordings. Each threshold keeps
  98% of pinches; the evidence is how much of each activity it removes.
* **Earlier steps**: the jolt study (step 1), the arm-pose study (step 2b) and the model comparison (step 3).
* **Untested**: no data yet. The double-pinch timing rules need the double-pinch recordings.

All recordings so far are one person, left wrist, at 50 Hz. Thresholds below are starting values to re-measure at
100 Hz on the double-pinch sessions, not final numbers.

## How the rules fit together

```text
watch data ─► A. data preconditions ─► B. context gates ─► C. candidate checks ─► model score per contact
                 (fail → abstain)        (fail → abstain)     (fail → not a contact)          │
                                                                                               ▼
                                     E. after a detection ◄── D. double-pinch pattern rules ◄──┘
```

Measured on the existing data, the gates and checks together keep about 80% of single pinches (91% through the gates,
89% through the checks). They cut candidate jolts a minute as follows:

| Activity | Candidate jolts a minute | After gates and checks | Time the gates leave open |
|---|---:|---:|---:|
| Arm movement (reach, scratch) | 76 | 0.6 | 12% |
| Wrist twist | 40 | 0.4 | 31% |
| Typing | 90 | 23 | 34% |
| Mouse | 72 | 17 | 55% |
| everything_else recordings | 53 | 20 | 53% |
| Fist | 31 | 17 | 88% |
| Thumbs up | 11 | 5 | 91% |

So the rules remove most arm movement and twisting, and about three quarters of the typing and mouse jolts. They do
not finish the job: tens of candidates a minute remain in typing and mouse use. The double-pinch pattern rules (D) and
the learned model must do the rest. The rules make the model's problem smaller; they do not replace it.

## A. Data preconditions (fail closed)

The detector abstains unless the data is whole and current.

| # | Rule | Starting value | Why | Evidence |
|---|---|---|---|---|
| A1 | The watch is on the wrist | Pulse sensor shows skin contact (contact quality and a steady pulse); the watch's off-body sensor, if it has one | Off the wrist, jolts mean nothing. This is the pulse sensor's role as the reference | Untested; `contact_quality` is already recorded |
| A2 | No gap in the motion stream | No gap over 60 ms in the last 1.5 s | Gaps make false edges, and the model's window must be whole | Gap handling already in the studies; drops counted by the watch stats |
| A3 | The rate is what the model was trained on | Achieved rate within ±10% of the trained rate (100 Hz) | A model trained at one rate misreads another | Achieved Hz is reported by the Watch power card |
| A4 | Timestamps in order, low jitter | Monotonic; jitter p95 under one sample period | Shapes and intervals depend on time | The ordering watermark in the decision chain |
| A5 | Data is current | Act only on data that arrives within 300 ms of being measured | A late detection is a wrong action | Delay p95 measured at 98 ms |
| A6 | Warm-up done | At least 10 s of continuous data since connect | Rules B and C use the recent 10 s level | Untested |
| A7 | No sensor at its range limit | No axis at its full-scale value in the window | A clipped jolt has the wrong shape | Untested |
| A8 | Orientation is valid | Rotation vector quaternion of length about 1 | Rules B6 and F2 read it | Rows with a bad quaternion are dropped in the studies |

## B. Context gates: when not to detect at all

### The main rule: detect only inside steady motion

The detector is off by default and turns on only while the motion sensors are steady. A pinch is then the one short
jolt inside that steadiness. This is a positive rule: it does not try to list every kind of motion that muddies the
data (B1-B5 below are examples of such a list). It asks for the one condition in which a pinch is clear.

"Steady" means all three of the following hold over a window. None of them depends on how the arm is posed:

| Measure | What it is | Pinches, second before (median) |
|---|---|---:|
| Acceleration spread | Spread of the linear acceleration about its own mean (each axis's standard deviation, as one magnitude) | 0.22 m/s² |
| Turning | Gyroscope RMS | 0.09 rad/s |
| Tilt change | How far "up" moved in the watch's axes across the window | 1.1° |

The rule has two halves:

* **Steady before (B0a):** steady from 1.0 s to 0.1 s before the first contact.
* **Settles after (B0b):** steady again after the second release. A pinch in the middle of a movement is not accepted,
  even if the movement paused for it.

Measured by `stability_check.py` → [`stability/results.md`](artifacts/double-pinch-2026-10/stability/results.md). It
uses 266 camera-timed pinches with a release, and checks the activities every 0.25 s. "Open" is the share of moments
whose previous second is steady. "Both sides" adds the requirement that the motion is steady again 0.9-1.8 s later:

| Limits (spread m/s², turning rad/s, tilt °) | Pinches steady before | Pinches steady on both sides | Arm movement open / both sides | Wrist twist | Typing | Mouse | Rest between pinches (arm repositioned) |
|---|---:|---:|---|---|---|---|---|
| Strict: 0.3, 0.3, 5 | 63% | 48% | 10% / 5% | 37% / 3% | 8% / 2% | 39% / 27% | 38% / 0% |
| **Start here: 0.4, 0.5, 10** | 77% | 64% | 11% / 7% | 44% / 8% | 27% / 12% | 55% / 42% | 46% / 4% |
| Loose: 0.54, 1.1, 28 (95% of pinch windows) | 93% | 85% | 13% / 8% | 51% / 9% | 61% / 37% | 68% / 53% | 75% / 42% |

What this shows:

* **Requiring steadiness on both sides is what removes movement.** With the starting limits, only 7% of arm movement,
  8% of twisting and 4% of the arm repositioning between pinches stay open. Steadiness only before leaves 11-46%,
  because a movement often starts from a pause.
* **Acceleration spread is what separates typing.** At 0.4 m/s², typing is open 27% of the time (12% on both sides). At
  0.6 m/s², it is open 72% of the time.
* **Steadiness does not separate a pinch from other still-hand motion.** Mouse use, fists and thumbs-ups are steady
  too (thumbs up: open 99% of the time). The candidate checks (C) and the model must reject those. Steadiness is the
  condition for looking, not the evidence of a pinch.
* **The cost:** in these recordings, a third of pinches were made while the hand was not steady. The arm was still
  settling from the last pinch, or the hand was mid-movement. Nobody was asked to hold still, so a user who knows the
  rule should do better. The double-pinch sessions should measure this with the instruction given.
* **The tension with speed:** the full "settles after" half needs about a second after the release before the
  detection can fire, which breaks D7 (decide within 400 ms). Two ways out: check only a short 0.3 s window after the
  second release, or act at once and require steadiness before only. Measure both on the double-pinch sessions.

B0 replaces B1-B3 as the main gate. B1-B3 stay below as single measures of the same thing, with their own figures.

### Other gates

Each is computed from the second before the moment.

| # | Rule | Starting value | What it removes (keeping 98% of pinches) | Evidence |
|---|---|---|---|---|
| B0 | **Not steady** (the main rule above) | Over 1.0-0.1 s before the first contact, and again after the second release: acceleration spread at most 0.4 m/s², turning at most 0.5 rad/s, tilt change at most 10° | With steadiness on both sides: 93% of arm movement, 92% of twisting, 88% of typing, 58% of mouse; keeps 64% of these pinches | Measured (`stability_check.py`) |
| B1 | **The arm is moving** (high acceleration muddies the data) | Linear acceleration RMS over the last 1 s above 0.62 m/s² (pinches: median 0.26) | 88% of arm movement, 40% of wrist twists, 29% of typing, 27% of mouse, 20% of everything_else | Measured |
| B2 | **The wrist is turning** | Gyroscope RMS over the last 1 s above 1.27 rad/s (pinches: 0.10) | 69% of arm movement, 48% of twists; no typing or mouse | Measured. Turning also leaks gravity into the linear acceleration |
| B3 | **The hand was not still just before** | Jolt over the last 0.5 s above 0.45 m/s² (pinches: 0.12) | 88% of arm movement, 43% of typing, 32% of mouse | Measured. It overlaps B1; keep whichever does better at 100 Hz |
| B4 | **Too many jolts recently** (typing, tapping) | More than 4 jolts in the last 3 s | 43% of typing, 27% of arm movement, 18% of mouse | Measured |
| B5 | **Rhythmic motion** (walking, running, typing rhythm) | Autocorrelation of acceleration at 0.3-1.2 s lags above 0.42; or the watch's step detector fired in the last 2 s | 29% of everything_else; little else in this data | Measured only partly: there is no walking in the data yet |
| B6 | **Pose envelope** | Report only for now (pinches: face tilted a median 56° from level) | – | Step 2b: pose differences followed sessions, not poses. Not a gate until the double-pinch sessions vary pose within a session |
| B7 | **The watch itself is vibrating** | Block from the start of any vibration (cue buzz, the confirmation pulse, notifications) to 300 ms after it ends | The app's own buzz must never start a detection, and its confirmation pulse must not start the next one | Measured at 50 Hz: the 120 ms cue buzz barely shows (0.12 m/s² against a pinch's 1.2 m/s²). Re-check at 100 Hz, which sees more of the motor's frequency |
| B8 | **Something is touching the watch** | Block while the screen is touched or a button pressed (when the app can see it) | Tapping the watch with the other hand makes the same jolt | Untested; visible only while the watch app is in front |
| B9 | **A vibrating environment** (car, train, power tools) | Covered by B1 and B3 (high level of quick motion); a separate noise-floor check if those miss it | – | Untested |
| B10 | **Charging or not worn** | Off | – | The watch stats report charging |

## C. Checks on a candidate jolt

### First, a high-pass filter on the shake

A pinch contact is short and sharp. Arm movement, turning, and gravity leaking into the linear acceleration are slow.
So the "shake" that the checks and the model read is the motion after a causal high-pass filter. The steadiness rule
(B0) still reads the unfiltered motion, because slow motion is exactly what it measures.

`filter_check.py` → [`filter/results.md`](artifacts/double-pinch-2026-10/filter/results.md) compares the studies'
earlier filter with others. The earlier filter subtracts each axis's trailing 0.3 s mean. The others are the first
difference and Butterworth high-pass filters (order 2 and 4, 1-16 Hz). The threshold keeps 95% of pinch peaks.

**Where a pinch's energy lies.** Against most activities, the pinch's share of power rises with frequency, all the way
to 25 Hz, the highest frequency 50 Hz sampling can see:

| Pinch power ÷ activity power | 0-2 Hz | 5-10 Hz | 15-25 Hz |
|---|---:|---:|---:|
| Wrist twist | 0.3 | 16 | 313 |
| Thumbs up | 6 | 33 | 373 |
| everything_else recordings | 0.4 | 1.4 | 4.6 |
| Typing | 0.7 | 0.6 | 1.9 |
| Mouse | 0.7 | 0.8 | 3.3 |
| Arm movement | 0.01 | 0.02 | 0.06 |

**Candidate jolts a minute on the accelerometer, at the same 95% of pinches kept:**

| Filter | Pinch over the floor before it | Wrist twist | Thumbs up | Fist | everything_else | Typing | Mouse | Arm movement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Trailing 0.3 s mean (until now) | 5.9× | 40 | 11 | 31 | 53 | 90 | 72 | 76 |
| **Butterworth order 2, 8 Hz** | 7.4× | 4.3 | 2.9 | 26 | 46 | 89 | 73 | 77 |
| Butterworth order 2, 12 Hz | 7.3× | 2.8 | 0.7 | 24 | 44 | 93 | 69 | 77 |

What this shows:

* **The filter separates slow motion from a pinch.** It cuts wrist-twist candidates about tenfold and thumbs-up
  candidates about fourfold. A pinch stands further out of the motion just before it (7.4× against 5.9×).
* **It does not separate typing, mouse use or arm movement.** Typing and clicking are taps, which shake the wrist in
  the same band as a pinch. Arm movement carries more power than a pinch at every frequency. The steadiness rule (B0),
  the checks below, the pattern rules (D) and the model must handle those.
* **The pinch's energy runs past 25 Hz.** At 100 Hz the watch sees up to 50 Hz, where the filter should separate
  better. This is one more reason to record at 100 Hz (G1). Re-run `filter_check.py` on those recordings.

| # | Rule | Starting value | Evidence |
|---|---|---|---|
| C0 | **High-pass the shake** | Butterworth order 2 at 8 Hz, causal, on every accelerometer and gyroscope axis, to find candidate spikes and for the checks. Not for the model: the CNN does better on each axis z-scored over its trailing 10 s and put through a sigmoid, without the high-pass (step 8: 42% of contacts found on a held-out day, against 33% with the high-pass and 24% raw). At 50 Hz, 12 Hz does about as well; at 100 Hz, try 8-20 Hz. One biquad per axis: cheap on the watch or the desktop | Measured (`filter_check.py`). Small samples: a minute or less of twist, typing, mouse and arm movement |

### The checks

A jolt counts as a possible contact only if it passes these. "Candidates" are jolt peaks at least as large as the smallest
5% of pinches (0.36 m/s²).

| # | Check | Starting value | What it rejects (keeping 98% of pinches) | Evidence |
|---|---|---|---|---|
| C1 | **Not too large** (knocks, impacts, claps) | Jolt peak above 2.3 m/s² (pinches: median 0.81) | 88% of arm-movement jolts, 9% of fist jolts | Measured |
| C2 | **Short** | Width at half height above 140 ms (pinches: 40 ms) | 39% of twist jolts | Measured |
| C3 | **Sharp** | The 60 ms quick part under 0.41 of the jolt (pinches: 0.74) | 89% of twist jolts, 75% of jolts at rest, 26% of arm movement, 24% of everything_else | Measured |
| C4 | **Turns about the pinch's axis** | Gyroscope jolt direction within 0.58 (abs cos) of the pinches' main axis (pinches: median 0.98) | 50% of mouse, 33% of thumbs up, 26% of arm movement, 21% of fist, 19% of typing jolts | Measured. Pinches turn the wrist about one consistent axis. The axis is in the watch's frame, so it holds in any pose, but must be mirrored for the right wrist (F2) |
| C5 | Accelerometer direction | Too spread to use (pinches: median 0.87 but a long tail) | – | Measured: weak; not used |
| C6 | Accelerometer and gyroscope peak together | No use at 50 Hz: nothing rejected | – | Measured; re-check at 100 Hz |
| C7 | **Large for the moment** | Jolt over its recent 10 s level, not a fixed size | Adapts to strap, session and person | Step 3: this scaling made the plain jolt score 0.99 AUC on the guided session; sessions differ more than poses (step 2b) |

## D. Double-pinch pattern rules

None of these can be measured until double pinches are recorded. The values are starting points from double-click
timing, to be replaced by the measured distribution.

| # | Rule | Starting value |
|---|---|---|
| D1 | Two contacts close together | Second contact 150-600 ms after the first |
| D2 | The right number of jolts | Contact, release, contact, release: 3 or 4 jolts in at most 1.0 s. Five or more is tapping or typing |
| D3 | Quiet around it | No jolt in the 0.5 s before the first contact or in the 0.3 s after the second release. Alone this barely helped (step 2a), but it costs little |
| D4 | The two contacts match | Sizes within ×3 of each other; gyroscope directions within 0.7 (abs cos) of each other |
| D5 | Each contact passes C and the model | Both contacts score above the model's threshold, or a sequence model over 1.5 s scores the whole pattern |
| D6 | Not a hold | The fingers release within 400 ms of each contact; a longer hold is a single pinch or another gesture |
| D7 | Decide quickly | Decide by the second release, at most 400 ms after the second contact |

## E. After a detection

| # | Rule | Starting value |
|---|---|---|
| E1 | Refractory time | No new detection for 1.0 s, which also covers the confirmation pulse (B7) |
| E2 | Rate limit | If more than 3 detections come within 10 s, something is wrong (activity, not intent): pause for 5 s |
| E3 | Fail closed | Any failed precondition (A) or gate (B) clears a half-seen pattern |

## F. Person and session

| # | Rule | Why | Evidence |
|---|---|---|---|
| F1 | Detect only when the gesture mode is Live | The user decides when gestures act | The app's gesture policy (Off / Monitor / Live) |
| F2 | Mirror the axes for the right wrist | C4 and the model's shapes are in the watch's frame; the session details record the wrist | All data so far is the left wrist |
| F3 | Scale to the recent motion level | Sessions differ in strap and pinch force more than in pose | Step 2b; step 3 (a new day: 64% → 27%). Step 8: z-scoring each axis over its trailing 10 s, then a sigmoid, raised the spike CNN on a held-out day from 24% to 42% |
| F4 | A short calibration | Five double pinches at the start set the person's size and interval for C7, D1 and D4 | Session-to-session difference is the biggest failure (step 3); the weak 11 October sessions defeated every model |
| F5 | A firm, consistent strap | A loose strap damps the jolt | Session details record the strap; untested |

## G. Constraints on the training data

| # | Rule | Why |
|---|---|---|
| G1 | 100 Hz on all motion sensors, achieved rate checked | Pinch jolts are 40 ms wide: two samples at 50 Hz. 100 Hz is the most the watch gives an app (see below) |
| G2 | Camera on, watch hand in view | Labels trail the gesture by reaction time; the camera gives the contact to about 0.1 s |
| G3 | Many sessions on different days | A new session is where every model fails (step 3) |
| G4 | Vary pose within a session (flat, hanging, raised) | The only way to measure a pose effect (step 2b) |
| G5 | Label the everyday stretches (set the everyday label) | The 31 October activities were recorded unlabelled and had to be timed from the plan |
| G6 | Everyday activities include walking, phone use, knocking and clapping | Walking (B5) and impacts (C1) are untested |
| G7 | Hard negatives: single pinches, long pinches, finger snaps, thumb rubbing, double taps on the desk, fists | These are what the pattern rules must reject |
| G8 | Record wrist, strap, arm and activity in the session details | Needed for F2, F5 and per-condition results |
| G9 | Leave out recordings with data hazards (gaps, wrong rate) | A6 to A8 apply to training data too |
| G10 | Keep the cue buzz in mind | It lands about 0.3 s before each cued pinch; a model must not learn it. Weak at 50 Hz; re-check at 100 Hz |

## The watch's limits, and what published systems did

### The watch gives apps at most 100 Hz

Read with `adb shell dumpsys sensorservice` on the Galaxy Watch4 (SM-R860, Android 16) on 2026-11-01:

| Sensor | Highest rate offered to apps | Delivered to the app |
|---|---:|---:|
| Accelerometer (LSM6DSV) | 100 Hz | not used |
| Gyroscope (LSM6DSO) | 100 Hz | every 10.0 ms |
| Linear acceleration | 100 Hz | every 10.0 ms |
| Rotation vector | 100 Hz | every 10.0 ms |
| Raw heart-rate (PPG), `com.samsung.sensor.hr_raw` | 25 Hz | not used |

Every continuous motion sensor reports the same 100 Hz ceiling, and the app already receives 100 Hz without gaps.
Faster data exists inside the watch, but apps cannot reach it:

* The sensor hub runs the gyroscope at about 200 Hz for its own orientation fusion.
* Samsung's 32G accelerometer and its 100 Hz raw heart-rate channels need a Samsung system permission.
* The 4000 Hz route of the papers below needs a modified kernel, meaning a rooted watch.

So the detector is designed for 100 Hz. A pinch contact is about four samples wide.

### What published systems did

| Work | Rate | Pipeline | Result | How it was measured |
|---|---:|---|---|---|
| Tsunoda et al., MUM 2024 | 4000 Hz (modified kernel) | 15 Hz high-pass → threshold detector → window centred on the spike → model pretrained without labels on 2 h of everyday data → linear SVM per user | 94.7% for 4 gestures on unseen people | Accuracy on detected gestures. Accuracy fell gradually down to 200 Hz, then sharply below it |
| ViWatch, UIST 2023 | 100 Hz | Energy threshold → 0.5 s window → 20 Hz high-pass → z-score → spikes aligned → 5-block CNN → adaptation to each new user from unlabelled data | About 97% over a week; 45% on an unseen person without the adaptation | On performed gestures. False positives in daily life not measured; detection runs only after an unlock and an activation gesture |
| Kim et al., CHI 2025 | 100 Hz | Fixed threshold on the 15 Hz high-passed signal | 95% of pinches | 800 deliberate pinches from 4 pilot users, inside a task |
| Apple Watch Double Tap | not published | Accelerometer, gyroscope and the optical heart sensor, into an on-device model | A shipping product | Works only with the screen on, and best with the hand raised |
| OpenWatch, 2026 | not checked | Filterbank features of IMU and PPG into a mixture of experts, 50 people | F1 90% on unseen people; PPG added 12.5 points | Gesture clips, not continuous use |

Three lessons for this design:

* **The rate route is closed, so ViWatch is the closest model.** It used the same rate and nearly the same pipeline as
  steps 7 and 8 (spike-centred window, z-score, CNN). The adaptation to each new user is what took it from 45% to
  about 97%. That matches the main failure here: a new day (14-42% in step 8). Calibration (F4), or unlabelled
  adaptation, is the most promising next step.
* **The pulse sensor belongs in the model, not only in the preconditions.** Apple fuses it, and OpenWatch measured a
  12.5-point gain. On this watch, the raw stream available to apps is 25 Hz.
* **The published figures measure an easier task.** Most are accuracy on gestures made on request and already cut out
  of the stream. Here the measure is pinches found at a fixed rate of false alarms over continuous recordings that
  include typing and mouse use. Report a gesture-accuracy figure alongside, so the two can be compared.

Sources: [Tsunoda et al. 2024](https://www.iplab.cs.tsukuba.ac.jp/paper/international/tsunoda_MUM2024.pdf),
[ViWatch](https://www.cs.virginia.edu/~stankovic/psfiles/ViWatch_UIST_%20FINAL.pdf),
[Kim et al. 2025](https://arxiv.org/pdf/2503.02308),
[OpenWatch](https://arxiv.org/html/2605.04791),
[ViBand](https://www.robertxiao.ca/research/viband/),
[Apple Watch Double Tap coverage](https://ktvz.com/money/cnn-business-consumer/2023/09/20/apple-watchs-new-gesture-control-feature-will-have-everyone-tapping-the-air/).

## H. Not handled (known limits)

* A pinch while holding something (pen, cup, phone): the contact is damped or absent.
* Other people: every recording is one person.
* Tremor, cold hands and fatigue.
* Gestures made during walking: B5 turns detection off, by design.
* Deliberate double pinches faster than 150 ms or slower than 600 ms, until calibration (F4) sets the range.

## What to do next

1. Record the double-pinch guided sessions under G1-G8, on two or more days, with the instruction to hold the hand still
   before and after each double pinch (B0). Then measure how many double pinches meet B0.
2. From them, measure D1-D7 and re-measure every threshold in B and C at 100 Hz.
3. Add the adaptation ViWatch used: a short calibration (F4), or adaptation to each new session from its unlabelled
   data. Then add the 25 Hz raw PPG stream as a model input, and score both against step 8 on a held-out day.
4. Build the rule layer in front of the model: A, then B0 (steadiness), B4 and B7, then the C0 filter, C1, C3, C4 and C7. Score the model with the
   layer on and off, as contacts found at a false-alarm rate (step 3's measure) and as double pinches found per false
   double pinch an hour.
5. Add F3 and F4 to the model's inputs, then re-run step 3 holding out a whole day.
