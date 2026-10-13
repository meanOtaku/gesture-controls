# PPG pinch onset: the open questions, tested on the current recordings (October 2026)

**Status:** research only. This tests, as far as the 2026-10 recordings allow, the gaps left by the earlier studies:
[ppg-step-findings-2026-10.md](ppg-step-findings-2026-10.md),
[ppg-green-onset-experiments-2026-10.md](ppg-green-onset-experiments-2026-10.md) and
[ppg-rgb-onset-follow-up-2026-10.md](ppg-rgb-onset-follow-up-2026-10.md). Script:
[scripts/followup_checks.py](ppg-step-study/scripts/followup_checks.py); full output:
[scripts/followup-report.txt](ppg-step-study/scripts/followup-report.txt).

**Short answer.** The PPG step is a real onset cue that is not explained by wrist motion, but on its own it is **weak,
slow and not specific to pinch**:

- Fist and thumbs-up starts look much like pinch starts.
- The decision needs about 700 ms after the start; at 300 ms there is nothing.
- One recording day does not carry over to another.
- As a continuous detector it finds few pinches while firing several times a minute.

It is not usable alone. The next step is clean data, not more tuning.

## Setup

- **Recordings:** the 17 usable recordings (10 pinch, 5 fist, 2 thumbs-up).
- **Signal:** the step of each channel in units of its recent past (median and spread of the previous 2 s).
- **Model:** standardised logistic regression. Each recording is scored by a model trained on all the others, and the
  scores are pooled.
- **95% intervals:** from resampling whole recordings.

The moments compared:

| Moment | Count | What it is |
|---|---:|---|
| pinch start | 145 | marked pinch starts |
| mid-pinch | 105 | inside a hold, at least 1.5 s from its start and end |
| unmarked time ("rest") | 84 | outside every mark, at least 1.5 s from any start or end; blank labels, not explicit rest |
| fist / thumbs-up start | 92 | other hand gestures starting |
| fist / thumbs-up mid | 83 | inside those gestures |

## Results

### 1, 3, 6. Against each kind of moment, by decision delay

The step uses the signal from 400 to 100 ms before the start and from the 400 ms before the decision.

| Pinch start against | Decide at +300 ms | +500 ms | +700 ms | +900 ms |
|---|---|---|---|---|
| mid-pinch | 0.47 [0.40–0.56] | 0.63 [0.53–0.75] | 0.66 [0.55–0.79] | 0.68 [0.56–0.81] |
| unmarked time | 0.18 [0.07–0.37] | 0.55 [0.45–0.70] | 0.71 [0.58–0.86] | 0.74 [0.60–0.91] |
| fist / thumbs-up starts | 0.60 [0.37–0.85] | 0.64 [0.42–0.91] | 0.64 [0.44–0.89] | 0.65 [0.45–0.86] |
| fist / thumbs-up mid | 0.60 [0.45–0.74] | 0.78 [0.67–0.89] | 0.87 [0.78–0.95] | 0.88 [0.78–0.97] |
| all non-start moments | 0.62 [0.55–0.71] | 0.73 [0.66–0.81] | 0.77 [0.70–0.85] | 0.78 [0.70–0.87] |

- **Delay:**
  - At +300 ms there is no usable step.
  - Separation builds up to about +700 ms and barely improves after that.
  - The unmarked-time column at +300 ms (0.18) rests on 84 moments from few recordings and is not interpretable.
- **Specificity:** pinch starts are told from other gestures' *starts* only at about 0.65, with intervals reaching chance.
  The step marks "a hand gesture began", not "a pinch began".
- **Uncertainty:** the intervals are 0.2–0.4 wide. Earlier differences of 0.01 between methods are far inside them.
- **Pooled vs per session:** against mid-pinch the pooled score is 0.68, against a median of 0.94 judged session by
  session (correction in the step findings). The step's *scale* still varies between sessions, so one threshold suits
  some sessions much better than others.

### 4. Not explained by wrist motion

| Pinch start against | PPG only | Motion only | PPG + motion |
|---|---|---|---|
| mid-pinch | 0.68 [0.56–0.80] | 0.40 [0.22–0.59] | 0.65 [0.54–0.78] |
| unmarked time | 0.74 [0.60–0.90] | 0.51 [0.19–0.74] | 0.67 [0.28–0.96] |
| fist / thumbs-up starts | 0.65 [0.47–0.84] | 0.69 [0.55–0.82] | 0.75 [0.63–0.87] |
| fist / thumbs-up mid | 0.88 [0.78–0.97] | 0.33 [0.06–0.60] | 0.76 [0.42–0.98] |
| all non-start moments | 0.78 [0.70–0.87] | 0.12 [0.05–0.22] | 0.74 [0.64–0.84] |

- **Calm pinches score higher.** On the calmest half of pinch starts (least change in the gyroscope), the PPG score is
  0.82 [0.74–0.91]; on the busiest half, 0.74 [0.64–0.84].
- **No relation to movement.** The green step and the gyroscope change are unrelated across pinch starts (Spearman
  ρ = −0.03, p = 0.74, n = 143).
- **A pinch barely turns the wrist.** The gyroscope showed movement at only 44 of 145 pinch starts.

So the PPG step is not wrist motion appearing in the PPG.

The motion-only model scores *below* chance against several kinds of moment (as low as 0.12). A model that is
consistently backwards on held-out recordings is most likely learning which recording a moment came from, not the
gesture. Motion and PPG combined are worse than PPG alone, except against other gestures' starts, where motion helps
(0.75). The motion features here are four simple ones; this says nothing about motion-based gesture models in general.

### 5. Across days

Trained only on 2026-10-11 (8 pinch recordings, plus the fist and thumbs-up recordings of that day), PPG only, +900 ms:

| Test day | AUC | Data |
|---|---|---|
| 2026-10-04 | 0.81 | 2 recordings, 24 pinch starts, 54 others |
| 2026-09-23 | 0.37 | 1 recording, 16 pinch starts, 24 others |

The earlier "consistent across sessions" result mostly came from sessions on one day. The 09-23 recording was made
with an older watch build, but on this evidence a new day can fail outright.

### 9. Fist and thumbs-up, start vs their own middle

| Gesture | AUC | Data |
|---|---|---|
| fist | 0.64 [0.37–0.95] | 65 starts, 57 mid, 5 recordings |
| thumbs-up | 0.66 [0.62–0.73] | 27 starts, 26 mid, 2 recordings |

Both are much weaker than pinch.

### 8. Mark timing

- **Usually not checkable:** the gyroscope showed the hand starting to move at only 44 of 145 pinch starts, so the marks
  mostly cannot be checked this way.
- **Where it can be:** the movement began a median of 34 ms *before* the mark, with the middle half from −262 to +74 ms.
  Half the marks are within ±200 ms.
- **What that means:** marks carry roughly ±250 ms of timing noise. Event-aligned windows are blurred by about that much.

### 2. As a continuous detector

The rule (PPG only, deciding at +900 ms) was run every 80 ms over every held-out recording.

| Score threshold | Pinch starts found | False per minute: pinch recordings | False per minute: fist / thumbs-up recordings | False per minute: unmarked time |
|---|---|---|---|---|
| 0.5 | 62/145 (43%) | 4.6 | 17.3 | 9.0 |
| 0.7 | 31/145 (21%) | 2.0 | 10.8 | 4.5 |
| 0.8 | 19/145 (13%) | 1.7 | 6.9 | 2.3 |
| 0.9 | 11/145 (8%) | 0.6 | 4.5 | 1.1 |

- **How it was counted:**
  - A detection claims a start 900 ms before it fires, and is found if within ±600 ms of a marked pinch start.
  - Detections are at least 1.5 s apart.
  - Every detection in a fist or thumbs-up recording is false.
- **Result:** even at the strictest threshold it fires about once a minute in pinch recordings and four or five times a
  minute during other gestures, while finding fewer than one pinch in ten. That is hundreds of false activations an hour.
  On its own the step is not a pinch detector.

### 7. A held-back set

Not possible: every current recording has been analysed. Only new recordings can provide one.

## What this changes

- **The step's real role:** a component, not a detector. It is worth combining with features that tell pinch apart from
  other hand movement, and it needs a decision about 700 ms after the start.
- **Methods are indistinguishable on this data.** With intervals 0.2–0.4 wide, earlier differences between them are
  noise. More method comparison on this data cannot settle anything.
- **The next recordings must provide what is missing:**
  - explicitly labelled rest;
  - other finger and hand movements that are not pinches;
  - arm movement without a pinch;
  - pinches on several different days, with a strap refitted between sessions;
  - a day kept untouched until the final test.
- **This script is the test to run on them:** the same tables, on new recordings.
