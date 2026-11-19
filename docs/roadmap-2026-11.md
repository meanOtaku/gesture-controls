# Refinements and ideas, November 2026

Updated: 2026-11-19, at version 0.2.0. A list of ways to make the project more dependable, more widely useful and
stronger as a paper. Nothing here is built or run yet unless its **Status** says so. Each item gives the evidence for it,
what it adds to the paper, and a first step.

**Status** is one of:

- **New**: not in the project or the paper.
- **Partly there**: some of it exists, as named.
- **Planned in the paper**: already described in the manuscript's prospective protocol (§8) or limitations (§9).

## Recommended first five

1. [Arbitrate between gestures](#1-arbitrate-between-gestures): fixes the snap and pinch-in conflict in the newest
   model, and is small.
2. [A "not me" button that feeds training](#2-a-not-me-button-that-feeds-training): attacks the largest live failure.
3. [Extend look–pinch–turn beyond volume](#7-extend-lookpinchturn-beyond-volume): more uses for the interaction that
   already works.
4. [Several participants, across days](#17-several-participants-leaving-whole-people-out): the paper's main
   limitation.
5. [Camera-proposed, hand-confirmed labels](#23-camera-proposed-hand-confirmed-labels): faster labelling, which
   makes item 4 affordable.

## A. Fewer misfires and missed gestures

### 1. Arbitrate between gestures

**Status:** New.

**Evidence:** in the four-gesture model retrained after the snap relabelling, 18 of 38 held-out snaps also take pinch-in
past its cut-off, against 4 before ([`snap-multi-2026-11`](research/artifacts/snap-multi-2026-11/README.md)). In the
app a snap can trigger the pinch-in action too.

**Idea:** a small arbiter over the model's outputs. Within a short window it keeps only the strongest gesture, then
holds a refractory period. Training also uses each gesture as a negative for the others.

**Paper:** the event-confusion matrix before and after.

**First step:** add the arbiter to the replay in `snap-multi-2026-11/compare.py` and measure snaps caught, pinch-ins
caught and cross-fires.

### 2. A "not me" button that feeds training

**Status:** New.

**Evidence:** at 0.99 a pinch model still fires about 21 times an hour on everyday movement
([live misses](research/live-misses-2026-11.md)). The remedy is more hard negatives, and live use produces them.

**Idea:** when a detection fires wrongly, one click in the app (or a gesture on the watch) saves the surrounding
seconds as a labelled negative stretch. Model Lab offers them to the next training run as everyday-noise data.

**Paper:** false activations an hour against rounds of this loop. This is active learning from real use.

**First step:** log the last 5 s of samples and the detection with each click, as a recording the labelling page can
open.

### 3. An arming gesture

**Status:** New. Off, Monitor and Live modes exist; this is a lighter layer inside Live.

**Idea:** for example, a double snap arms pinch actions for 10 s. False activations outside that window cannot act.

**Paper:** a measured trade-off between false activations an hour and the extra effort.

**First step:** replay the held-out recordings with an arming rule and count what is left.

### 4. Calibration for each user in about 2 minutes

**Status:** New. Needs [item 17](#17-several-participants-leaving-whole-people-out) to be measured.

**Idea:** the user records about 20 pinches. Only the last layer, or only the cut-offs, is fitted to them.

**Paper:** accuracy for a new person with 0, 10, 20 and 50 examples.

### 5. Post-motion training as an opt-in trainer option

**Status:** Partly there. The experiment is done
([`post-motion-2026-11`](research/artifacts/post-motion-2026-11/README.md)).

**Evidence:** over three seeds it catches about 4 more of 50 pinches made 0.25 s after 14 s of motion, and about 4
fewer of 89 on ordinary recordings.

**Idea:** a Model Lab training option, off by default. It trains a new version and never replaces the active model.

### 6. Show the uncertainty of false-activation rates

**Status:** Partly there. The paper reports a 95% upper bound; Model Lab does not.

**Evidence:** about 0.5 h of held-out no-gesture time means one false activation counts as 2 an hour. Models are
judged deployable or not on that.

**Idea:** Model Lab shows the 95% upper bound and the hours behind each rate, and warns when the time is too short to
judge.

## B. Wider use

### 7. Extend look–pinch–turn beyond volume

**Status:** Partly there. The pinch volume knob works
([original volume interaction](original-volume-interaction.md), which plans brightness and scrolling next).

**Idea:** the same grab and turn for brightness, scrolling, media scrubbing, zoom and drone throttle, and several head
targets on screen at once.

**Paper:** one interaction technique applied to several controls makes a stronger HCI claim than one control.

### 8. Gestures by sequence

**Status:** Partly there. Double-pinch research exists
([double pinch conditions](research/double-pinch-conditions-2026-10.md)).

**Idea:** a small grammar of sequences such as double pinch, pinch then snap, and long hold. It adds commands without
new models.

### 9. Profiles for each app

**Status:** New.

**Idea:** the frontmost app chooses which recipes are enabled. For example, pinch is play/pause in a media player and
next slide in a presentation.

### 10. An open output API

**Status:** New.

**Idea:** send detections and the knob's value over OSC, WebSocket or MIDI. Other tools can then use them: music
software, home automation, OBS, game engines.

**Paper:** shows the system is a general input device, not a single demo.

### 11. Run the model on the watch

**Status:** New.

**Evidence:** Bluetooth ordering and Samsung's freezing of background apps have both caused misses.

**Idea:** the watch runs the CNN and sends only detections and readiness. That means less radio traffic, it works
without the desktop (for example to control a phone), and it may use less battery.

**Paper:** on-watch latency and energy against laptop inference.

**First step:** measure CNN v2 inference time on the Galaxy Watch4 with TFLite.

### 12. Accessibility: the pinch as a switch

**Status:** New.

**Idea:** switch access for people with limited hand or arm movement: a pinch as one switch, with dwell and scanning
modes, and the arming rule from item 3.

**Paper:** strong motivation and a clear impact statement. Any claim needs a study with those users.

### 13. Haptic confirmation of each detection

**Status:** Partly there. The watch already vibrates on the desktop's `desktop.haptic` command.

**Idea:** a setting that sends a short vibration on each detection, different for each gesture, so the user knows what
fired without looking.

**Paper:** §8 already plans haptic-feedback tests. This makes them possible.

## C. Engineering

### 14. Regression tests from recorded live sessions

**Status:** Partly there. Live parity is shown
([`live-parity-2026-11`](research/artifacts/live-parity-2026-11/README.md)).

**Idea:** save real live sessions, including message order and clock-estimate changes, and replay them through the
runtime in CI. This would have caught the out-of-order message and time-going-backwards bugs of November.

### 15. A full latency breakdown

**Status:** Planned in the paper.

**Idea:** timestamps at each stage (sensor, watch send, Bluetooth, desktop receive, buffering, model, gate, action),
shown in the app and exported.

**Paper:** a stacked latency figure, and it shows where to cut.

### 16. Battery and heat

**Status:** Partly there. The watch already reports battery and temperature in its stats.

**Idea:** a fixed test of drain per hour at 100 Hz with pulse on and off, and with on-watch inference if item 11 is
built.

## D. Mainly for the paper

### 17. Several participants, leaving whole people out

**Status:** Planned in the paper (§8). All data so far come from one participant (§9).

**Idea:** 5–10 people. Hold out whole participants for any user-independent claim.

**Paper:** this is the main limitation. Item 23 makes labelling their data affordable.

### 18. Across days and strap refits

**Status:** Planned in the paper (§8).

**Idea:** the same people on new days, with the watch taken off and put back on, looser and tighter.

### 19. Ablations

**Status:** Planned in the paper (§8) for IMU-only, PPG-only and fused inputs, rolling against median scaling, and the
CNN against the trees.

**Add:** input rate (25, 50, 100 Hz), window length, the jerk gate on and off, and model size.

### 20. All-day wear

**Status:** New.

**Idea:** 8 hours of ordinary life with the app in Monitor, counting false activations and their causes.

**Paper:** false activations an hour with a tight interval, instead of an upper bound from 0.5 h.

### 21. Seeds and intervals everywhere

**Status:** Partly there. The post-motion experiment uses three seeds.

**Idea:** every comparison reports the mean and spread over at least three seeds, with bootstrapped intervals over
recordings. Seeds 17 and 18 of the same model differ by 8 of 89 pinches caught, as much as most variants do.

### 22. Label quality as a finding

**Status:** Partly there. The paper has an annotation audit (§4).

**Evidence:** the snap relabelling is a natural experiment. The same architecture trained on tighter labels went from
21 to 31 of 38 snaps caught.

**Add:** a second annotator on a sample of recordings, to measure boundary agreement. §9 names its absence as a
limitation.

### 23. Camera-proposed, hand-confirmed labels

**Status:** Partly there. Camera labels were used, then replaced by hand labels because of per-recording lag of up to
1.3 s ([PPG and IMU fusion](research/ppg-imu-fusion-and-triggers-2026-10.md)).

**Idea:** the camera does not label. It proposes each pinch with its fingertip distance, and the person only confirms
and nudges the boundaries on the labelling page.

**Paper:** labelling time saved, and agreement of confirmed boundaries with fully manual ones.

### 24. Self-supervised pretraining, again

**Status:** Partly there. An earlier attempt gave a modest result
([mixed-era robustness](research/ppg-mixed-era-robustness-2026-10.md)).

**Idea:** retry with CNN v2 and the much larger pool of unlabelled everyday recordings.

**Paper:** how many labels are needed with and without pretraining. Low priority.

### 25. Baselines

**Status:** Partly there. The trees exist, and §8 plans the CNN against them.

**Add:** a plain threshold detector on the jolt, and one method reproduced from prior smartwatch-gesture work.

### 26. A user study

**Status:** Planned in the paper (§8): a counterbalanced task against a conventional volume control.

**Add:** SUS and NASA-TLX questionnaires, and tasks beyond volume from item 7.

### 27. Release the dataset and benchmark

**Status:** New.

**Idea:** publish the deduplicated, hand-labelled recordings with a dataset card and the whole-recording replay
evaluator as a benchmark. The duplicate-export audit in §4 already gives the deduplication.

**Paper:** a contribution of its own that others can cite and compare against.

### 28. AR and VR headsets

**Status:** Planned in the paper (§8).

**Idea:** the watch pinch where the headset's cameras cannot see the hand, compared with and combined with the
headset's own pinch.
