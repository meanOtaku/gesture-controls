# Wrist PPG for hand, finger, and pinch recognition: literature and acquisition priorities

Research cutoff: **21 October 2026**. This is a literature report, not a new experiment or a claim that this repository's detector meets a deployment target.

## Scope and reading rules

The central question is whether **raw wrist PPG alone can detect intentional pinches in continuous everyday use**, including unfamiliar days, strap fits, postures, and non-pinch activity. A classifier that distinguishes already located gesture clips answers only part of that question. In this report, “PPG-only” requires optical inputs for classification; any non-PPG segmentation dependency is explicitly identified. Cameras and force sensors used only for annotation do not make the deployed classifier multimodal.

Searches combined *PPG / photoplethysmography* with *hand / finger / pinch / gesture / smartwatch / wrist*, plus *sensor shift / force / review / dataset*. Backward and related-paper searches followed FinDroidHR, Zhao's conference and journal papers, the Ruan/Ling lineage, the noninvasive-wearable review, and recent OpenWatch and μDPad references. This was a targeted literature search, not an exhaustive systematic review. Authentication, pulse-rate estimation, remote camera PPG, and optical proximity sensing were not treated as evidence for wrist PPG gesture recognition.

All numbered literature citations below link directly to a DOI, publisher article, or versioned arXiv paper. Publisher pages were inspected where accessible; blocked ACM/IEEE pages were supplemented by the paper's author-hosted manuscript or author-uploaded full text. **Full text**, **abstract only**, and **related-record only** distinguish the evidence actually inspected. “Unverified” means unavailable in the inspected material, not necessarily absent from the full paper. Recommendations are this report's proposals; their quantities are acquisition targets, not published minimum sample requirements.

## What the evidence establishes

Commercial-watch feasibility exists: FinDroidHR classified a vocabulary containing pinch from optical measurements, while fSense studied exerted force. Neither result establishes a low-false-activation, continuously running everyday pinch detector. [P1][P2]

Hardware geometry matters when interpreting results: the INFOCOM prototype had two green-light sensors; the PCA study used four spatial sensor sites at each wavelength. Their inputs are not interchangeable with three wavelength streams from a watch. [P3][P5]

Read the entire pipeline before accepting “PPG-only.” Eddy et al.'s PPG classifier uses accelerometer-derived gesture boundaries. Zhao's journal headline includes motion-sensor fusion, and OpenWatch's reported PPG benefit is an addition to IMU. [P10][P11][P8]

The most actionable evidence concerns robustness rather than classifier complexity: sensor-shift experiments, cross-day evaluation, and force variation directly motivate how to collect the next recordings. [P6][P7][P11]

## A. PPG-only studies on commercial smartwatches

### P1. Zhang et al. — FinDroidHR: Smartwatch Gesture Input with Optical Heartrate Monitor (2018)

**Full text; commercial smartwatch; PPG recognition with a separate IMU comparator.** [P1]

- **Device/data:** Samsung Gear S3 Frontier, green PPG; 20 participants. The paper describes 100 Hz PPG with a “200 Hz sample rate”; this terminology should not be silently interpreted as 200 independent optical samples/s. Approximately 20–25 repetitions per gesture per condition. [P1]
- **Protocol/labels:** Ten selected gestures include hand open/close, wrist up/down, rubbing, flicking, finger clicking, pinch, and four-finger movements. Trials use 3 s capture windows; sitting, standing, walking, and tram conditions are examined. Gesture boundaries are checked by observation/stopwatch. Pinch and middle/ring clicking are reported confusers. [P1]
- **Processing/evaluation:** Wavelet denoising, normalization, gradient-based movement segmentation, feature selection, linear SVM/RF; 10-fold cross-validation, without a demonstrated participant/day-disjoint interpretation. Resting measurements calibrate segmentation. [P1]
- **Results/caveats:** Best SVM accuracy 90.55%, recall 90.73%. Selected-vocabulary clip classification and condition calibration do not establish spontaneous event detection or false activations/hour. [P1]

### P2. Buddhika et al. — fSense: Unlocking the Dimension of Force for Gestural Interactions using Smartwatch PPG Sensor (2019)

**Full text; commercial smartwatch; PPG-only force classification.** [P2]

- **Device/data:** Gear 3 Frontier, 25 Hz; 12 participants; 168 trials/person: 14 gestures × four states × three blocks. Trials take approximately 1–2 s. [P2]
- **Protocol/labels:** Pinch, fist, thumb/watch taps, and object grasps; randomized blocks. Soft/medium/hard force is self-selected, with no-action as baseline. There is no calibrated force ground truth; medium force is ambiguous. [P2]
- **Processing/evaluation:** Actions standardized to 43 samples; five-sample moving average, gradient, eight statistics in 20-sample windows with 50% overlap. SVM, multinomial logistic regression, RF; 10-fold CV, pooled and per-user analyses. Subject-disjoint testing is not established. [P2]
- **Results/caveats:** RF: 46.3% for three force levels, 71.7% for soft versus medium+hard, 69% for hard versus medium+soft; force versus no-action 92.1%. These are force decisions across gestures, not pinch identity or open-world detection. The paper specifies moving-average smoothing; the author's project summary describes it differently, so the paper is followed here. [P2]

## B. PPG-only studies on custom wrist hardware

### P3. Zhao et al. — PPG-based Finger-level Gesture Recognition Leveraging Wearables (INFOCOM 2018)

**Full text; custom wristband, not a tested commercial smartwatch.** [P3]

- **Device/data:** Two adjacent green-LED PPG sensors, Arduino UNO; default 100 Hz, with lower-rate experiments. Ten adults; 3,600 segments from nine gestures repeated 40 times/person. [P3]
- **Protocol/labels:** Prompted single-hand finger-level ASL gestures, worn on the right wrist. Classes are illustrated as S1–S9; this is not a nine-word continuous sign-language task. Observation supplies boundary references; no independently synchronized contact sensor is established. Everyday negative exposure is not quantified. [P3]
- **Processing/evaluation:** A 2 Hz high-pass filter is used for coarse detection only; short-time energy, derivative/energy onset and DTW pulse-return ending detection refine segments. Raw gesture information is retained for time/frequency/template features and binary gradient-boosting classifiers. Twenty Monte Carlo rounds use 50% training, 50% validation. [P3]
- **Results/caveats:** Mean nine-class accuracy 88.32%, SD 2.3%. Fixed sensor placement and random segment splits do not establish transfer after refitting or to unseen people; completed-segment recognition is not early pinch onset detection. [P3]

### P4. Subramanian, Savur, and Sahin — Using Photoplethysmography for Simple Hand Gesture Recognition (2020)

**Full text; custom PPG band; sEMG is a comparator, not a fused input.** [P4]

- **Device/data:** Three wrist PPG sensors near radial/ulnar arteries, ESP32 acquisition, 60 Hz. Four subjects; 775 examples, including 175 reject examples. [P4]
- **Protocol/labels:** Thumbs-up, fist, wave-in, wave-out, reject. Visual prompts and Lab Streaming Layer event markers define recordings. Prompt clock accuracy does not itself measure execution onset; reject-class everyday coverage is not established. [P4]
- **Processing/evaluation:** One-second, 60×3 segments; DC removal and low-pass filtering. Eight features/channel, feature ranking/PCA, cubic SVM and gradient-boosted trees. Reported 77/23 train/test allocation and five-fold validation; no participant-disjoint claim. [P4]
- **Results/caveats:** Test accuracies are 93.36% for SVM and 91.8% for boosting. Table IV's pooled SVM **precision** is 92.4%, recall 91.2%, F1 91.79%. The review's 92.4% “accuracy” should not replace the primary paper's metric labels. No pinch class or long continuous deployment evaluation. [P4][R1]

### P5. Ruan et al. — Principal component analysis of photoplethysmography signals for improved gesture recognition (2022)

**Full text; custom spatial array; PPG-only.** [P5]

- **Device/data:** Four MAX30105 sites, each red/IR/green, 100 Hz/channel; 14 subjects. Approximately 50 repetitions/gesture sitting or walking, 25 jogging or running. [P5]
- **Protocol/labels:** Fourteen classes: six wrist, seven finger, relaxed baseline. Execution includes raising the arm to the chest and returning it. Treadmill speeds are 3/5/8 km/h. Prompted class labels and signal-threshold boundaries; independently measured onset unverified. [P5]
- **Processing/evaluation:** PCA across four spatial channels **of the same wavelength**, component amplitude normalization, reconstruction, threshold segmentation, 32-point envelopes. Linear SVM/1-NN; subject-specific random 10% training/90% testing, cross-validated. [P5]
- **Results/caveats:** Sitting red-PPG SVM accuracy 99.44% ±0.41%. This is neither three-color PCA nor cross-day validation. Complete-gesture normalization and coordinated arm raising differ from causal, still-arm pinch detection. The dataset is explicitly reused from Ling et al. (2021), so these are not independent replications. [P5]

### P6. Fang et al. — Exploration on the Negative Effects of Sensor Shifts in Photoplethysmography-Based Gesture Recognition and a Solution Based on Transfer Learning (2023)

**Abstract only; PPG study; exact hardware and smartwatch status unverified.** [P6]

- **Device/data/protocol:** Ten participants, 14 gestures, ten batches with sensor shifts. The accessible abstract does not identify sensor model, wavelength, sample rate, repetitions, gesture names, or everyday confusers. [P6]
- **Labels/processing:** Detailed ground truth, segmentation, normalization, and windows are unverified. Do not assume the earlier group's hardware or PCA procedure was reused. [P6]
- **Model/evaluation:** LSTM transfer learning; single-batch versus multibatch experiments and calibration-data-size comparisons. Exact batch partitions and adaptation/test separation require full text. [P6]
- **Results/caveats:** The abstract reports a 59.24% recognition-accuracy drop from sensor shifts and improvement with transfer learning, particularly with little calibration data. Its wording does not establish whether that drop is relative percent or percentage points. It motivates refit testing, not a promised calibration improvement for this repository. [P6]

### P7. Li et al. — Feasibility of Wearable PPG for Simultaneous Hand Gesture and Force Level Classification (2023)

**Full text; custom watch-like wristband; PPG-only inference.** [P7]

- **Device/data:** MAX30101 red/IR/green, 200 Hz; 14 healthy participants. Four pinches × three force levels × ten five-second trials/person. [P7]
- **Protocol/labels:** Thumb–index, thumb–middle, thumb–ring, key pinch; 10/40/70% maximum voluntary contraction. A P100 dynamometer sampled at 1 kHz provides force feedback/reference. Participants sit still and pinch an instrument; no everyday non-pinch class. [P7]
- **Processing/evaluation:** Fourth-order 1 Hz low-pass filter; 200 ms windows, 100 ms step; five time-domain features. SVM/RF/LDA/KNN, individually trained models, leave-one-trial-out evaluation; five-fold hyperparameter search. [P7]
- **Results/caveats:** Best joint 12-class accuracy 77.5%, SVM with all wavelengths. Force changes affect gesture discrimination. This concerns sustained instrumented force, not light transient finger contact; 200 ms windows do not prove 200 ms end-to-end latency. Trial grouping is stronger than random overlapping-window splits, but is not unseen-day or unseen-user testing. [P7]

## C. Commercial smartwatches with PPG + IMU

### P8. Bonazzi et al. — OpenWatch: A Multimodal Benchmark for Hand Gesture Recognition on Smartwatches (2026)

**Full text, arXiv v2; preprint; Huawei Watch GT 4.** [P8]

- **Device/data:** PPG plus 100 Hz six-axis IMU; 50 participants, 78 sessions, over ten hours, 59 gesture-sequence labels. Optical channels are averaged; native PPG rate is not independently established here. [P8]
- **Protocol/labels:** Benchmark: double-clench, double-pinch, pinch-up/down, slide, plus negative activities such as typing/grabbing. Visual instructions provide class labels; IMU bandpass/envelope/peak detection locates clips. [P8]
- **Processing/evaluation:** Drift correction, training-split z-scores; 1 s windows at 0.2 s stride. MixToken and NormWear variants; claimed subject-independent evaluation, clip voting/consecutive-window aggregation. Exact participant allocation should be checked before reuse. [P8]
- **Results/caveats:** Adding PPG to NormWear improves clip macro-F1 by 0.125; MixToken reports 0.903 clip macro-F1, but that is not a PPG-only result. Neither the 59-label corpus nor the five-command benchmark establishes continuous 59-class recognition. IMU-derived boundaries preclude treating released clips as an end-to-end PPG-only detection benchmark without further annotation. [P8]

### P9. Rylo, de Medeiros, and de Lucena Jr. — Gesture recognition of wrist motion based on wearables sensors (2022)

**Full text; Galaxy Watch 4; PPG + accelerometer + gyroscope.** [P9]

- **Device/data:** PPG 25 Hz, motion sensors 100 Hz. Section 3.1 states 16 participants/2,240 samples; §3.2 states 12 participants. This inconsistency is unresolved. [P9]
- **Protocol/labels:** Seven wrist/finger movements plus resting calibration; 20 repetitions in 3 s intervals. Classes are illustrated rather than given reliable semantic names in the extracted text. Prompted trials; no independent execution-onset reference established. [P9]
- **Processing/evaluation:** Normalization, smoothing, PPG gradients/second-order change for segmentation; PPG/IMU features, feature selection, SVM/RF, five-fold CV. User/day grouping unverified. [P9]
- **Results/caveats:** Seven-gesture RF accuracy 0.820, F1 0.819; easier reduced vocabularies score higher. Selected features are predominantly inertial. Therefore this paper supports low-rate PPG-assisted segmentation, not 81.9% PPG-only pinch recognition. Collection excludes translational body movement. [P9]

## D. Custom or research wrist devices with multimodal inputs

### P10. Zhao et al. — Towards Low-Cost Sign Language Gesture Recognition Leveraging Wearables (2019 online; 2021 issue)

**Full text; custom prototype; both PPG-only and PPG+IMU experiments.** [P10]

- **Device/data:** Two green PPG sensors plus motion sensing; ten adults, over 7,000 PPG and 2,500 motion segments. Only seven original participants return for the fusion comparison. [P10]
- **Protocol/labels:** Nine prompted ASL finger gestures, static and body-motion conditions. Class identity follows the requested gesture; independent contact ground truth unverified. No quantified everyday negative hours. [P10]
- **Processing/evaluation:** Energy/gradient/DTW segmentation, engineered features and GBT; ResNet and transfer learning also evaluated. Default participant-dependent evaluation uses twenty 50/50 Monte Carlo splits. [P10]
- **Results/caveats:** Fusion yields over 98% mean precision/recall in the seven-person comparison. This is not the PPG-only result, nor evidence from a stock watch. It extends the INFOCOM work and should not be counted as an independent replication of that pipeline. Random segment splits and selected ASL gestures differ from refitted-day, continuous pinch detection. [P10]

### P11. Eddy et al. — Discrete Gesture Recognition Using Multimodal PPG, IMU, and Single-Channel EMG Recorded at the Wrist (2024)

**Full text; commercial BioPoint research sensor, not a consumer smartwatch.** [P11]

- **Device/data:** PPG/ACC 50 Hz, one EMG channel 2 kHz; 12 people. Twenty repetitions/class initially, five/class in four additional arm positions, twenty/class 3–7 days later after replacement. [P11]
- **Protocol/labels:** Rest, wrist flexion/extension, hand open/close, middle-finger–thumb double tap, snap. Prompted 2 s trials; **ACC derivative segments every modality**, including the “PPG-only” classifier. [P11]
- **Processing/evaluation:** 200 ms windows/100 ms stride, wavelet features, three-layer LSTMs, user-dependent leave-one-repetition-out baseline; separate position/day tests. [P11]
- **Results/caveats:** PPG accuracy: 79.7% baseline, 56.6% unseen positions, 39.4% across days. ACC+PPG: 94.8/75.8/71.5%; all three: 96.1/82.4/74.2%. These are completed-gesture classifications, not false-activation measurements. The PPG ablation's inertial boundary dependency must be retained when interpreting its transfer results. [P11]

### P12. Wang et al. — A Novel PPG-FMG-ACC Wristband for Hand Gesture Recognition (2022)

**Full text; custom wristband; PPG + force myography + accelerometry.** [P12]

- **Device/data:** PPG 100 Hz; FMG/ACC 40 Hz. Nine people; ten trials with twelve five-second gestures, first familiarization trial discarded. [P12]
- **Protocol/labels:** Six wrist postures and six hand/finger postures, including hand open/close, thumbs-up, OK, victory, finger-heart. Seated, supported elbow; protocol triggers label gestures. Independent contact timing and everyday null activity are unverified. [P12]
- **Processing/evaluation:** 200 ms windows/100 ms overlap, feature extraction/selection and attention-fusion CNN (CNN-AF); subject-dependent leave-one-trial-out evaluation. [P12]
- **Results/caveats:** Fusion precision/recall 97.9%, F1 97.5%. Table IV defines F1 differences by subtraction: the 40.1 improvement over PPG is **percentage points**, not a relative improvement. FMG is an additional sensor, not another PPG wavelength. Static postures and within-user trials do not establish arbitrary-pinch onset detection or watch-only performance. [P12]

### P13. Hauptmann et al. — μDPad: A Large-Scale Multimodal PPG and IMU Dataset for Wrist-Worn Microgesture Recognition (2026)

**Full text; custom prototype, not a stock smartwatch.** [P13]

- **Device/data:** MAX86177A eight-photodiode spatial layout plus QMI8658 IMU, 112 Hz. Sixty-six recorded participants after two hardware exclusions; six further outliers excluded from evaluation. Twenty-five hours, 28,000 gesture/16,000 negative samples; nine video hours. [P13]
- **Protocol/labels:** Thumb swipes, pinch close/open, side tap, held-pinch rotation; typing, handwriting, grasping negatives. Random prompts; video refines a subset. [P13]
- **Processing/evaluation:** Per-channel z-normalization, 150-sample windows, VGG-like CNN; participant-disjoint eight-fold ablations, HMM and ACC activity gating online. [P13]
- **Results/caveats:** Table 2 PPG-only accuracy/F1 47.1/35.3%; fusion 83.7/77.0%. Online HMM: 78.6/71.5%, FPR 5.3%. The abstract's 83.7%/3.7% pairing differs from the online section; do not merge these. FPR is not false events/hour. Spatial channels differ from watch wavelength streams, and full online inference requires IMU. [P13]

### P14. Hu et al. — WatchForce: Wrist-worn PPG and IMU sensing for hand force estimation (2026)

**Publisher abstract/introduction inspected; full manuscript retrieval unsuccessful; adjacent force task.** [P14]

- **Device/data:** Wrist PPG+IMU; 16 participants. The paper describes smartwatch-compatible sensing and leaves commercial-watch hardware validation to future work. Specific sensor model/rates and recording totals remain unverified. [P14]
- **Protocol/labels:** Three force levels and MVC-normalized continuous force; posture, motion, lighting tests. Detailed gesture taxonomy, force-reference instrument, confusers, preprocessing, and windowing remain unverified. [P14]
- **Model/evaluation:** Vision Transformer with bidirectional InfoNCE alignment; user-dependent, session-level “universal,” and leave-one-subject-out evaluations. [P14]
- **Results/caveats:** Universal classification 86.31%; LOSO 78.50%, regression nRMSE 0.1509 and R² 68.04%. Session-level universal is not equivalent to unseen-user testing. These are multimodal force estimates, not PPG-only gesture identity or consumer-watch deployment results. [P14]

### P15. Multi-modality gesture recognition for portable wearables: A high-integration system combining electromyography, inertial measurement unit, and photoplethysmography (2026)

**Publisher abstract/introduction inspected; custom integrated smartwatch-form-factor hardware.** [P15]

- **Device/data:** Eight integrated EMG electrodes yielding three channels, plus IMU and PPG; 199 subjects, 4,132 samples. Rates and raw recording duration unverified. [P15]
- **Protocol/labels:** Fist, double pinch, double rub, single pinch, and daily-activity null scenarios. Exact null taxonomy, execution timing, reference annotation, filtering, and windowing unverified. [P15]
- **Model/evaluation:** Multi-branch CNN with squeeze-and-excitation attention; subject-independent 3,220/356/556 train/validation/test samples. [P15]
- **Results/caveats:** Best fusion accuracy 98.24%, 0.0544 million parameters. This is an EMG+IMU+PPG result; no independently verified PPG-only score or continuous false-activation rate was recovered. A compact form factor does not make the sensor stack equivalent to this repository's Galaxy Watch inputs. [P15]

## E. Closely related records, reviews, and acquisition evidence

### Ling et al. (2021): important predecessor, incomplete access

*Comparative Study of Gesture Recognition Based on Accelerometer and Photoplethysmography Sensor for Gesture Interactions in Wearable Devices* is a verified IEEE record. Its original full text was not recovered. Device, participants/recordings, protocol/confusers, labels, preprocessing/windows, split, and numerical results therefore remain **unverified from this paper itself**; no headline accuracy is assigned here. P5 documents the shared dataset. Comparison of ACC and PPG should not automatically be called fusion. [L1][P5]

### WF-PPG (2025): contact-pressure dataset, not gesture recognition

*WF-PPG: A Wrist-finger Dual-Channel Dataset for Studying the Impact of Contact Pressure on PPG Morphology* uses a custom pressure-adjustable wrist setup and simultaneous fingertip reference, with ECG, pressure, blood pressure, and oxygen-saturation measurements; 27 healthy young participants. Its ground truth concerns contact pressure/physiology, not pinch events. A gesture vocabulary, gesture classifier/split, and recognition accuracy are **not applicable**. Detailed windowing and recording counts were not extracted. This source supports measuring fit/contact conditions; it does not establish that pressure correction preserves gesture information. [A1]

### Reviews and synthesis checked

- **Tchantchane et al. (2023), A Review of Hand Gesture Recognition Systems Based on Noninvasive Wearable Sensors:** broad sensing/multimodal review; optical subsection and references were useful for finding P1/P4/P10. Review summaries are secondary evidence. In particular, the Zhao journal result must retain its fusion context, and Subramanian's metric labels should come from the original tables. Reviews have no single device, participant cohort, gesture protocol, ground truth, model, or split to compare with a primary experiment. [R1][P4][P10]
- **Charlton et al. (2023), The 2023 wearable photoplethysmography roadmap:** broad PPG research roadmap covering acquisition variability, multiwavelength sensing, and quality assessment. It motivates recording skin/contact/physiological context; it is not evidence for gesture recognition accuracy. Gesture-specific participant counts, labels, windows, classifiers, and results are not applicable. [R2]
- **Guo et al. (2024), Fine-grained Gesture Recognition and Sign Language Interpretation via Photoplethysmography (PPG) on Smartwatches:** synthesis/book chapter revisiting the two-sensor, nine-gesture research. Do not count its described 10-adult/3,600-gesture experiment as an additional independent validation or infer commercial-watch acquisition from the chapter title. Its task remains gesture classification, not continuous everyday pinch detection. [R3]

## Comparability checklist for interpreting these papers

These are analytical distinctions, not additional experimental findings:

| Dimension | What must match before comparing a paper with this repository |
|---|---|
| Sensor inputs | Optical classification **and** optical event segmentation; exclude inertial gates from a PPG-only claim. |
| Hardware | Stock watch versus distributed wrist array; wavelength count versus independent spatial paths; raw access versus internal averaging. |
| Target | Contact onset, held force, pose, release, double-pinch sequence, or completed gesture. |
| Context | Still-arm finger movement versus coordinated arm raising, object squeezing, or treadmill protocol. |
| Negatives | Rest/calibration, other selected commands, deliberately elicited confusers, and long natural activity are different populations. |
| Split | Random windows, whole trials, sessions, days/refits, and unseen participants answer different generalization questions. |
| Causality | Complete-clip amplitude normalization, resampling to known endpoints, and bidirectional/offline processing can consume future information. |
| Metric | Multiclass accuracy, onset AUC, clip macro-F1, window FPR, event recall, and false activations/hour are not interchangeable. |
| Independence | Follow-up papers and reused datasets must not be counted as new replications. |

No pooled accuracy or ranking across papers is calculated because these dimensions differ.

## Repository context checked read-only

The watch client documents Galaxy Watch 4+ raw green/red/IR PPG through Samsung's `PPG_CONTINUOUS` tracker, with source timestamps and per-channel status. This describes the supported acquisition path, not a verified inventory of the physical watches used in every existing recording. [Watch client](../../apps/watch/README.md#raw-ppg-galaxy-watch-4-samsung-wear-os-only)

The current trainer is a PPG-only onset model: causal z-scores over 1/2/4 s histories, derivative statistics, and ExtraTrees, with decisions approximately 880 ms after labelled starts. It already separates training/evaluation recordings and replays full recordings to score starts, latency, and false activations/hour. Acquisition proposals below should preserve those capabilities. [Trainer](../../tools/label-trainer/README.md)

Earlier research identifies onset-label uncertainty and confusing fist/thumbs-up starts; the later mixed-era study states that its explored recordings no longer constitute an untouched final test. These are repository-specific observations, not academic-paper results, and the older slope-only findings should not be represented as an evaluation of the current trainer. [Onset questions](ppg-onset-open-questions-2026-10.md), [mixed-era study](ppg-mixed-era-robustness-2026-10.md#current-conclusion)

## Repository benchmark position and the closure-label experiment

The current reference is a causal, PPG-only pinch-start pipeline: 25 Hz zero-order-hold grid; 1/2/4 s causal z-score histories for green/red/IR; causal derivative summaries; and ExtraTrees. Across 37 recordings and 20 fixed recording-disjoint folds it measured minimum/mean/pooled event AUC **0.7885/0.8426/0.8105**, with **41.15%** matched pinch-start recall, **15.09** false activations/minute, and about **830 ms** latency at the frozen live rule. These explored-cross-validation scores do not replace the earlier new-day result of about 0.60–0.64 AUC against labelled non-pinch activity. [Onset questions](ppg-onset-open-questions-2026-10.md), [held-out test](ppg-onset-heldout-test-2026-10-14.md)

A closure-label experiment rebuilt the *training event table* from raw labels, treating qualifying `pinch`, `pinching`, and `fist` holds as positive starts. It retained the archived negative events and fixed recording-disjoint splits. The rebuilt table had 1,531 events, 565 positive. ExtraTrees measured minimum/mean/pooled event AUC **0.7742/0.8049/0.7982**. When replayed against the existing pinch-start timeline target, it reached **33.49%** pinch recall and **19.68** false activations/minute. Therefore it did not improve pinch deployment performance.

The closure event-AUC experiment is valid for the rebuilt training labels, but its continuous evaluator still uses the archived pinch-only start list. Its recall and false-activation values are consequently a **pinch-target replay**, not closure-target recall/false-activation metrics. A separate closure-specific timeline evaluation would be required before making any claim about a deployable generic closure detector. The earlier experiment that changed only evaluation labels without rebuilding training positives is discarded.

**Position relative to the literature:** the project is stronger than most papers at assessing a continuous causal PPG-only trigger—recording-disjoint evaluation, explicit fist/everything-else confusers, new-day testing, latency, and false activations—but its present detector is not useful for everyday triggering. Many much higher reported paper scores are prompted, pre-segmented, within-user/clip evaluations, multimodal systems, or use spatial PPG hardware rather than stock-watch wavelength streams. The closest strict evidence also shows PPG-only degradation across positions/days. [P1][P3][P6][P8][P11][P13]

## Prioritized acquisition changes for the everyday PPG-only pinch detector

These are concrete proposals for the next collection, **not changes implemented by this report**. The target remains PPG-only runtime inference; optional video, contact, force, or IMU measurements below are annotation/context channels and must not supply deployment features or test-time event gates.

### P0 — Define and independently timestamp the target

Define an intentional thumb–index contact onset as the primary event, separately marking movement start, first contact, held contact, release, and any second contact. Include a label for aborted pinches and ordinary object pinching without command intent. Agree whether the product must distinguish those intentions: identical physical acts may not carry distinguishable intent in PPG.

Record hand-only video at a proposed 60 fps or faster for controlled sessions, plus a visible synchronization event at both start and end to estimate clock offset/drift. Preserve cue timestamps separately from observed execution. Have a second annotator check a subset; record uncertain/occluded intervals explicitly. A contact switch or force sensor can validate a subset, but retain uninstrumented pinches because an object can change execution. The literature's prompted and instrumented tasks motivate this separation; they do not establish cue time as contact truth. [P1][P7][P13]

**Deliverable:** an additive event table with `participant_id`, `recording_id`, `event_id`, `gesture`, `movement_start`, `contact_onset`, `release`, clock mapping, annotation method, and uncertainty. Preserve the original labels and raw clocks. Do not infer ground truth from the same PPG step being evaluated. The repository's existing timing uncertainty makes this the first priority. [Onset questions](ppg-onset-open-questions-2026-10.md#8-mark-timing)

### P0 — Collect continuous negatives with identifiable causes

For each collection session, target **30–60 minutes of continuous no-command activity**, including explicit quiet rest, typing, mouse clicking, phone tapping/scrolling, writing, cup/utensil use, gripping, clothing adjustment, scratching, handwashing, and watch/strap touching. Mark task blocks and incidental finger contacts rather than assigning all unlabeled time to clean rest. Retain difficult or poor-contact intervals and identify them.

Add randomized matched trials of fist, thumbs-up, thumb–middle/ring contact, finger snap, rubbing, wrist flexion/extension, arm raising without pinch, and pinch release. Capture onset, hold, and return for negatives as carefully as for positives. This produces confusers for the event target rather than merely expanding a vocabulary of easy classes. Academic negative sets and pinch-like confusions provide examples, not assurance of complete everyday coverage. [P1][P8][P13]

**Deliverable:** per-activity exposure minutes and event labels sufficient to report false activations/hour by activity and overall. Save all raw continuous data; do not export only candidate-triggered clips.

### P0 — Reserve future days and strap fits before viewing signals

Start with a feasible within-user pilot: **six separate days, two complete remove/re-don sessions/day**. Assign days 1–3 to development, day 4 to threshold/model validation, and days 5–6 to a sealed final test. Do not inspect final traces or tune annotation offsets against their model scores. If the final test is used for development later, collect another future test.

Record a fit identifier, wrist side, strap hole/tension description, watch location relative to wrist landmarks, and a placement photograph. Cover comfortable normal/looser/snugger fits and modest placement shifts; do not rely on always returning to one marked location. Separate zero-calibration testing from a proposed refit-calibration mode: collect calibration first, then a distinct later test from that fit. Cross-day and sensor-shift evidence motivates this design. [P6][P11]

**Deliverable:** an immutable split manifest at the day/refit level. Keep all windows from a trial and session together. This pilot addresses personal reuse; a population claim additionally needs participants held out entirely.

### P1 — Factor pinch execution and movement context

Within each fit, target **at least 60 isolated pinch events**, balanced across light/normal/firm effort and arm positions such as desk-supported, elbow bent, hand by hip, and arm extended. Include brief contacts, longer holds, releases, and repeated/double contacts. Use comfortable effort descriptions for ordinary sessions; reserve calibrated force measurements for a subset. Randomize order and vary inter-event rest, retaining several seconds of preceding/following signal for causal baselines.

Cross positive and negative conditions: still arm with pinch; arm movement without pinch; walking with pinch; walking without pinch; object grasp with and without an intended command. Avoid a protocol in which every positive includes a distinctive arm raise or every negative comes from another recording. Force and position studies motivate these factors; they do not prescribe the proposed count. [P5][P7][P11]

**Deliverable:** a balanced acquisition manifest with context, effort, duration, object contact, and intentional-command fields; report missing combinations rather than silently treating them as covered.

### P1 — Preserve optical and timing provenance

Retain each raw green/red/IR value with its source timestamp and SDK status. Add recording metadata for device model, firmware, app/SDK build, requested/observed rate, wrist side, transport route, and disconnects. Preserve host arrival times separately to quantify batching latency. Log channel gaps, duplicated/out-of-order timestamps, clipping, and contact-status changes. Do not overwrite raw clocks with repaired timestamps or average wavelengths before export. This extends the documented acquisition path. [Watch client](../../apps/watch/README.md)

Measure actual intervals and valid-sample coverage for each channel in each recording. If the hardware exposes a higher native rate, acquire a small paired experiment at available rates and downsample offline using training-only decisions. Interpolation cannot create a higher native sampling rate. The varied published rates are not evidence for one universal optimum. [P2][P3][P7][P9]

Record contextual factors such as skin tone, wrist circumference, hair/tattoos at the site, ambient light, skin temperature proxy, and recent exercise/sweat when feasible. These are analysis strata and provenance, not required classifier features. Optical acquisition literature motivates the fields, but their impact on this particular pinch detector remains to be measured. [A1][R2]

### P2 — Size evaluation by exposure and events, not windows

Freeze the model, threshold, refractory rule, and event-matching tolerance before final capture. Report per-day/per-fit event recall, precision, duplicate triggers, median/p95 contact-to-output latency, false activations/hour, and usable-signal coverage. Include onset-uncertainty sensitivity and performance during each negative activity. Keep ROC/AUC and prompted-clip accuracy as secondary diagnostics. Build on the trainer's existing full-recording replay instead of selecting a new model from academic headline accuracy. [Trainer](../../tools/label-trainer/README.md)

Set a product false-activation target before deciding test duration. As an **illustrative statistical calculation**, under a constant-rate Poisson assumption, zero false activations in `T` hours gives an approximately `3/T` one-sided 95% upper rate bound (`-ln(0.05)/T`). Thus zero in 30 minutes still permits roughly six/hour; zero in 30 hours permits roughly 0.1/hour. Real activities cluster, so also report session-level uncertainty and the activity mix. This calculation is not a guarantee or a result from the papers.

## Coverage gaps and limits

- **No verified deployment-equivalent result:** this search did not establish a stock-watch, end-to-end PPG-only, continuously running intentional pinch detector with low false events/hour across unseen refits/days and natural everyday activity. This is a limit of the evidence located, not proof that such a detector is impossible.
- **Incomplete primary access:** Fang's shift study is abstract-only; Ling's original comparison is record-level; WatchForce and the 2026 integrated EMG paper have incomplete methods access. Exact unknown fields are listed above. Full-text acquisition would be especially valuable for shift magnitudes, calibration splits, sensor geometry, and null-class annotation.
- **Optical generalization:** direct comparisons between this repository's three wavelength streams and spatial PPG arrays are missing. Public multimodal datasets may average optical channels or rely on IMU segmentation. Reuse requires checking native channel semantics, timestamps, and whether continuous raw streams and independent labels are available. [P5][P8][P13]
- **Ground truth:** cue labels, signal-derived boundaries, force plateaus, and video contact onset are different targets. No common onset annotation standard was established across the inspected studies.
- **Population and duration:** the inspected PPG-only experiments do not establish broad coverage of skin characteristics, ages, wrist anatomy, motor differences, sweating, prolonged wear, firmware changes, or multiweek drift. Large multimodal cohorts do not close those PPG-only gaps.
- **Reported inconsistencies:** Rylo's participant counts conflict; μDPad's abstract and online section report different metric pairings; FinDroidHR's rate wording is ambiguous. These are retained as uncertainties rather than reconciled by assumption. [P1][P9][P13]
- **Availability is not reproduction:** DOI identity and direct-source destinations were checked, but publisher anti-bot/access restrictions prevented successful full-text retrieval for some links. No external dataset was downloaded into the repository, no paper's experiment was reproduced, and no claims of artifact completeness or reproducibility are made.

[P1]: https://doi.org/10.1145/3191788 "Zhang et al. (2018), FinDroidHR"
[P2]: https://doi.org/10.1145/3311823.3311839 "Buddhika et al. (2019), fSense"
[P3]: https://doi.org/10.1109/INFOCOM.2018.8486006 "Zhao et al. (2018), PPG-based Finger-level Gesture Recognition Leveraging Wearables"
[P4]: https://doi.org/10.1109/SoSE50414.2020.9130489 "Subramanian et al. (2020), Using Photoplethysmography for Simple Hand Gesture Recognition"
[P5]: https://doi.org/10.3389/fnins.2022.1047070 "Ruan et al. (2022), Principal component analysis of photoplethysmography signals for improved gesture recognition"
[P6]: https://doi.org/10.1109/TIM.2023.3268469 "Fang et al. (2023), sensor shifts and transfer learning"
[P7]: https://doi.org/10.1109/JSEN.2023.3241126 "Li et al. (2023), simultaneous gesture and force classification"
[P8]: https://arxiv.org/html/2605.04791v2 "Bonazzi et al. (2026), OpenWatch, v2"
[P9]: https://doi.org/10.1016/j.procs.2022.10.135 "Rylo et al. (2022), Gesture recognition of wrist motion based on wearables sensors"
[P10]: https://doi.org/10.1109/TMC.2019.2962760 "Zhao et al. (2021 issue), Towards Low-Cost Sign Language Gesture Recognition Leveraging Wearables"
[P11]: https://doi.org/10.1109/LSENS.2024.3447240 "Eddy et al. (2024), multimodal discrete gestures"
[P12]: https://doi.org/10.1109/JBHI.2022.3194017 "Wang et al. (2022), PPG-FMG-ACC wristband"
[P13]: https://doi.org/10.1145/3776574.3831197 "Hauptmann et al. (2026), μDPad"
[P14]: https://doi.org/10.1016/j.cmpb.2026.109547 "Hu et al. (2026), WatchForce"
[P15]: https://doi.org/10.1016/j.engappai.2026.115547 "Multi-modality gesture recognition for portable wearables (2026)"
[L1]: https://doi.org/10.1109/JSEN.2021.3081714 "Ling et al. (2021), comparative ACC/PPG study"
[A1]: https://doi.org/10.1038/s41597-025-04453-7 "WF-PPG (2025)"
[R1]: https://doi.org/10.1002/aisy.202300207 "Tchantchane et al. (2023), review of noninvasive wearable gesture sensing"
[R2]: https://doi.org/10.1088/1361-6579/acead2 "Charlton et al. (2023), wearable PPG roadmap"
[R3]: https://doi.org/10.1007/978-3-031-57345-3_7 "Guo et al. (2024), fine-grained gestures and sign-language chapter"
