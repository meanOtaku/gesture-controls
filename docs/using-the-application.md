# Using Spatial Gesture Control

This guide explains how to set up and use the desktop application, what every tab does, and the safe workflow for moving from raw sensor telemetry to a desktop-controlled volume gesture.

> **Safety first:** Watch and headphones are sensor sources only. Models, policy decisions, and actions run on the desktop. Keep inference **Off** until you have a reviewed model and have verified it in **Monitor** mode, and completed the applicable checks in [release readiness](release-readiness.md).

## 1. Before you start

### What you need

- A supported desktop host. The packaged application is intended for macOS, Windows, and Linux; actual install/package validation is still a release gate.
- Sony headset tracking when you want gaze calibration and the overlay. On macOS and Windows, `npm start` builds the tracking support directly into the desktop app (no separate process); on macOS grant it Input Monitoring on first launch, on Windows follow Sony Head Tracker's Repair Tracker instructions yourself if the sensor node is missing. Linux development can use the sample sender because the upstream tracker has no Linux hardware backend.
- A Galaxy Watch for Watch IMU/PPG telemetry and gesture recording. The Watch connects over **Bluetooth LE by default** (the desktop needs a Bluetooth adapter, and you approve the desktop once on the Watch with **Trust this computer**), or over Wi-Fi, in which case both devices must be on the same non-isolated local network. Pick the transport in Settings; see the [Bluetooth transport](protocols/watch-ble-transport.md).
- Training a model from your own recordings (arriving in the next Model Lab step) will need extra tools on your machine; using an imported model does not.

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

1. Confirm the system-volume backend works before testing volume control (move the volume from the Main tab).
2. Open **Model Lab** to see which models are registered and the runtime mode. It starts **Off** until you choose otherwise.
3. Connect the headset and, if used, the Watch. Keep inference **Off** until the model workflow below is complete. The inference mode is remembered between launches, but a remembered **Live** is always reduced to **Monitor** at startup: select Live again, deliberately, each session.
4. Do not use Live mode with an unreviewed model or a production audio device.

## 2. Recommended first-use workflow

Follow this order rather than enabling every feature at once:

1. **Headphones:** connect Sony tracking and capture the center and top-right calibration targets.
2. **Watch:** confirm connection, raw orientation, and any enabled health-sensor state.
3. **Live signals:** check that the watch's streams are arriving.
4. **Recorder:** record several labeled sessions for each intended gesture and non-gesture/background activity; export one dataset CSV per session.
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

#### Built-in gestures (Settings)

**Settings → Built-in gestures** has an on/off switch for each rule-based wrist gesture: **Shake**, **Swipe**, **Tap**, **Roll** and **Pitch**. They are all on by default. An off gesture is not recognised at all, so its live readout stops and any recipe that uses it never fires; the Recipes tab marks such a recipe "Never fires: … gesture off in Settings". The recipe stays saved and starts working again when the switch is turned back on. A pinch and the STEM button are not on this list. The reason for the switches is that a model you train for the same gesture can take over without the rule-based one also firing.

#### Watch orientation (Settings)

The watch senses movement in its own frame, so for swipes and rolls the app needs to know how it sits on you:

- **Crown side** (default: crown on the right): which side of the watch face the crown is on as you read it. It decides which way a swipe along your arm is left or right, and (with the wrist) which way a roll is clockwise.
- **Watch worn on** (default: left wrist): which wrist. Only the roll gesture uses it.

Earlier versions had a single "Watch worn on" setting that also swapped swipe left and right. That was wrong for someone wearing the watch normally on the right wrist; the crown side is what actually matters for swipes. A saved wrist setting is kept, and the crown side starts at "right".

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

### Capture: Live signals, Recorder and Recordings

The capture tools are three tabs in the **Capture** group of the sidebar, in the order you use them:

- **Live signals** shows what the sensors are sending right now (the charts below). Use it to check a stream, not to record one.
- **Recorder** records a session from the watch and exports it. A timed capture still stops and exports by itself if you switch to another tab while it runs, and the export folder you chose stays chosen when you leave the page.
- **Recordings** looks inside saved sessions (currently the raw image viewer).

The sidebar marks **Recorder** while a recording is running. Cmd/Ctrl+1 to 9 open the first nine tabs, and Cmd/Ctrl+comma opens Settings.

#### Live charts

**Live signals** visualizes available raw streams, including:

- Headphone yaw, pitch, and roll.
- Watch orientation (from the watch's rotation-vector sensor).
- Watch acceleration: linear acceleration with gravity removed, in m/s². It arrives with each orientation sample, is saved in every recording as `accel_x`, `accel_y` and `accel_z` next to the gyroscope columns, and the chart is hidden if the watch's acceleration sensor is switched off.
- Raw PPG: green, red, and IR.
- Available health streams such as heart rate, IBI, temperature, EDA, SpO2, and ECG.

Chart visibility follows the enabled/streaming state of the corresponding sensor.

#### Ordinary CSV capture (Recorder)

Use **Start recording** / **Stop recording** for a general telemetry capture, then choose **Save CSV**. This exports buffered incoming rows with source timestamps and sequences. The tab shows buffer usage; when the cap is reached, the oldest ordinary-capture rows are dropped.

#### Camera hand tracking (Recorder)

Under the recorder, **Camera hand tracking** finds the landmarks of your hand with the camera, on this computer. **Turn camera on** (macOS asks for permission the first time; allow it), and you see a mirror view with the 21 points drawn on each hand, how many hands are in view, the frame rate, which hand it is, and the distance between thumb and index finger in hand sizes (about 0 is a firm pinch). Keep the hand that wears the watch in view.

With **Save hand landmarks with recordings** ticked (the default), each recording also saves `hand_landmarks.csv` (the landmarks of every camera frame, and when it was taken) and `clock_sync.csv` (how to line the camera up with the watch). **Only landmarks are saved, never the picture, and nothing leaves your computer.** The camera stays on while you switch to other tabs, so a recording keeps its pictures. A timed capture is now also saved as a recording (with its landmarks), as a manual stop already was. The panel shows the clock alignment with the watch once the watch is streaming, and how many frames a running recording has kept (about 17 minutes is the limit).

This step only captures. Turning landmarks into gesture labels is not built yet. Details: `docs/architecture/camera-landmarks.md`.

#### Labeled dataset recorder (Recorder)

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

#### Let the camera mark it (Recorder)

Under the recorder, **Let the camera mark it** labels a recording for you. Choose a label (it must have a gesture in the Gesture library), turn the camera on, and tick **Let the camera mark the gesture**. A badge shows live whether the camera sees the gesture, so you can check it before you start. Record as usual with the watch on the hand the camera sees. The recording is made as a timeline with no manual marks; when you stop and it saves, the camera's holds of that gesture are added as **unreviewed** intervals, so the PPG and motion rows carry that label. A message says how many were marked, or that the camera never saw the gesture (the recording is kept either way). Review the intervals in Recordings like any others.

#### Label from the camera (Recordings)

At the top of **Recordings**, **Label from the camera** runs your Gesture library over a recording's saved hand landmarks. Pick a recording made with the camera on, choose **Find gestures**, tick the holds you want and add them. Each becomes a label interval on the watch data, using the label the gesture is linked to, and starts **unreviewed** like any other interval.

- The camera and the watch have separate clocks. They are lined up from clock samples saved with the recording, and the panel shows how closely (the link's jitter). The labelled rows are never more exact than that.
- A gesture with no label, a recording with no camera data or too few clock samples, and a proposal that overlaps an interval already in the recording are each skipped or refused, with the reason shown.
- Quick-capture recordings carry one label over the whole recording, so a proposal there overlaps it and cannot be added. Camera proposals are for timeline recordings or ones with room between intervals.

#### Raw image viewer (Recordings)

The **Recordings** tab gives a read-only visual inspection of one numeric raw-data column from a saved recording's `raw.csv`. Choose a square grid size — any multiple of 4 from 4×4 through 64×64 (default 64×64) — and each frame reshapes exactly `N × N` chronological raw rows into an `N × N` image (pixel left-to-right, then top-to-bottom, in raw-row order); the slider and prev/next controls move in `N`-row hops, and the far end of a recording is always reachable even if it isn't hop-aligned. Changing the grid size realigns the current position to the new hop and reloads the frame. A missing raw field renders in a distinct color from "beyond the end of this recording," and neither is ever filled in with replacement data. Recording-scale normalization (the default) and an explicitly labeled per-frame-scale alternative are pure rendering choices over the already-loaded frame. Hover or use arrow keys to inspect a pixel's raw row, timestamp, value, and null state.

The same selected window renders as two images side by side (stacked on narrow layouts): a grayscale image (black = low, white = high) and a rainbow false-colour image (red = low through the spectrum to violet = high). Both share the same grid, navigation position, and normalization mode; the color mode is a second pure rendering choice, like normalization, and is not a channel-mapping or multi-sensor composite. Missing-value and beyond-recording fills and the constant-value gray are the same in both images, and each has its own title, aria-label, and legend describing its palette and endpoints.

This viewer is inspection-only: it has no annotation-editing or training action, and nothing it renders or computes feeds Model Lab, dataset export, or inference.

### Labels

The **Labels** tab (first under Labels) is the one place labels are made and managed. A label is a short name for a gesture or an everyday activity the app can learn or recognise. Each label has an id (letters, digits and underscores, made from the name), a display name, optional notes and a role.

- **Add a label** with a name; the id is shown before you create it and never changes afterwards. **Edit** changes the name, notes and role, and everything that refers to the label (recordings, models, recipes, gestures) keeps pointing at it.
- Each label shows how many recordings and gestures use it and the state of its model. A label something still uses can be **archived** but not deleted, so nothing is left without a meaning. Archived labels are hidden from pickers and can be restored.
- Everywhere else reads this list: the **Gesture library** and **Model Lab** choose from it, and the **Recorder** offers it as buttons. A label typed by hand in the Recorder that is not in the list says so and has **Add to Labels**.

In forms, a field marked with a red `*` is required; the others can be left empty or already have a sensible default.

### Gesture library

The **Gesture library** tab (under Labels) defines gestures the camera recognises from your hand's shape. It needs the camera but not the watch.

1. Choose **New gesture**, name it, pick the label it will be recorded as (from the Model Lab label list) and which hand it applies to.
2. Turn the camera on. A line under the picture says which hand the app sees: raise your left hand, and if it says Right, tick **Left and right are swapped**. Then choose **Record gesture and background**. Hold the gesture for four seconds, moving the hand a little, then do anything else for seven. Nothing but hand landmarks is used, and nothing is saved from this step except the rule.
3. The measurements that tell the two apart become the rule (for example "thumb to index tip below 0.3 hand sizes"), with a start threshold and a looser end threshold so it does not flicker. You can edit every number and add or remove conditions; the percentage shows how well the rule separates the frames you recorded. Calibration quality is on those frames only, so test the gesture live afterwards.
4. **Hold before it counts** ignores brief accidental poses; **Forgive losing it for** stops a flickering hand ending it early.

Saved gestures show **Detected** live while the camera is on.

**Model against camera** (below the list) checks a deployed watch model against the camera while you perform. A gesture linked to a label with an active model, a camera that is on and the model runtime in Monitor or Live are all needed. For each gesture it counts the holds the camera saw, how many the model found within about two seconds and its typical delay, how many it missed, and how many times the model fired while your hand was in view and you were not doing the gesture. Detections with your hand out of view cannot be judged and are counted apart. The camera is taken as the truth, so wear the watch on the hand it sees. The counts are not saved and restart when you press **Start over** or reopen the page. They are kept in `gesture-library.json` in the app's config folder.

### Model Lab

Model Lab is organised around **one model per label**: a label is a gesture or activity ("snap_fingers", "pinch_start"), and each label has its own model. Models run inside the app; nothing else needs to be installed to use one. The page shows, top to bottom:

1. an overview (runtime mode, active models, recordings);
2. **Label models**: your models, and the Off / Monitor / Live switch;
3. **Activity**: detections and releases this session;
4. **Labels**: recordings per label and how far along each label's model is;
5. **Recordings**: the labelled sessions you have imported.

#### Label models

The **Label models** card at the top of Model Lab is the per-label model system: one binary model per label, several active at once, all run inside the app (nothing else to install).

- **Import a model folder** picks a folder holding `manifest.json` and one ONNX model. It is checked in full and added as a **Draft**. Nothing is activated by importing.
- Each model moves forward by your explicit choice: **Mark as evaluated → Approve → Activate**. Imported models are not evaluated by this app, so review them yourself first. Activating checks that the model's files are intact and that it runs; a model that cannot run is not activated. **Deactivate** and **Roll back** work per label. An **archived** model can be **deleted for good** (after a confirmation): it is removed from the registry and its files are deleted. Only archived models can go, so nothing under review or in use is lost; the training run that made it stays as a record, and the same model can be imported again later.
- **Model runtime** is **Off**, **Monitor** (models run and show a score and a "Detected" badge, nothing acts) or **Live** (a detection can start recipes that use that label, see *Model label* below). Switching to Live asks first, and a restart always comes back in Monitor.
- A label whose active model cannot be loaded (for example its file was changed) is named in a red alert and has no running model.

#### Train a model

The **Train a model** card teaches the app one label from your recordings.

1. Choose the **label to teach**. Every recording starts selected; untick any you do not want.
2. Give every other label in those recordings a role: **Something else** (it teaches the model what is *not* the gesture) or **Leave out**. Nothing is assumed.
3. Choose a **method**: logistic regression (fast, simple; a good first try), a small neural network in scikit-learn, or a small neural network in PyTorch (the first run downloads PyTorch, which is large).
4. Choose **what the model may read**: acceleration, gyroscope, orientation and/or the pulse (PPG) sensor. The model can only use those streams, and only runs while the watch sends them all. Pick what the gesture actually changes: a **finger pinch barely moves the watch, so it shows in the pulse sensor, not in acceleration**; a wrist twist or a shake shows in acceleration, gyroscope and orientation.
5. Optionally tick **Only how things change**. It drops absolute levels (such as how the watch is held) and keeps spread and change over the window. This stops a model memorising one session's posture, and is worth trying for movement gestures.

Before anything runs, the card shows which recordings it will **train on** and which it will **test on**. The app decides this, deterministically, and a recording is never in both, so the score is about recordings the model has not seen. It refuses, and says why, if there are not at least two recordings with the label and two with something else (a recording with both kinds counts for each) so one of each can train and one of each can test.

The card warns if only one recording of the gesture would be trained on: a model trained on a single session usually memorises it. Three or more recordings in different positions work much better.

When training finishes you see, in words, how much of the gesture it found, how much of what it flagged was right, and how often it wrongly flagged something else, all measured on the recordings it never trained on. **The cut-off for "detected" is fitted on those same test recordings** (a model's scores shift from one session to the next, so a fixed cut-off can sit above everything), so the numbers are a little optimistic; the card says so. **A model that cannot tell the gesture apart is not kept**: if its test score (AUC) is under 0.7, or its best F1 under 0.5, the run is recorded as *trained but not good enough*, nothing is added to your models, and the card says why. An AUC under 0.5 means it scored the gesture *lower* than other things on new recordings, which is what memorising a session looks like. Otherwise the model is added as a **Draft** under Label models: review it, mark it evaluated, approve it, then activate it. Check it in Monitor on the Gestures tab before Live. A failed or cancelled run is recorded with its reason and produces no model.

Training runs on this computer and needs **uv** on the PATH and this repository checkout (`tools/pinch-classifier`); the card says so if it is missing. The first run downloads the Python packages. Running a model needs none of this.

#### Activity

A list of what the active models have done this session, newest first: **Detected** (with the model's confidence), **Released**, and **Attention** for a skipped window, a model that was swapped out, or two labels that cannot coexist being detected together (both are then held off). An identical line repeating is shown once with a count. The card can be **collapsed** (the button shows how many entries are inside, and it stays as you left it). In Monitor this is what the models would have done; in Live the same detections can start recipes. A release always shows, in every mode.

#### Labels

Labels are yours: the app ships none. **Add a label** with a name (it becomes an id, shown before you create it: "Snap fingers" is `snap_fingers`), say whether it is a gesture to detect or an everyday activity a model should not mistake for one, and optionally add notes. Record it on the Recorder tab under that same id, then import the recording.

Each label shows its recordings and its model's furthest state (No model, or Model: draft / evaluated / approved / active). A label with a single recording is flagged: a model is tested on whole recordings it never saw, so it needs at least two. **Archive** hides a label from new use without touching old recordings (**Show archived labels** brings it back, **Restore** undoes it). **Delete** is offered only for a label nothing uses, and the app refuses it for one a recording, project or model refers to.

Labels an older version shipped (idle, walking, typing and so on) are removed on the first start of this version unless a recording or model still uses them; those that are used stay as ordinary labels you can archive.

#### Recordings

Record a labelled session on the **Recorder** tab (Quick Capture is one label; Timeline Capture keeps the label of each interval), export the CSV, then **Import a recording (CSV)** here. The import is all-or-nothing: the file is checked in full (size limit, exact header, consistent labels, every label already in the catalogue) before anything is written, a failure says exactly why, and nothing is changed on disk. It is a compatibility path independent of the newer recording-bundle format and never touches those bundles. Labels keep stable ids; archiving one hides it from new selection but never changes old recordings.

The older three-class training, LiteRT readiness, intent-binding, replay and legacy inference panels were removed from this page; a model from the old system that could not be converted is kept aside and counted on the Label models card.

### Gestures

The **Gestures** tab (under Automation) is where you try what is working before building a recipe. Nothing on it controls your computer.

- **Watch gestures:** the STEM button (lit while held) and the built-in shake, swipe, tap, roll and pitch. Each card says how to perform it, whether it is switched on in Settings, how many times it has been recognised this session, and which of your enabled recipes use it. The variant just recognised (for example *Left* for a swipe) lights for about a second and a half.
- **Head locations:** every calibrated location, with the one you are looking at lit.
- **Model gestures:** every loaded model with a live score bar and a **Detected** badge, which works in **Monitor** as well as Live. If the runtime is Off it tells you to set Monitor in Model Lab; if no model is loaded it points to Model Lab.

The pinch gesture is not shown: it needs a model trained for it, which will appear under Model gestures once you have one.

### Settings

#### Appearance

**Settings → Appearance → Theme** switches the look of the app. **Neo-brutalism** is the default: cream paper with thick black outlines, hard offset shadows (no blur), vibrant yellow, teal, pink and lavender fills, and bold rounded type. **Electric** is the original deep-blue theme. It applies at once and is remembered on this computer (it is not part of the settings you apply, and not shared with another computer). The floating volume knob keeps its own look in both. The theme only changes colours and outlines; nothing about how the app works changes.

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

- **Left and right** run along the watch's 9-3 axis, which lies along your forearm however your elbow is bent. Read the watch face as you normally do: with the **crown on the right** (the usual way, on either wrist) a push toward 3 o'clock is a swipe right. If you wear it the other way round, set **Settings → Watch orientation → Crown side** to the left. If left and right come out backwards, switch it.
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

### Roll

*(This gesture was called **Rotate** in earlier versions. Recipes and settings saved under that name still load, and now show as Roll.)*

**Roll wrist clockwise** and **Roll wrist counter-clockwise** are gesture steps for one quick twist of the wrist about your forearm, like turning a key. They are momentary like the others, so they can only start a button action. Example: *Roll wrist clockwise* → *Next track*, *Roll wrist counter-clockwise* → *Previous track*.

- A roll is a twist of at least a set angle (default **60°**) within about **0.6 seconds**, mostly about the forearm. A slow turn takes too long to qualify (that is the *Roll* axis of the wrist rotation step that turns a volume, brightness or scroll dial: the same movement, but followed continuously instead of fired once), and swinging the whole arm does not count because the movement is not about the forearm.
- The turn back that often follows a flick is ignored for 0.8 seconds, so a twist out and back fires once, for the way out. Pause before the next one.
- **Clockwise** is the way you turn a screwdriver, looking along your forearm from the elbow towards the hand. The same physical turn is clockwise on one wrist and counter-clockwise on the other, so this uses both settings under **Settings → Watch orientation**: **Watch worn on** (left or right wrist) and **Crown side**. If clockwise and counter-clockwise come out backwards, switch either one.
- **Settings → Roll sensitivity → Roll angle** (30° to 180°) sets how big the twist must be; the card shows the last roll recognised and a count.
- It uses only the watch's orientation sensor, which streams about 50 times a second. Not verified on a real watch.

### Pitch

**Pitch hand up** and **Pitch hand down** are gesture steps for one quick nod of the hand at the wrist, like a stop sign or a wave. They are momentary like the others, so they can only start a button action. Example: *Pitch hand up* → *Play / pause*, *Pitch hand down* → *Mute*.

- A pitch is a tilt of at least a set angle (default **40°**) within about **0.6 seconds**, mostly about the axis across your wrist (the watch's 12-6 axis). The wrist bends less than it twists, so the default is smaller than a roll's. A slow tilt takes too long (that is the *Pitch* wrist rotation of a volume, brightness or scroll dial, a different thing). A twist about the forearm is a roll, and swinging the whole arm is neither.
- The nod back is ignored for 0.8 seconds, so up-and-back fires once, for the way up. Pause before the next one.
- **Up** means the hand rising. Which way the watch turns for that depends on how it sits on you, so it uses both **Watch orientation** settings (**Watch worn on** and **Crown side**). If up and down come out backwards, switch either one.
- **Settings → Pitch sensitivity → Pitch angle** (20° to 120°) sets how big the nod must be; the card shows the last pitch recognised and a count.
- It uses only the orientation sensor. Not verified on a real watch.

Because it is a moment, a shake, swipe, tap, roll or pitch (and a one-shot model label, below) can only start a **button action** (play/pause, next, previous, mute); the editor does not offer them for volume, brightness or scroll, and refuses to save a recipe that has one. It needs the watch's **acceleration** sensor switched on, which is the default.

### Model label

A **Model label** step uses a gesture detected by a model you trained and activated (see the Model Lab). Type its label or pick one of the loaded labels.

- **While detected** works like a pinch: it counts for as long as the model keeps detecting the label, so it can be chained into a dial (for example *Model "fist" → Roll wrist → Volume*) and the dial lets go when the detection ends.
- **Once, when detected** works like a shake: it counts for about 0.6 seconds after the label is first detected, and only starts a button action.
- A model step only acts while the model runtime is in **Live** mode. A recipe naming a label that is not loaded shows **Waiting for model** and does not run. Importing and training models arrive in later steps, so for now no model is loaded.
- A fault, a model swap or a rejected window cancels a pending one-shot.

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

Try changing the volume from the Main tab to check the backend. Backend errors fail closed: the app must not claim a volume change it did not perform.

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
| Volume does not change | Check the platform's audio backend works from the Main tab; use a test audio output; ensure the overlay is visible and an interaction is actively grabbed. |
| Monitor/Live controls are disabled | Activate an Approved, validated TFLite bundle with complete safe intent bindings. LiteRT must also be included in the desktop build. |
| A model will not activate | Read the red alert on the Label models card: the model's files were altered, or it does not run. Import it again. |
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
