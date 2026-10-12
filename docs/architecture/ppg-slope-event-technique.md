# PPG slope-event technique

**Status:** proposed experiment. This document defines the intended technique; it does not claim implementation or model validation.

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
