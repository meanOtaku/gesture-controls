# PPG slope-event technique

**Status:** stage 1 implemented: the window-level step (`ppg_{green,red,ir}_rel_z_step`, below). The causal event tracker
is still a proposal.

Tested on the 2026-10 recordings ([../research/ppg-onset-open-questions-2026-10.md](../research/ppg-onset-open-questions-2026-10.md)),
the step is a real onset cue, not wrist motion, but not a detector on its own:

- **Not specific:** about 0.65 against fist and thumbs-up starts.
- **Slow:** it needs about 700 ms after the start.
- **Uneven across days:** 0.81 and 0.37 on two other days.
- **Run continuously:** under 10% of pinches found at about one false activation a minute.

Stage 2 waits for a test on the untouched 2026-10-14 recordings (the first with labelled non-pinch activity), and for
features that tell a pinch from other hand movement.

## Stage 1: the step through the window (implemented)

Before building the tracker, the idea was tested offline on 17 earlier recordings (10 pinch sessions over three days). In
units of each session's recent past, the PPG steps up across a pinch's start in every pinch session, and a rule on that
step told pinch starts from other moments at about 0.83-0.90 AUC on sessions it never saw, where the raw level was at
chance. Those other moments were mostly the middle of held pinches, not rest (correction of 2026-10-13 in the findings);
against clean rest the step is untested. Fist
was not consistent between sessions; thumbs-up dipped in both of its two sessions.

So the trainer and the live runtime now compute, for each channel, `rel_z_step`: the window's PPG through `pulse_z` against
the baseline before it, then the mean over the window's last 40% less the mean over its first 25%. It is one of the
baseline features (opt-in with a baseline), identical in `features.py` and `crates/pinch-inference/src/features.rs`, pinned
by the shared cases in `tests/fixtures/baseline_cases.json`. Use a window of about 1.3 s so the whole step fits.

With the trainer's own windows (leave one recording out, PPG only, 1.3 s windows, "did a pinch just start"), the step
alone scored 0.68-0.70 pooled across recordings; the existing PPG features ranked windows well inside each recording
(median 0.81-0.87) but their scores shifted between recordings (pooled 0.3-0.5). The step is the feature whose scale
carries over. Two limits remain: the trainer labels every window of a held gesture, while the step marks its start (an
onset target is the next step), and only six recordings had enough rest to be judged.

## Purpose

Detect a gesture-related PPG deformation while a recording is in progress, then describe its rise, peak, and recovery as features for training and live inference. Raw PPG and IMU samples remain authoritative and are recorded unchanged.

This is an addition to the existing fixed-window features, not a replacement. The existing pipeline already emits per-channel slope, peak position, half-height rise/fall duration, and derivative extrema. The proposed feature family adds a true event onset and recovery boundary.

For research rationale and model comparisons, see [slope-morphology-event-detection.md](../research/slope-morphology-event-detection.md).

## Inputs

For every green, red, and infrared PPG sample:

- raw sensor timestamp in nanoseconds;
- raw channel value;
- per-channel contact/quality status where available;
- the recent causal baseline buffer.

Arrival order and transport flush timing are not signal time. All timing features use source timestamps after the existing ordering checks.

## Causal event tracker

Maintain one tracker per channel plus a fused decision:

```text
idle -> rising -> peak -> recovering -> idle
```

1. **Idle:** update a recent robust baseline from valid non-event samples.
2. **Rising:** enter only after the baseline-corrected derivative crosses an adaptive threshold for a minimum sustained interval. Save `onset_ns`.
3. **Peak:** detect a derivative sign change or a sufficiently persistent local maximum. Save `peak_ns` and peak value.
4. **Recovering:** track return toward the local baseline or the half-prominence crossing. Save `recovery_ns` when it occurs.
5. **Idle:** close the candidate, emit final features, and allow a new candidate after a refractory interval.

The threshold is relative to recent robust variation, for example a multiple of median absolute deviation. It must not be a fixed raw PPG amplitude.

## Feature contract

For each channel, emit the following only when the required landmarks exist; otherwise emit `null` plus the matching validity flag.

- `event_onset_to_peak_ms = peak_ns - onset_ns`
- `event_peak_to_recovery_ms = recovery_ns - peak_ns`
- `event_rise_slope_mean = (peak_value - onset_value) / event_onset_to_peak_ms`
- `event_rise_slope_max`: largest causal first derivative between onset and peak
- `event_fall_slope_mean = (recovery_value - peak_value) / event_peak_to_recovery_ms`
- `event_fall_slope_min`: smallest causal first derivative between peak and recovery
- `event_prominence`: peak relative to the local contour/baseline
- `event_width_half_prominence_ms`
- `event_area`: signed baseline-corrected integral from onset through recovery
- `event_peak_delay_from_rise_max_ms`
- `event_landmark_valid`
- `event_quality_valid`

Fuse only after channel-local extraction:

- number of valid channels;
- maximum onset/peak timing disagreement between channels;
- green/red/IR prominence ratios where denominators are safe;
- agreement validity flag.

All slopes are amplitude per millisecond or amplitude per second, named consistently in the eventual schema. Durations are milliseconds.

## Early and confirmed decisions

A live model may produce:

- an **early** score after `peak`, using onset-to-peak and rise features; and
- a **confirmed** score after `recovery`, using the full morphology.

The early score cannot precede the actual peak. Total observed latency also includes transport delivery cadence; no classifier can remove samples that have not arrived.

## Recording behavior

- Continue writing every raw PPG and IMU sample regardless of tracker state or classifier output.
- Store derived candidates/detections as additive metadata with their source timestamps, model version, score, and validity flags.
- A rejected candidate is diagnostic data, not a reason to delete raw samples.
- Preserve raw timestamps exactly; any repaired or normalized clock is a separate explicit field.

## Training and live parity

Python training and Rust inference must implement the same:

- baseline update eligibility;
- smoothing method and parameters;
- derivative calculation;
- onset, peak, and recovery conditions;
- timestamp/unit conversion;
- missing-landmark behavior;
- feature order and names.

Add shared timestamped fixtures before training a model. Each fixture must cover a normal positive event, a negative event, missing recovery, contact-quality failure, batched delivery, and a timestamp gap.

## Evaluation sequence

1. With annotation boundaries supplied, compare the current model against current-plus-slope features on complete held-out sessions.
2. Evaluate the tracker across continuous held-out recordings.
3. Tune all thresholds, smoothing, and classifier settings only inside the training/validation sessions.
4. Report event precision/recall/F1, false activations per hour, missed events, early/confirmed latency, and each held-out session separately.

The acceptance criterion is improved event-level performance at an acceptable false-activation rate on unseen sessions, not higher pooled accuracy from overlapping windows.
