# Documentation

## Using and running

- [Using the application](using-the-application.md): setup, every tab, and the safe workflow from raw telemetry to a desktop-controlled volume gesture
- [Running the project](development/running-project.md): prerequisites, one-command launch, tracker setup, tests and CI
- [Troubleshooting the watch link](troubleshooting-watch-link.md): reading Link health, why a link ends, and the causes found so far

## Architecture

- [Components and deployment](architecture/components-and-deployment.md): what runs where, how the pieces communicate, data at rest, build, packaging and CI
- [Performance review](performance.md): what was measured, what changed because of it, what was deliberately left alone, and how to reproduce the numbers
- [Safety and fail-closed behavior](architecture/safety-and-fail-closed-behavior.md): the invariants that bound what the desktop can do, and what is not guaranteed
- [Project brief](architecture/project-brief.md): the original design specification and milestone plan (see its status note for where the implementation differs)
- Per-app structure: [desktop](../apps/desktop/ARCHITECTURE.md), [watch](../apps/watch/ARCHITECTURE.md), [Sony tracker](../tools/sony-head-tracker/ARCHITECTURE.md)
- Training tooling: [label-trainer](../tools/label-trainer/README.md)

## Protocols

- [Watch WebSocket protocol](protocols/watch-websocket-protocol.md): the message envelope and every message, shared by both transports; the Wi-Fi transport
- [Watch Bluetooth LE transport](protocols/watch-ble-transport.md): the default transport, framing, trust model and failure states

## Research

- [PPG gesture-recognition literature, benchmark position, and acquisition priorities, October 2026](research/ppg-gesture-literature-2026-10.md): smartwatch/custom-hardware research, why reported metrics differ, the valid closure-label result, and the next data-collection protocol.
- [PPG step across a gesture: findings, October 2026](research/ppg-step-findings-2026-10.md): whether the PPG change around a gesture is the same from session to session (yes for pinch), what was built from it, and what is next
- [Green PPG pinch-onset experiments, October 2026](research/ppg-green-onset-experiments-2026-10.md): reproducible onset/duration experiments, results, limitations, and the candidate next pipeline
- [RGB PPG pinch-onset follow-up experiments, October 2026](research/ppg-rgb-onset-follow-up-2026-10.md): preprocessing, feature, regularization, augmentation, and label-audit results; research-only candidate and evidence gaps
- [PPG pinch onset: mixed-era robustness study, October 2026](research/ppg-mixed-era-robustness-2026-10.md): 32-recording strap/session-generalisation screens, robust model combinations, operational checks, and the remaining untouched-data gate
- [PPG pinch onset: held-out test on the 2026-10-14 recordings](research/ppg-onset-heldout-test-2026-10-14.md): every October technique, trained on the original recordings and tested once on a new day with labelled non-pinch activity: about 0.60-0.64 AUC, fist starts not told apart, no usable detector
- [PPG pinch onset: the open questions, tested, October 2026](research/ppg-onset-open-questions-2026-10.md): non-pinch negatives, decision delay, motion, days, intervals, mark timing and continuous detection on the current recordings: a real but weak, slow, non-specific onset cue
- [Pinch start: adding the IMU, trigger rules and label shifts, October 2026](research/ppg-imu-fusion-and-triggers-2026-10.md): PPG + IMU beats PPG alone (worst split 0.79 → 0.84) and halves false activations on no-pinch recordings; firing on the probability's peak helps; the false activations left are real reactions to other movement, so the next step is everyday-movement data and camera-timed labels
- [Pinch boundaries with PPG and IMU: proxy evaluation, October 2026](research/ppg-imu-boundary-proxy-2026-10.md): recording-disjoint evidence that PPG+IMU is stronger than either input for generic labelled pinch starts and ends; force/intensity remains untested
- [Slope and waveform-morphology features for PPG gesture-event detection](research/slope-morphology-event-detection.md): the research behind the idea, and the methods to compare
- [PPG slope-event technique](architecture/ppg-slope-event-technique.md): the technique as specified, and its implemented first stage
- [Watch data path: findings, October 2026](research/watch-data-path-findings-2026-10.md): how samples reach the desktop now, why PPG went missing over Bluetooth and the graph lagged, what was measured and what is still open

## Decisions

- [Dataset capture and recording contract](decisions/2026-09-dataset-capture-recording-contract.md)
- [UI consistency contract](decisions/2026-09-ui-consistency-contract.md)
- [Model Lab domain model](architecture/model-lab-domain.md) (per-label binary models; step 1, not yet wired into the app)
- [Label inference: bundles, pipeline and detections](architecture/label-inference.md) (step 2; in-process runtime, nothing runs until a model is imported)
- [Model format and inference runtime](decisions/2026-10-model-runtime-and-format.md) (in-process, no Python at runtime; since 2026-10-19 the one model is ExtraTrees as a plain `model.trees` file, not ONNX)
- [Wi-Fi vs BLE watch transport](decisions/2026-09-24-wifi-vs-ble-transport.md) (superseded: Bluetooth is now the default)

## Release

- [Release-readiness acceptance checklist](release-readiness.md): the real-device gate

## Records

- [Review remediation](review-remediation.md): the status of every finding in the four engineering reviews, with commits
- [GC-036 optimization and documentation pass](optimization-2026-09-gc-036.md)
- The reviews themselves (historical, not edited): [`.hermes/reviews/`](../.hermes/reviews/)
- Task and checkpoint logs: [`TASKS.md`](../TASKS.md), [`CHECKPOINT.md`](../CHECKPOINT.md)
