# How data reaches the model: training against live use, 18 November 2026

## Result

- **The computation is the same.** On the nine 45 s miss clips saved on 13 November, every score the app made live equals the
  trainer's on the same saved samples. In four clips the two are identical to 1e-15. In all nine, every decision above the
  model's cut-off is the same live and offline. See `compare.py` and `results.md`.
- **What differs is which samples the app gets to decide on.** The trainer scores every pulse sample of a recording. Live,
  the app skipped a few of them (0–36 per clip, depending on how the sequences align), always near a `reset` in the live log.
- **A regression since 18 November makes this much worse.** Since the watch update of 17 November (`c21f6c4f`), the
  desktop has refused about 80 watch messages in under two hours. Each refusal throws away all buffered telemetry and
  cancels any gesture in progress, so the model is blind for about 11 s while its window refills. Details below.
  **Fixed on 19 November in `db3e85a1`:** the watch keeps messages in sequence order, and a late message now ends any
  grab without discarding the buffered telemetry. After the fix, five minutes of streaming had no refused message.

## Training, step by step (`label_trainer`)

1. A recording's PPG rows are on the watch clock: `ppg_clock.csv` records the offset `SourceClockMap` used, which is
   the smallest gap between send time and the newest sample over the last 30 s. Old millisecond-stamped recordings
   are repaired.
2. There is one decision at every pulse sample (about 25 a second). For each decision, `cnn_input.inputs` builds the
   input:
   - It sets up an 11 s grid at 100 Hz for CNN v2, filled by zero-order hold from samples at or before each tick.
   - Each channel is scaled by its median and 1.4826 × MAD, leaving out fast-turning ticks.
   - The last 1 s is passed through a sigmoid.
   - It adds the accelerometer's jerk envelope as a tenth channel.
   - If either stream has a gap over 250 ms, the decision has no input.
3. Labels come from `manual_label` when it is set, otherwise from `label`. A decision is positive 0.4–0.6 s after a
   start, and is left out from 0.2 s before a start to 1.2 s after it.
4. Training adds noise-overlay copies and augmentation (scale, noise, shift, pulse blanking, warps). Negatives are
   **subsampled to 40,000 per network**, out of about 236,000. Positives are weighted up to 3 times.
5. The cut-off is chosen on held-out training folds. Replay applies the jerk gate, which zeroes any score with no
   accelerometer spike in the last 600 ms.

## Live use, step by step (`label-inference::pipeline`, `runtime`)

1. Pulse batches arrive about every 100 ms and motion arrives in packed batches. Pulse samples are placed on the watch
   clock by `ClockMap`, the same rule the recorder uses.
2. There is one decision at every pulse sample once the motion up to it has arrived. It uses the same input code
   (`pinch_inference::cnn_input`, kept equal to the trainer's by shared fixture tests) and the same jerk gate.
3. The live app checks more than the trainer does. Any one of these refuses the window:
   - a stream is stale (over 1 s)
   - a gap is over 250 ms
   - there are too few samples
   - contact quality is above 0

   Contact quality was never flagged in the 73 hand-labelled recordings.
4. At most 50 backlogged decisions are made per round; older ones are skipped. After `set_models` (a registry change),
   only the newest sample is decided.
5. **A refused message is handled differently:**
   - A pulse or motion batch whose timestamps go backwards (`BadStream`) is dropped whole, its samples are never
     decided, and every detection is released.
   - A watch message the bridge refuses (out of order, or malformed) calls `fail()`: all buffered telemetry is
     dropped, every detection is cleared and automation is cancelled.
   - Neither reason is written to the live log, which records only `reset`.

## The regression

Since `c21f6c4f`, the watch's send queue puts control messages (wear state, button, sensor status) ahead of the
telemetry already waiting. Every message takes its sequence number from one counter when it is made. So a wear-state
message made after three queued telemetry messages is sent before them with a higher number. The desktop's bridge then
refuses the three as "out-of-order or duplicate sequence", and the app calls `fail()` for each.

The desktop log of 18 November confirms this:

- There are 80 refusals between 14:56 and 16:47 UTC, none before the watch connected that day.
- The refused sequences come in runs that sit just below the next message's number, for example 1748952–1748954
  refused after 1748955.
- There are also 20 "malformed" refusals (bad packed motion, bad JSON) in the same period. Their cause is not
  established.
