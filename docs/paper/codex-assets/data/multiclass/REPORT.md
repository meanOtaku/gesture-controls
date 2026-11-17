# Single multi-gesture CNNv2 experiment

## Scope and protocol

- One CNNv2 backbone with a four-logit softmax head: no gesture, pinch-in, pinch-out, pinch-hold. Three independent training seeds (17, 18, 19); **no ensemble**.
- Reused the current 100 Hz, 10-channel CNNv2 causal feature builder: accelerometer, gyroscope, green/red/IR PPG, accelerometer jerk envelope. One-second input, approximately eleven seconds of required history for scaling.
- **State-classification adaptation:** targets are the effective annotated state at decision time minus 500 ms. Pinch-hold uses its entire annotated interval. This is NOT identical to the production binary onset target (positive only 400–600 ms after each onset), and is not a drop-in deployment bundle.
- Existing CNNv2 benchmark recording pool: 18 training, 4 validation, 16 test recordings. Four validation recordings were removed from the original 22 training recordings. No test labels selected weights, epochs or thresholds. Test data has been used in earlier project research: this is an exploratory held-out comparison, NOT a newly collected untouched release test.
- The four explicit state labels are used without boundary trimming. The loader uses manual_label when populated, otherwise the recorded label. Background includes unlabeled inter-gesture time, still, supported and everyday-noise labels. Fist and other unassigned gestures are not included.
- Raw PPG and IMU sample fingerprints verified disjoint across training/validation/test, not merely different filenames. Existing overlapping alternate exports are excluded by the original benchmark cohort. Input gaps over 250 ms and missing initial normalization history cannot be scored.
- 20 epochs; Adam 0.001, weight decay 0.0001, cosine schedule, batch 128, existing v2 magnitude/time warping, noise, temporal shift and PPG blanking. Background training capped at 40,000 examples; inverse-frequency class weighting capped at 3. Seeds are fixed, but CUDA cumsum in the existing time-warp augmentation lacks a deterministic kernel: bitwise repeatability is not claimed.
- No stillness or jerk gate: this measures the network, including genuine everyday negatives, not a gate hiding classifier mistakes.
- The older repository recording manifest does not register the hand-labelled cohort. A separate SHA-256 snapshot was made for this exploratory study; source recordings and the repository baseline manifest were not changed.

## Results

Primary predeclared seed 17: accuracy **95.73%**, balanced accuracy **77.09%**, macro-F1 **0.7784** over 103,347 valid held-out decisions.

Class precision / recall / F1:

- no_gesture: 97.41% / 98.52% / 0.9796 (n=94,610).
- pinch_in: 75.62% / 75.09% / 0.7536 (n=2,425).
- pinch_out: 70.98% / 84.82% / 0.7729 (n=2,148).
- pinch_hold: 77.60% / 49.93% / 0.6076 (n=4,164).

Across three independent seeds, macro-F1 mean 0.7778, range 0.7730–0.7821; accuracy mean 95.52%, range 95.22–95.73%. These are seed-variation summaries on the same split, not confidence intervals.

Per-seed results:

- Seed 17: accuracy 95.73%, balanced accuracy 77.09%, macro-F1 0.7784; validation-selected confidence threshold 0.8.
- Seed 18: accuracy 95.61%, balanced accuracy 77.49%, macro-F1 0.7821; validation-selected confidence threshold 0.8.
- Seed 19: accuracy 95.22%, balanced accuracy 78.00%, macro-F1 0.7730; validation-selected confidence threshold 0.9.

## Continuous event replay

The standard trainer temporal detector and event accounting were reused, with a class score suppressed whenever another class wins. A shared confidence threshold was selected by four-class macro-F1 on validation only, NOT by test results or a false-activation-budget sweep. Pinch-hold event recall here means recognizing entry into hold; it does not validate physical hold-duration accuracy. Predictions represent a 500 ms-delayed annotated state; latency is still measured from the original label onset.

- pinch_in: 125/179 caught (69.83%), miss rate 30.17%; 14 false activations / 1.0520 negative hours = 13.31/h; median matched onset latency 743.63179 ms; repeats 0; late 20.
- pinch_out: 140/181 caught (77.35%), miss rate 22.65%; 24 false activations / 1.1036 negative hours = 21.75/h; median matched onset latency 724.886041 ms; repeats 0; late 3.
- pinch_hold: 122/167 caught (73.05%), miss rate 26.95%; 50 false activations / 1.0800 negative hours = 46.30/h; median matched onset latency 744.4059645 ms; repeats 8; late 28.

## Context sensitivity (seed 17)

- live: accuracy 73.09%, macro-F1 0.7609. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.
- moving: accuracy 83.87%, macro-F1 0.7495. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.
- resting: accuracy 91.59%, macro-F1 0.8288. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.
- everyday: accuracy 99.10%, macro-F1 0.2489. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.
- still: accuracy 99.81%, macro-F1 0.2498. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.

## Interpretation limits

- Do not equate high overall accuracy with safe live control: background dominates this corpus. Use per-gesture recall, macro-F1 and continuous false activations.
- This experiment establishes how a single state classifier performs on this cohort. It does not establish superiority over separately trained production onset models: no matched binary controls were trained, and the target definitions differ.
- Labels are the current annotations; optical/motion morphology is not independent physical onset/offset ground truth. The 500 ms label delay is intentional and is not zero-latency recognition.
- One fixed recording-held-out split, three seeds. No cross-day-grouped cross-validation or untouched deployment test. Live-model settings and artifacts were not modified.

## Verification and artifacts

- Independently recomputed confusion matrices, accuracy, balanced accuracy and macro-F1 from saved per-recording prediction vectors for all three seeds and validation/test roles.
- Verified class-probability sums, timestamp order, snapshot SHA-256, all checkpoint hashes, checkpoint save/reload parity, and a runnable delayed-label mapping self-test.
- `confusion-matrix.png`: seed-17 percentages and counts. `confusion-matrices-three-seeds.png`: seed robustness. CSV matrices, results JSON, audit JSON, snapshot, checkpoints and prediction vectors retain the underlying evidence.
- GPU: NVIDIA GeForce GTX 1050 Ti; PyTorch 2.5.1+cu124; parameters 30,468; measured training time seed 17 2341.1 s; peak PyTorch allocated memory 96.9 MiB.
