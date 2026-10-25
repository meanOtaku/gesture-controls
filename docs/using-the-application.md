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

The sidebar is laid out in the order you use it. Work down it:

1. **Headphones** and **Watch** (Devices): connect them; capture the head calibration targets; confirm the watch's orientation and any health sensors you want.
2. **Labels**: name each gesture you want, plus an everyday activity or two to tell them apart from.
3. **Gesture library**: define each gesture from your hand's shape with the camera, by showing it and then showing everything else.
4. **Live signals** (Capture): check the watch's streams are arriving.
5. **Recorder**: turn the camera on, pick a label, tick **Let the camera mark the gesture**, and record several sessions of each gesture with the watch on the hand the camera sees. They save automatically.
6. **Recordings**: review the intervals the camera marked (approve or exclude them), and check them against the raw data.
7. **Model Lab** (Models): add the recordings to the training data, train a model for each label, then approve and activate it. Use **Monitor** mode first: it scores and shows detections but cannot act. Saved recordings (the Recordings tab, and the lists in the Gesture library and Model Lab) are numbered the same way, by when they were saved: #1 is the earliest, the lists are in that order, and the order is kept in a small `sequence.json` beside the recordings, never inside them. The numbers run 1, 2, 3 … without a gap: deleting a recording moves the ones after it up by one. Recordings added to Model Lab are numbered in the order they were imported (#1 for the first), listed in that order there and in the Train card, with the time each was imported; the numbers run without a gap, so deleting a recording moves the ones after it up by one. The **Network lab** next to it shows the one model the app trains, stage by stage, and lets you look inside each model you have.
8. **Gestures** (Automation): see each gesture light up as it is recognised, including how well each model agrees with the camera.
9. **Recipes**: chain gestures (head location, wrist, model labels, camera gestures) into something that controls your computer. **Virtual devices** shows and tunes the controls recipes drive.
10. Only after reviewing Monitor results and checking the target platform, use **Live** mode with an isolated test audio output. Camera gestures have their own **armed** switch.

## 3. In-app feedback, help, and file saves

### Async action feedback

Buttons that trigger a desktop-side operation (training, activation, rollback, inference-mode changes, wellness measurements, CSV saves, and similar) show a pending state while the request is in flight — the button's label changes (for example to "Saving…" or "Updating…") and it disables itself so a second click cannot fire a duplicate request. When the operation finishes, the outcome is reported as a toast notification: **success**, **info** (for example, a cancelled save), **warning**, or **error**, each auto-dismissing after a few seconds. Treat these toasts, not silent completion, as confirmation that an action actually happened.

### Undo

Deleting recordings, sealing or unsealing them, and moving a recording's labels to the camera or the model each show a message
with **Undo** for 8 seconds. A delete waits out those seconds before it happens, with the recordings hidden meanwhile, so
Undo brings them back untouched; closing the app in that time leaves them undeleted.

### Keyboard shortcuts

Press **?** anywhere outside a text field for every keyboard shortcut, grouped by where it works. Press it again, or Esc, to
close the list.

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
- **Making a model** lists the steps from recording to the final test (Record, Label, Clean, Train, Final test), where each
  stands from what the app holds, and the next one to do. **Label the next →** opens the first recording nobody has
  reviewed on the Labelling page.

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
- The **Link health** card shows how the link is doing: its phase, how long it has been connected, drops, the packet size, and **Sample delay**, how late motion samples arrive (typical and worst 5%). A few hundred milliseconds or more means the Bluetooth link is behind. See [Troubleshooting the watch link](troubleshooting-watch-link.md).

If a sensor is unavailable, treat that as a device capability or permission state—not a successful inference input. Low-quality, stale, malformed, or disconnected sensor data fails closed and releases any active interaction.

### Capture: Live signals, Recorder and Recordings

The capture tools are three tabs in the **Capture** group of the sidebar, in the order you use them:

- **Live signals** shows what the sensors are sending right now (the charts below). Use it to check a stream, not to record one. The head and watch orientation graphs draw yaw, pitch and roll as continuous lines: an angle turning through the back of the circle (+180° to -180°) carries on past 180° instead of jumping, so a slow turn is not drawn as a spike. This is for the graphs only; recorded values keep the raw angles.
- **Recorder** records a session from the watch and exports it. While a timed capture records, a **Time remaining** counter and a progress bar count down to the moment it stops. When a timed capture ends it exports by itself as a dataset folder (`ppg.csv` and `imu.csv`), the same as the **Export dataset folder** button, and it still does so if you switch to another tab while it runs, and the export folder you chose stays chosen when you leave the page.
- **Recordings** looks inside saved sessions (currently the raw image viewer).

The sidebar marks **Recorder** while a recording is running. Cmd/Ctrl+1 to 9 open the first nine tabs (Main to Model Lab, in sidebar order), and Cmd/Ctrl+comma opens Settings.

#### Live charts

**Live signals** visualizes available raw streams, including:

- Headphone yaw, pitch, and roll.
- Watch orientation (from the watch's rotation-vector sensor).
- Watch acceleration: linear acceleration with gravity removed, in m/s². It arrives with each orientation sample, is saved in every recording as `accel_x`, `accel_y` and `accel_z` next to the gyroscope columns, and the chart is hidden if the watch's acceleration sensor is switched off.
- Raw PPG: green, red, and IR.
- Available health streams such as heart rate, IBI, temperature, EDA, SpO2, and ECG.

The fast charts (headphones, watch orientation and acceleration, PPG) show the **last 6 seconds**; the slow ones (heart rate, IBI, temperature, about one value a second) keep their last 600 values. Watch motion is drawn at each sample's own watch timestamp, so samples that Bluetooth delivers in a burst keep their real spacing instead of piling up at one moment.

Chart visibility follows the enabled/streaming state of the corresponding sensor.

#### Ordinary CSV capture (Recorder)

Use **Start recording** / **Stop recording** for a general telemetry capture, then choose **Save CSV**. This exports buffered incoming rows with source timestamps and sequences. The tab shows buffer usage; when the cap is reached, the oldest ordinary-capture rows are dropped.

#### Camera hand tracking (Recorder)

Under the recorder, **Camera hand tracking** finds the landmarks of your hand with the camera, on this computer. **Turn camera on** (macOS asks for permission the first time; allow it), and you see a mirror view with the 21 points drawn on each hand, how many hands are in view, the frame rate, which hand it is, and the distance between thumb and index finger in hand sizes (about 0 is a firm pinch). Keep the hand that wears the watch in view. If the computer has more than one camera, a **Camera** dropdown appears (here and in the Gesture library); picking one while the camera is on switches to it at once, and picking one while it is off is used the next time you turn it on. The list updates when you plug a camera in. Only one camera is used at a time, and the choice is not remembered between launches.

With **Save hand landmarks with recordings** ticked (the default), each recording also saves `hand_landmarks.csv` (the landmarks of every camera frame, and when it was taken) and `clock_sync.csv` (how to line the camera up with the watch). **Only landmarks are saved, never the picture, and nothing leaves your computer.** The camera stays on while you switch to other tabs, so a recording keeps its pictures. A timed capture is now also saved as a recording (with its landmarks), as a manual stop already was. The camera badge shows how fast the camera is going and how long the hand model takes for each picture (for example “30 frames/s · 12 ms each”); the picture is asked for at 640×360, which is plenty for the hand model. The hand model runs in a **background worker**, so detecting your hand never holds up the page or the picture, and the camera takes a new picture only when the last one is answered, so pictures never queue up and the hands always belong to a recent picture. A “Hand model” badge says what runs it (graphics chip or processor, background or page thread); if the worker cannot start, the app quietly runs the same model on the page's own thread. Gestures are decided on every frame whatever the page is drawing. If the camera drops below 15 frames a second while camera marking records, the marking card warns that the marks may be a little off. The panel shows the clock alignment with the watch once the watch is streaming, and how many frames a running recording has kept (about 17 minutes is the limit).

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

**Export review gate.** Pressing **Export dataset folder** with a buffered session first shows this same quality summary as a review dialog. A session with no quality warnings exports immediately from that dialog. A session with warnings requires an explicit **Export anyway** click; **Cancel** closes the dialog and leaves every buffered row and interval untouched. A session with no recording/quality summary available (nothing buffered yet) exports exactly as before, with no dialog.

**Discard** removes the current in-memory session without saving or exporting it — nothing has been written to disk yet at that point, so nothing needs to be cleaned up. **Export dataset folder** writes the recording as a folder of two dense files that Model Lab imports as one: `ppg.csv` (a row for each pulse sample) and `imu.csv` (a row for each motion sample, with acceleration, gyroscope and orientation), plus a small `dataset.json` with the row counts and labels. Each file has a row only where its own sensor produced a sample, so neither has blank cells where the other sensor had nothing; both carry the label of each row, and a `# label:` line says every row of a single-label session. A name that is already taken gets a number after it, so an export never overwrites another. **Export one CSV (older format)** still writes the single file with blank cells, for tools that expect it. Either way, the export writes the dataset the Model Lab importer reads: a Quick Capture session is one uniformly labeled file; a Timeline Capture session keeps each row's interval label, with the rows between intervals left unlabeled (the importer drops those). Only these per-row labels reach training; a recording's curation status and interval boundaries in `annotations.json` do not (see [Review remediation](review-remediation.md)). Preserve a mix of positive gestures and realistic background/negative activities; that is important for false-activation evaluation.

**Pinch collection protocol.** A practical routine for capturing usable `pinch` intervals with Timeline Capture:

1. Put the watch/headphones on and let sensors settle a few seconds before recording anything.
2. Start the recording, then hold a few seconds of neutral rest (no gesture) so there's clean lead-in.
3. Hold the marker through one full pinch — start the hold just before the pinch begins and release just after it ends, for at least 300–500 ms (see the marker's tooltip); a shorter hold gives the 500 ms model window too little context and is flagged as a short label.
4. Return to rest, then repeat steps 2–3 for several more pinches, mixed with realistic non-pinch activity so background/negative coverage isn't all idle.
5. Capture more than one session (separate Start/Stop recordings) rather than one very long one — training holds out whole sessions, so one session can't cover evaluation by itself.
6. Before exporting, check the quality summary and timeline intervals — fix mislabeled or too-short intervals, then export.

#### Session details (Recorder)

The **Session details** card says how the next recording is made:

- which wrist the watch is on;
- where the arm is: resting on a surface, raised and held still, moving, or walking;
- what you are doing;
- how the strap sits;
- whether you pinch with a light touch or a firm press;
- any notes.

A model only learns the conditions it was shown: one trained only on pinches with the arm resting does not recognise them
when the wrist moves. So vary these across sessions, and record ordinary activity without the gesture too.

- The details are saved with the recording: as `# context.<field>: <value>` lines at the top of its files and in its
  `recording.json`.
- They go with it into Model Lab, which shows them under each recording as "Recorded: …". The Labelling page shows them for
  the recording that is open.
- The last details you used are kept for the next session. A recording under way keeps the details it started with.
- A field left as "Not said" is not recorded.

**The pulse sensor's clock.** The pulse sensor stamps its samples with its own clock, which the Recorder puts on the watch's
clock before saving them. So that this can be redone later if the mapping ever turns out wrong, every saved recording and
exported folder also holds `ppg_clock.csv`.

- It has one row per pulse batch: its `sequence` (as on its rows), when the watch sent it (`sent_ns`), its newest sample's
  own timestamp (`newest_sensor_ns`), and the offset added to put its samples on the watch clock (`offset_ns`).
- A pulse row's own timestamp is its `timestamp_ns` less its batch's offset.

#### Guided session (Recorder)

A **guided session** tells you when to make the gesture and labels it at that moment, so there is no key to hold and every
label starts the same way.

- Choose the **gesture**, **how many times**, how long to **hold each**, and how long to **rest** between cues (each rest is
  picked at random between the shortest and longest, so the cues cannot be anticipated).
- Then come stretches of **everyday activity** (typing, using the mouse, moving the arm by default; add or remove them). They
  are labelled with the **everyday label** you choose (a label with the everyday-activity role), or left unlabelled.
- **Start guided session** starts a timeline recording. After a 5 s lead-in, each cue counts down ("Get ready… 3"), then
  shows "*Gesture* now" in large type, and the watch buzzes. The label is on for the hold time.
- The recording stops by itself at the end, and is saved and exported like any timed recording. **Stop and save** ends it
  early; stopping or discarding it on the recorder ends the session too. Switching tabs does not.
- Each label starts at the cue, so it trails the gesture by your reaction time (about 0.3 s). That lag is steady, and Label
  timing on the Labelling page measures and removes it.
- If the watch cannot be buzzed (not connected, or the browser preview), the card says so and the cues are on screen only.
- The labels it makes are recorded as made by a guided cue.

#### Signal health (Recorder)

Under the connection status, a strip shows the watch's streams live: the **motion** and **pulse** rates over the last 5 s and
the **pulse contact** (how much of it the sensor flagged).

- A stream silent for more than a second, or contact flagged on more than 30% of samples, shows red. Under 20 Hz, or contact
  flagged on more than 10%, shows yellow.
- While recording, anything red is also said in a warning above everything else, so a broken session is stopped in seconds
  rather than found afterwards.

#### What you have recorded (Recorder)

The **What you have recorded** card counts the holds of a label in Model Lab's recordings by the session details they were
recorded with: a grid of arm by wrist, and lines for activity, strap and pinch. Empty conditions say "none" and thin ones
(under 10 holds) are marked: those are what to record next. Choose the label at the top; the most recorded one is shown first.

#### Review it right away (Recorder)

After a recording is saved, a card offers **Review it in Labelling**: it adds the recording to Model Lab (as **From the
Recorder** would, with unreviewed intervals counted) and opens it on the Labelling page. A recording already added is just
opened. **Not now** hides the card.

#### Let the camera mark it (Recorder)

Wherever a page needs the camera (the Recorder's camera marking, the Gestures tab's check against the camera, the arm switch, the gesture editor and the correction panel in Model Lab), the same small camera control is there: **Turn camera on**, then a badge with the frame rate, **Show preview** / **Hide preview** for a small live picture with the hand drawn on it, and **Turn camera off**. It is the same camera as everywhere else, so turning it off here turns it off for the whole app; it cannot be turned off in the middle of a recording, because the recording would lose its hand landmarks. Under the recorder, **Let the camera mark it** labels a recording for you, and it is **on by default**. It takes effect whenever the camera is on, hand landmarks are being saved, and the label you chose has a gesture in the Gesture library; until then recordings are made as usual with no camera marks. A badge shows live whether the camera sees the gesture, so you can check it before you start. Record as usual with the watch on the hand the camera sees. With marking in effect the recording is made as a timeline, and **while you record** the camera writes the label straight into the watch data, just like holding the **Mark label** button: the label is on while the camera sees the gesture and off when you let go, starting where the gesture began rather than where the camera noticed it. Those intervals are **unreviewed**, and the PPG and motion rows carry the label in the saved recording and in **Export Dataset CSV**, the moment you stop. When you stop, a message says how many were marked, or that the camera never saw the gesture (the recording is kept either way). The tick box is a choice you can switch off, and it is remembered. Review the intervals in Recordings like any others.

**Several labels in one recording.** Choose the main label as usual, then under **Also mark in the same recording** press the other labels you want (any label that has a gesture in the Gesture library; a pressed one is highlighted). The camera then marks all of them in the one recording, each label's intervals on its own rows, and the recording keeps every label for Model Lab. Only one label is on at a time: if gestures of two labels are held together, the one that began last is marked, and the other takes over from where it ended if it is still held. The extra labels are fixed when you press Start, and cannot be changed during a recording. If a chosen label has no gesture the card says which, and no marking happens until you add the gesture or drop the label. When you stop, the message counts the intervals for each label and names any the camera never saw. Marking by hand with the Mark label button still marks the one main label.

#### Mark an older recording (Recordings)

At the top of **Recordings**, **Mark an older recording** runs camera marking on a recording that was saved without it (the camera was off, or the gesture did not exist yet), or again after you improve a gesture. It runs your Gesture library over a recording's saved hand landmarks. Pick a recording made with the camera on, choose **Find gestures**, tick the holds you want and add them. Each becomes a label interval on the watch data, using the label the gesture is linked to, and starts **unreviewed** like any other interval.

- The camera and the watch have separate clocks. They are lined up from clock samples saved with the recording, and the panel shows how closely (the link's jitter). The labelled rows are never more exact than that.
- A gesture with no label, a recording with no camera data or too few clock samples, and a proposal that overlaps an interval already in the recording are each skipped or refused, with the reason shown.
- Quick-capture recordings carry one label over the whole recording, so a proposal there overlaps it and cannot be added. Camera proposals are for timeline recordings or ones with room between intervals.

#### Raw image viewer (Recordings)

The **Recordings** tab gives a read-only visual inspection of one numeric raw-data column from a saved recording's `raw.csv`. Choose a square grid size — any multiple of 4 from 4×4 through 64×64 (default 64×64) — and each frame reshapes exactly `N × N` chronological raw rows into an `N × N` image (pixel left-to-right, then top-to-bottom, in raw-row order); the slider and prev/next controls move in `N`-row hops, and the far end of a recording is always reachable even if it isn't hop-aligned. Changing the grid size realigns the current position to the new hop and reloads the frame. A missing raw field renders in a distinct color from "beyond the end of this recording," and neither is ever filled in with replacement data. Recording-scale normalization (the default) and an explicitly labeled per-frame-scale alternative are pure rendering choices over the already-loaded frame. Hover or use arrow keys to inspect a pixel's raw row, timestamp, value, and null state.

**Importing a recording.** **Import dataset folder** (on the Recordings tab, beside Source) takes a folder exported by the Recorder, the one that holds `ppg.csv` and `imu.csv`; the two files are merged back by time into one recording. **Import CSV** takes a Timeline Capture `raw.csv` or a single-file dataset export (the older format). Either becomes a new read-only recording to inspect, and the labels in a dataset become its label ranges.

The same selected window renders as two images side by side (stacked on narrow layouts): a grayscale image (black = low, white = high) and a rainbow false-colour image (red = low through the spectrum to violet = high). Both share the same grid, navigation position, and normalization mode; the color mode is a second pure rendering choice, like normalization, and is not a channel-mapping or multi-sensor composite. Missing-value and beyond-recording fills and the constant-value gray are the same in both images, and each has its own title, aria-label, and legend describing its palette and endpoints.

This viewer is inspection-only: it has no annotation-editing or training action, and nothing it renders or computes feeds Model Lab, dataset export, or inference.

### Labels

The **Labels** tab (first under Labels) is the one place labels are made and managed. A label is a short name for a gesture or an everyday activity the app can learn or recognise. Each label has an id (letters, digits and underscores, made from the name), a display name, optional notes and a role.

- **Add a label** with a name; the id is shown before you create it and never changes afterwards. **Edit** changes the name, notes and role, and everything that refers to the label (recordings, models, recipes, gestures) keeps pointing at it.
- Each label shows where it is used: in how many Recorder recordings, how many recordings in the training data, how many gestures and how many models. Recording and training happen in their own tabs, not here. A label something still uses can be **archived** but not deleted, so nothing is left without a meaning. Archived labels are hidden from pickers and can be restored.
- **Archive…** and **Delete…** on a label that something uses open a preview that says exactly what will happen, and nothing runs until you confirm.
  - **Archive** switches off the recipes that use the label's model, archives its models (an active one stops first) and archives the label. Gestures and recordings are kept. It remembers what it switched off, so **Restore** switches those recipes back on and returns the models to Draft (approve and activate them again).
  - **Delete** removes the label together with: the recipes that use it (its model, or one of its gestures), its gestures, its models and their files, the training recordings that hold only this label, and this label's marks on Recorder recordings. The Recorder recordings and their raw data stay. If a training recording also holds other labels, delete cannot go ahead until you remove that recording in Model Lab. You must type the label's id to confirm.
  - Each label may also have **training history**: the projects, runs and sealed snapshots the model registry keeps after a model is deleted. They are listed under **Where it is used**. **Delete** removes the label's own history, once its models are gone. If another label's history mentions this label (for example as "not the gesture"), that history is sealed and cannot be edited, so delete cannot go ahead: delete the other label first, or archive this one.
  - If a step fails, it stops there and says how many steps were done.
- Open **Where it is used** under a label to see every gesture, Recorder recording, training recording, model and recipe that uses it, each with a button that opens that tab.
- Everywhere else reads this list: the **Gesture library** and **Model Lab** choose from it, and the **Recorder** offers it as buttons. A label typed by hand in the Recorder that is not in the list says so and has **Add to Labels**.

In forms, a field marked with a red `*` is required; the others can be left empty or already have a sensible default.

### Gesture library

The **Gesture library** tab (under Labels) defines gestures the camera recognises from your hand's shape. It needs the camera but not the watch.

1. Choose **New gesture**, name it, pick the label it will be recorded as (from the Model Lab label list) and which hand it applies to.
2. Turn the camera on. A line under the picture says which hand the app sees: raise your left hand, and if it says Right, tick **Left and right are swapped**. Then choose **Record gesture and background**. Hold the gesture, moving the hand a little, then do anything else. Both lengths are choices above the button (gesture: 4, 8, 15 or 30 seconds, default 4; everything else: 7, 15, 30 or 60 seconds, default 7), and are remembered. Longer recordings give the rule more to learn from. Nothing but hand landmarks is used. When you save, the rule is kept, and so are up to 300 of the measured frames of the gesture itself (numbers only, no pictures) so later gestures can be checked against it (see below).
3. The measurements that tell the two apart become the rule (for example "thumb to index tip below 0.3 hand sizes"), with a start threshold and a looser end threshold so it does not flicker. You can edit every number and add or remove conditions; the percentage shows how well the rule separates the frames you recorded. Calibration quality is on those frames only, so test the gesture live afterwards.
4. **Hold before it counts** ignores brief accidental poses; **Forgive losing it for** stops a flickering hand ending it early.

**Second camera (optional).** With the first camera on, **Second camera** lets you add another camera as a separate source. Its picture appears beside the first camera's (stacked on a narrow window), each with its own camera choice above it. It has its own hand detector, and nothing is lined up between the two: each camera checks your gestures on its own. **A gesture counts when either camera sees it**; when both do, the earlier start is used, and it lasts until the last camera lets go. During calibration, frames from both cameras go into the same recording, so the rule has to work from both angles. The same rule applies to the live "Detected" badge, to Model against camera, and to camera gestures in recipes. Two hand detectors cost twice the processing, so watch the frame rates shown for each camera; if they fall well below 25, it is too much for this computer. The Recorder's **Camera hand tracking** panel has the same two cameras side by side. When a recording is made with both on, each camera's landmarks are saved in a file of its own (`hand_landmarks.csv` for the first, `hand_landmarks_2.csv` for the second), and **Let the camera mark it** and **Mark an older recording** read both and mark a gesture if either camera saw it. A recording made with one camera works as before. The second camera is off at every start.

Saved gestures show **Detected** live while the camera is on.

**Measurements.** Besides the thumb-to-fingertip distances and how straight each finger is, a rule can use: **four fingers straightness** (the average, low for a fist), **thumb pointing up** (+1 straight up, −1 straight down, as the camera sees it), **thumb away from the palm** (small with the thumb tucked in, large with it held out), **index finger pointing up** and **hand pointing up**. Thumb up versus thumb down, and thumbs up versus a fist, can only be told apart with these; the earlier measurements read the same for all three. Up and down are as the camera sees them, so keep the camera upright.

**Pretrained gestures.** The camera also runs MediaPipe's pretrained Gesture Recognizer (open source, Apache-2.0, about 8 MB, trained only on hand gestures, shipped with the app so it works offline). In the same pass as the hand landmarks it names seven gestures: closed fist, open palm, pointing up, thumb up, thumb down, victory and I love you. While the camera is on, the Gesture library page shows what it sees right now (for example “Thumb up · 92%”). In the gesture editor, **Pretrained gesture (optional)** makes a library gesture require that reading too: the model must be at least 60% sure to start and stay at 40% or more to keep going. Use it alone (no conditions needed) for one of the seven, or together with a calibrated rule to make it stricter. It cannot learn new gestures, so anything beyond the seven still comes from your own calibrated rules. If the model cannot be loaded the camera falls back to the plain hand landmarker (the camera's speed line then says “no pretrained gestures”) and pretrained gestures simply never fire. The Library check does not look at the pretrained reading.

**Telling similar gestures apart.** When you record a gesture, every other gesture in the library (on the same hand) that has saved frames is checked against it automatically: the rule is chosen so it finds your gesture and does not fire on theirs, and the result lists how often it would fire on each (for example “Also fires on 3% of the Fist frames”). If a rule would fire on 10% or more of another gesture's frames you are told, and from 30% it is marked weak with the name of the gesture to separate it from. Spend the “everything else” recording on other poses, not on the library gestures, which are already included. Gestures calibrated before this version have no saved frames, so they are not checked against: edit them and record again (a Fist and a Thumbs up made earlier should be recorded again so they use the new thumb measurements). The **Library check** card on the Gesture library page does the same for the whole library: for each pair of gestures, how often one's rule fires on the other's frames, worst first. It uses the start thresholds only, so it is slightly stricter than live recognition. A gesture may now use up to four conditions.

**Model against camera** (below the list) checks a deployed watch model against the camera while you perform. A gesture linked to a label with an active model, a camera that is on and the model runtime in Monitor or Live are all needed. For each gesture it counts the holds the camera saw, how many the model found within about two seconds and its typical delay, how many it missed, and how many times the model fired while your hand was in view and you were not doing the gesture. Detections with your hand out of view cannot be judged and are counted apart. The camera is taken as the truth, so wear the watch on the hand it sees. The counts are not saved and restart when you press **Start over** or reopen the page. They are kept in `gesture-library.json` in the app's config folder.

### Model Lab

Model Lab is organised around **one model per label**: a label is a gesture or activity ("snap_fingers", "pinch_start"), and each label has its own model. Models run inside the app; nothing else needs to be installed to use one. The page follows the order you use it, top to bottom, and the buttons under the overview jump to each part:

1. an overview (runtime mode, active models, recordings);
2. **From the Recorder**: add recordings you made in the Recorder to the training data;
3. **Recordings**: the labelled sessions in the training data, and importing a CSV;
4. **Labels**: a pointer to the Labels tab, and how many labels are in use;
5. **Train a model**: teach a label from the recordings;
6. **Training history**: what was tried for each label;
7. **Label models**: your models, and the Off / Monitor / Live switch;
8. **Activity**: detections and releases this session.

#### Label models

The **Label models** card in Model Lab is the per-label model system: one binary model per label, several active at once, all run inside the app (nothing else to install).

- **Import a model folder** picks a folder holding `manifest.json` and a pinch-start model's trees (`model.trees`): the PPG + IMU model the app now trains, or the earlier PPG-only one, which still runs. It is checked in full and added as a **Draft**. Nothing is activated by importing. Models of any other kind (the ONNX models of earlier versions) cannot run in this app and are removed from the store when it starts; recordings and labels are never touched.
- A model marked **Monitor only** did not pass the checks for going live (see *Train a model*). It can still be approved (**Approve for Monitor**) and activated: it scores and shows what it detects, even with the runtime in Live, but it never starts a recipe.
- Each model moves forward by your explicit choice: **Mark as evaluated → Approve → Activate**. Imported models are not evaluated by this app, so review them yourself first. Activating checks that the model's files are intact and that it runs; a model that cannot run is not activated. **Deactivate** and **Roll back** work per label. An **archived** model can be **deleted for good** (after a confirmation): it is removed from the registry and its files are deleted. Only archived models can go, so nothing under review or in use is lost; the training run that made it stays as a record, and the same model can be imported again later.
- **Model runtime** is **Off**, **Monitor** (models run and show a score and a "Detected" badge, nothing acts) or **Live** (a detection can start recipes that use that label, see *Model label* below). Switching to Live asks first, and a restart always comes back in Monitor.
- A label whose active model cannot be loaded (for example its file was changed) is named in a red alert and has no running model.

#### Duplicates and quality (Model Lab)

Each recording under **Recordings** shows what training can use: its holds of each label (of at least 200 ms), holds too
short to train on (which training ignores), and how often the pulse sensor flagged its contact.

- It is shown in red when there are short holds, when no hold is long enough, or when contact was flagged on more than a
  tenth of the samples.
- A recording whose rows are the same as another's is marked "Same data as …", whatever its `#` lines say: a recording
  imported once as a single CSV and once as a folder is one recording twice.
- Delete one copy. Otherwise it counts twice, and one copy can be trained on while the other is tested on, which makes the
  test look far better than it is.
- Importing a recording Model Lab already holds is refused, and training refuses a request that includes two copies.
- Recordings imported before these checks get them the first time the list is shown.

**Find and act on recordings.** Above the list:

- search by name, label or session details; filter by day, by label, and by what is wrong (**With something to fix**,
  **Copies**, sealed or not, **Labels not reviewed**, **Labels need work**); sort by number, day, name, worst contact or most
  holds;
- tick recordings (or **Choose every recording listed**) to seal, unseal or delete them together;
- when there are copies, **Keep one of each** deletes all but one of each set: the sealed copy if there is one, else the
  oldest;
- **Label** on a recording opens it on the Labelling page. Each recording also shows whether its labels were reviewed there.

Each label is shown in its colour from the Labels tab, here, on the Train card, in the Recorder's label buttons and on the
Labelling page.

#### Final test (Model Lab)

Every score Model Lab shows comes from recordings that also shaped the model, its threshold or the method. The **final test**
is the honest one: a model run over recordings that took no part in any of that.

**Seal a test set:**

- Under **Recordings**, **Seal a day…** seals every recording of a day (the day in a Recorder export's name, else the day it
  was imported). **Seal** and **Unseal** on each recording do one at a time.
- Seal a whole day you have not trained on: a new day is what the model will meet.
- A sealed recording is marked **Sealed for the final test**.
- Training leaves it out: it is not in the list of recordings to use, and a request that names it is refused.
- Unsealing makes it ordinary training data again, and it then stops being an untouched test.

**Run the final test:**

- On the **Final test** card, choose a model (any version, active or not) and press **Run the final test**.
- It runs over every sealed recording exactly as the app runs it live, in Monitor, so nothing acts and nothing about the
  model changes.
- It reports, overall and per recording:
  - how many of the gesture's starts it caught (a detection 0.68 to 1.28 s after a start);
  - how many times a minute it fired with no start;
  - the median delay.
- Starts are counted as training counts them, by hand labels where you gave them.
- Every test is logged, and the card says how many times the sealed recordings were tested before. Test sparingly: each look
  makes them a little less untouched. Once you have changed the model because of what the final test said, seal a new day
  for the next one.

#### Train a model

The **Train a model** card teaches the app one label from your recordings. Every label is trained as the same model, the **PPG + IMU pinch-start model**, chosen by the October 2026 research (see [IMU fusion, trigger rules and label shifts](research/ppg-imu-fusion-and-triggers-2026-10.md)):

- it reads the **pulse sensor** (green, red and infrared light, 25 times a second): each moment is compared with the 1, 2 and 4 seconds before it (a z-score against each), and its slope, curvature and jerk are worked out from the samples before it; 21 statistics of those over the last 0.3, 0.6 and 1.3 s make 1,701 inputs;
- and the **motion sensors** (accelerometer and gyroscope, 50 times a second): the same 21 statistics of each axis, its size and its change over the last 0.3, 0.6 and 1.3 s, and how much it moved against the 3 s before, make 1,032 more;
- 300 randomised decision trees (ExtraTrees) vote on whether the gesture **has just started**, and it fires at the **top of the vote's climb** (the first moment the vote falls back after reaching the cut-off), not the moment it first crosses it.

It fires about 0.9 s after a gesture begins. Tested 20 times on recordings it never saw (37 recordings), its worst-case AUC was 0.87 (0.79 for the earlier PPG-only model), and at a cut-off that kept false alarms under 2 a minute it caught about 46% of gesture starts (with about 1.9 false alarms a minute; 35% with at most 1): better than the pulse alone, mostly because the motion tells a pinch from the start of another gesture, but not yet reliable as a live trigger. It needs about 5.6 s of pulse data before it scores, so it is quiet for the first seconds after the watch connects; it also needs the motion stream, and says so if that stops. A recording's time between gestures (rows with no label) is kept when it is imported, because the model compares each moment with the seconds before it.

1. Choose the **label to teach**. Every recording starts selected; untick any you do not want.
2. Give every other label in those recordings a role: **Something else** (it teaches the model what is *not* the gesture; their starts are the hardest thing for it to tell apart) or **Leave out**. Nothing is assumed.
3. Optionally set the **label timing** (below) and tick **Also run research checks**.

Before anything runs, the card shows which recordings it will **train on** and which it will **test on**. The app decides this, deterministically, and a recording is never in both, so the score is about recordings the model has not seen. It refuses, and says why, if there are not at least two recordings with the label and two with something else (a recording with both kinds counts for each). The card warns if only one recording of the gesture would be trained on: a model trained on a single session usually memorises it.

The plan also has a table of the label's holds on each side, by arm and wrist, from the recordings' session details. It
points out a condition only the test has (its score there is about something new to the model) and one only training has
(the score says nothing of it). Stretches left out on the Labelling page need no role: they are always left out.

The trainer learns from moments it picks in each recording: about 880 ms after each start of the label (the positives), and as negatives the same moment after every other label's start, moments 0, 200 and 400 ms after each start of the label (so it does not fire before the moment), points inside holds, and quiet time at least 1.5 s from any hold.

When training finishes you see, in words, how many of the gesture's starts it found, how much of what it flagged was right, and how often it wrongly flagged another moment, all measured on the recordings it never trained on. **The cut-off for "detected" is fitted on the training recordings**: each is scored by a model trained without it and played through as it would run live, and the cut-off that catches the most gestures while going off without one at most 2 times per minute of recording is used (if none manages that, the one that catches the most gestures for its false alarms), so the numbers on the test recordings are fair. The card also says what the model does **played through the test recordings as it would run live**: how many gestures it caught (a detection 680 to 1,280 ms after a start catches it), how soon, and how often it went off with no gesture.

A model is good enough to go live when, on the test recordings, its AUC and balanced accuracy are at least 0.7, it flags at most 10% of the other moments, it goes off at most 30 times an hour without the gesture, and it catches at least half the gestures (the test recordings must also hold at least a minute without the gesture). Trained on some of the training recordings, it must also tell the gesture apart in the others (AUC at least 0.7), or doing well on the test recordings was luck. **A model that falls short is still kept, as Monitor only**: the card says why, and under Label models it can be approved and activated to watch it score, but it never starts a recipe. A failed or cancelled run is recorded with its reason and produces no model.

Training runs on this computer and needs **uv** on the PATH and this repository checkout (`tools/label-trainer`); the card says so if it is missing. The first run downloads the Python packages. Running a model needs none of this.

#### Label timing

The camera marks a hold when it sees it, which can be a little before or after the pulse sensor and motion sensor show it. The Train card's **Label timing (ms)** moves every label later in time by that much (earlier when negative) before the windows are made; 0 leaves the labels as recorded and the samples are never changed. The value is limited to ±1500 ms and is kept in the model's manifest.

**Check which timing fits** tries offsets from −1000 to +1500 ms in steps of 250 on the chosen recordings and lists each one's score: every recording is scored by a smaller version of the model (100 trees) trained without it, pooled into one ROC AUC. The best offset is highlighted, with **Use +N ms** to set it. The offset is picked using the same recordings it is scored on, so the best score is a little optimistic, and when the best and worst differ by less than 0.03 the card says the timing barely matters.

#### Activity

A list of what the active models have done this session, newest first: **Detected** (with the model's confidence), **Released**, and **Attention** for a skipped window, a model that was swapped out, or two labels that cannot coexist being detected together (both are then held off). An identical line repeating is shown once with a count. The card can be **collapsed** (the button shows how many entries are inside, and it stays as you left it). In Monitor this is what the models would have done; in Live the same detections can start recipes. A release always shows, in every mode. The list has a fixed height and scrolls, so a long session does not make the page longer, and **Clear** empties it (new detections keep arriving afterwards; nothing about the models changes).

#### Labels

Labels are yours: the app ships none. **Add a label** with a name (it becomes an id, shown before you create it: "Snap fingers" is `snap_fingers`), say whether it is a gesture to detect or an everyday activity a model should not mistake for one, and optionally add notes. Record it on the Recorder tab under that same id, then import the recording.

Each label shows its recordings and its model's furthest state (No model, or Model: draft / evaluated / approved / active). A label with a single recording is flagged: a model is tested on whole recordings it never saw, so it needs at least two. **Archive** hides a label from new use without touching old recordings (**Show archived labels** brings it back, **Restore** undoes it). **Delete** is offered only for a label nothing uses, and the app refuses it for one a recording, project or model refers to.

Labels an older version shipped (idle, walking, typing and so on) are removed on the first start of this version unless a recording or model still uses them; those that are used stay as ordinary labels you can archive.

#### Warning: a model is seeing values it was never trained on

A trained model records, for each input, the range that input usually had in its training windows (the 1st to the 99th percentile). While the model runs, each window's inputs are compared with that range, and an input counts as outside when it is more than a quarter of the range's width beyond either end, and as far outside when it is two widths beyond. A window is unlike the training ones when one input is far outside, or at least half of them are outside. If, over the last three seconds, most windows (70% or more, once there are at least six) are unlike the training ones, an alert appears under the label in **Label models** and on the **Gestures** tab: which model, how much of the time, the inputs furthest outside with their live value and their training range, and the usual cause (the watch sits differently, or the sensor's level has drifted since the training recordings). It goes away when most windows are back inside. A model that is being given inputs it never trained on can fire on everything or on nothing, so its score means little until this is fixed: check how the watch sits, or train on recordings made the way you wear it now.

A model run beside the active one for comparison is not checked. The check never changes a model's answer or what a recipe does: it only says that the answer is not to be trusted.

#### The Network lab

The **Network lab** tab (under Model Lab in the sidebar) shows the model the app trains and lets you look inside each one:

- **PPG + IMU pinch-start model** shows the model's six stages (pulse sensor → compared with the recent past → how it changes → motion → ExtraTrees → peak trigger) and what the research measured for it.
- **Your models** lists the models; **Look inside** opens the card described below. A model that may only run in Monitor is marked **Monitor only**.

#### Inspect a model (Model Lab)

Every model under **Label models** has an **Inspect** button, which opens it in the **Network lab** (the Network lab's **Your models** list does the same with **Look inside**). For a model trained in this app it shows:

- **How well it works:** on the moments of the recordings it was tested on (each start of the gesture, other gestures' starts, the middle of holds and quiet time): the confusion (hits, misses, false alarms, correct rejections) and rates at a cut-off you can slide anywhere, the **ROC curve**, the **precision-recall curve**, **what each cut-off would do**, a **histogram of the scores**, a **calibration** chart, and **each held-out recording on its own**. With another model of the same label chosen under **Compare with**, the curves are drawn together and the two are compared in a table. Every chart has an **SVG** button, and the results can be saved as CSV or as a JSON report.
- **Research checks** (only if **Also run research checks** was ticked when training): a **learning curve** (the same model retrained on a quarter, half and three quarters of the training moments, scored on the same held-out ones, with a sentence on whether more recordings would probably help) and **leave one recording out** (each recording scored by a model trained on all the others, pooled into one ROC AUC).
- **What it leans on:** the 25 inputs whose splits do the most to tell a start from the rest, each in words (for example "green slope against the last 1 s: mean over 0.32 s") with its share of everything the trees learn.

Everything shown comes only from recordings the model never trained on. An imported model shows only the inputs it declares.

#### Mistakes (Model Lab)

**Mistakes** lists every start a model missed and every time it fired when it should not, on the recordings it was tested on
(tick **Also the recordings it trained on** for those too: a mistake there usually means a wrong label).

- Each model is run over the recordings as the app runs it live, and its detections are matched to the starts as in the
  final test.
- A miss says how high the score got (short of the threshold, or high enough but at the wrong time). A false detection says
  whether it was too early or too late for a start nearby, a second detection of a start already caught, or nowhere near one,
  and which label was on at the moment it was judging (0.88 s before it).
- Above the list, the false detections are counted by what was going on, so you can see that, say, most came while typing.
- **Open** shows the moment on the Labelling page. For a false detection, the stretch that makes it a training example is
  selected, ready to label as everyday activity.
- A detection judging a stretch left out on the Labelling page is not counted.

#### Threshold (Model Lab)

**Threshold** shows what a model's threshold trades: at each threshold from 0.30 to 0.95, the share of starts it catches on
its test recordings against its false alarms a minute, as a curve with its own threshold ringed. The slider shows the
numbers at any one, beside those at its own. The curve comes from one run of the model's scores through its detection rule at
each threshold. The threshold is part of a trained model: to use another, train again.

#### Compare models (Model Lab)

**Compare models** puts two to four models of one label side by side on the same recordings: ones that none of them trained
on. Each model was tested on its own recordings when it was trained, so those scores cannot be compared; these can.

- A table gives each recording's starts and, for each model, how many it caught and how many false alarms it made, at its own
  threshold, with totals.
- Their threshold curves are drawn together, and any final tests of them are listed.
- If no recording is new to all of them, it says so: compare them on a sealed day with the final test instead.

#### Training history (Model Lab)

**Training history** lists, for each label you have trained, what the model registry remembers: the project, every run and how it ended (ready to use, scored only, or failed), the sealed snapshots of exactly which recordings were used, and how many models exist now. It also shows which labels a project was trained against (for example "not the gesture") and which other labels' history mentions this one.

Under **Runs**, each run shows the model it made, how many recordings it trained and tested on, and how far the labels were
moved, and says what changed from the run before: recordings added or dropped, labels newly taught as not the gesture or left
out, a different label timing, research checks on or off. Runs from before this was kept show less.

A deleted model leaves this record behind. **Delete history** removes it (after a confirmation) and never touches a recording. It is disabled, with the reason, while the label still has models (delete them under Label models first) or while another label's history mentions it (that history is sealed; delete it first). This is also what has to be cleared before a label can be deleted from the Labels tab.

#### From the Recorder (Model Lab)

Recordings you make in the Recorder are saved automatically and can go straight into the training data, with no export and import. In Model Lab, **From the Recorder** lists them with how many intervals are approved, unreviewed and excluded.

- **Intervals to use** chooses whether intervals you have not reviewed yet count ("Approved and not yet reviewed") or only the ones you approved. Excluded intervals never count.
- **Label everything else as** optionally gives the rows between intervals a background label (a label that is an everyday activity). That teaches the model what is not the gesture, which a recording that only holds the gesture cannot. Use it only if the gesture did not happen in those stretches; camera-marked recordings can miss one, so review them first.
- **Add to training data** makes a recording from the labelled rows. Adding the same, unchanged recording twice is refused; after you change its intervals, adding it again makes a new recording alongside the old one, which you can delete under Recordings.

Importing a CSV file still works for recordings made elsewhere.

#### Recordings

Record a labelled session on the **Recorder** tab (Quick Capture is one label; Timeline Capture keeps the label of each interval), export the dataset folder, then **Import a recording folder** here: choose the folder and both files are imported together (the check covers each file's exact header, rows of the right width, timestamps that never go backwards, consistent labels and that every label is already in the catalogue). **Import a single CSV (older format)** still takes a one-file export, and stores it as two files too. Recordings are kept in the app as a folder of two dense files, and the trainer merges them by timestamp when it reads them, which gives it exactly the samples a single file held, so nothing about training or running a model changes. Each recording shows how dense its streams are: how many times the pulse or motion stream went quiet for more than a quarter of a second, the longest gap and the share of the recording spent in gaps, with a warning when it is more than a tenth (the watch stream stalls together for both sensors, and a model cannot score while it does). Recordings imported before this are in the older single-file format; **Convert to two files** converts them one at a time, checks that no row was lost, removes the old file only after the new folder is saved and the list says so, and keeps the recording's identity, so models trained on it stay tied to the same data. The import is all-or-nothing: the file is checked in full (size limit, exact header, consistent labels, every label already in the catalogue) before anything is written, a failure says exactly why, and nothing is changed on disk. It is a compatibility path independent of the newer recording-bundle format and never touches those bundles. Labels keep stable ids; archiving one hides it from new selection but never changes old recordings.

The older three-class training, LiteRT readiness, intent-binding, replay and legacy inference panels were removed from this page; a model from the old system that could not be converted is kept aside and counted on the Label models card.

#### Labelling

The **Labelling** page (under Model Lab in the sidebar) is where you mark gestures by hand on a recording's signals. It is
for fixing labels the recorder or the camera put in the wrong place (they are often a few hundred milliseconds late), and for
marking recordings that have none.

**Open a recording:**

- **Model Lab recording** opens one of Model Lab's recordings.
- **Open CSV…** opens a single-file dataset.
- **Open folder…** opens a dataset folder (`ppg.csv` and `imu.csv`), as the Recorder exports it.
- A recording with no labels at all opens too.
- If you have unsaved hand labels, opening another recording asks first. The work on the page is kept while you visit other
  pages.

**The graphs:**

- Every column of the recording is drawn on one shared timeline: PPG green, red and infrared, acceleration and rotation.
  Contact quality and orientation are hidden at first; tick them under the graphs to show them.
- Above the graphs, **Recorded** shows the labels the recorder or the camera gave, and **By hand** shows yours.
- **Ctrl/⌘+scroll** or a trackpad pinch zooms in or out where the cursor is; plain up-and-down scrolling scrolls the page.
  **Shift+scroll** or a sideways swipe moves along.
- **Zoom in**, **Zoom out**, **Whole recording** and **Zoom to selection** do the same with buttons.
- A long recording draws quickly: each pixel shows the lowest and highest value of the samples it covers, so no spike is
  hidden.
- Each graph's scale is fixed to its column's range over the whole recording, so moving or zooming never rescales it.
  **Scale: Fit to view** scales each graph to what is in view instead, for a close look at small changes.
- **Graph height** makes every graph Compact, Normal or Tall.

**Camera contact.** If the open recording was made in the Recorder with the camera on, the page draws the camera's view of the
hand. This includes Model Lab recordings added from the Recorder, and new versions of them.

- **Camera: thumb to index** is a graph of the distance between thumb and index fingertip. When two hands are in view, it
  shows whichever pair is closer. The dashed line is where a pinch closes: the threshold of your Gesture library's pinch, or
  0.35 without one.
- **Camera contact** is a rail with a yellow mark at each moment the distance falls past that line.
- Click a mark to start the selection exactly there. This is the most exact start you have; labels from the recorder or
  camera marking are often a few hundred milliseconds late.
- Camera and watch are lined up from clock samples saved with the recording. The page says how closely, typically about
  100 ms on a Bluetooth link.

**Label a stretch:**

1. Drag across any graph to select it. The selection shows on every graph, with its start, end and length below the buttons.
2. The arrow keys move the selection's end by 20 ms; with **Alt** they move its start, and with **Shift** five times as far.
3. Choose a label: a catalogue label (keys **1–9** pick the first nine), or **Nothing here** (key **0**). Nothing here marks
   the stretch as no gesture at all, whatever the recorder said; that is how to mark everyday movement as a negative.
4. Press **Label selection** (or **Enter**). **Erase hand label** (or **Backspace**) takes your label off the stretch, so it
   trains on the recorded label again.
5. **Undo** and **Redo** (⌘Z, ⇧⌘Z) step through your edits.

**How hand labels are used:**

- Recordings now carry a **`manual_label`** column, after `label`, in `ppg.csv`, `imu.csv` and the single CSV.
- Wherever a row has a manual label, training uses it instead of `label`. "-" (Nothing here) means the row has no label.
- The Recorder writes the column empty.
- A file from before the column existed is read as it always was, and gets the column, empty, when it is imported or opened
  here.

**Check the model against the recording:**

- **Run the active models** replays the recording through your active models exactly as the app runs them live, in Monitor,
  so nothing acts. Nothing about the models or the recording changes.
- Each model's score is drawn as a graph above the signals, with its threshold dashed, and its detections go on a
  **Model** rail:
  - green ("caught") where a detection comes 0.68 to 1.28 s after a labelled start of its gesture;
  - red ("false?") where it does not.
- A summary counts the starts it caught and the detections elsewhere, and says if some stretches could not be scored.
- **Click a red detection** to select the stretch that turns it into a training example of what is not the gesture. The
  stretch starts 0.88 s before the detection, because training takes each labelled start's moment 0.88 s in. The page also
  picks your everyday-activity label (a label with that role on the Labels page).
- Press **Enter** to label it, then **Save as new version**. Retraining on the new version teaches the model that moment
  was not the gesture. A missed start shows as a labelled start with no green detection after it.
- This is the quickest way to collect the hard negatives the model needs. Record ordinary activity (typing, using the mouse,
  drinking, talking with your hands), run the model over it, and label what it fires on.

**Label timing.** The page estimates how late the open recording's labels start, for the label most of its spans have:

- **Camera:** the median gap between the label starts and the nearest camera contact (within 1.5 s), when the recording has
  camera data and at least three starts have a contact near them.
- **Model:** after **Run the active models**, the shift (−1.5 s to +1 s, in 50 ms steps) under which its detections catch the
  most starts. A model trained on late labels learns their lateness, so where there is a camera, prefer the camera.
- **Move the labels to the camera** (or **to the model**) moves every recorded span of this recording by that amount, as hand
  labels: the span is painted where it now goes, and where it was is marked Nothing here. Undo takes it back.
- Each recording gets its own correction: one shared offset cannot fix lags that differ from recording to recording.

**Find your way:**

- The **overview** strip above the rails is the whole recording: recorded labels on top, yours below, orange marks at places to
  check, grey at suggestions and green and red at model detections, and a box over what is in view. Click or drag it to look
  elsewhere; ← and → step along when it has focus.
- Hovering a graph shows each graph's value at the cursor. With camera data, a small picture beside the overview draws the
  hands the camera saw at that moment.
- A selection's edges **snap** to camera contacts and releases, sharp wrist moves and label edges, when within 8 pixels of one.
  Hold **Alt** while dragging not to, or untick **Snap** under the graphs.

**Places to check.** A bar above the rails counts the places worth a second look and steps through them with **[** and **]**
(or **Previous** and **Next**), saying what each is:

- suspect data, also drawn on a **Data** rail: a stream that stopped for more than a quarter of a second, a clock that jumped
  back, a pulse signal flat for a second, a column stuck at its highest or lowest value for ten samples or more (out of the
  sensor's range), and pulse contact flagged for half a second or more. Click one on the rail to select it, with Leave out
  chosen;
- a hold under 200 ms, which training ignores;
- a gesture labelled where the camera saw no contact within 1.5 s, and a contact with no gesture labelled near it;
- after **Run the active models**: a detection with no start of its gesture 0.68 to 1.28 s before it, and a labelled start it
  missed.

**Suggestions.** The page suggests unlabelled stretches worth a look, on a **Suggested** rail:

- where the camera saw the fingers close, likely the pinch;
- where a model fired with nothing labelled (after **Run the active models**), likely everyday activity: the stretch that
  makes it a training example;
- where the wrist turned sharply, which only you can tell.

Where two point at the same moment, the camera wins, then the model. **Review them** selects each in turn, with its likely
label chosen: **Enter** labels it, **X** skips it, **N** and **P** move on and back. A stretch you have labelled, or marked
Nothing here, is never suggested.

**Leave out (key L).** For a stretch of bad data (strap loose, poor contact, the watch knocked). It stays in the recording but
is never trained on, nor counted in a model's mistakes or final test. It is saved as the label `left_out` in `manual_label`,
which needs no entry on the Labels tab.

**Try another threshold.** After running the models, a slider under each model's summary shows its detections at another
threshold, on the rail, in the summary and among the places to check. It changes only what is shown, never the model.

**Keep it:**

- **Save as new version** adds the recording, with your labels, to Model Lab as a new recording named "… (labelled)", and
  opens it so you can go on.
  - The recording you started from is left exactly as it was, so models trained on it stay tied to the data they learned
    from.
  - As for any recording added to Model Lab, its labels must be in the catalogue and at least one row must have one.
- **Export…** writes the recording with your labels. It is a **folder of two files** by default (`ppg.csv`, `imu.csv` and
  `dataset.json`, numbered if the name is taken), or **one CSV** with both `label` and `manual_label`. Either can be opened
  here again or imported into Model Lab.

**Review.** Once you have looked through a recording, say where its labels stand: **Labels are right**, or **Needs work** with
what still needs doing. Save your labels first: the review is of the recording as saved. Model Lab shows it beside the
recording, can list those nobody has reviewed, and the Main tab counts them.

### Gestures

The **Gestures** tab (under Automation) is where you try what is working before building a recipe. Nothing on it controls your computer.

- **Watch gestures:** the STEM button (lit while held) and the built-in shake, swipe, tap, roll and pitch. Each card says how to perform it, whether it is switched on in Settings, how many times it has been recognised this session, and which of your enabled recipes use it. The variant just recognised (for example *Left* for a swipe) lights for about a second and a half.
- **Head locations:** every calibrated location, with the one you are looking at lit.
- **Model gestures:** every loaded model with a live score bar and a **Detected** badge, which works in **Monitor** as well as Live. If the runtime is Off it tells you to set Monitor in Model Lab; if no model is loaded it points to Model Lab.

The pinch gesture is not shown: it needs a model trained for it, which will appear under Model gestures once you have one.


Under the model gestures, **Model against camera** checks each loaded model against the camera, the same check as on the Gesture library page: turn the camera on, perform the gesture, and it counts how often the model noticed it, missed it or fired when you were not doing it. It needs a Gesture library gesture linked to the model's label.
### Settings

#### Appearance

**Settings → Appearance → Theme** switches the look of the app. **Neo-brutalism** is the default: cream paper with thick black outlines, hard offset shadows (no blur), vibrant yellow, teal, pink and lavender fills, and bold rounded type. **Electric** is the original deep-blue theme. **NERV** is a command-terminal theme after the Evangelion interfaces: black panels in thin orange frames with bright corner brackets and square corners; filled orange label plates; black-and-orange hazard stripes under the top bar and above the bottom bar; headings, card titles and the menu in tall, thin capitals, and titles and big readouts squeezed thin; a menu of page numbers and names with no icons; orange for headings, labels and the main action; green for normal and active state; cyan for chart data; amber for cautions and red only for critical messages (an error message becomes a red **WARNING** plate with red-and-black stripes); condensed capitals for headings and buttons; monospace, tabular numbers that glow faintly; page titles as title cards: large white Mincho capitals squeezed hard sideways beside a thick orange bar; a background that is more than flat black (a honeycomb fading in at the top right and faint orange and EVA purple glows, which stay still while the page scrolls, and a ruler of tick marks along the top and the orange technical grid, which scroll with it); anything switched off (buttons, fields, dropdowns, switches, options in a list) shown on dim hazard stripes with a dashed frame; menu items numbered in order; and panels numbered “01 / MODULE”, “02 / MODULE” and so on. Some details follow the show's own screens: on windows at least about 1,240 pixels wide the top bar shows the computer's time as orange seven-segment digits under "ACTIVE TIME DISPLAY" (the bottom bar shows it otherwise); signal charts are drawn like the psychographic display, with green column lines and "+" marks, an orange ruler along the bottom and the chart's name in an outlined box; score meters are rows of cyan segments; and an error message looks like an EMERGENCY board, with bands of orange-and-black stripes and red rules above and below and a "警告 WARNING" plate before its title. Status badges carry a symbol and their words (● active, ○ inactive, ■ critical) so colour is never the only signal. Dropdowns are square with an orange arrow, and their option list is drawn in the theme too (black, orange frame, the chosen option marked, the highlighted one orange); it works with the mouse and the keyboard (arrows, Home and End, Enter or Space to choose, Escape to close, and typing the first letters of an option). Motion is quick and mechanical: switching pages wipes the new page in from the left with a short flicker while the page label in the top bar slides in; lists, tooltips and expanding sections unroll downwards; and confirmation dialogs open out from a horizontal line. All of it is off when the system asks for reduced motion. When NERV is chosen, a **CRT effects** switch appears under the theme: faint scanlines, shading at the screen edges and the glow on numbers. They are remembered, and are off whenever the system asks for reduced motion or more contrast; everything works the same without them. The design tokens follow a written specification rather than an official palette. The fonts it names are bundled (free, SIL Open Font License, small Latin subsets in `public/fonts`, so they work offline): Shippori Mincho B1 Extra Bold for page titles (Matisse EB if installed), League Gothic for headings, card titles and the menu, Oswald for buttons and small labels, JetBrains Mono for numbers and data. **Telemetry panel:** on the right of every page (windows at least about 1,100 pixels wide) there is a panel with **01 / HEADPHONES** and **02 / WATCH** modules and an **03 / EVENT LOG**. While the headphones are connected it shows the device, yaw, pitch, roll, packet rate and latency; while the watch is connected it shows whether it is on the wrist, the battery (as a segmented bar), the PPG state and rate, heart rate and skin temperature when the watch reports them, and the round-trip time. Anything not connected shows “NO SIGNAL” and anything the watch has not reported is left out, never filled in. The event log lists changes seen since the panel opened (devices connecting or dropping, the watch going on or off the wrist, PPG changing state) with their times. The panel collapses to a slim strip with its button and remembers that. **Top and bottom bars:** the top bar has an orange caution-triangle mark, names the system, shows the headphones, watch and camera as three oversized caution triangles locked edge to edge just right of the system name, running off the top and bottom of the bar (filled when live, outlined when not, each with its name and state on its centre; hidden on windows narrower than about 980 pixels) and shows the open page as its place in the menu and its name (for example “07 // RECORDER”). The bottom bar shows, with a symbol and words, whether the headphones, watch (online, or off the wrist), camera and recorder (idle, arming or recording) are live, and the computer's clock, which ticks each second. Everything on both bars is read from the app's own state. They replace the sidebar's logo and apply on every page and window size. It applies at once and is remembered on this computer (it is not part of the settings you apply, and not shared with another computer). The floating volume knob keeps its own look in every theme. The theme only changes colours and outlines; nothing about how the app works changes.

The **Settings** tab controls desktop acceptance/recording rates and Watch delivery settings. It is grouped by what each setting affects, in this order: **Watch** (transport, how it is worn, sensor switches, sampling rates, Samsung health delivery), **Gestures** (which built-in gestures are on, then each one's sensitivity, then wrist rotation limits), **Headphones**, **Recording & graphs**, and **Display** (the theme). The index at the top stays in view while you scroll: it jumps to a group and marks the one you are in.

- Every number states its unit, allowed range and default under the field. A field you have changed is marked **Edited**, and a small reset button puts it back to its default (you still apply the change).
- Nothing is applied until you choose **Apply changes** (or press Enter in any field), and then everything is applied together. The bar at the bottom says how many changes are waiting, and stays in view while you scroll whenever there is something to apply.
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

> Look at *Top right* → the *pinch* model (or hold the STEM button) → Roll the wrist → rotation knob → Volume

The pinch step is a model you train for a label named `pinch` (see Labels and Model Lab). Until that model is active the recipe shows **Waiting for model: pinch** and does not run. Recipes saved with the older built-in "Pinch and hold" step were converted to this automatically.

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

### Camera gesture

A recipe step can also be a gesture from your **Gesture library**, seen through this computer's camera: choose **Camera gesture** in the recipe editor, pick the gesture, and choose **While seen** (like a pinch, it can keep a dial turning) or **Once, when seen** (a moment, like a shake; button actions only).

- It works only while this app is open and its camera is on (turn it on in the Gesture library or the Recorder). With the camera off, or if the gesture is deleted, the recipe shows **Waiting for camera** and cannot start.
- The app window reports what the camera sees to the part of the app that runs recipes, several times a second. If those reports stop for about a second (the camera turned off, the window frozen or hidden), every camera gesture is released at once, so one cannot be left stuck on.
- It acts after the gesture's own **Hold before it counts** time (100 ms by default), so a camera gesture is a little slower than a built-in wrist gesture.
- Camera gestures have their own master switch, **Camera gestures armed**, at the top of your recipes whenever one uses a camera step. It is off every time the app starts, you can only turn it on while the camera is running, and it turns itself off again whenever the camera stops, so a recipe never acts on the camera unless you armed it in this run. While it is off, camera steps never hold. Arming starts clean: a gesture seen just before does not fire a once-only step, but one you are already holding counts. (Model labels are gated by the model runtime's mode instead.)
- A gesture a recipe uses cannot be deleted from the Gesture library until the recipe stops using it.

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
| Monitor/Live controls are disabled | Activate an approved model for a label in Model Lab first. |
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
