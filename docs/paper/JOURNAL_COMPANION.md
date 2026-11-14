# Journal Paper Companion: Spatial Gesture Control Explained

Nov 8, 2026 · Vaibhav Bisht

> Exported from the Claude Doc [Journal Paper Companion](https://claude.ai/artifact/RKx7VAgDvQuQjUEg7n8ZDn) (revision 19). The doc is the editable original; re-export if it changes.

## How to use this guide

This guide explains, in plain language, everything that appears in the journal version of the paper *Spatial Gesture Control: Controlling a Laptop with Head Orientation and Smartwatch Pinch Gestures*: every claim, term, number, equation, table and figure. The text explained is the revision of 8 November 2026.

**Which files.** The IEEE journal version (`docs/paper/archive/ieee-journal/`) and the Springer Nature journal version (`docs/paper/archive/springer-journal/`) share an identical `body.tex`; only the title block, abstract wrapper and back matter differ. Section numbers below follow the IEEE PDF (Roman numerals there, Arabic in Springer).

| This guide | Paper section |
| --- | --- |
| Title and abstract | Front matter |
| Section 1 | I. Introduction |
| Section 2 | II. Related Work |
| Section 3 | III. System Design |
| Section 4 | IV. Data Collection and Reference Annotations |
| Section 5 | V. Detection Methods |
| Section 6 | VI. Evaluation Protocol |
| Section 7 | VII. Results |
| Section 8 | VIII. Discussion |
| Sections 9–10 | IX. Limitations and Future Work; X. Conclusion; statements |
| Glossary, number sources | Reference material for the whole paper |

**How each part is written.** For every passage the guide says what it states, what the terms mean, why it matters, and how much weight the evidence can bear. Where the paper reports a number, the guide says where it was measured. The last section lists the repository file behind each figure so a reviewer's question can be traced to its source.

**One-sentence summary of the paper.** Consumer headphones and a smartwatch can drive a look-pinch-turn volume knob on a laptop; detecting the pinch from the wrist is the hard part, PPG alone is not enough, motion sensors and a small neural network help most, and honest evaluation practice decided whether offline numbers meant anything.

## Title and abstract, explained

The abstract compresses the whole paper into nine claims: what was built, how the hard part was measured, and five results with their limits.

### Title

*Spatial Gesture Control: Controlling a Laptop with Head Orientation and Smartwatch Pinch Gestures.* "Spatial" means the control lives in the space around the user rather than on a screen or keyboard: you look at a place and act with your hand. "Head orientation" is which way the head points, measured by motion sensors inside the headphones. "Pinch gestures" are thumb-to-index-finger touches, detected by the watch.

### Author block and running head

The author line, the "Manuscript received" footnote and the running head `[Journal Name], Vol. [X]` are IEEE Transactions conventions. The bracketed parts are placeholders the journal or author fills in. The Springer version uses `\author*` (corresponding author), `\affil` and an e-mail line instead.

### The abstract, sentence by sentence

| Abstract says | What it means | Where it is supported |
| --- | --- | --- |
| A person controls a laptop without touching it | Hands-free input through wearables; no camera is needed at run time | Sections III, VII |
| Look at a calibrated location, pinch to grab a virtual knob, turn the wrist, pinch again to release | The five-step look–pinch–turn–release interaction | Section III-A |
| Head orientation from consumer Sony headphones | Off-the-shelf noise-cancelling headphones contain an inertial sensor; an open-source tool reads it | Section III-A |
| Wrist motion and raw PPG from a Galaxy Watch over Bluetooth LE | The watch streams accelerometer, gyroscope and the raw light signal of its heart-rate sensor | Section III-D |
| All inference on the laptop behind a fail-closed safety chain | The watch only senses; decisions happen on the computer; any doubt cancels the action | Section III-E |
| Camera hand landmarks as reference timing annotations | A webcam marked when pinches happened, used only to label training data | Section IV |
| Continuous event detectors; caught pinches against false activations per hour | Judged the way it runs live, over whole recordings, not on pre-cut clips | Section VI |
| PPG alone: AUC 0.60–0.64 on a new day | Barely better than chance (0.5) on unseen data | Section VII-A |
| "Six robustness methods did not change this" | Six methods meant to make models transfer across sessions, listed in Table VI, did not raise the worst case | Table VI |
| IMU fusion: worst-split AUC 0.789 → 0.837; peak trigger +4–12 recall points | Adding motion sensors and changing when the detector fires both helped | Section VII-B |
| CNN beat trees; 43% of 372 starts pooled, about two thirds on newer days | The neural network did better, but results vary strongly by day | Table VII |
| Hand-labelled model: 47/57 starts, 0 false activations over 0.48 h, median 442 ms, reproduced by replay | The newest model's stored score was re-run and confirmed | Table VIII |
| Median-based normalisation removed a motion-induced blind spot | A scaling fix stopped the model going "blind" after big wrist movements | Table IX |
| Evaluation and labelling practices determined whether offline results predicted live behaviour | The method lessons are a main contribution | Section VIII |

**Note on "six robustness methods".** An earlier draft said "ten", counting methods cited in the project's research notes. Table VI shows six screened methods beside two baselines, so the abstract was corrected on 8 November 2026 to say six, matching what the reader can see.

### Keywords

Gesture recognition, smartwatch, photoplethysmography, inertial sensing, head tracking, human–computer interaction, wearable computing, event detection. Journals use these for indexing and reviewer matching; they name the field (HCI, wearables), the sensors (PPG, inertial) and the method framing (event detection).

## Section 1 (I). Introduction

The introduction argues that everyday wearables could replace the keyboard for simple spatial controls, explains why that is hard, and states three research questions and four contributions.

### The motivation

- **Sensors people already wear.** Noise-cancelling headphones such as Sony's WH-1000XM range contain an inertial measurement unit (IMU) used for spatial audio, so they know where the head points. A smartwatch has an IMU and an optical heart-rate sensor. The paper asks whether these can drive a laptop control with no camera and no touch.
- **The chosen task.** A virtual volume knob: look at it, pinch to grab, turn the wrist, pinch to release. Volume was picked because it is a continuous value, it is harmless if wrong, and it is easy to verify.

### Why it is hard (the four obstacles)

1. **The watch cannot see the fingers.** A pinch has to be inferred indirectly: from small changes in the PPG signal (finger tendons and contact change blood volume and pressure under the watch) and from tiny jolts in the motion sensors.
2. **Everyday activity looks similar.** Typing, reaching or scratching move the same tendons and wrist, so the detector must not fire on them (false activations).
3. **Signals drift between days and strap fits.** A model trained on Monday may fail on Wednesday after the strap was put on slightly differently.
4. **Three clocks and a real effect.** Headset, watch and laptop each keep their own time, and the system changes the real system volume, so errors must never escalate.

### The research questions

| Question | In plain words | Answered in |
| --- | --- | --- |
| RQ1 | Can the watch's light sensor alone tell when a pinch starts, during normal use, on a new day? | Section VII-A |
| RQ2 | How much do motion sensors, the firing rule and the kind of model change the results? | Section VII-B |
| RQ3 | What evaluation and labelling habits make offline scores predict live behaviour? | Section VIII-A |

Each results subsection ends with an italic *Answer to RQn* sentence so a reader can find the conclusion quickly.

### The four contributions

1. **The system** (Section III): a desktop coordinator joining headset orientation, watch motion and PPG, with a recipe engine and a fail-closed safety chain.
2. **The data pipeline** (Sections IV–V): recording watch signals with camera reference annotations, keeping hand corrections separate from original labels, aligning three clocks, and training one binary detector per gesture.
3. **The empirical study** (Section VII): PPG alone transfers poorly; motion fusion and a peak trigger help; a compact CNN beats engineered-feature trees on new sessions, with large day-to-day variation; and a replayed event log for the hand-labelled model.
4. **The evaluation standard and its lessons** (Sections VI, VIII): counting events as the detector runs live, and the specific practices that had inflated earlier results.

**Why the contributions are framed this way.** Neither PPG+IMU fusion nor a CNN is new in itself (Section II). The paper's defensible novelty is the end-to-end interaction plus continuous, honest event evaluation.

## Section 2 (II). Related work

The related-work section places the project among three bodies of research and argues that none of them shows a continuously running, low-false-activation pinch detector from a stock watch's PPG, which is the gap this paper works in.

### II-A. Wrist PPG for gesture recognition

**What PPG is.** Photoplethysmography shines light (green, red, infrared) into the skin and measures how much returns. The amount changes with blood volume, which is how watches measure heart rate. Finger and wrist movement also change it, by moving tendons and changing the pressure and contact between sensor and skin. That second effect is what gesture research exploits.

| Cited work | What it did | Why the paper cites it |
| --- | --- | --- |
| FinDroidHR (Zhang et al., 2018) | Classified gestures, including pinch, from a commercial smartwatch's optical sensor | Shows smartwatch PPG gestures are an established idea, so the paper cannot claim the sensing principle as new |
| fSense (Buddhika et al., 2019) | Estimated the force of a gesture from smartwatch PPG | Force changes PPG, which matters because pinch effort varies |
| Zhao et al., INFOCOM 2018 | Finger-level gestures from a custom band with two green sensors | Custom geometry; not directly comparable with a watch's three wavelength streams |
| Subramanian et al., 2020 | Simple hand gestures from PPG | Early PPG-only feasibility |
| Ruan et al., 2022 | Four spatial sensing sites per wavelength, analysed with principal component analysis (PCA) | More sensors in different positions than a watch has |
| Fang et al., 2023 | Showed sensor shift degrades PPG gestures; proposed transfer learning | Directly relevant: strap refits are a sensor shift |
| Li et al., 2023 | Classified gesture and force level together | Effort varies between pinches |
| Eddy et al., 2024 | PPG, IMU and single-channel EMG at the wrist | Its "PPG" classifier used accelerometer boundaries, so it was not PPG-only |
| Zhao et al., sign language, 2021 | Wearable sign-language recognition | Headline result fuses motion sensors |
| OpenWatch (Bonazzi et al., 2026) | 50 people, smartwatch PPG + IMU benchmark; F1 90% on unseen people, PPG adding 12.5 points | Closest large-scale multimodal evidence; PPG as an addition to IMU |
| Wang et al., 2022; multimodal 2026 | PPG with force myography, accelerometer and EMG | Custom multimodal wristbands |
| μDPad (Hauptmann et al., 2026) | Large PPG + IMU microgesture dataset | Data scale reference |
| WatchForce (Hu et al., 2026) | Hand force from wrist PPG + IMU | Force estimation |
| Tchantchane et al., 2023; Charlton et al., 2023 | Reviews of wearable gesture sensing and wearable PPG | Background |

**The section's key argument.** Most published accuracies are for *prompted, pre-segmented clips*: the participant is told to gesture, and the classifier sees a cut-out window known to contain one. That is much easier than finding pinches in a continuous stream full of typing and reaching, and it says nothing about false activations per hour.

### II-B. Motion-based pinch and tap detection

| Cited work | Rate | Result | Lesson for this project |
| --- | --- | --- | --- |
| Tsunoda, Choi and Shizuki, MUM 2024 | 4,000 Hz accelerometer (modified kernel) | 94.7% for four gestures on unseen people; falls sharply below 200 Hz | High rates help, but need a rooted watch |
| ViWatch (Chen et al., UIST 2023) | 100 Hz | About 97% over a week; 45% on an unseen person without per-user adaptation | Per-user adaptation is the biggest lever |
| Kim et al., CHI 2025 | 100 Hz | 95% of deliberate pinches with a fixed threshold on the high-pass filtered signal | A pinch contact is a sharp jolt in motion |

On this watch, applications get 50–100 Hz motion and 25 Hz PPG, so the high-rate route is closed and ViWatch is the closest comparison.

### II-C. Robustness methods for time series

The paper screened methods designed to make models hold up when data shift between sessions:

- **Group DRO** (distributionally robust optimisation): trains for the worst-performing group, not the average.
- **Domain-adversarial training**: learns features that cannot tell which session a sample came from.
- **Deep CORAL**: aligns the statistics (covariances) of features between sessions.
- **MiniRocket**: thousands of random convolution kernels as fast features for time series.
- **Invariant risk minimisation**: favours relationships that hold across all sessions.
- **MixStyle**: mixes feature statistics between samples to simulate new sessions.

It also cites **extremely randomised trees** (the tree model used) and **Savitzky–Golay filtering** (a smoothing method for derivatives).

**Reference housekeeping.** The journal's `refs.bib` still marks the Tsunoda, ViWatch and Kim titles as "to be completed". The codex manuscript's bibliography has verified full metadata for Tsunoda (Riku Tsunoda, Myungguen Choi, Buntarou Shizuki, *Thumb-to-Finger Gesture Recognition Using COTS Smartwatch Accelerometers*) and ViWatch (Wenqiang Chen et al., *Robust Finger Interactions with COTS Smartwatches via Unsupervised Siamese Adaptation*); copy those across.

## Section 3 (III). System design

The system section describes what was built: which device does what, how a look becomes a target, how a wrist turn becomes a volume, how data travel from the watch, and what stops a mistake from becoming an action.

### III-A. Architecture (Fig. 1 and Table I)

**Figure 1** is a box diagram with three rows of sources at the top (Sony headset, Galaxy Watch, webcam), the desktop pipeline in the middle, and the actions at the bottom. Read it top to bottom:

- **Head tracker** turns headset motion into quaternions (see the glossary). On macOS and Windows it runs inside the app; on Linux it is a separate bridge sending JSON over local UDP port 4243.
- **Watch bridge** receives watch data over Bluetooth LE (default) or Wi-Fi.
- **Interaction engine** holds the head calibration, the dwell timer and the wrist-to-volume mapping.
- **Label runtime** runs the pinch-in and pinch-out CNN models.
- **Recipe engine + safety gate** (highlighted) is the only box allowed to show the knob or change volume.
- **Overlay knob** is a transparent window that never takes keyboard focus; **Volume writer** applies changes on its own thread; **System volume** is the operating system's output level.
- The **webcam, Recorder and Model Lab + trainer** sit to the right: they make training data and models but never act at run time.

**Software named in the paragraph.** Tauri 2 is a framework for desktop apps with a Rust back end and a web front end; React is the front-end library; `sony-head-tracker` is the open-source tool that reads the headphones; Samsung's Health Sensor SDK gives apps raw PPG; `btleplug` is the Rust Bluetooth library; MediaPipe finds hand landmarks in camera images; PyTorch trains the CNN.

**Table I (devices and data rates).** Headset orientation at about 25 Hz; watch rotation vector, linear acceleration and gyroscope at 50 Hz; raw PPG green, red and infrared at 25 Hz; crown button and wear state when they change; webcam landmarks at 23–30 frames/s, for labels only. "Galaxy Watch4+" means the Watch4 or later, the first models whose SDK exposes raw PPG.

**The five-step interaction.** (1) Look at the calibrated spot for 400 ms; the knob appears. (2) Pinch in: grab, remembering wrist pose and current volume. (3) Roll the wrist: volume changes relative to that pose. (4) Pinch out: release, volume kept, knob still ready. (5) Look away: knob hides; Escape cancels.

### III-B. Head targeting (Equation 1)

During calibration the user looks at the screen centre and each named location, and a **unit quaternion** (a four-number description of 3-D orientation) is stored for each. At run time the angle between where the head points now and each target is

```latex
\theta = 2\arccos\bigl(\lvert q_{\mathrm{cur}} \cdot q_{\mathrm{tgt}} \rvert\bigr)
```

- q\_cur is the current head orientation, q\_tgt a stored target; the dot product of two unit quaternions is the cosine of half the angle between them.
- The absolute value is needed because q and −q describe the same orientation.
- A target activates when θ stays under an adjustable threshold for the dwell time. This is better than separate yaw and pitch limits because it measures true angular distance in any direction.
- If the headset's **reset counter** changes, its reference frame moved, so the stored targets no longer line up and calibration is invalidated.

### III-C. Wrist-to-volume mapping (Equation 2 and Table II)

At grab time the watch orientation Q\_s is stored. Each new sample gives the rotation since the grab:

```latex
Q_{\mathrm{rel}} = Q_s^{-1} Q_{\mathrm{cur}}
```

The twist about the forearm axis is taken from Q\_rel. Because the target is computed from the grab pose each time (absolute), small errors do not pile up. The mapping uses a 1° dead zone (tiny tremors are ignored) and about one volume point per 3°, with a sensitivity setting and a switch to reverse direction for either arm.

**Table II (filters and limits)**, row by row:

| Stage | What it does | Why |
| --- | --- | --- |
| Velocity outlier | Freezes the target if the wrist appears to turn impossibly fast | A sensor glitch must not jump the volume |
| Jitter rejection | Accepts a new target only once it differs by 0.5 points | Stops small back-and-forth flicker |
| Easing | Moves toward the target with a 150 ms exponential time constant | Smooth sound, no steps |
| Slew limit | At most 30 points per second, whatever the sensor rate | A 200 Hz input once let volume move faster; fixed |
| Write pacing | Native writes at least 100 ms apart, on a writer thread | macOS volume calls take 130–190 ms and must not block sensor processing |
| Interaction epoch | Drops writes left over from a released grab | Releasing must stop changes immediately |
| Clamp | 0–100 | Valid volume range |

### III-D. Watch sensing pipeline (Table III)

- **JSON envelopes**: every message carries type, version, device id, sequence number, timestamp and payload, so one decoder handles both transports.
- **GATT peripheral / central**: in Bluetooth LE the watch advertises a service (peripheral) and the laptop connects to it (central).
- **Bonding plus trust approval**: the operating systems pair and encrypt the link, and the watch user must also tap "Trust this computer", because bonding alone authenticates nothing.
- **Batching**: motion is sent in 100 ms batches and PPG at each sensor flush (10 per second by default): about 30 BLE notifications per second.

**The faults found and fixed**, which the paragraph describes:

1. **MTU − 3 = 514 bytes.** The negotiated maximum transmission unit (MTU) was 517 bytes; three are protocol overhead, so fragments were sized 514. But a Bluetooth attribute value may be at most 512 bytes, so Android silently refused every PPG batch's first fragment. Fix: 512-byte cap.
2. **Unbounded queue.** When an arm movement weakened the radio path, the queue grew to seconds of delay and was then thrown away whole. Fix: keep about half a second and drop the oldest whole messages.
3. **61 notifications per second** (one per motion reading) saturated the link. Batching halved it to about 30.
4. After the fixes, 15 minutes of logs showed 20 dropped messages (about 2 s of data), almost all just after reconnects.

**Table III** lists the measured properties: 49.8 Hz motion per sensor, 25.0 Hz PPG, 6–10% of PPG gaps over 60 ms (timestamp jitter), MTU 517, notifications before and after, watch CPU 21% (app) and 41% (Bluetooth service) at the old rate, desktop CPU 10% and 13%, and about 0.2 ms per inference in a debug build.

**Clocks.** Sample timestamps stay on the watch's own monotonic clock; every freshness and safety decision uses the laptop's clock, so a watch clock jump cannot keep an action alive.

### III-E. Recipe engine and safety

- A **recipe** chains a head stage (looking at a target), a gesture stage (pinch) and a wrist stage (roll) into an action on a virtual device (the knob). Conflicting recipes that would drive the same output are blocked.
- **Paired stage.** A pinch-in detection is a one-off event, and the detector going quiet afterwards does not mean the fingers opened. So the paired stage *remembers* the grab between a pinch-in and a pinch-out. It ignores repeated pinch-ins while grabbed, lets release win if both arrive together, and cancels on head exit, Escape, data loss, model change or leaving Live mode.
- **Fail-closed chain.** Each check that rejects data forces a release: an ordering watermark (data must arrive in time order), a quality gate, a window-length check, a freshness check (orientation older than 500 ms is rejected) and the gesture policy. A watchdog releases any grab whose model data has been silent for 750 ms.
- **Off / Monitor / Live.** Off: no scoring. Monitor: scores and logs but never acts. Live: acts only through explicitly bound intents. A saved Live setting starts as Monitor after a restart, so actions begin only after an explicit choice.
- **Model bundles** are data, never code, and their SHA-256 hash (a fingerprint of the file) and input contract are checked on every load.

## Section 4 (IV). Data collection and reference annotations

This section explains where the training and test data came from and how pinch times were marked. Because the watch cannot see the fingers, the quality of these marks limits every result that follows.

### IV-A. Recordings

- **One participant, left wrist.** Every recording is the author's own. That limits how far results generalise (Section VIII-C).
- **Immutable bundles.** A recording is written once (PPG, motion, labels) and never edited in place; corrections are stored separately.
- **Three pinch labels.** `pinch_in` is the moment of contact, `pinch_hold` the time fingers stay together, `pinch_out` the release. Splitting them lets separate detectors learn the start and the end.
- **Negatives.** Fist, thumbs-up and three kinds of everyday noise (typing, mouse use, ordinary activity). Negatives teach the model what *not* to fire on, and give the time over which false activations are counted.

**Table IV (the collections)**, row by row:

| Row | What it is | Why it matters |
| --- | --- | --- |
| September–October 2026 | 17 usable recordings with cue-based labels | The early PPG studies; training data for the held-out test |
| 14 October 2026 | 15 recordings: 9 pinch, 4 fist, 2 everyday activity; strap refitted between sessions | Used once as a held-out day, then in the mixed-era study |
| Frozen benchmark | 37 recordings, 1,390 events | A fixed set for comparing feature and trigger choices fairly |
| October–November 2026 | Camera-timed pinch sessions and everyday noise | CNN versus trees; the leave-one-day-out study |
| Leave-one-day-out set | 372 camera-marked pinches | Table VII |
| Hand-labelled collection | 37 exports reducing to 28 distinct sensor streams; manual label overrides | The hand-labelled model (Table VIII) |

**"37 exports, 28 distinct sensor streams".** Some recordings were exported twice under different names (for example, once as a `pinch_hold` file and once as a `pinch_in` file) with identical sensor data. Treating them as separate sessions would make the data look larger, and could put the same data on both sides of a train/test split. Grouping identical streams before splitting prevents that.

### IV-B. Camera reference annotations and clock alignment

- **Why cameras.** Early labels came from on-screen cues ("pinch now"). People respond with different delays, and each recording had its own lag of up to 1.3 s between cue and the actual pinch, so models learned from wrongly timed examples.
- **MediaPipe Hand Landmarker** finds 21 points on each hand (fingertips, knuckles, wrist) per camera frame, inside the app with no network access. Only these coordinates are saved, never images (privacy).
- **Clock alignment.** The watch and browser keep different clocks. Every 200 ms the app logs a watch timestamp and the browser time it arrived. Delivery delay can never be negative, so the smallest "arrival minus watch time" across pairs is the best estimate of the clock offset.
- **Marking a pinch.** Contact is marked when the thumb tip and index tip come close enough. A fixed threshold of 0.35 "hand sizes" missed many real pinches, because the apparent distance depends on how the hand faces the camera. The missed pinches were then trained as non-pinches, and counted as false activations when the model correctly fired on them. Judging each session against its own hand's range cut false activations on pinch sessions from 110 to 20 per hour.
- **Hold-gap audit.** 8 of 163 camera-labelled pinch-in intervals were followed straight by pinch-out with no hold in between, which is physically suspicious, so they were queued for visual review.

**Why the paper says "reference annotations" and not "ground truth".** The marks come from an automatic landmark model, thresholds and later human edits. They are the best available reference, but nobody independently verified each contact time, so calling them ground truth would overstate their accuracy.

## Section 5 (V). Detection methods

Two model families answer the same question at every PPG sample, "did a pinch just start?": a tree ensemble on hand-designed features and a small convolutional network on the raw signals. A shared trigger turns their scores into events.

*CNN detection pipeline: six stages, four event outcomes.* (In the Claude Doc this is an interactive diagram; this is a text version.)

```text
 1. Watch signals         accelerometer x/y/z, gyroscope x/y/z (50 Hz), PPG green/red/IR (25 Hz)
          |
          v
 2. Common time grid      9 channels resampled onto a 549-tick grid ending at the decision moment
          |
          v
 3. Normalise             per channel: (x - median) / (1.4826 x MAD), with floors; clip to +/-500;
          |               keep the last 50 ticks  ->  a 9 x 50 input
          v
 4. Three 1-D CNNs        3 dilated convolutions each (32/32/64 channels, kernel 5, dilation 1/2/4)
          |
          v
 5. Ensemble score        average of the three networks (three seeds), one score per PPG sample
          |
          v
 6. Peak trigger          fire at the first falling score after reaching activation;
          |               release 0.15 below; 1.5 s cooldown
          v
    Evaluation sorts each event:  catch | repeat | late | false activation
```

The top five boxes run at every PPG sample; only the trigger decides when a score becomes an event, and the evaluation then sorts each event into one of four outcomes (Section VI).

### V-A. Engineered features and extremely randomised trees

- **Causal features.** Every number is computed only from data up to the decision moment, as it would be live.
- **PPG features (1,701).** Each sample is z-scored (centred and divided by the spread) against the preceding 1, 2 and 4 s, so a change is measured relative to the recent past. From these the model computes slope (first derivative), curvature (second) and jerk (third), and takes 21 statistics of each over the last 0.3, 0.6 and 1.3 s.
- **Motion features (1,032).** The same statistics for each accelerometer and gyroscope axis, its magnitude and its change, plus how much it moved relative to the 3 s before.
- **Extremely randomised trees (ExtraTrees).** 300 decision trees vote; each split is chosen from random thresholds, which makes the ensemble robust to noise. At least 3 samples per leaf and 70% of inputs considered per split.
- **Training moments.** Positive: the moment 0.88 s after each labelled start (the trees need that long to see the pinch). Negative: matched moments after other gestures' starts, inside holds and in quiet time.

### V-B. Compact 1-D convolutional network (Equations 3–4)

**Inputs.** Nine channels: accelerometer x, y, z; gyroscope x, y, z; PPG green, red, infrared. All are resampled onto a 50 Hz grid (one tick every 20 ms).

**Normalisation**, the equations in the paper:

```latex
m_c = \operatorname{med}_{j\in G} x_{c,j}, \qquad s_c = 1.4826\,\operatorname{med}_{j\in G} \lvert x_{c,j} - m_c \rvert
```

```latex
u_{c,t} = \sigma\!\left(\operatorname{clip}\!\left(\frac{x_{c,t} - m_c}{s_c + \epsilon_c}, -500, 500\right)\right), \quad t \in W
```

| Symbol | Meaning |
| --- | --- |
| c | One of the nine channels |
| G | The last 549 ticks before the decision, about 11 s: the history used for scaling |
| W | The last 50 ticks, 1 s: the window the network actually sees |
| m\_c | Median of the channel over G: its typical recent level |
| s\_c | Median absolute deviation (MAD) times 1.4826: a robust spread; 1.4826 makes it equal the standard deviation for normally distributed data |
| ε\_c | A small floor so a perfectly still channel does not divide by zero: 0.02 for accelerometer axes, 0.01 for gyroscope axes, 0.001(\|m\_c\| + 1) for PPG |
| clip | Limits the scaled value to ±500 so one extreme spike cannot dominate |
| σ | The sigmoid function, squashing every value into 0–1 |
| u\_{c,t} | The 9 × 50 = 450 numbers fed to the network |

**Why median and MAD instead of mean and standard deviation.** A single burst of wrist motion inflates a mean and standard deviation for the whole history window; the median and MAD barely move. Earlier models z-scored each tick against the 10 s before it, which created the blind spot in Section VII-D.

**Network.** Three **dilated convolutions** (filters that look at the signal with gaps of 1, 2 and 4 ticks, so the layers together see a longer stretch) with 32, 32 and 64 channels and kernel size 5, each followed by **batch normalisation** (keeps activations in a stable range). Then per-channel **max and mean pooling** over time, a **32-unit dense layer with dropout** (randomly silencing units in training to prevent overfitting), and one output: the probability that a pinch just started.

**Ensemble.** Three networks trained from different random seeds; their probabilities are averaged, which steadies the score.

**Training.** Positives: every sample 0.4–0.6 s after a labelled start. Negatives: samples with no start between 1.2 s before and 0.2 s after. At most 40,000 negatives per network, positives weighted up to 20 times because they are rare. Adam optimiser at learning rate 0.001, weight decay 0.0001, 12 passes (epochs), batches of 256.

**Table V** compares the families: 2,733 features versus 450 raw values; 300 trees versus 3 CNNs; about 1,000–1,300 versus tens of thousands of training moments; decisions about 0.88 s versus 0.5 s after a start; 5.6 s versus 11 s of history needed before the first decision.

### V-C. Detection rule and threshold selection

- **Peak trigger.** After the score has reached the activation threshold, a detection is emitted at the first score that is lower than the one before (the top of the climb has passed). The event time is that decision, not a backdated maximum, which keeps the latency honest.
- **Hysteresis.** The detection stays active until the score falls below the release threshold, 0.15 below activation. Different on and off thresholds stop it flickering.
- **Cooldown.** After the detection ends, the next cannot start for 1.5 s.
- **Threshold selection.** Only training recordings are used. Five models, each trained without one fifth of the training recordings, score the fifth they did not see; the threshold that catches the most starts while staying within 30 false activations per hour wins. This keeps test recordings out of the choice.
- **Export check.** The exported model file must reproduce the trained model's answers before it is released, and shared test fixtures keep the Python trainer and Rust runtime computing inputs and detections identically.

## Section 6 (VI). Evaluation protocol

The evaluation section defines exactly how a detector is scored. Its central choice is to judge a detector the way it runs live, over whole recordings, counting events, rather than as a classifier of pre-cut windows.

### Event categories

Every detection the model emits is exactly one of:

| Category | Definition | Counts as |
| --- | --- | --- |
| Catch | Inside the match window after a labelled start (for the CNN, 300–900 ms after; for the trees, 680–1,280 ms) | A success for that pinch |
| Repeat | Another detection while an already caught pinch is still under way | Neither success nor false alarm; reported separately |
| Late | A detection during a pinch that was not caught in time | The pinch counts as missed; the firing is not a false alarm |
| False activation | Any other detection | An error: in live use this would act unprompted |

### Equations 5 and 6: the headline metrics

```latex
\mathrm{TAR} = \frac{\#\,\text{caught starts}}{\#\,\text{labelled starts}}, \qquad \mathrm{FAR} = \frac{\#\,\text{false activations}}{\text{hours with no gesture under way}}
```

- **TAR (true activation rate)** is event recall: the share of real pinch starts the detector caught.
- **FAR (false activation rate)** is false activations per hour, where the hours count only time *with no gesture under way*. The paper stresses this denominator. Pinch sessions are dense with gestures, so dividing by total recording time made one model look acceptable when it actually fired about 175 times per hour of genuinely idle time.

### The five study designs

1. **Recording-disjoint cross-validation.** The data are split many ways into training and test recordings, never splitting a recording. Results are ranked by the *worst* split (minimum AUC) first, because a detector must work in its bad sessions too.
2. **One-shot held-out day.** The protocol and candidate techniques were written down before the 14 October recordings were used, and those recordings were scored once. This is the closest the project has to an untouched test.
3. **Leave-one-day-out.** Train on all days but one, test on that day, repeat for each day. Tests transfer to a new day.
4. **Spliced-motion replays.** Real bursts of wrist motion are inserted into held-out recordings just before pinches, to test recovery after movement.
5. **Ablations.** Remove or swap one component (preprocessing, trigger, labels) at a time to see what it contributes.

**Seen versus unseen data.** Each study records whether its data had been looked at before. Cross-validation on data used during development is reported as progress evidence, not as an untouched test. Within each experiment, training and test recordings are disjoint, and exported files with identical sensor data are grouped as one source before splitting.

### Equation 7: what "zero false activations" proves

```latex
\lambda_{95\%} \approx \frac{-\ln 0.05}{T} \approx \frac{3}{T}\ \text{per hour}
```

If false activations occur at a steady random rate (a Poisson process) and none is observed in T hours, then with 95% confidence the true rate is below about 3/T per hour. With 30 clean minutes (T = 0.5) the rate could still be up to about 6 per hour. With the hand-labelled model's 0.48 h it is 6.2 per hour. To claim fewer than one per hour you need about three hours with none. The "steady rate" assumption is optimistic, because real activities cluster.

## Section 7 (VII). Results

The results run from the weakest signal to the working system: PPG alone (RQ1), then motion, triggers and model family (RQ2), the hand-labelled model, a normalisation failure, other variations, double pinch and system performance.

### VII-A. RQ1: PPG alone

- **The "step".** In each session's own units, the PPG signal rises at the start of a pinch on all three colours. This looked promising.
- **The correction.** Its "rest" comparison moments had been chosen only by distance from gesture start and end, without checking they were outside a gesture. A recheck found 84% (1,645 of 1,958) were inside gestures, mostly the middle of long holds. So the early studies had compared pinch starts with mid-pinch, not with rest.
- **What the step really does.** It separates starts from mid-hold well (median AUC 0.94), but separates pinch from fist and thumbs-up starts only at about 0.65, needs about 700 ms, and does not transfer between days (0.81 on one, 0.37 on another). Run continuously it caught under 10% of pinches at about one false activation a minute.
- **The held-out day.** On 14 October (208 pinch starts, 80 everyday-activity moments, 68 fist starts), every PPG technique scored 0.60–0.64 AUC (0.5 is chance), with uncertainty reaching about 0.45. Fist starts could not be told from pinch starts at all (0.37–0.57).

**Table VI (mixed-era robustness screen).** 32 recordings, 20 recording-disjoint splits with 60% training and 40% test; Min, Mean and Max are the AUC over the 20 splits.

| Row | What it is | Result |
| --- | --- | --- |
| Reference A | RGB waveform with a histogram gradient-boosting (HGB) classifier | Baseline 0.676 / 0.749 / 0.842 |
| Reference B | z-scored inputs, dense neural network | Baseline 0.661 / 0.756 / 0.853 |
| Group DRO | Optimise the worst group | Lower minimum (0.618): rejected |
| Causal morphology + HGB | Shape features: onset, peak, slopes, width | Best mean (0.785) but minimum barely changed |
| MiniRocket-like | Random convolution features | No gain |
| Constrained derivative DTW | Dynamic time warping on derivatives | Best minimum (0.682), lower mean |
| Feature-space augmentation | Synthetic variations of features | No gain |
| CORAL adaptation | Align feature statistics to the test session | Collapsed (0.462) |

The reference PPG-only tree pipeline (37 recordings, 20 folds) reached minimum/mean/pooled event AUC 0.7885/0.8426/0.8105, 41.15% recall at 15.09 false activations per minute, about 830 ms latency, and fired 19–25 times a minute on recordings with no pinch. **Answer to RQ1:** PPG carries a real onset cue, but it is weak, slow and not specific to pinch; alone it cannot drive a continuous detector.

### VII-B. RQ2: motion, trigger and model family

- **Adding the IMU.** On the frozen benchmark, motion features alone beat PPG; fused, worst-split AUC rose from 0.789 to 0.837 (better on 19 of 20 splits). Telling pinch from other gesture starts improved from 0.70 to 0.79–0.81. False activations on no-pinch recordings fell from 19.0 to 12.0 a minute.
- **The trigger.** The old rule fired the first time the score crossed the threshold; at low thresholds that was often too early, and its 1.5 s lockout then blocked the correct firing. Firing at the peak added 4–12 recall points at the same false-alarm budget, costing 35–90 ms.
- **Label shifts.** Moving labels 200–350 ms earlier turned only about three false activations a minute into catches, so most remaining false activations were real reactions to other movement.

**Table VII (CNN variants, leave one day out, 372 pinches).**

| Row | Meaning | Reading |
| --- | --- | --- |
| October only, no noise (earlier)\* | The previously deployed CNN, trained on most October data | 204 caught but on data it trained on, so not a fair test |
| With still-hand rule | Training kept only moments after a still hand | Fewer catches (146) |
| **Without the rule, with noise** | All moments plus everyday noise | **161 caught (43%), 7 false/h on unseen noise**: chosen configuration |
| Rule only at runtime | Trained without, applied live | 130 caught, 3 false/h |

FAR noise counts false activations per hour on unseen everyday-noise sessions; FAR pinch counts them within pinch sessions (the 49/h is dominated by one day). Pooled 161/372 hides big day effects: 21/171 and 37/52 on the October days, 67/92 and 36/57 on the November days. On the newer days the CNN caught about two thirds of pinches against 10–28% for trees, firing about 0.4 s sooner. **Why the still-hand rule hurt:** applied in training, it removed every moving moment, so the model never learned that movement is not a pinch. **Answer to RQ2:** motion fusion and the peak trigger each help a lot; the CNN beats trees on new sessions, but transfer across days varies widely.

### VII-C. Hand-labelled development model (Table VIII)

- **What changed.** Labels were corrected by hand in the app's labelling view: a non-empty manual label overrides the original row label; a blank one keeps it.
- **The model.** A median-scaled CNN (`pinch_in-ae0a22bf`), trained on 20 recordings with its 0.99 threshold chosen on training data only, evaluated on 8 others.
- **The replay.** The bundle stored a recall but no event log, so the stored model was re-run through the trainer's own detection code. It reproduced the stored numbers exactly.
- **Table VIII**: 47 of 57 starts caught (82.5%; 72–94% by day); 10 missed (4 late, 6 undetected); 0 repeats and 0 false activations; 0.48 h of eligible no-gesture time; therefore at most 6.2 false activations per hour at 95% confidence; latency median 442 ms (middle half 384–510 ms).
- **The margin.** On the everyday-activity session the score peaked at 0.970 against the 0.99 threshold. Zero false activations depends on that narrow 0.02 gap.
- **Status.** Development evidence for one person and one target; the evaluation recordings are not proven untouched by development.

### VII-D. A normalisation blind spot (Table IX)

The earlier CNN scaled each channel by a rolling 10 s mean and standard deviation. One burst of wrist motion pushed the gyroscope's deviation from about 0.03 to about 1 rad/s, so a pinch afterwards looked about 30 times smaller until the burst left the 10 s window. No training pinch had followed such a burst (largest prior gyro RMS 0.62 rad/s; everyday noise reaches 14 rad/s). **Table IX** is a *window-score diagnostic*: real bursts spliced in, a pinch counted if the peak score 0.1–1 s after it reached the threshold. Rolling scaling dropped to 0% after 2–8 s bursts; median scaling kept 93% (2 s) and 87% (4 s) but fell to 58% (6 s) and 16% (8 s). It is not a live test or a continuous event replay.

### VII-E. Further variations (Table X)

| Variation | Result | Why |
| --- | --- | --- |
| Retrain on own false alarms | Recall 27% vs 31%, no fewer false activations | Off |
| 2 s window, fourth convolution | 49–51% vs 45%, but its chosen threshold broke the false-alarm budget on noise | Deferred |
| Self-supervised pretraining | 27 vs 7 false activations/h | Rejected |
| Still-hand rule in training | Never learns movement is not a pinch | Off for CNN |
| Fixed camera-mark threshold | 110 false activations/h | Replaced by per-session marks |
| Pinch-shape and Haar-wavelet features | No gain | Not adopted |

The **curriculum** (train on newest clean data, then older camera labels, then noise) reached 78.9% (15/19) for pinch-in and 52.6% (10/19) for pinch-out at zero false activations on a reserved pair, but the same pair chose the threshold, so it is validation evidence only. Training on newest data plus noise alone transferred poorly to older sessions (4.9–31.4%).

### VII-F. Double-pinch gating

For a future double-pinch gesture, the detector abstains outside a stated envelope (data preconditions, context gates) and checks each candidate jolt first. On 278 camera-timed contacts this kept about 80% of single pinches, while cutting candidate jolts during arm movement from 76 to 0.6 per minute and during wrist twists from 40 to 0.4.

### VII-G. System performance

Measured before optimising, on an Apple M3: buffer append 452 µs → 0.1 µs (the old path also scrambled row order past 200,000 rows); repeated viewer requests 52 ms → 1.3 µs via a cache; status events up to 200 → about 10 per second; trainer on a long recording 7.26 s → 2.23 s; release binary 17.5 MB → 12.0 MB; live inference about 0.2 ms per window.

## Section 8 (VIII). Discussion

The discussion answers RQ3 (which practices made offline results trustworthy), draws implications, and lists the threats to validity a reviewer will look for.

### VIII-A. RQ3: what made offline results predictive

Four practices had inflated results before they were corrected:

1. **Rest controls that were really mid-gesture** made PPG look far better than it was (Section VII-A).
2. **Explored recordings reused as tests**: once you have looked at data and tuned on it, a high score there no longer predicts a new day (0.78 fell to 0.60–0.64).
3. **The wrong false-activation denominator**: dividing by total recording time hid a model firing about 175 times per idle hour.
4. **Per-window AUC used as a release metric**: a detector can rank windows well and still fire constantly in a live stream.

Two labelling practices mattered as much as any model change: cue-based labels with up to 1.3 s lag, and a fixed camera threshold that quietly turned real pinches into negatives. And a training filter, the still-hand rule, changed what the model learned. **Answer to RQ3:** offline results became predictive only once evaluation replayed whole recordings through the deployed trigger, counted false activations per idle hour, protected test sets and used camera-timed, per-session labels.

### VIII-B. Implications

- **Motion first, PPG second.** On a stock watch, inertial sensing should be the primary pinch signal and PPG a complementary one, consistent with OpenWatch.
- **Small raw-signal networks** with robust normalisation and everyday negatives generalised better than large hand-designed feature sets.
- **Interaction design reduces the cost of errors.** Because a pinch only matters while the user is looking at the knob (gaze dwell), and a grab needs a paired release, an occasional false detection does far less harm than in an always-armed detector.

### VIII-C. Threats to validity

These are the standard categories reviewers expect:

| Kind | What it asks | This paper's answer |
| --- | --- | --- |
| **Internal validity** | Are the results caused by what we think, or by leakage and selection? | Thresholds were chosen on training data, but most data were explored during development; only 14 October was a true one-shot test. The hand-labelled model's evaluation set may have informed labelling or selection (not recorded), its training settings were reconstructed for the replay, its zero-false-activation result sits 0.02 below threshold, and no hand-labelled pinch-out model exists. Camera-label accuracy and clock-alignment error were not independently measured. |
| **External validity** | Would results hold for other people, watches, activities? | One participant, one watch, one wrist, mostly 50 Hz motion; pinches made while moving are rare. Results may not transfer. |
| **Construct validity** | Does the measurement capture the real-world quantity? | False activations were measured on recorded noise sessions, not full days of natural use, so hourly rates rest on limited exposure (see Equation 7). |

## Sections 9–10 (IX–X). Limitations, future work, conclusion and back matter

The closing sections say what is still unproven, what to do next, and what the paper concludes; the back matter holds the statements journals require.

### IX. Limitations and future work

- **Day effects.** Every model trained on other days catches only 12–18% of the 14 October pinches, against 63–75% on 3–4 November. Something about that day (strap fit, pinch style, label timing) is not captured.
- **A sealed test.** The next step freezes the model, preprocessing, thresholds and protocol *before* collecting new data, across several days with strap refits, with 30–60 minutes of continuous everyday activity per session and pinches made while moving, recorded at 100 Hz. Data collected after freezing is the only way to make an untouched-test claim.
- **Per-user adaptation.** ViWatch went from 45% to 97% by adapting to each person; this is the most promising modelling direction.
- **A longer window.** A 2 s input with a stricter threshold choice is a second candidate.
- **Engineering.** Wi-Fi peer authentication, physical validation on Windows and Linux, signed packaging and a Bluetooth battery trial remain open.
- **Extending the interaction** to brightness and scrolling once volume is dependable.

### X. Conclusion

The conclusion restates the paper in three claims: (1) a consumer headset and smartwatch can drive a look–pinch–turn interaction on a laptop; (2) on a stock watch, PPG alone is not sufficient; (3) motion fusion, camera-timed labels and event-based evaluation are what turned a promising offline score into a working interaction.

### Back matter

| Item | IEEE journal | Springer Nature journal | What to put there |
| --- | --- | --- | --- |
| Data and code availability | Own section | Data, materials and code availability items | Repository URL and licence, or "available on reasonable request" |
| Ethics | Ethics Statement | Ethics approval and consent to participate | The author was the only participant; whether an approval or waiver is needed for self-recorded physiological data depends on the institution and journal |
| Consent for publication | — | Item | Usually "Not applicable" for self-data |
| Conflict of interest | Section | Competing interests item | "None" if true |
| Funding | Acknowledgment | Funding item | Sources or "Not applicable" |
| Author contribution | — | Item | Who did what (sole author here) |
| Biography | IEEE biography | — | Short career summary |
| AI assistance | Not yet stated | Not yet stated | Most journals now require disclosing AI tools used in drafting; see the codex manuscript's declaration and follow the target journal's policy |

**References.** IEEE style numbers citations in order of appearance; the Springer version uses the `sn-mathphys-num` numbered style, which can be swapped for the journal's preferred style in one option.

## Glossary

Every technical term in the paper, in alphabetical order, with the paper section where it first matters.

| Term | Meaning | Paper |
| --- | --- | --- |
| Activation threshold | Score a detection must reach to start (0.99 for the hand-labelled model) | V-C |
| Adam | A standard neural-network optimiser that adapts each weight's step size | V-B |
| AUC (ROC AUC) | Area under the ROC curve: the chance a random positive scores above a random negative. 0.5 = chance, 1 = perfect | VII-A |
| Balanced accuracy | Average of the hit rate on positives and on negatives | VII-C |
| Batch normalisation | Rescales a layer's outputs during training to keep them stable | V-B |
| BLE (Bluetooth Low Energy) | Low-power Bluetooth used for the watch link | III-D |
| Bonding | Operating-system pairing that encrypts a Bluetooth link | III-D |
| Catch | A detection inside the match window after a labelled start | VI |
| CNN (convolutional neural network) | A network that slides learned filters along a signal to find patterns | V-B |
| Cooldown | Wait after a detection ends before another can start (1.5 s) | V-C |
| CORAL | Correlation alignment: matches feature statistics between sessions | VII-A |
| Cross-validation (recording-disjoint) | Repeated train/test splits where whole recordings stay on one side | VI |
| Dead zone | Small rotation (1°) ignored to suppress tremor | III-C |
| Dilated convolution | A filter applied with gaps between samples, to see a longer stretch cheaply | V-B |
| Dropout | Randomly silencing units during training to reduce overfitting | V-B |
| DTW (dynamic time warping) | Compares signals that may be stretched or shifted in time | VII-A |
| Dwell | Holding the gaze on a target for a set time (400 ms) before it activates | III-A |
| Epoch | One pass over the training data | V-B |
| Event recall | See TAR | VI |
| ExtraTrees (extremely randomised trees) | An ensemble of decision trees with random split thresholds | V-A |
| F1 | Harmonic mean of precision and recall; "window F1" scores windows, not events | VII-C |
| Fail-closed | Any doubt cancels the action rather than letting it proceed | III-E |
| FAR (false activation rate) | False activations per hour of time with no gesture under way | VI |
| GATT | Bluetooth's service/characteristic data model; peripheral serves, central connects | III-D |
| Group DRO | Training that optimises the worst-performing group | II-C |
| HGB | Histogram gradient boosting, a fast tree-boosting classifier | VII-A |
| Hysteresis | Separate on and off thresholds so a detection does not flicker | V-C |
| IMU (inertial measurement unit) | Accelerometer plus gyroscope (and orientation) | I |
| Late | A detection during a pinch that was not caught in its window | VI |
| Leave-one-day-out | Train on all days but one, test on that day, repeat | VI |
| MAD (median absolute deviation) | Median distance from the median: a spread measure robust to outliers | V-B |
| MediaPipe Hand Landmarker | Google's model that finds 21 hand points per camera frame | IV-B |
| Monitor mode | Scores and logs but never acts | III-E |
| MTU (maximum transmission unit) | Largest packet a Bluetooth link negotiates (517 here) | III-D |
| Overlay | Transparent always-on-top window showing the knob without taking focus | III-A |
| Peak trigger | Emit a detection at the first fall after the score crosses the threshold | V-C |
| Poisson bound | Upper limit on a rate when zero events were seen: about 3/T per hour | VI |
| PPG (photoplethysmography) | Light-based measurement of blood volume under the skin | II-A |
| Quaternion | Four numbers describing a 3-D orientation without gimbal lock | III-B |
| Recipe | A chain of head, gesture and wrist stages driving one action | III-E |
| Reference annotation | The best available label of when a pinch happened (camera plus manual edits), not verified ground truth | IV-B |
| Release threshold | Score below which an active detection ends (0.15 under activation) | V-C |
| Repeat | Extra detection during an already caught pinch | VI |
| Reset counter | Headset value that changes when its reference frame resets | III-B |
| Rolling normalisation | Earlier scaling: each tick against the 10 s before it | VII-D |
| SHA-256 | A cryptographic fingerprint proving a model file is unchanged | III-E |
| Sigmoid (σ) | Function mapping any number into 0–1 | V-B |
| Slew limit | Maximum rate of volume change (30 points/s) | III-C |
| Still-hand rule | Only allow a gesture to start after a still hand | VII-B |
| TAR (true activation rate) | Share of labelled pinch starts caught | VI |
| Tauri | Framework for desktop apps with a Rust back end and web front end | III-A |
| Watchdog | Timer that releases a grab whose data went silent (750 ms) | III-E |
| Window-score diagnostic | A check using the peak score near each pinch, not a full event replay | VII-D |
| Worst-split AUC | The lowest AUC across all splits; a pessimistic summary | VI |
| z-score | Value minus a mean, divided by a standard deviation | V-A |

## Where every number comes from

Each figure in the paper traces to a file in the `gesture-controls` repository. When a reviewer asks "where is this from?", start here.

| Paper figure(s) | Section | Source file |
| --- | --- | --- |
| Table I rates; Table III data-path measurements; MTU 514/512 fault; 61 → 30 notifications; 20 dropped messages | III-A, III-D | `docs/research/watch-data-path-findings-2026-10.md` |
| Table II filters; 0.5-point steps, 150 ms easing, 1°, \~3° per point | III-C | `docs/original-volume-interaction.md`; `docs/architecture/safety-and-fail-closed-behavior.md` |
| 130–190 ms macOS volume call; 500 ms freshness; 750 ms watchdog | III-C, III-E | `docs/architecture/safety-and-fail-closed-behavior.md` |
| 37 exports, 28 distinct streams | IV-A | `docs/paper/EVIDENCE_AUDIT.md`; `revision-assets/evidence-audit.json` |
| Label lag up to 1.3 s | IV-B | `docs/research/ppg-imu-fusion-and-triggers-2026-10.md` |
| 0.35 hand sizes; 110 → 20 false activations/h | IV-B | `docs/architecture/pinch-models.md` |
| 8 of 163 pinch-in intervals without a hold | IV-B | `docs/research/camera-label-hold-audit-2026-11.md` |
| Tree features (1,701 + 1,032), 300 trees; CNN architecture and training settings | V-A, V-B | `docs/architecture/pinch-models.md` |
| Normalisation constants (549, 50, 1.4826, floors, ±500) | V-B | `tools/label-trainer/src/label_trainer/cnn_input.py` |
| Peak trigger, release and cooldown behaviour | V-C | `crates/label-inference/src/detection.rs` |
| Event categories; \~175/h denominator example; match windows | VI | `docs/research/gesture-detector-evaluation-metrics.md` |
| 84% (1,645 of 1,958) rest controls; step 0.94/0.65/700 ms | VII-A | `docs/research/ppg-step-findings-2026-10.md` |
| Held-out day 0.60–0.64; fist 0.37–0.57; 208/80/68 moments | VII-A | `docs/research/ppg-onset-heldout-test-2026-10-14.md` |
| Table VI | VII-A | `docs/research/ppg-mixed-era-robustness-2026-10.md` |
| 0.7885/0.8426/0.8105, 41.15%, 15.09/min, \~830 ms | VII-A | `docs/research/ppg-gesture-literature-2026-10.md` (benchmark position) |
| 0.789 → 0.837; 19.0 → 12.0/min; peak +4–12 points; 35–90 ms | VII-B | `docs/research/ppg-imu-fusion-and-triggers-2026-10.md` |
| Table VII; per-day 21/171, 37/52, 67/92, 36/57 | VII-B | `docs/research/artifacts/cnn-all-days-2026-11/results.md` |
| Trees 10–28% on new sessions; \~0.4 s sooner | VII-B | `docs/architecture/pinch-models.md`; `docs/research/artifacts/camera-old-new-2026-11/results.md` |
| Table VIII; 0.970 peak; threshold sweep | VII-C | `docs/paper/revision-assets/HAND_LABELLED_REPLAY.md`; `hand-labelled-replay.json`; `replay_hand_labelled.py` |
| Table IX; 0.03 → 1 rad/s; 0.62 and 14 rad/s | VII-D | `docs/research/cnn-motion-hangover-2026-11.md` |
| Table X; 2 s window; pretraining | VII-E | `docs/architecture/pinch-models.md` |
| Curriculum 15/19, 10/19; newest-only 4.9–31.4% | VII-E | `docs/research/cnn-curriculum-old-noise-2026-11.md` |
| Double-pinch 278 contacts; 76 → 0.6, 40 → 0.4 per minute | VII-F | `docs/research/double-pinch-conditions-2026-10.md` |
| System performance (452 µs → 0.1 µs, 17.5 → 12.0 MB, etc.) | VII-G | `docs/performance.md` |
| 12–18% on 14 October vs 63–75% on 3–4 November | IX | `docs/architecture/pinch-models.md` |

**Checks to keep the paper honest.** `docs/paper/revision-assets/verify.py` and `docs/paper/archive/codex-tools/verify.py` re-check links, model hashes and the paired LaTeX bodies; `replay_hand_labelled.py` recomputes Table VIII from the checked-in model and recordings.
