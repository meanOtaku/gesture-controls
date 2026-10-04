# Using Spatial Gesture Control

This guide explains how to set up and use the desktop application, what every tab does, and the safe workflow for moving from raw sensor telemetry to a desktop-controlled volume gesture.

> **Safety first:** Watch and headphones are sensor sources only. Model training, LiteRT inference, policy decisions, and actions run on the desktop. Keep inference **Off** until you have recorded data, trained a reviewed model, verified it in **Monitor** mode, and completed the applicable checks in [release readiness](release-readiness.md).

## 1. Before you start

### What you need

- A supported desktop host. The packaged application is intended for macOS, Windows, and Linux; actual install/package validation is still a release gate.
- Sony headset tracking when you want gaze calibration and the overlay. On macOS and Windows, `npm start` builds the tracking support directly into the desktop app (no separate process); on macOS grant it Input Monitoring on first launch, on Windows follow Sony Head Tracker's Repair Tracker instructions yourself if the sensor node is missing. Linux development can use the sample sender because the upstream tracker has no Linux hardware backend.
- A Galaxy Watch for Watch IMU/PPG telemetry and gesture recording. The Watch connects over **Bluetooth LE by default** (the desktop needs a Bluetooth adapter, and you approve the desktop once on the Watch with **Trust this computer**), or over Wi-Fi, in which case both devices must be on the same non-isolated local network. Pick the transport in Settings; see the [Bluetooth transport](protocols/watch-ble-transport.md).
- `uv` and a repository checkout only when using the current development-only training or replay workflow in Model Lab. The app's **Desktop readiness** panel will report missing requirements.

### Start a development checkout

From the repository root:

```bash
npm ci
npm start
```

On macOS and Windows, `npm start` launches only the Tauri desktop app, which acquires the Sony headset itself; set `SONY_HEAD_TRACKER_PROVIDER=external` to fall back to the separate tracker bridge instead. To run the Tauri app alone during Linux/sample-sender development:

```bash
npm run tauri -- dev
python3 tools/sony-head-tracker/scripts/send_sample.py
```

For host prerequisites and tracker troubleshooting, see [Running the project](development/running-project.md).

### First launch checklist

1. Open **Model Lab** and review **Desktop readiness**. Use **Recheck** after installing a missing prerequisite.
2. Confirm the required system-volume backend is reported as available before testing volume control.
3. Connect the headset and, if used, the Watch. Keep inference **Off** until the model workflow below is complete. The inference mode is remembered between launches, but a remembered **Live** is always reduced to **Monitor** at startup: select Live again, deliberately, each session.
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
- Lets you capture the **center** reference and any number of named locations (**Top right** is there to start with). **Add location** creates another and **Remove** deletes one (Center cannot be removed). Recipes refer to locations by name. Locations are remembered between runs; captures are not, because a head pose only means something for the tracker session it was taken in.
- Lets you adjust the target acceptance threshold and dwell duration.
- Reports when recalibration is needed after a tracker reference-frame reset.

#### Gaze overlay workflow

1. Put on the headset and wait for a stable connection.
2. Face your neutral forward direction and capture **Center**.
3. Look at the place you want to use and capture that location (for example **Top right**).
4. Hold your gaze on the location a recipe starts from, for the configured dwell time, to show the volume overlay.
5. Leaving the location, losing headset tracking, or pressing **Escape** hides the overlay.

The overlay is deliberately non-focus-stealing. Keyboard volume controls only work while a visible overlay and a supported native volume backend are available.

### Watch

The **Watch** tab is the Watch connection and sensor-control dashboard.

- Shows whether the Watch is connected and its connection/clock-synchronization state. Over Bluetooth it also shows why nothing is streaming yet (scanning, awaiting approval on the Watch, Bluetooth off, and so on).
- Identifies the Watch by the Bluetooth peripheral the desktop discovered (over Wi-Fi, by the Watch's own per-install id), so two Watches are never confused for one another.
- Shows raw orientation and PPG status when those streams are available.
- Shows available Samsung health-sensor telemetry, such as heart rate, skin temperature, or EDA, when supported by the device and permissions.
- Provides immediate enable/disable controls for supported Watch sensor streams.

If a sensor is unavailable, treat that as a device capability or permission state—not a successful inference input. Low-quality, stale, malformed, or disconnected sensor data fails closed and releases any active interaction.

### Live data

The **Live data** tab is the telemetry viewer and recorder.

#### Live charts

It visualizes available raw streams, including:

- Headphone yaw, pitch, and roll.
- Watch orientation (from the watch's rotation-vector sensor).
- Watch acceleration: linear acceleration with gravity removed, in m/s². It arrives with each orientation sample, is saved in every recording as `accel_x`, `accel_y` and `accel_z` next to the gyroscope columns, and the chart is hidden if the watch's acceleration sensor is switched off.
- Raw PPG: green, red, and IR.
- Available health streams such as heart rate, IBI, temperature, EDA, SpO2, and ECG.

Chart visibility follows the enabled/streaming state of the corresponding sensor.

#### Ordinary CSV capture

Use **Start recording** / **Stop recording** for a general telemetry capture, then choose **Save CSV**. This exports buffered incoming rows with source timestamps and sequences. The tab shows buffer usage; when the cap is reached, the oldest ordinary-capture rows are dropped.

#### Labeled dataset recorder

Use this for model training data. It records a separate, labeled session distinct from the ordinary CSV capture above, and it never includes data you were already looking at before you pressed Start.

**Graph history is excluded on purpose.** The live charts above keep a rolling buffer so you can see recent signal, but that buffer is never copied into a new recording. Pressing **Start** arms the recorder and clears only the new recording's buffer; the first row ever stored is the first sensor sample the desktop accepts *after* Start, not anything already visible in the graphs.

**Arming and the timer.** After Start, the card shows `Arming…` while it waits for that first accepted sample — if the sensor is unavailable or you press Stop before any sample arrives, the session is cancelled and no data file is created. Once the first sample lands, recording begins immediately and the elapsed/remaining timer starts counting from that moment, not from when you pressed Start. This keeps "planned duration" and "actual duration" honest even if there's a short delay before the first sample.

Two capture modes share this same Arming/timer behavior and the same immutable-raw-data guarantee, but differ in how labels are attached:

- **Quick Capture** — pick or type one label, Start, perform only that gesture or activity, Stop. The whole session becomes a single label interval covering its full span. This is the simplest workflow and matches the original one-label-per-session recorder.
- **Timeline Capture** — Start a longer recording, then switch labels live as you go: click a label, press number keys 1-9 to toggle a label on/off, or hold Alt+1-9 to label only while the key is held. Stretches you don't label stay `unannotated` rather than being silently treated as a negative/background label — an unlabeled gap is not the same thing as "no gesture happened."

**Raw data is immutable.** Once samples are captured, `raw.csv` for that recording is never rewritten — not by labeling, not by curation, not by later edits. Only interval/label metadata (`annotations.json`) can change after the fact. Quick Capture saves its bundle automatically on Stop; Timeline Capture leaves the session in a **Saved** state so you can review/edit intervals first, then choose **Save recording bundle** to persist that reviewed state.

**Interval curation (Timeline Capture only).** After Stop, the recording timeline editor lets you split, move boundaries, relabel, delete, or mark each interval's curation status (`unreviewed`, `approved`, `excluded`) before you rely on it for training, and lets you fill an unannotated gap with a new interval. Every one of these edits changes only interval metadata — the underlying raw samples and their timestamps never move. Use **excluded** to drop a bad stretch of a recording without discarding the rest of it.

**Recording quality summary.** While a session is buffered and on a saved recording's detail view, a compact quality summary reports row count, observed time span and effective sample rate, timestamp ordering (`ok`/`warning`/`insufficient_data`), missing-value counts per channel, and label coverage including any interval shorter than ~150 ms (too brief for the current 500 ms model window). This is a data-quality review, not model validation — it never rewrites raw samples or annotations, and it never claims a recording is "training-ready."

**Export review gate.** Pressing **Export Dataset CSV** with a buffered session first shows this same quality summary as a review dialog. A session with no quality warnings exports immediately from that dialog. A session with warnings requires an explicit **Export anyway** click; **Cancel** closes the dialog and leaves every buffered row and interval untouched. A session with no recording/quality summary available (nothing buffered yet) exports exactly as before, with no dialog.

**Discard** removes the current in-memory session without saving or exporting it — nothing has been written to disk yet at that point, so nothing needs to be cleaned up. **Export Dataset CSV** writes the dataset CSV the Model Lab importer reads: a Quick Capture session is one uniformly labeled file; a Timeline Capture session keeps each row's interval label, with the rows between intervals left unlabeled (the importer drops those). Only these per-row labels reach training; a recording's curation status and interval boundaries in `annotations.json` do not (see [Review remediation](review-remediation.md)). Preserve a mix of positive gestures and realistic background/negative activities; that is important for false-activation evaluation.

**Pinch collection protocol.** A practical routine for capturing usable `pinch` intervals with Timeline Capture:

1. Put the watch/headphones on and let sensors settle a few seconds before recording anything.
2. Start the recording, then hold a few seconds of neutral rest (no gesture) so there's clean lead-in.
3. Hold the marker through one full pinch — start the hold just before the pinch begins and release just after it ends, for at least 300–500 ms (see the marker's tooltip); a shorter hold gives the 500 ms model window too little context and is flagged as a short label.
4. Return to rest, then repeat steps 2–3 for several more pinches, mixed with realistic non-pinch activity so background/negative coverage isn't all idle.
5. Capture more than one session (separate Start/Stop recordings) rather than one very long one — training holds out whole sessions, so one session can't cover evaluation by itself.
6. Before exporting, check the quality summary and timeline intervals — fix mislabeled or too-short intervals, then export.

#### Raw image viewer

This tab gives a read-only visual inspection of one numeric raw-data column from a saved recording's `raw.csv`. Choose a square grid size — any multiple of 4 from 4×4 through 64×64 (default 64×64) — and each frame reshapes exactly `N × N` chronological raw rows into an `N × N` image (pixel left-to-right, then top-to-bottom, in raw-row order); the slider and prev/next controls move in `N`-row hops, and the far end of a recording is always reachable even if it isn't hop-aligned. Changing the grid size realigns the current position to the new hop and reloads the frame. A missing raw field renders in a distinct color from "beyond the end of this recording," and neither is ever filled in with replacement data. Recording-scale normalization (the default) and an explicitly labeled per-frame-scale alternative are pure rendering choices over the already-loaded frame. Hover or use arrow keys to inspect a pixel's raw row, timestamp, value, and null state.

The same selected window renders as two images side by side (stacked on narrow layouts): a grayscale image (black = low, white = high) and a rainbow false-colour image (red = low through the spectrum to violet = high). Both share the same grid, navigation position, and normalization mode; the color mode is a second pure rendering choice, like normalization, and is not a channel-mapping or multi-sensor composite. Missing-value and beyond-recording fills and the constant-value gray are the same in both images, and each has its own title, aria-label, and legend describing its palette and endpoints.

This viewer is inspection-only: it has no annotation-editing or training action, and nothing it renders or computes feeds Model Lab, dataset export, or inference.

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

Use **Monitor** before **Live**. Each window's diagnostics line also says whether the live PPG window matches the window the model was trained on. A mismatch reads `window mismatch: live 960 ms vs trained 500 ms (Live is blocked)`. Monitor still classifies such a window so you can inspect it, but **Live refuses to start** (and refuses each mismatched window) until the two agree: set the Watch PPG flush rate so windows span about the trained length (roughly 2 Hz for a 500 ms model), or retrain with a matching `--window-ms`. A model's declared minimum samples per window is also enforced live.

A Live selection is only accepted while the live window matches, and a remembered Live is reduced to Monitor when the app starts. A stale input, quality rejection, malformed/out-of-order telemetry, runtime error, model swap, mode downgrade, or Watch disconnect force-releases and hides an active interaction.

#### Dataset and label coverage

1. Import exported dataset CSV files (Quick Capture or Timeline Capture).
2. Select the sessions to include in training.
3. Review per-label coverage and the label catalogue, and give every label on the selected sessions a training role (target, negative, or exclude). A Timeline session contributes every label on its rows, so each of them needs a role.

Labels have stable IDs, display metadata, roles, and archive state. Archiving is non-destructive: historical recordings and models retain their label meaning. Do not train a deployable gesture model until relevant positive and negative/background labels have useful coverage.

##### CSV import and migration state

The **Dataset** panel's importer accepts the CSV exported by the labeled dataset recorder above, in either of its two shapes: a single-label session (with a `# label:` line, where every row must carry exactly that label) or a Timeline Capture export (empty `# label:` line, a label on each annotated row, blank labels between intervals, which are dropped on import). This importer is a compatibility path, not a converter: it is intentionally kept independent of the newer recording-bundle format (`raw.csv` / `recording.json` / `annotations.json`) used by Timeline Capture, and importing a CSV never reads, writes, or otherwise touches any recording bundle on disk. The two pipelines share only the label catalogue, so a label created in either place is recognized by the other.

Import is all-or-nothing and recoverable: a CSV is written to the app's dataset store, and the session index is updated, only after the file has been fully validated (byte-size limit, the exact header, consistent labels between the `# label:` line and the rows, and every label on the rows already existing in the catalogue). If any check fails, or if updating the index fails, nothing is left on disk — the failure is reported as the specific error (for example, "unknown label; create it in Model Lab before importing recordings") in the panel rather than a generic failure, so you can create the missing label or fix the file and simply retry the same import. A failed import never partially writes a session and never modifies any existing dataset, recording, or raw sensor file.

Labels themselves migrate forward automatically and non-destructively: previously used label IDs and their display metadata keep working after an app update, and archiving a label only hides it from new selection — it never deletes or renumbers historical sessions that reference it.

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
- The active model bundle, contract, digest, and binding snapshot are revalidated and immutable while active. A bundle, whether trained here or imported from elsewhere, is held to the trainer's full contract: tensor shapes and dtypes, the exact preprocessing policy, window configuration, a passed conversion-parity record, training provenance with no session shared between train and test, and a SHA-256 of `model.tflite` recomputed from disk. An imported bundle missing any of these is rejected.
- If the model registry file on disk is unreadable or corrupt, the app reports the error and **leaves the file untouched** rather than starting an empty registry; restore it from a backup or move it aside deliberately.
- Use rollback to return to a previously approved model. Model swaps release an active interaction before the swap completes.

#### Offline replay

Replay runs a managed dataset against an approved or active validated TFLite bundle without operating gestures or volume. It resolves labels through the same label mapping the model was trained with, so a label trained as a target is scored as that target. A bundle without a recorded mapping (for example an imported one) uses the legacy vocabulary and rejects labels it does not cover instead of scoring them as negative. It produces bounded per-window outcomes and a summary. Use it to compare expected labels with predicted decisions before enabling Live mode.

### Settings

The **Settings** tab controls desktop acceptance/recording rates and Watch delivery settings.

- Every number states its unit, allowed range and default under the field. A field you have changed is marked **Edited**, and a small reset button puts it back to its default (you still apply the change).
- Nothing is applied until you choose **Apply changes** (or press Enter in any field), and then everything is applied together. The bar at the bottom says how many changes are waiting.
- A value that is empty, not a number, or outside its range is **never silently corrected**: the field turns red, says what is wrong (for example "Too high: the maximum is 200 Hz."), keeps what you typed so you can fix it, and the first bad field takes focus. Nothing is applied until every edited field is valid.
- **Discard changes** drops your edits. **Reset to defaults** restores every setting after a confirmation. Switches (sensors, transport, demos) take effect immediately.

The other forms follow the same rules: the Timeline recorder's label shows what it will be saved as while you type (`Wrist Flick` is saved as `wrist_flick`) and applies on Enter, its duration says why Start is unavailable, the head-calibration threshold and dwell apply when you leave a field but only if valid, and the timeline editor's time boxes no longer treat an empty box as 0.

#### Headphones

- Enable or disable accepted headphone samples.
- Set the headphone acceptance rate.

Incoming Sony packets still maintain connection and calibration state; this setting controls what the desktop accepts for display and recording.

#### Wrist rotation tuning

These limits apply to every recipe and take effect the next time one starts (each recipe sets its own dead zone and sensitivity on the **Recipes** tab):

- **Max angular velocity:** rejects implausibly fast twist motion.
- **Max volume rate:** caps how quickly volume can change; the volume follows the wrist angle but moves no faster than this many points per second.

Defaults target roughly 30 volume points for a 90° twist. Begin with defaults and adjust gradually using a test audio output.

#### Recording, graphs, and Watch rates

- Set ordinary recording rate and graph refresh rate.
- Set Watch orientation, acceleration, and gyroscope delivery rates.
- Set raw PPG flush rate and desktop acceptance rates for heart rate, temperature, and EDA.
- Toggle supported Watch sensor streams.

These controls preserve raw source timestamps. For health sensors, Samsung/device sampling remains authoritative; some controls affect desktop acceptance or flush/delivery behavior rather than physical sampling frequency.

## 5. How volume control works

Volume is driven by **gesture recipes**, shown on the Control center. A recipe is a chain of gestures that all have to hold, ending in a wrist rotation that turns a virtual knob:

> Look at *Top right* → Pinch and hold (or hold the STEM button) → Roll the wrist → rotation knob → Volume

### Making your own: the Recipes tab

The **Recipes** tab lists every recipe with an on/off switch, an Edit button and a Delete button (which asks first). **New recipe** opens the editor:

1. **Name** it. The name appears on the Control center and in conflict messages.
2. **Steps that must all hold**: add *Look at a location* steps (from the locations on the Headphones tab) and *Hold a gesture* steps (pinch, or the STEM button). The same step cannot be used twice.
3. **Turn your wrist**: choose the axis (roll, pitch or yaw), whether to reverse the direction, and a **dead zone** — turning less than that from where you started does nothing.
4. **To control**: volume, brightness or scroll (see below).
5. **Device**: a rotation knob (endless), a horizontal or vertical fader (finite travel with end stops), or a step knob (whole steps). Their numbers are in the unit of what the recipe controls: sensitivity per degree, or travel and range, or degrees and amount per step. Changing what a recipe controls resets those numbers to the defaults for it, since 10 means something different in volume points, brightness percent and scroll pixels.
6. **Save**. New recipes start switched off, so they cannot surprise you by conflicting with one you already use. If the save fails the editor stays open and says why.

### What a recipe can control

| Control | What it does | Platform support |
| --- | --- | --- |
| Volume | System output volume, with the knob shown on screen | macOS, Windows, Linux |
| Brightness | Display brightness | macOS (presses the brightness keys, in sixteenth steps; needs **Accessibility** permission), Linux (`brightnessctl`), Windows (built-in displays only, through WMI) |
| Scroll | Scrolls the window under the pointer; turn one way for down, the other for up | macOS (needs **Accessibility** permission), Linux (`xdotool`, X11 only), Windows |

### Button actions: media keys and mute

**Play / pause**, **Next track**, **Previous track** and **Mute** are *buttons*, not dials. A recipe for one has only steps (for example *Hold a pinch*, or *Look at Top right* then *Hold STEM button*) and no wrist rotation or device. It fires **once**, the moment all its steps hold, and cannot fire again until you let go and repeat the gesture. A second firing within half a second is ignored, so a flickering pinch cannot skip tracks. A button recipe must have at least one step.

| Action | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Play / pause, next, previous | System media keys (posted through a short script) | `playerctl` (needs a player running) | Media virtual keys |
| Mute | Toggles the system mute | Toggles the system mute | Toggles the system mute |

### Shake

**Shake wrist** is a gesture step, like the pinch or the STEM button, but it is a *moment* rather than something held. It is recognised from the watch's acceleration: a quick back-and-forth of at least four strokes within about a second. A single jolt, a steady swing, or knocks all the same way (walking, typing) do not count. After a shake is recognised it counts as happening for about half a second, so you can combine it with another step, such as *Look at Top right* then *Shake wrist* → *Next track*. It then ignores further shaking for a second, so one shake fires once.

### Swipe

**Swipe left**, **Swipe right**, **Swipe up** and **Swipe down** are gesture steps for one quick push of the hand, like flicking through pages in the air. They are read from the watch's acceleration and orientation, are momentary like a shake, and so can also only start a button action. Example: *Swipe right* → *Next track*, and *Swipe left* → *Previous track* as a second recipe (they do not conflict: different keys).

- **Left and right** run along your forearm, which stays pointing along the arm however your elbow is bent. Which way along it is "left" depends on which wrist the watch is on, so set **Settings → Swipe sensitivity → Watch worn on**. If left and right come out backwards, switch it.
- **Up and down** follow gravity, whatever way the watch is turned.
- A swipe is one strong push in one clear direction. A sloppy diagonal is ignored rather than guessed, and a shake (a run of pushes back and forth) is not read as swipes: a push is held for a quarter of a second, and a similarly strong one the other way cancels it. The hand stopping afterwards (a weaker push the other way) is expected and does not count.
- After a swipe the detector rests for about 0.7 seconds, so one swipe fires once.

**Swipe strength** (default 8 m/s², range 3 to 30) sets how hard the push must be; lower it if your swipes are missed. The card shows the last swipe recognised and how many there have been, so you can try a setting before building a recipe. Not yet verified on a real watch: in particular the world-frame direction for up/down assumes the watch's orientation sensor reports the standard device-to-world rotation, so if up and down are reversed, tell me.

### Tap

**Tap watch** and **Double-tap watch** are gesture steps for knocking a finger on the watch's screen or case. They are momentary like a shake or swipe, and so can only start a button action. Example: *Double-tap watch* → *Mute*, *Tap watch* → *Play / pause*.

- A tap is recognised by its **shape**: one brief, sharp jolt (a sample or two at the watch's 50 samples a second) *into the screen*, arriving while your arm is otherwise still. A longer push is a swipe, a jolt along the screen is the arm bumping something, and a jolt in the middle of other movement is just that movement; none of them count.
- A double tap is two such knocks within 0.4 seconds. A **single tap is reported about 0.4 seconds after the knock**, once it is clear no second tap is coming. That delay is the price of telling the two apart, and it applies even if you only use single taps.
- **Settings → Tap sensitivity → Tap strength** (default 12 m/s², range 4 to 40) sets how hard a knock must be; lower it if your taps are missed. The card shows the last tap recognised (tap or double tap) and a count, so you can try it before building a recipe.
- Tapping the watch with a finger also moves your arm a little, so a tap right after other movement may be ignored for being "not still". Pause a moment first.
- Not yet verified on a real watch. At 50 samples a second a tap is only one or two samples, so a very light knock can fall between them; if taps are unreliable, say so.

Because it is a moment, a shake, swipe or tap can only start a **button action** (play/pause, next, previous, mute); the editor does not offer them for volume, brightness or scroll, and refuses to save a recipe that has one. It needs the watch's **acceleration** sensor switched on, which is the default.

#### Tuning the sensitivity

In **Settings → Shake sensitivity**:

- **Shake strength** (default 6 m/s², range 2 to 30): how hard each stroke must be. Lower it if your shakes are missed; raise it if ordinary movement sets it off.
- **Shake strokes** (default 4, range 3 to 10): how many quick strokes back and forth make a shake. Fewer is more sensitive.

Apply the change, then shake: the counter beneath the fields goes up each time a shake is recognised, whether or not a recipe uses it, so you can find a setting that suits you without building a recipe first. Defaults have been tested only against simulated strokes.

Each media key can have its own recipe, and they can share a gesture, but two recipes on the *same* key conflict and both pause.

Different things can run at once: the same gesture can drive brightness and scroll together. Two recipes controlling the *same* thing conflict, and both pause. Brightness and scroll show no knob of their own; the system's own brightness indicator appears on a Mac. If one cannot be carried out (a missing permission, a missing tool), the Control center shows why.

Scroll and brightness are relative: only the amount you turn counts, from where the hold began, and anything left over when you let go is dropped. A single burst is capped so a sensor glitch cannot fling the page or slam the screen to an extreme.

### The Virtual devices tab

The **Virtual devices** tab shows the four devices a recipe can use. Drag **Wrist rotation** to see each one respond, with how much it would move whatever it controls, using its default settings. Each device also says which recipes use it, and **Make a recipe with this** opens the recipe editor with that device already chosen. Devices are configured per recipe, in the editor.

Recipes are saved between runs. Deleting a location does not delete recipes that use it; they simply never start, and the editor flags the missing location.

Three recipes come with the app, and only the first is on:

- **Look top right, hold STEM, roll** (on): the knob appears when you look at the location; hold the Watch's STEM button and roll your wrist to change the volume.
- **Look top right, pinch, roll** (off): the same, but the hold is the PPG pinch gesture. It needs a validated model in Live mode.
- **Look top right, roll** (off): no hold at all; looking at the location is enough to start turning.

### One recipe per thing you control

Two enabled recipes that control the same thing (today only volume) are in **conflict**: both are paused and the Control center says which two, until you switch one off. This is deliberate. A silent "first one wins" would make it unclear which gesture is in charge.

### What happens during a gesture

- Looking at the location (for the configured dwell time) shows the knob. Looking away hides it.
- When every step holds, the volume is anchored to what it is at that moment and follows the wrist from there. The orientation when the hold began is the zero point, so you never have to start from a particular wrist angle.
- Letting go of the hold, looking away, losing the Watch, a model failure or pressing **Escape** ends it. After Escape the same gesture does nothing until you release it and start again.

### How fast volume can change

The volume follows the wrist but moves no faster than **Max volume rate** (30 points per second by default), implausibly fast twists are ignored (**Max angular velocity**), and writes reach the operating system at most about ten times per second.

### Native platform volume backends

- **macOS:** native system output volume adapter.
- **Windows:** Core Audio default multimedia output adapter.
- **Linux:** PipeWire (`wpctl`) first, PulseAudio (`pactl`) fallback.

Use the Desktop readiness screen to check the backend. Backend errors fail closed: the app must not claim a volume change it did not perform.

## 6. Troubleshooting and safe recovery

| Symptom | What to do |
| --- | --- |
| Watch is not connected | Check which transport is selected. **Bluetooth:** enable Bluetooth on both devices, bond them, then tap **Trust this computer** on the Watch when it shows the desktop's address; the Watch tab reports `awaiting approval` until you do. **Wi-Fi:** confirm both devices are on the same non-isolated LAN and the firewall allows port 8766. Open the Watch app, check permissions, and use the Watch tab to see the connection state. |
| No PPG or health data | Verify Watch hardware support, permissions, sensor switches, contact quality, and any Samsung Health SDK status. The app will reject unusable data rather than guessing. |
| Live will not start, or is blocked on every window | Open **Live inference diagnostics** and read the window line: a `window mismatch` means the live PPG window does not match the model's training window. Align the PPG flush rate or retrain with a matching window; Monitor still works meanwhile. |
| Inference is on Monitor after a restart | By design: a remembered Live is reduced to Monitor at startup. Select Live again once you have checked Monitor. |
| An error says the model registry is corrupt | The app refused to overwrite it. Restore `registry.json` from a backup, or move it aside to start an empty registry (the model bundles on disk are untouched). |
| A Timeline CSV is rejected on import | Create any missing label first (the error names it), then retry. Rows with no label are dropped; a file with no labeled rows at all is rejected. |
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

The Watch's Bluetooth link adds OS bonding and an explicit on-Watch approval of the desktop, with the limits described in the [Bluetooth transport doc](protocols/watch-ble-transport.md) (Just Works bonding has no man-in-the-middle protection). The Wi-Fi link is plain `ws://` with no pairing-derived identity or authenticated session; that accepted risk is documented in the release checklist.
