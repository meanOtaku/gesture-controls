# Pinch start: adding the IMU, trigger rules and label shifts, October 2026

The app's PPG-only pinch-start model fires on hand movement in general, not on pinches: on the 13 recordings with no pinch (fist, thumbs-up, everything else) it fires about 19–25 times a minute. These three studies, run on 2026-10-21, ask what the recordings we already have can say about fixing that, before collecting more:

1. Does adding the watch's IMU help?
2. Does a better trigger rule help?
3. How many false activations are really pinches scored against late labels?

All three use the frozen benchmark of `artifacts/ppg-benchmark-2026-10/`:

- 37 recordings and 1,390 events, split 20 ways so that no recording is in both training and test;
- ExtraTrees with the frozen settings;
- the same live-detection matching: a fire counts if it lands 680–1,280 ms after a labelled pinch start.

They are cross-validation progress evidence on data every earlier study has seen, not an untouched test.

## Summary

- **The IMU is the most useful thing we can add.** On its own it already beats PPG. Combined with PPG it raises worst-split AUC from 0.789 to 0.837 (better on 19 of 20 splits). It mostly helps tell a pinch from the start of another gesture: 0.70 → 0.79–0.81 AUC on that pair.
- **It halves the false activations on no-pinch recordings at the frozen 0.5 threshold:** 19.0 → 12.0 a minute fused, 9.8 with the IMU alone. That is better, not usable.
- **The frozen trigger rule loses pinches.** It fires when the probability first crosses the threshold. At low thresholds that is often before the scoring window, and the fire's 1.5 s lockout then blocks the right one. That is why lowering the threshold catches fewer pinches.
- **Firing just after the probability's peak fixes that.** With PPG + IMU it adds 4–12 points of recall at the same false-activation budget, for 35–90 ms more delay. With PPG alone, no rule helps.
- **Moving the labels earlier doesn't uncover a hidden win.** At the 0.5 threshold a 200–350 ms shift turns about 3 false activations a minute into caught pinches. At budgets of 2 a minute or fewer, recall barely moves, and the peak rule already gets the same gain without moving labels. The false activations that are left are real: the model reacting to other movement.
- **The next step is data, not more re-scoring of these recordings:**
  - everyday-movement sessions as negatives;
  - camera-timed pinch labels, because each recording has its own label lag, up to 1.3 s;
  - possibly a higher IMU rate.

## The data

Every recording stores the watch's IMU alongside the PPG:

- accelerometer x/y/z, gyroscope x/y/z and orientation;
- 50 Hz (20 ms apart);
- the same clock as the PPG: the IMU starts and ends within about 130 ms of the PPG in every recording.

One recording (2026-10-14T00-54-06) was captured at 100 Hz.

## 1. Adding the IMU

[`imu_fusion.py`](artifacts/ppg-benchmark-2026-10/imu_fusion.py), results in [`ppg-imu-fusion/`](artifacts/ppg-benchmark-2026-10/ppg-imu-fusion/results.md).

**What was compared.** Three inputs, fixed before any was scored, each into the same ExtraTrees:

- **ppg:** the app's model. PPG z-scored against the previous 1, 2 and 4 s → slope, curvature, jerk → 1,701 summaries.
- **imu:** 1,032 causal features ending at the decision tick. The channels are the accelerometer and gyroscope axes plus the two magnitudes, held on a 50 Hz grid. For each channel and each of the last 320, 640 and 1,280 ms there are:
  - the same 21 summaries, on the signal and on its sample-to-sample change;
  - the log ratio of the window's spread to the 3 s before it.
- **ppg+imu:** both blocks side by side.

| Input | Worst-split AUC | Mean AUC | Splits better than ppg | Pinch vs other gestures' starts (mean AUC) | False/min at 0.5, no-pinch recordings |
|---|---:|---:|---:|---:|---:|
| ppg (app) | 0.789 | 0.843 | – | 0.695 | 19.0 |
| imu | 0.807 | 0.882 | 18/20 | **0.807** | **9.8** |
| ppg+imu | **0.837** | **0.892** | 19/20 | 0.794 | 12.0 |

Mean held-out score by event kind:

| Input | Pinch start | Other gesture start | Everything else | Pinch hold | Other hold | Unmarked |
|---|---:|---:|---:|---:|---:|---:|
| ppg | 0.546 | 0.393 | 0.298 | 0.172 | 0.157 | 0.179 |
| imu | 0.595 | 0.300 | 0.327 | 0.162 | 0.163 | 0.182 |
| ppg+imu | 0.601 | 0.342 | 0.296 | 0.154 | 0.146 | 0.176 |

- **The IMU separates pinches from other gestures' starts.** That was the main confusion in the multi-scale study's diagnosis.
- **The IMU alone scores "everything else" (free movement) higher than PPG does.** This is the expected risk: arm movement dominates the IMU. Fusing pulls it back, which argues for fusing the two rather than replacing PPG.
- **Even fused, live detection is far from usable.** At about 2 false activations a minute it catches 34% of pinches, against 29% for PPG alone. At about 1 a minute it catches 21%, against 15%. These thresholds were read off the held-out predictions, so the figures compare the inputs fairly but are optimistic.

## 2. Trigger rules

[`trigger_rules.py`](artifacts/ppg-benchmark-2026-10/trigger_rules.py), results in [`ppg-trigger-rules/`](artifacts/ppg-benchmark-2026-10/ppg-trigger-rules/results.md).

**Why the frozen rule loses pinches.** At the 0.5 threshold:

- 31% (ppg) and 43% (ppg+imu) of false fires land up to 1 s before a labelled pinch's scoring window;
- 62% and 57% of missed pinches had such an early fire, whose lockout blocked the right one.

At 0.7 the shares of missed pinches fall to 24% and 23%, because a higher threshold is crossed later in the probability's rise.

**Rules compared.** Four causal rules, fixed before scoring, on the same held-out predictions. Each fires at most once per run above the threshold and shares the 1.5 s lockout:

- **edge:** the frozen rule; fires on the first tick above the threshold.
- **debounce:** fires on the third consecutive tick above the threshold.
- **smooth:** the edge rule on the mean of the last three probabilities.
- **peak:** fires on the first tick the probability falls, one tick after its peak.

The edge rule at 0.5 reproduces the multi-scale study's 41.3% recall and 15.09 false activations a minute exactly.

Most pinches caught within a false-activation budget (thresholds swept 0.20–0.95):

| Input | Rule | ≤ 0.5/min | ≤ 1/min | ≤ 2/min | ≤ 5/min | Latency at ≤ 2/min |
|---|---|---:|---:|---:|---:|---:|
| ppg | edge | 0.067 | 0.149 | 0.230 | 0.343 | 845 ms |
| ppg | best of debounce, smooth, peak | 0.043 | 0.124 | 0.249 | 0.383 | 880–910 ms |
| ppg+imu | edge | 0.115 | 0.209 | 0.340 | 0.385 | 820 ms |
| ppg+imu | debounce | 0.160 | 0.241 | 0.368 | 0.466 | 865 ms |
| ppg+imu | smooth | **0.183** | **0.271** | 0.335 | 0.431 | 855 ms |
| ppg+imu | peak | 0.162 | 0.245 | **0.378** | **0.509** | 910 ms |

- **With PPG + IMU, peak or smooth is worth taking.** Peak is best at looser budgets and smooth at the strictest ones, for under 100 ms more delay.
- **With PPG alone, no rule clearly helps.** Its probabilities are too noisy for the rule to matter.

## 3. Label shifts

[`label_shift.py`](artifacts/ppg-benchmark-2026-10/label_shift.py), results in [`ppg-label-shift/`](artifacts/ppg-benchmark-2026-10/ppg-label-shift/results.md).

**What was done.** The held-out predictions were re-scored with every pinch start moved by one common shift, from 700 ms earlier to 350 ms later. Nothing was retrained. Later shifts are the control: if an earlier window only caught stray fires, a later one would too.

PPG + IMU:

| Label shift | Rule | Recall at 0.5 | False/min at 0.5 | ≤ 1/min | ≤ 2/min | ≤ 5/min |
|---|---|---:|---:|---:|---:|---:|
| 0 | edge | 0.350 | 11.25 | 0.209 | 0.340 | 0.385 |
| 0 | peak | 0.560 | 6.82 | 0.245 | 0.378 | 0.509 |
| −200 ms | edge | 0.578 | 8.24 | **0.306** | 0.379 | 0.529 |
| −200 ms | peak | 0.604 | 6.25 | 0.243 | 0.379 | **0.571** |
| −350 ms | edge | 0.600 | 7.95 | 0.199 | 0.357 | 0.513 |
| −500 ms | edge | 0.479 | 9.54 | – | 0.020 | 0.240 |
| +200 ms (control) | peak | 0.312 | 10.08 | 0.115 | 0.167 | 0.266 |

PPG alone shows the same pattern: edge at 0.5 goes from 0.413 and 15.09 a minute at zero shift to 0.572 and 13.00 at −200 ms.

- **At the 0.5 threshold, some false activations are early fires on real pinches.** A 200–350 ms earlier shift turns about 3 a minute of them into caught pinches, for both inputs. Later shifts get worse, so this isn't chance.
- **This is mostly how the edge rule behaves, not late labels.** A low threshold is crossed while the probability is still rising. The peak rule at zero shift does as well as the edge rule shifted −200 ms.
- **At budgets of 2 a minute or fewer, no shift moves recall much** (about 0.38 throughout). The false activations left there are not near any pinch.
- **Scores collapse about 300 ms either side of the best shift.** The 600 ms scoring window is narrow next to how uncertain the label timing is. The label-lag audit found each recording's best shift anywhere from −1,400 to +850 ms (the 10-17 recordings −700 to −1,300 ms). One common shift cannot correct that, so it still distorts training. Camera-timed labels are the fix.

## What this means

1. **The model should use PPG + IMU, and fire on the peak (or smoothed) probability.** That is the best we can get from these recordings. Still expect only about a quarter to a third of pinches at 1–2 false activations a minute, and less on a new day.
2. **The false activations left are real reactions to other movement.** The fix is training data: long everyday-movement sessions as negatives, with hard-negative mining.
3. **Label timing needs an independent reference.** Camera contact timing at 60 fps or more, so each recording's lag is measured instead of guessed.
4. **The 50 Hz IMU may be too slow** to capture the brief vibration of fingertip contact. Recording at 100–200 Hz is worth testing alongside the new data.

## In the app (2026-10-21)

Point 1 is built: Model Lab now trains the PPG + IMU model and the runtime fires it on the peak.

- **Inputs.** The 1,701 PPG features, then 1,032 motion features (`imu_onset.py`, mirrored by `crates/pinch-inference/src/imu_onset.rs`), with both grids ending at the decision's PPG sample. Live, each pulse sample is placed on the watch clock the motion is stamped with, as the recorder does. A decision waits until the motion up to it has arrived.
- **Trigger and cut-off.** The trigger is peak. The cut-off is the one that, replayed over training recordings each scored by a model that had not seen it, catches the most starts with at most 2 false activations per minute of recording. When none stays within that, it is the one that catches the most starts less its false activations. (Revised 2026-10-22; see below.)
- **Earlier models.** PPG-only models trained before this keep running, with the same inputs and edge trigger. Like every model, they now decide on every pulse sample (see below).

**Checks:**

- [`app_fusion_check.py`](artifacts/ppg-benchmark-2026-10/app_fusion_check.py) puts the app's version on the same 20 splits:
  - worst-split AUC 0.853 and mean 0.898 (research 0.837 / 0.892);
  - 0.236 of pinches caught within 1 false activation a minute (research 0.245);
  - 0.373 within 2 a minute (research 0.378).
  - With the revised peak trigger (2026-10-22): 0.213 / 0.301 / 0.372 within 0.5 / 1 / 2 a minute.
- The Rust live path scores two real held-out recordings exactly as the trainer does (largest difference 6e-17), with motion arriving 60 ms after the pulse.
- **A model trained in the app on these recordings,** holding out the five 10-17 recordings:
  - The cut-off came out at 0.85.
  - Its replay of the training recordings caught 22% of pinches at 1.6 false activations a minute.
  - On the 10-17 recordings it caught 10% of pinches. Those recordings' labels run 0.7–1.3 s late, so this is expected.
  - It is kept as Monitor-only.

## Findings from building it

Building the model into the app turned up these, beyond the studies above.

1. **Live, the pulse and the motion are on different clocks.**
   - The pulse sensor stamps its samples with the Samsung SDK's clock. The motion samples, and every watch message, use the watch's `elapsedRealtimeNanos`.
   - The recorder already maps each pulse sample onto the watch clock with the smallest send-time minus newest-sample offset seen in the last 30 s (`SourceClockMap`), so the recordings line up within about 130 ms.
   - The runtime did not need this while models read the pulse alone. A model that reads both does, so the runtime now applies the same rule from each batch's send time.
   - With that, the live path scores real held-out recordings exactly as the trainer does.
2. **The two streams arrive separately, so a decision has to wait.**
   - Motion comes in batches every 100 ms and the pulse every 100 ms (10 Hz flush), independently.
   - A decision made as soon as its pulse sample arrives would hold the last motion sample over the missing ones, a window the trainer never saw. A decision therefore waits until the motion up to its moment has arrived, about 0.1 s of extra delay at most.
   - If the motion stops for more than 1 s, the model reports a stale stream instead of deciding without it.
3. **The runtime only decided on the newest pulse sample of each batch.**
   - That is about 10 decisions a second where the trainer replays 25.
   - It now decides on every sample, in order. Up to 50 waiting samples are handled per round, older ones are skipped.
   - Scores from the same moment go through the detectors together, so labels that cannot coexist are still judged on the same moment.
   - Old PPG-only models' detections can shift slightly because of this.
4. **The training sample leaves no negatives just after a start, so the score rises early.**
   - Positives are taken 880 ms after each start. Negatives inside holds are taken at least 1.5 s from either edge.
   - Nothing in training tells a moment 200 ms after a pinch's start from one 880 ms after. On synthetic recordings the score sat at 1.0 from about +200 ms to +1.4 s.
   - There, the edge rule fired at +200 ms, before the scoring window. The peak rule fired at the end of the plateau, after it. Both missed.
   - On real recordings the score peaks nearer +900 ms (median latency 900–918 ms in the checks), so the peak rule works there. But this is also why the edge rule fires early on real pinches (study 2).
   - Taking negatives from the first 0.5 s of each hold should sharpen the timing for both rules. It is untested.
5. **The startup clean-up would have deleted the old models.**
   - On startup the app removes every model and training run that is not of a kind it runs.
   - Changing the training contract alone would have purged every PPG-only model and its runs. Both kinds are now recognised.
6. **The IMU is recorded at 50 Hz, not 100.** One recording (2026-10-14T00-54-06) is at 100 Hz. That is too slow to see the brief vibration of fingertip contact (see point 4 of *What this means*).
7. **The cost is small.** A decision, 2,733 features and 300 trees, takes about 0.25 ms in a release build, so 25 a second per model is negligible.

## Fix: the first models caught almost nothing live (2026-10-22)

The first PPG + IMU model trained in the app (15 training and 6 held-out recordings, pinch against fist and hand-open) detected almost no pinches.

**The model was fine:**

- Held-out AUC was 0.996.
- On the 6 held-out recordings, 94% of pinches pushed the score to 0.5 or more and 79% to 0.8, peaking a median 880 ms after the start, exactly where it is trained to.

**The cut-off was the problem.** Two rules combined to push it to 0.95, where the peak trigger caught 17% (14 of 84):

1. **The budget was counted per hour without a gesture.**
   - These recordings are packed with gestures, so the 15 training recordings held only 3 minutes without one.
   - 10 false activations there count as 197 an hour, over the 120 allowed, at every cut-off.
   - Nothing met the budget, and the fallback took the cut-off with the fewest false activations: the highest on offer.
   - The research counts false activations per minute of the whole recording. The budget now does too (2 a minute).
   - The fallback is now the cut-off that catches the most starts less its false activations, never simply the highest.
2. **The peak trigger needed the fall to stay above the cut-off.**
   - A score that just touched 0.95 and fell straight back below it never fired.
   - It now fires on the first fall after the score has reached the cut-off, wherever the fall lands.

**Results.** Replayed on the 6 held-out recordings with the same model:

| Cut-off | Old peak rule | New peak rule | Edge rule |
|---:|---:|---:|---:|
| 0.95 | 14/84 (17%), 1.1 false/min | 30/84 (36%), 1.4 false/min | 29/84 (35%), 1.6 false/min |
| 0.90 | 34/84 (40%), 1.4 false/min | 42/84 (50%), 2.3 false/min | 35/84 (42%), 3.6 false/min |
| 0.70 | 43/84 (51%), 3.2 false/min | 47/84 (56%), 3.2 false/min | 24/84 (29%), 7.3 false/min |

**Retrained with both fixes:**

- The cut-off came out at 0.9: 57 of 224 training starts caught at 1.5 false activations a minute.
- On the held-out recordings it caught 42 of 84 pinches (50%, up from 17%) with 13 false activations (2.3 a minute).
- It is still Monitor-only: the go-live gate counts false activations per hour without a gesture, and these recordings have 66 s of that.

**On the benchmark.** The new peak rule raised the pinches caught within 0.5 and 1 false activation a minute from 0.156 / 0.236 to 0.213 / 0.301. Within 2 a minute it stayed at 0.37 (`app_fusion_check.py`).

## Training on moments just after a start (2026-10-24)

[`timing_negatives_check.py`](artifacts/ppg-benchmark-2026-10/timing_negatives_check.py), results in
[`timing-negatives/`](artifacts/ppg-benchmark-2026-10/timing-negatives/results.md).

**The idea.** Finding 4 above: training had no negatives just after a start, so the score rose early. This study adds, for
every pinch start, negatives at fixed offsets after it, and compares with the app's own sample. The setup is otherwise the
same:

- the same 20 splits;
- the app's features and trees;
- the runtime's peak rule;
- false activations per minute of recording.

The offsets were fixed before any were scored.

| Negatives added | Worst-split AUC | Mean AUC | Splits better | Recall ≤ 0.5/min | ≤ 1/min | ≤ 2/min | ≤ 5/min |
|---|---:|---:|---:|---:|---:|---:|---:|
| none (the app's sample) | 0.853 | 0.898 | – | 0.213 | 0.301 | 0.372 | 0.479 |
| **0, 200, 400 ms after the start** | **0.873** | **0.906** | 12/20 | **0.281** | 0.347 | **0.462** | **0.614** |
| 1.5, 1.8 s after the start | 0.854 | 0.900 | 8/20 | 0.226 | 0.302 | 0.427 | 0.569 |
| both | 0.865 | 0.899 | 8/20 | 0.237 | 0.367 | 0.427 | 0.592 |

**What it shows:**

- **The early negatives help at every budget.** About 9 more pinches in 100 are caught within 2 false activations a minute,
  at the same delay (about 910 ms).
- **The gain is not uniform:** they are better on 12 of the 20 splits. They were also picked from three variants on these
  splits, so the gain is a little optimistic.
- **Late negatives add little,** and adding them to the early ones does not beat the early ones alone.

**Now in the trainer** for the PPG + IMU model (`ppg_onset.EARLY_OFFSETS_MS`, kind `target_early`). A PPG-only spec
samples as before.

## A duplicate inflated the app's held-out test (2026-10-24)

The first PPG + IMU model trained in the app scored a held-out AUC of 0.996. Part of that was not real:

- Two of the app's recordings were each stored two or three times: once imported as a single CSV, again as a folder, with
  identical rows and different `#` lines.
- The split put copies on both sides: ee1f8363 and 62564c89 trained, while their copies 001cc3e2, dad6565c and e04bf86c were
  tested.
- So the test included recordings the model had trained on.

Model Lab now identifies recordings by their rows, flags copies, refuses to import one, and refuses to train on two.

## Where this leaves the project

- **The best model these recordings support is now in the app.** It catches about a quarter to a third of pinches at 1–2 false activations a minute on recordings it did not see. Every model trained on the current recordings will be Monitor-only, which is right.
- **Nothing here is an untouched test.** All 37 recordings were used to choose the method. The one-shot test on a new day (2026-10-14, [held-out test](ppg-onset-heldout-test-2026-10-14.md)) gave 0.60–0.64 AUC with the earlier PPG techniques. Expect the same kind of drop for this model on new recordings.
- **The next gains come from data, in this order:**
  1. long everyday-movement sessions as negatives, with hard-negative mining from this model's Monitor detections;
  2. camera-timed pinch labels, so each recording's label lag (−1.4 to +0.85 s in the audit) is measured rather than guessed;
  3. a higher IMU rate;
  4. one or two new days kept sealed for a final test.

## Reproducing

From the repository root, each run takes about 2–3 minutes:

```sh
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/imu_fusion.py [out_dir]
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/trigger_rules.py [out_dir]
uv run --project tools/label-trainer python docs/research/artifacts/ppg-benchmark-2026-10/label_shift.py [out_dir]
```

`trigger_rules.py` and `label_shift.py` reuse `imu_fusion.py`'s inputs. All three reuse `multiscale_zscore.py` and `reproduce.py`.
