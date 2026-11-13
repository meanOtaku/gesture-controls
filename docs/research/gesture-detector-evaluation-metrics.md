# Gesture detector evaluation metrics

This project evaluates a pinch detector as a **continuous event detector**, not as a per-window classifier. ROC-AUC and window accuracy remain diagnostic values, but they are not release metrics.

The trainer implements this standard (`tools/label-trainer/src/label_trainer/label_train.py`: `detections`, `cohort`, `budget_threshold`, `verdict`), and so do Model Lab's own replays, the Threshold card, Mistakes, Compare models and the final test (`apps/desktop/src-tauri/src/detector_events.rs`: `count`, `judge`). Where this page and the code disagree, the code is wrong.

## Decision flow

```text
Complete recording
  -> causal model scores
  -> frozen threshold, peak rule, hysteresis, and cooldown
  -> emitted activation events
  -> each event: a catch, a repeat, late, or a false activation (see below)
  -> report per label-timing cohort; judge on the trusted one
```

Use the same runtime policy, event-match window, label mapping, false-activation budget, and cohort rules for every model comparison.

## Headline metrics

| Metric | Definition | Unit | Desired direction |
|---|---|---:|---|
| True Activation Rate (TAR) | labelled pinch events with a valid activation / labelled pinch events | percent | higher |
| Miss Rate | labelled pinch events with no valid activation / labelled pinch events | percent | lower |
| False Activation Rate (FAR) | false activations / time with no gesture under way | per hour | lower |

TAR is event recall. Miss Rate is always `100% - TAR`; show it alongside TAR for readability, not as independent evidence.

FAR has one denominator everywhere: **time with no gesture under way**, never total recording time. Pinch sessions are dense (a pinch every few seconds), so a rate per minute of recording is several times lower than the same firings per hour without a gesture. Mixing the two hid a model that fired about 175 times an hour behind a target it appeared to meet (see Evidence).

Do **not** define "no activation rate" as the fraction of quiet sample windows. That value depends on how often the watch samples and how long the recording is. Quiet non-pinch time is represented by FAR instead.

## Event accounting rules

- The positive unit is one labelled `pinch_in` start.
- A **gesture under way** runs from that start through the parts of the same gesture that follow it without a gap (`pinch_hold`, `pinch_out`: labels with the same name before the first `_`), and at least to the end of the start's match window.
- Each emitted event is exactly one of:
  - **catch**: the event paired with a start inside its match window (680–1,280 ms after the start for the trees, which decide 880 ms after it). This is the valid activation for that pinch.
  - **repeat**: another event while a caught gesture is under way.
  - **late**: an event while a gesture is under way that was not caught in its window. The gesture counts as missed; the event is not a false activation.
  - **false activation**: any other event, that is, one with no gesture under way. An event after a pinch has ended, for example when the hand opens, is a false activation: the user would see a second action.
- `left_out` stretches, and any label mapped to Exclude, are left out of both matching and the time with no gesture under way.
- Report as companions: repeats per 100 labelled pinches, late events, and median latency (catch time minus start). They identify models that fire twice per pinch, or only after the gesture is useful.

## Ground truth: label-timing cohorts

Each recording's labels were timed in one of two ways:

- **camera**: the camera marked where the thumb and index met and parted (the Recorder's camera marking, or the camera relabel of older sessions);
- **estimated**: placed from the watch's own motion, with no camera (`scripts/split_pinch_from_motion.py`).

A recording with no start of the target at all (everyday noise from the Recorder, or a session of another gesture) has
no gesture timing to doubt: it is **noGesture**, and is judged together with the camera-timed recordings. Its time is
all time with no gesture under way, so its false activations an hour are the closest measure of ordinary use.

Estimated timings are not interchangeable with camera timings. They are placed from the same wrist jolt the model learns to detect, so scoring a model against them is partly circular and flatters it (see Evidence).

The rules:

1. Report totals for each cohort separately (`byLabelTiming`). Never blend them into one headline number without saying so.
2. When a set holds both kinds and the camera-timed recordings have at least 20 pinches and, with any noGesture recordings, 60 s with no gesture under way, **choose the threshold and judge the model on the camera-timed and noGesture recordings only** (`cohort: camera`). Otherwise use all of them and say so (`cohort: all`).
3. Estimated recordings may train a model, but they never decide whether it ships.

The desktop sends each recording's timing in the training spec (`labelTiming`), from what Model Lab shows: "Labels marked by the camera" or "estimated from the watch's motion".

## Session cohorts: old and new sessions

A model must work on a session it has never seen, recorded on another day. The held-out set should contain whole new sessions, not only recordings from the days it trained on. When the old and new sessions perform differently, report both; do not let the old ones carry the average.

The strongest new-session check is the **final test**: seal a whole day you have not trained on (Datasets → Seal a day), and run the candidate over it once. Every sealed run is logged.

## Comparison protocol

1. Freeze the target label, event-match window, causal feature pipeline, runtime policy, label mapping, false-activation budget, and the recordings in each set before running models.
2. Choose the threshold on the training recordings only: each training recording is scored by a model that did not see it and replayed as the runtime would run it. Never tune it on the held-out or sealed recordings.
3. Choose it **within the same budget the release gate uses**. A threshold chosen for a looser budget is then failed by the gate for firing too often, and the failure says nothing about whether a better threshold existed.
4. Replay each candidate over complete held-out recordings, not only windows near known gestures.
5. Report TAR, Miss Rate, FAR, repeats per 100, late events and median latency, per label-timing cohort, and for new sessions apart from old ones.
6. Use ROC-AUC and PR-AUC only to diagnose score ranking. Raw window accuracy is not a model-selection metric: pinch windows are rare, so an always-no-pinch model has high accuracy and detects nothing.

## Release gate

One budget, used twice (threshold choice and release):

> **FAR at most 5 false activations per hour with no gesture under way** (`FALSE_ACTIVATIONS_BUDGET_PER_HOUR`), about one every twelve minutes of ordinary use.

A model is ready to go live only when, on the judged cohort of the held-out recordings:

- FAR is within the budget;
- TAR is at least 50% (`MIN_GESTURE_RECALL`);
- the held-out recordings hold at least 60 s with no gesture under way, so FAR can be measured at all.

The trainer also refuses a model whose ROC-AUC on held-out or cross-checked decisions is under 0.7, whose balanced accuracy is under 0.7, or that flags more than 10% of the other held-out moments. These checks catch a model that cannot rank the gesture at all; passing them alone never ships a model.

A failing model is still kept, and can run in Monitor, where it only reports.

A release report states the budget, the judged cohort, the threshold source, the number of labelled pinches, the time with no gesture under way, and the label timing of every recording.

The budget was 30 an hour until 13 Nov 2026. At 30 the trainer chose cut-offs that then had to be raised by hand: for
`pinch_out` it chose 0.5, at which the model fired 18 times in 35 minutes with no gesture under way
([results](artifacts/training-improvements-2026-11/final-models.md)). The evidence below was gathered under the budget of 30.

## Evidence (3 Nov 2026)

The trees model (`ppg-onset-trees`, PPG + IMU, still-hand gate on) for `pinch_in`. Trained on 16 camera-timed recordings from 14 and 17 Oct. Held out: the four camera-timed sessions of 3 Nov (new sessions), two camera-timed sessions from 14 and 17 Oct, and two motion-estimated ones (11 Oct). Same model each time; only the rules differ.

| Rules | Threshold | Cross-check (training recordings) | Held-out, camera-timed | Held-out, estimated |
|---|---:|---|---|---|
| Before: 2 per minute of recording | 0.45 | 106 of 202 caught (52%), 175 FAR/h, reported "within target" | 50 of 93 (54%), 129 FAR/h | 26 of 30 (87%), 0 FAR/h |
| This standard: 30 per hour, camera cohort | 0.70 | 66 of 202 (33%), 15 FAR/h | 12 of 93 (13%), 43 FAR/h | 4 of 30, 0 FAR/h |

What it shows:

- The earlier per-minute target let the threshold be chosen at about 175 false activations an hour, which the release gate then failed. Within a consistent budget, the threshold rises to 0.70.
- At that threshold the model catches a third of the pinches in the training recordings but only 13% of the new sessions': it does not carry over to a new session yet. More varied sessions are the fix, not a looser threshold.
- The estimated recordings score far better than the camera-timed ones (87% against 54% at 0.45, no false activations), as expected from labels placed by the signal the model detects. They must not decide a release.
- At the same threshold, the new accounting moved only a few events (two late, one repeat). Of the 18 false activations left, 9 fired just after a pinch ended (the hand opening). That is a real second action, so it stays a false activation.

## Legacy model comparison

Old and new models are comparable only when their scores are replayed through the current event accounting on the same recordings. A model with only aggregate AUC or window metrics keeps those as history, but is not ranked against a new one by the headline metrics until it is replayed. Models trained before this standard state `targetFalseActivationsPerMinute` in their manifest's provenance. Models trained under it state `falseActivationsBudgetPerHour` and `evaluationCohort`.
