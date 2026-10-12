# Slope and waveform-morphology features for PPG gesture-event detection

## Executive answer

Yes. The proposed idea is an established signal-processing and machine-learning pattern: detect meaningful waveform landmarks, measure the shape and timing between them, and train a classifier on those measurements. The usual names are **waveform morphology features**, **fiducial-point features**, or **landmark-based features**.

For this project, slope and start-to-peak duration are plausible because hand pressure and motion alter the wrist PPG contour. PPG has already been used for smartwatch hand-gesture recognition, and subject-specific PPG gesture studies have classified segmented waveforms with conventional classifiers.[12][1] Derivative PPG research explicitly treats the first derivative as a velocity waveform, uses its extrema and zero crossings to locate landmarks, and measures time, slope, and area between landmarks.[2] Other PPG algorithms directly combine amplitude and first-derivative slope thresholds to detect characteristic waves.[3]

The key caveat is that **classifying an already segmented event** and **finding events in a continuous stream** are different problems. A useful research result must test both.

## The proposed feature set

For each optical channel—green, red, and infrared—start with a locally baseline-corrected signal `z(t)` and define:

- **Onset time:** where a sustained rise or fall begins, not merely the left edge of the model window.
- **Peak time and amplitude:** the most prominent signed excursion after onset.
- **Start-to-peak duration:** `t_peak - t_onset`.
- **Average rise slope:** `(z_peak - z_onset) / (t_peak - t_onset)`.
- **Maximum and minimum instantaneous slope:** extrema of a smoothed first derivative, expressed per second rather than per sample.
- **Fall duration and slope:** peak to recovery or half-recovery.
- **Width:** preferably width at half prominence; this is better defined than an unqualified “peak width.”
- **Prominence:** height relative to the surrounding local contour, not the session's absolute raw level.
- **Signed and absolute area:** integral from onset to recovery.
- **Derivative landmark timing:** delay from maximum positive derivative to the peak, and from peak to maximum negative derivative.
- **Cross-channel agreement:** timing differences and amplitude ratios across green/red/IR.
- **Quality and missingness flags:** whether a valid onset, peak, or recovery was found and whether contact quality was acceptable.

PPG morphology studies use detected fiducial points to derive timing, slope, area, and crest-time measurements; onset-to-systolic-peak time is explicitly defined as crest time.[2] Peak prominence, width, distance, and plateau size are also standard computable peak properties in signal-processing software.[11]

Do not resample every candidate to an equal duration before calculating these measurements: that would erase the very duration information under test. A normalized waveform can still be supplied to a second model after the timing features have been saved.

## What the project already has

The current trainer already implements much of this idea in `tools/label-trainer/src/label_trainer/features.py` and mirrors it in Rust live inference:

- per-channel whole-window slope;
- baseline-removal choices including first derivative, straight-line detrending, rolling-median residual, morphological top-hat, Butterworth high-pass, Savitzky–Golay residual, and Haar detail;
- spike height and robust z-score;
- peak position within the window;
- `spike_rise_ms` and `spike_fall_ms`;
- spike count;
- steepest positive and negative derivative;
- local baseline-relative PPG levels.

However, the current `spike_rise_ms` is **half-height-to-peak width**, not true event-onset-to-peak duration. The requested experiment therefore does not need a new signal-processing subsystem. It needs one clearly defined onset detector plus a small set of additional morphology features, kept identical in Python training and Rust inference.

## Candidate algorithms

### 1. Morphology features plus a small classifier — recommended first

Extract the measurements above and train regularized logistic regression, an SVM, Random Forest, or gradient-boosted trees. PPG research has already used morphology features as inputs to supervised models and feature selection.[10] PPG gesture studies also show that conventional SVM/KNN models can work with relatively small datasets after waveform processing.[1]

Why start here:

- interpretable: a model can reveal whether rise time, fall slope, or prominence matters;
- small-data friendly;
- inexpensive enough for desktop and potentially watch inference;
- easy to compare with the existing feature model.

Main weakness: landmark detection can fail when movement produces multiple peaks or a noisy plateau. Missing-landmark flags must be real inputs; do not invent a peak or duration.

### 2. Shapelet transform

A shapelet is a discriminative local subsequence. A shapelet transform converts each event/window into distances from learned local patterns, then feeds those distances to an ordinary classifier.[4] A learned shapelet could represent a rise–peak–recovery motif without manually deciding which single slope measurement matters.

Use when morphology features are too rigid but interpretability still matters. Shapelets tolerate where a pattern occurs within a window, but they are not automatically invariant to execution speed and do not solve continuous-stream segmentation by themselves.

### 3. Derivative DTW or constrained DTW

Derivative Dynamic Time Warping compares local shape changes rather than only absolute signal levels.[8] It is useful as a small-data template baseline when the same gesture occurs faster or slower between sessions.

Use a constrained warping band. Unrestricted warping can align genuinely different gestures and erase duration differences—the exact signal the proposed start-to-peak feature is intended to retain. DTW is best as a benchmark or nearest-template classifier, not the first production model.

### 4. MiniROCKET/ROCKET

ROCKET applies many convolutional kernels at varied lengths, dilations, and scales, then trains a linear classifier on each kernel's maximum response and proportion of positive responses.[5] MiniROCKET retains dilation and proportion-positive pooling while using a smaller, mostly deterministic transform and substantially reducing computation.[6][16]

This is the strongest low-effort waveform baseline after morphology features. It can discover slope-like and rise–fall patterns without explicitly naming them. It still classifies supplied windows; it does not identify event boundaries on its own.

### 5. Change-point detection for candidate boundaries

PELT optimizes a penalized segmentation objective and can detect changes in mean, variance, or another chosen cost under stated expected-linear-cost conditions.[7] For this project it could propose event starts where derivative energy or locally normalized PPG statistics change.

Use it offline first. Standard PELT is retrospective, and every statistical change is not a gesture. A classifier must still reject ordinary movement, contact shifts, and sensor dropouts.

### 6. Wavelet or multiscale derivative features

Wavelets and derivative waveforms emphasize transient changes at more than one timescale. PPG work uses first and second derivatives to expose contour landmarks that are subtle in the raw waveform.[2][14] Wavelet denoising has also been compared directly with other processing methods in PPG gesture recognition.[1]

This is useful if events happen at noticeably different speeds. It is more complex than the requested slope-duration experiment, so add it only if the simpler features fail.

### 7. A small 1D CNN

A 1D CNN can learn slope and shape filters directly from locally normalized PPG or derivative windows. The project already has a CNN grid path, so no new model family is required. The limitation is data: overlapping windows from a few sessions do not create independent examples. Use the CNN only after simpler baselines and with enough genuinely separate sessions.

### 8. Broad automatic feature libraries

Catch22 is a compact set of 22 interpretable time-series characteristics selected from thousands of candidates for broad classification performance.[9] It is useful as a sanity-check baseline, but its generic features are less directly tied to the user's onset-to-peak hypothesis than the proposed morphology set.

## Recommended experiment

### Research question

> Do event-relative slope and duration features improve gesture-event detection on a completely unseen recording session compared with the current window statistics and spike features?

### Data split

Use whole recording sessions as groups:

- outer evaluation: leave one complete session out;
- inner validation: hold out another training session for feature/filter/threshold choices;
- never place overlapping windows, augmented copies, or intervals from one session in different folds;
- if deployment must work for another wearer, evaluate with the wearer held out instead.

Wearable-ML research shows that record-wise random cross-validation can substantially overestimate accuracy when the deployment target is a new subject; the same principle applies to new sessions because the validation relationship must match the intended use case.[15]

### Phase A — classification with known boundaries

Use camera/manual annotations as event boundaries. Compare:

1. current canonical features;
2. current features plus true onset-to-peak, peak-to-recovery, prominence, width, area, and derivative-landmark timings;
3. constrained derivative-DTW nearest-template classification;
4. MiniROCKET plus a ridge classifier on locally normalized green/red/IR windows.

This answers whether slope morphology separates the labels without confounding the result with a boundary detector.

### Phase B — continuous event detection

Run across full held-out recordings:

1. create candidate starts from sustained derivative-energy or prominence changes;
2. classify candidates/windows;
3. require temporal persistence and merge duplicate detections;
4. measure one-to-one event matches, not per-window accuracy.

Report:

- event precision, recall, and macro-F1;
- false activations per hour;
- missed events;
- onset and peak timing error;
- detection latency;
- performance for each held-out session, not only a pooled average.

### Ablations

Run these one at a time:

- raw level versus local baseline normalization;
- raw waveform versus first derivative versus both;
- timing features enabled/disabled;
- PPG-only versus PPG plus IMU;
- green, red, infrared individually and jointly;
- true timestamps versus index-based timing;
- fixed 500 ms windows versus a duration chosen from training-session event lengths.

## Important implementation constraints

1. **Preserve raw samples and timestamps.** Feature extraction must be additive and reproducible.
2. **Use physical units.** Slopes should be amplitude/second and durations in milliseconds; buffer flush cadence must not be mistaken for physical sampling rate.
3. **Smooth before differentiating.** Differentiation amplifies noise. Reuse the project's existing mild smoothing/residual methods and tune only inside training folds.
4. **Use adaptive/local thresholds.** Fixed raw-amplitude thresholds are fragile across contact pressure, skin, placement, and sessions. PPG derivative research shows both the usefulness of slope rules and the difficulty of low-amplitude/noisy signals.[3][2]
5. **Preserve missingness.** If onset or recovery cannot be found, emit a validity flag rather than a fabricated zero-duration event.
6. **Keep training/live parity.** Every new feature needs one shared fixture proving Python and Rust return the same value from identical timestamped samples.
7. **Do not optimize cardiac cleanup too aggressively.** In this application, motion deformation is useful gesture information, even though heart-rate pipelines often treat it as artifact.

## Recommendation

Implement only a research branch first:

- add true onset-to-peak duration, peak-to-recovery duration, average/max rise and fall slopes, prominence, width, area, and validity flags;
- compare **current model**, **morphology + logistic/boosted-tree model**, and **MiniROCKET**;
- evaluate by held-out session and false activations per hour;
- proceed to shapelets, change points, or a CNN only if this comparison identifies a specific limitation.

The hypothesis is technically sound, and the current project is already close to testing it. The main new work is defining a robust onset/recovery boundary and evaluating on unseen sessions—not inventing another large model.

## Live recording and inference feasibility

Yes: this can run while raw PPG and IMU data are recorded. The computation is small; the essential design is a causal state tracker operating beside the recorder, not a second recording pipeline.

### Causal live path

1. Keep a short rolling PPG buffer and the existing recent baseline.
2. Apply only causal smoothing, then calculate derivative energy and local robust scale.
3. Use a state machine: `idle → rising → peak → recovering → idle`.
4. On a sustained rise, save the candidate onset. At the peak, calculate onset-to-peak duration, average/max rise slope, prominence, and channel agreement.
5. On recovery, add fall duration, width, and area, then make or revise the decision.
6. Record the raw sensor samples continuously regardless of a candidate's result; derived event metadata must be additive.

There are two legitimate outputs:

- **Early:** emitted at or just after the peak, using rise features.
- **Confirmed:** emitted after recovery, using the full morphology.

No causal method can know a peak at its onset. The minimum classification latency is therefore the physical onset-to-peak interval plus any confirmation period. In this project, transport batching may add further delivery delay; the restored stable continuous PPG path may deliver a buffered callback near its flush cadence. That is a data-arrival limit, not a model-computation limit.

### Live-specific rules

- Compute duration from sensor timestamps in milliseconds and slope in amplitude/second, never from callback index or flush timing.
- Preserve raw timestamps even if a batch contains nearly identical arrival times.
- Do not use zero-phase filters or whole-session normalization in live inference: both look into the future.
- Mark a candidate invalid when onset, peak, recovery, or quality checks fail; do not manufacture zero-duration features.
- Keep Python trainer and Rust inference bit-for-bit equivalent with shared timestamped fixtures.
- Test live event precision/recall, false activations per hour, and latency on complete held-out sessions.

The existing runtime already uses rolling fixed windows and already mirrors spike features in Rust. The smallest implementation is therefore an incremental onset/peak/recovery tracker that augments those features; it does not require a new model platform or changes to raw recording.

## Sources

[1] https://doi.org/10.3389/fnins.2022.1047070
[2] https://doi.org/10.3389/fpubh.2022.920946
[3] https://doi.org/10.1186/1475-925X-13-139
[4] https://doi.org/10.1007/s10618-013-0322-1
[5] https://arxiv.org/abs/1910.13051v1
[6] https://arxiv.org/abs/2012.08791v2
[7] https://doi.org/10.1080/01621459.2012.737745
[8] https://doi.org/10.1016/j.eswa.2014.11.007
[9] https://doi.org/10.1007/s10618-019-00647-x
[10] https://doi.org/10.1371/journal.pone.0279419
[11] https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html
[12] https://doi.org/10.1145/3191788
[14] https://doi.org/10.1371/journal.pone.0076585
[15] https://doi.org/10.1093/gigascience/gix019
[16] https://doi.org/10.1145/3447548.3467231
