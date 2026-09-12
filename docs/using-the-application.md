# Using Spatial Gesture Control

This guide explains how to set up and use the desktop application, what every tab does, and the safe workflow for moving from raw sensor telemetry to a desktop-controlled volume gesture.

> **Safety first:** Watch and headphones are sensor sources only. Model training, LiteRT inference, policy decisions, and actions run on the desktop. Keep inference **Off** until you have recorded data, trained a reviewed model, verified it in **Monitor** mode, and completed the applicable checks in [release readiness](release-readiness.md).

## 1. Before you start

### What you need

- A supported desktop host. The packaged application is intended for macOS, Windows, and Linux; actual install/package validation is still a release gate.
- Sony headset tracking when you want gaze calibration and the overlay. On macOS/Windows, `npm start` starts the pinned Sony tracker bridge alongside the desktop app. Linux development can use the sample sender because the upstream tracker has no Linux hardware backend.
- A Galaxy Watch for Watch IMU/PPG telemetry and gesture recording. The desktop and Watch must be on the same local network for discovery and streaming.
- `uv` and a repository checkout only when using the current development-only training or replay workflow in Model Lab. The app's **Desktop readiness** panel will report missing requirements.

### Start a development checkout

From the repository root:

```bash
npm ci
npm start
```

`npm start` launches the Sony tracker bridge and the Tauri desktop app together. To run the Tauri app alone during Linux/sample-sender development:

```bash
npm run tauri -- dev
python3 tools/sony-head-tracker/scripts/send_sample.py
```

For host prerequisites and tracker troubleshooting, see [Running the project](development/running-project.md).

### First launch checklist

1. Open **Model Lab** and review **Desktop readiness**. Use **Recheck** after installing a missing prerequisite.
2. Confirm the required system-volume backend is reported as available before testing volume control.
3. Connect the headset and, if used, the Watch. Keep inference **Off** until the model workflow below is complete.
4. Do not use Live mode with an unreviewed model or a production audio device.

## 2. Recommended first-use workflow

Follow this order rather than enabling every feature at once:

1. **Headphones:** connect Sony tracking and capture the center and top-right calibration targets.
2. **Watch:** confirm connection, raw orientation, and any enabled health-sensor state.
3. **Live data:** make a short ordinary CSV capture to verify incoming telemetry.
4. **Live data:** record several labeled sessions for each intended gesture and non-gesture/background activity; export one dataset CSV per session.
5. **Model Lab:** import sessions, check label coverage, train a TFLite model, inspect evaluation, and configure safe class bindings.
6. **Model Lab:** promote the model through the lifecycle, activate it, and run offline replay.
7. **Model Lab:** use **Monitor** mode with live telemetry. It records decisions but cannot operate desktop controls.
8. Only after reviewing Monitor results and validating the target platform, use **Live** mode with an isolated test audio output.

## 3. In-app feedback, help, and file saves

### Async action feedback

Buttons that trigger a desktop-side operation (training, activation, rollback, inference-mode changes, wellness measurements, CSV saves, and similar) show a pending state while the request is in flight — the button's label changes (for example to "Saving…" or "Updating…") and it disables itself so a second click cannot fire a duplicate request. When the operation finishes, the outcome is reported as a toast notification: **success**, **info** (for example, a cancelled save), **warning**, or **error**, each auto-dismissing after a few seconds. Treat these toasts, not silent completion, as confirmation that an action actually happened.

### Contextual help

A small "?" icon next to some section headings and controls opens an accessible help tooltip on hover, keyboard focus, or click. It is used where a control's behavior is not obvious from its label alone — for example, the difference between recording rate and graph refresh rate, what a safe intent binding can and cannot do, or what each inference mode is allowed to do. Not every control has one; obvious controls intentionally do not.

### Saving CSV files

**Save CSV** and **Export Dataset CSV** open your operating system's native save dialog so you choose the destination yourself; nothing is written until you confirm the dialog. Canceling the dialog reports "Save cancelled" and writes nothing. A write failure (for example, no permission to the chosen folder) is reported with the underlying error rather than failing silently. In the browser-preview build only (no Tauri runtime), the same actions fall back to a normal browser download since no native dialog is available there; this fallback is never used to mask a Tauri write failure.

## 4. Tabs and features

### Main

The **Main** tab is the at-a-glance control center.

- Shows headset and Watch connection summaries.
- Shows the current calibration/target state.
- Provides the primary calibration actions when available.
- Surfaces application errors, such as tracker, calibration, overlay, or sensor-control failures.

Use it to confirm that the system is connected before moving into calibration, recording, or model work.

### Headphones

The **Headphones** tab is for Sony tracker status and gaze calibration.

- Displays device identity, orientation, quaternion, gyroscope, packet rate, latency, and reset state.
- Lets you capture the **center** reference and the **top-right** activation target.
- Lets you adjust the target acceptance threshold and dwell duration.
- Reports when recalibration is needed after a tracker reference-frame reset.

#### Gaze overlay workflow

1. Put on the headset and wait for a stable connection.
2. Face your neutral forward direction and capture **Center**.
3. Look at the desired upper-right position and capture **Top-right**.
4. Hold your gaze on the top-right target for the configured dwell time to show the volume overlay.
5. Leaving the target, losing headset tracking, or pressing **Escape** hides the overlay.

The overlay is deliberately non-focus-stealing. Keyboard volume controls only work while a visible overlay and a supported native volume backend are available.

### Watch

The **Watch** tab is the Watch connection and sensor-control dashboard.

- Shows whether the Watch is connected and its connection/clock-synchronization state.
- Shows raw orientation and PPG status when those streams are available.
- Shows available Samsung health-sensor telemetry, such as heart rate, skin temperature, or EDA, when supported by the device and permissions.
- Provides immediate enable/disable controls for supported Watch sensor streams.

If a sensor is unavailable, treat that as a device capability or permission state—not a successful inference input. Low-quality, stale, malformed, or disconnected sensor data fails closed and releases any active interaction.

### Live data

The **Live data** tab is the telemetry viewer and recorder.

#### Live charts

It visualizes available raw streams, including:

- Headphone yaw, pitch, and roll.
- Watch orientation.
- Raw PPG: green, red, and IR.
- Available health streams such as heart rate, IBI, temperature, EDA, SpO2, and ECG.

Chart visibility follows the enabled/streaming state of the corresponding sensor.

#### Ordinary CSV capture

Use **Start recording** / **Stop recording** for a general telemetry capture, then choose **Save CSV**. This exports buffered incoming rows with source timestamps and sequences. The tab shows buffer usage; when the cap is reached, the oldest ordinary-capture rows are dropped.

#### Labeled dataset recorder

Use this for model training data:

1. Choose a built-in label or enter a custom label and select **Use custom label**.
2. Choose **Start**.
3. Perform only the selected gesture or activity during the session.
4. Choose **Stop**.
5. Choose **Export Dataset CSV**.

Each exported dataset file is one uniformly labeled session. **Discard** removes the current in-memory labeled session without exporting it. Preserve a mix of positive gestures and realistic background/negative activities; that is important for false-activation evaluation.

### Model Lab

The **Model Lab** tab manages datasets, model training, model safety state, replay, and desktop inference mode.

#### Desktop readiness

This panel checks local prerequisites without reading or transmitting telemetry:

- availability of the `uv` runner;
- availability of the bundled classifier project;
- whether this desktop build includes LiteRT inference;
- availability of the current platform's system-volume backend.

Training and replay are currently development workflows: they use `uv` and the repository's `tools/pinch-classifier` project. LiteRT must be present in the desktop build for real model inference; otherwise the app remains fail-closed.

#### Live inference diagnostics

This panel displays the active model, current inference mode, and a bounded recent-event feed.

- **Off:** no model decisions are processed for control.
- **Monitor:** decisions and quality outcomes are visible, but desktop actions are not permitted.
- **Live:** only a validated active model with complete safe bindings may issue approved safe intents.

Use **Monitor** before **Live**. A stale input, quality rejection, malformed/out-of-order telemetry, runtime error, model swap, mode downgrade, or Watch disconnect force-releases and hides an active interaction.

#### Dataset and label coverage

1. Import exported dataset CSV files.
2. Select the sessions to include in training.
3. Review per-label coverage and the label catalogue.

Labels have stable IDs, display metadata, roles, and archive state. Archiving is non-destructive: historical recordings and models retain their label meaning. Do not train a deployable gesture model until relevant positive and negative/background labels have useful coverage.

#### Training and evaluation

Choose a backend:

- **TFLite:** the deployable desktop model path.
- **scikit-learn baseline:** useful for comparison, but it cannot be activated for desktop Live inference.

Start training and monitor the in-app progress/log output. After training, inspect the evaluation data and false-activation behavior before promotion.

#### Model lifecycle, bindings, activation, and rollback

Models move through the lifecycle:

```text
Draft → Evaluated → Approved → Active → Archived
```

- Use lifecycle controls to promote a reviewed model; only an **Approved** model can become active.
- Configure every deployable class with one of the offered **safe intents**. Arbitrary shell or desktop commands are never available.
- A TFLite model with complete bindings is required for activation.
- The active model bundle, contract, digest, and binding snapshot are revalidated and immutable while active.
- Use rollback to return to a previously approved model. Model swaps release an active interaction before the swap completes.

#### Offline replay

Replay runs a managed dataset against an approved or active validated TFLite bundle without operating gestures or volume. It produces bounded per-window outcomes and a summary. Use it to compare expected labels with predicted decisions before enabling Live mode.

### Settings

The **Settings** tab controls desktop acceptance/recording rates and Watch delivery settings. Edit values, then choose **Apply rates**; use **Reset to defaults** to restore defaults.

#### Headphones

- Enable or disable accepted headphone samples.
- Set the headphone acceptance rate.

Incoming Sony packets still maintain connection and calibration state; this setting controls what the desktop accepts for display and recording.

#### Wrist rotation tuning

These settings apply to the next successful volume grab (from the Watch button fallback or an approved live model gesture):

- **Dead zone:** rotation ignored near the starting pose.
- **Smoothing:** motion smoothing strength.
- **Sensitivity:** volume points per degree.
- **Max angular velocity:** rejects implausibly fast twist motion.
- **Max volume rate:** caps how quickly volume can change.

Defaults target roughly 30 volume points for a 90° twist. Begin with defaults and adjust gradually using a test audio output.

#### Recording, graphs, and Watch rates

- Set ordinary recording rate and graph refresh rate.
- Set Watch orientation, acceleration, and gyroscope delivery rates.
- Set raw PPG flush rate and desktop acceptance rates for heart rate, temperature, and EDA.
- Toggle supported Watch sensor streams.

These controls preserve raw source timestamps. For health sensors, Samsung/device sampling remains authoritative; some controls affect desktop acceptance or flush/delivery behavior rather than physical sampling frequency.

## 5. How volume control works

### Watch-button fallback

With model inference Off, the supported Watch-button interaction can begin a volume grab after the gaze target is active. The desktop establishes a fresh wrist-orientation reference, then maps safe wrist rotation to bounded volume changes. Releasing the button ends the interaction.

### Model-assisted gesture

With a validated active TFLite model in Live mode, the desktop may begin or release only the intent explicitly bound to the model class. The model does not run on the Watch or headphones. The same desktop transaction is used for model and button initiation so a new interaction always gets a fresh rotation reference.

### Native platform volume backends

- **macOS:** native system output volume adapter.
- **Windows:** Core Audio default multimedia output adapter.
- **Linux:** PipeWire (`wpctl`) first, PulseAudio (`pactl`) fallback.

Use the Desktop readiness screen to check the backend. Backend errors fail closed: the app must not claim a volume change it did not perform.

## 6. Troubleshooting and safe recovery

| Symptom | What to do |
| --- | --- |
| Watch is not connected | Confirm both devices are on the same LAN, open the Watch app, check permissions, and use the Watch tab to confirm discovery/connection state. |
| No PPG or health data | Verify Watch hardware support, permissions, sensor switches, contact quality, and any Samsung Health SDK status. The app will reject unusable data rather than guessing. |
| Overlay does not appear | Recalibrate center and top-right, verify headset packets are arriving, then wait for the configured dwell. |
| Volume does not change | Check Desktop readiness for the platform backend; use a test audio output; ensure the overlay is visible and an interaction is actively grabbed. |
| Monitor/Live controls are disabled | Activate an Approved, validated TFLite bundle with complete safe intent bindings. LiteRT must also be included in the desktop build. |
| Model training/replay cannot start | Open Desktop readiness, install `uv`, use a complete repository checkout, and recheck. |
| An interaction remains active unexpectedly | Stop Watch telemetry or disconnect the Watch; the desktop should force-release/hide. Also leave the gaze target or press Escape to hide the overlay. |

## 7. Before enabling Live on your own hardware

Complete the applicable items in [Release-readiness acceptance checklist](release-readiness.md), especially:

- record and retain real labeled data;
- review evaluation and offline replay;
- verify Monitor produces no actions;
- test stale telemetry, disconnect, sensor-quality rejection, model failure, and mode downgrade;
- test the native volume backend on the target operating system;
- test the produced package on a clean host.

The current Watch LAN connection does not implement pairing-derived identity or authenticated sessions. That accepted risk is documented in the release checklist and is outside the present feature scope.
