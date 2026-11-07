# Release-readiness acceptance checklist

This checklist is the real-device gate for a desktop release candidate. It supplements
automated tests; it does **not** claim that physical devices, platform volume backends,
or package installation have been validated. Record the release candidate commit, host
OS/architecture, device model/firmware, and outcome for every applicable row.

## Preconditions

- [ ] The working tree is the release candidate commit and `npm ci` completed.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`
  pass. Run `npm run test:performance` separately on an otherwise idle host (see
  [performance validation](performance.md#calibration-performance-gate)). Also run the two suites CI does not: the trainer
  (`cd tools/label-trainer && uv run --locked --extra dev --extra cnn pytest tests -q -rs`) and the
  watch (`cd apps/watch && ./gradlew :app:testDebugUnitTest`). If
  `native-head-tracking`'s `ffi_macos` smoke test aborts locally, confirm the
  `macos-14` CI job passes it instead.
- [ ] Run the platform bundle command, `npm run tauri -- build`, on every release
  platform. CI's packaging matrix exercises Ubuntu x64, macOS ARM64-host, and Windows
  x64 tooling; it is not a signed-release, cross-architecture, or install test.
- [ ] Validate a reviewed tree or CNN bundle (`manifest.json` plus `model.trees` or
  `model.cnn`) through the current importer. Inference runs in Rust inside the ordinary
  desktop build; no separate LiteRT runtime, Cargo feature or packaging command is used.
  See [label inference](architecture/label-inference.md) and
  [pinch models](architecture/pinch-models.md). Training requires the repository and uv;
  importing/running a model does not require Python.
- [ ] Use an isolated test audio output and a test dataset. Do not enable Live on an
  unreviewed model or a production presentation/audio device.

**Status update (engineering-review remediation):** the findings in
`.hermes/reviews/` were addressed in code with automated tests; see
[Review remediation](review-remediation.md) for each finding's status. That work
changed behavior this checklist must now confirm on real hardware: the rows marked
*(remediation)* below. None of them has been exercised on a physical watch,
headset or audio backend.

**Current scope (2026-11-06):** the earlier GC-004 LiteRT packaging instructions
are superseded by the in-process tree/CNN runtime. Historical review records describe
older implementations, not additional current release commands. No automated test result
clears signing, clean-host installation or physical-device acceptance; attach fresh results
to this checklist for each release candidate.

## UI feedback and accessibility

- [ ] Trigger a representative async action in each tab (for example: apply
  settings, train/activate/roll back a model, change inference mode, start/stop a
  wellness measurement, save a CSV) and confirm it shows a pending state (disabled
  control and/or changed label) and a terminal success or error toast; confirm a
  second rapid click does not fire a duplicate request while pending.
- [ ] Reach each visible help ("?") icon by keyboard (Tab to focus, then confirm the
  tooltip content is announced/visible) as well as by mouse hover, and confirm
  Escape or moving focus away dismisses it.
- [ ] Confirm **Save CSV** and **Export Dataset CSV** open the native OS save dialog,
  that cancelling it reports "Save cancelled" and writes nothing, and that a save
  failure (for example, an unwritable folder) surfaces the underlying error as a
  toast rather than failing silently.

## Watch raw-telemetry and quality gate

- [ ] **Bluetooth (default):** install the Watch app on a supported Galaxy Watch, grant
  the Bluetooth and sensor permissions, start the desktop app, bond the devices, and
  approve the desktop with **Trust this computer** on the Watch. Confirm the Watch tab
  reports awaiting approval until then and **Connected** after, with increasing
  sequence numbers, heartbeat, clock synchronization, and raw IMU data. Walk the
  Bluetooth rows in the [BLE transport doc](protocols/watch-ble-transport.md#hardware-validation-still-required).
- [ ] **Wi-Fi:** repeat on the same non-isolated Wi-Fi/LAN with Wi-Fi selected and
  confirm mDNS pairing reaches **Connected** with the same evidence.
- [ ] *(remediation)* Confirm the desktop identifies the Watch consistently: over
  Bluetooth the device id has the `ble-…` shape and is unchanged after a reconnect
  and a Watch app restart; over Wi-Fi it is the Watch's own `watch-…` id, different
  for a second Watch. Reboot the Watch mid-session and confirm gesture ingestion
  recovers after it reconnects (previously it stayed wedged until the desktop
  restarted).
- [ ] *(remediation)* On the target Watch, check the logs for the one-time
  "rebasing orientation timestamps" line. Record whether the device's sensor clock
  needed rebasing, and confirm orientation and PPG rows in an exported recording are
  in plausible time order.
- [ ] On compatible Galaxy Watch 4+ Samsung Wear OS hardware, verify raw green/red/IR
  PPG reaches the desktop. On unsupported hardware, record the documented PPG-unavailable
  state rather than treating it as a failed inference result.
- [ ] Sleep the Watch display while streaming. Confirm the foreground service continues
  raw sensor telemetry, then explicitly disconnect and confirm collection stops.
- [ ] Deliberately degrade/remove the required contact or sensor stream. Confirm the
  desktop quality/freshness gate rejects it and records the reason; it must not emit a
  gesture action.
- [ ] Confirm exported recordings retain raw source timestamps, session metadata, and
  the selected label ID (including an archived historical label when applicable).

## Model lifecycle, replay, and inference diagnostics

- [ ] Import recordings, inspect annotation quality and identity, and assign explicit
  training/test roles. Preserve original data and keep untouched evaluation sessions out
  of training and threshold selection.
- [ ] Train/evaluate each candidate label model. Record its ID, bundle digest, dataset
  identities, environment, event recall, false activations/hour, exposure duration and
  latency. Research-only or Monitor-only models must not be treated as deployable.
- [ ] Import the reviewed tree/CNN bundle; verify its hash, preprocessing contract,
  feature order, thresholds and quality rules through the importer. Reject a scratch copy
  with changed weights/hash, an unsupported format, or a malformed manifest.
- [ ] Approve and activate the candidate for its label, replay a managed recording, and
  compare results with labels before enabling actions. Confirm a failed load leaves the
  previous active model intact.
- [ ] Select **Monitor** and stream telemetry. Confirm model detections are diagnostic
  only and cannot start a recipe. For this check disable unrelated camera, button and
  rule-based recipes, which have their own activation controls.
- [ ] Let the model's required sensor history warm up. Verify missing contact, insufficient
  history, stream gaps and stale data prevent actionable detections and clear an active
  detection. PPG transport flush batches are not model windows: do not retrain or change
  flush rate to match the obsolete 500 ms batch-window rules.
- [ ] Restart after selecting Live: confirm the model runtime returns to **Monitor**,
  and the UI and behavior agree. Corrupt the registry only in a scratch profile and
  confirm the error is reported without silently replacing the file.
- [ ] Enable **Live** only after independent evaluation and Monitor acceptance. Verify
  only deployable active label detections can satisfy enabled recipe conditions and only
  the configured action runs. A Monitor-only model must never initiate that action.
- [ ] Switch to another approved model and roll back. Confirm model state is released
  and the selected version is loaded/validated before it supplies new detections.

## Interaction safety and failure handling

- [ ] Verify the dedicated Watch-button fallback can grab, adjust, and release volume
  without touching the Watch screen when model inference is Off.
- [ ] In Live mode, verify a positive gesture begins only its approved safe interaction,
  and a release ends it. Verify an unbound, negative/background, or calibration-only
  label takes no action.
- [ ] Stop Watch telemetry during an active interaction and repeat with stale samples,
  a Watch disconnect, and an inference/runtime failure. In each case, verify forced
  release/hide occurs and no additional volume change follows.
- [ ] *(remediation)* With a Watch-button grab active, trigger a model release (and the
  reverse): confirm one source's normal end does not end the other's interaction, and
  that a second source cannot take over an active grab. Confirm Escape, a Watch
  disconnect, and leaving the gaze target still end any grab.
- [ ] *(remediation)* Roll the wrist quickly through a large angle and confirm the volume
  follows no faster than the **Max volume rate**, with no jump on the first reading
  after the grab begins. Confirm haptic pulses stay rate-limited and a disconnected
  Watch produces no repeated errors.
- [ ] *(remediation)* On each platform, confirm Escape and Watch button-up remain
  responsive while the volume backend is slow (for example by saturating the audio
  service), and that quitting the app exits within about ten seconds of closing the
  window even with a stuck transport.
- [ ] *(performance)* On macOS, rotate the wrist through a large range while a model or the
  Watch button holds the grab, and confirm the volume follows the wrist without the overlay,
  the button release, or Monitor/Live decisions lagging. Volume writes are now applied by a
  dedicated writer thread (each `osascript` call takes 130-190 ms); confirm a release ends the
  change promptly and no volume write lands after the release or on the next grab.
- [ ] *(performance)* Open a long recording in the raw image viewer and scrub the slider and the
  prev/next controls: the first frame may take a moment, every later frame should be
  immediate. Delete the recording and confirm it disappears and no stale frame is served.
- [ ] *(performance)* Run a Timeline Capture past 200,000 rows (about an hour at typical
  rates) and confirm the saved recording is in row order and each interval still covers the
  rows it was drawn over.
- [ ] Reconnect the Watch. Confirm desktop-owned live settings are replayed, raw
  telemetry resumes, and no old grab/action state is resurrected.
- [ ] Disconnect Sony tracking during an overlay interaction and press Escape. Confirm
  the overlay hides and keyboard volume control is fail-closed while hidden.

## Platform adapters and package installation

- [ ] **macOS 14+:** grant Input Monitoring to Spatial Gesture Control itself (the
  native `crates/native-head-tracking` provider runs in-process; it is no longer a
  separate tracker binary), verify headset samples, verify the permission-denied /
  scanning / device-not-found / device-not-verified / feature-write-failed / error
  diagnostics surface correctly for their real triggering conditions (not just the
  synthetic events exercised by `crates/native-head-tracking/tests/ffi_macos.rs` and
  `apps/desktop/src-tauri/src/head_pose.rs`'s unit tests), verify reconnect and the
  reset-counter/recalibration path, verify `SONY_HEAD_TRACKER_PROVIDER=external`
  correctly falls back to the CLI bridge and its own Input Monitoring grant, and
  verify the macOS system-volume adapter reads and changes the selected test output
  with rate limiting. None of this has been exercised against a physical Sony
  headset in this repository's own testing; only the no-hardware CI job
  `native-head-tracking-macos` (`macos-14`) and code review have run so far.
- [ ] **Windows 11 x64:** verify the native `crates/native-head-tracking` provider
  (in-process, no separate tracker binary) discovers the headset over Bluetooth,
  verify the permission-denied / scanning / device-not-found / device-not-verified /
  feature-write-failed / error diagnostics surface correctly for their real
  triggering conditions (not just the synthetic events exercised by
  `crates/native-head-tracking/tests/ffi_windows.rs` and
  `apps/desktop/src-tauri/src/head_pose.rs`'s unit tests), verify reconnect and the
  reset-counter/recalibration path, verify Sony Head Tracker's documented Repair
  Tracker flow resolves a missing sensor node without this app performing any
  elevated action itself, verify `SONY_HEAD_TRACKER_PROVIDER=external` correctly
  falls back to the CLI bridge, and verify the Windows Core Audio volume adapter
  reads and changes the selected test output with rate limiting. None of this has
  been exercised against a physical Sony headset in this repository's own testing;
  only the no-hardware CI job `native-head-tracking-windows` (`windows-2022`) and
  code review have run so far.
- [ ] **Linux:** use the sample sender to validate UI/UDP behavior. The upstream Sony
  tracker has no Linux hardware backend; record that limitation. Verify the native
  volume adapter against PipeWire (`wpctl`) and, where used, its PulseAudio (`pactl`)
  fallback on the target distribution.
- [ ] Install the generated package on a clean host for each supported platform. Verify
  launch, launcher shutdown cleanup, firewall/permission prompts, and uninstall.
- [ ] Record unsigned/signing status and artifact hashes. Release publication, signing,
  ARM64 artifacts, and clean-host installation remain release gates beyond a successful
  CI package build.

## Drone control

Experimental, and not required for a release that does not offer it. See [Drone control](architecture/drone.md). Run with the
props off unless a row says otherwise, with the drone secured and its battery switch within reach. Record the drone's model and
firmware name.

- [ ] Joining the drone's Wi-Fi connects by itself, without arming, and Disconnect stays disconnected until Connect is chosen or
  the Wi-Fi is left.
- [ ] The firmware name and live video appear, and the marker follows when the drone is carried and returns.
- [ ] Calibrate gyro works on the ground, and is refused while armed.
- [ ] Arm, Take off and Land start and stop the motors from the app, and a flight recording appears.
- [ ] Hold position refuses on a drone that is held still, and centres the sticks.
- [ ] Closing the Drone page while armed tells the drone to land within about a second.
- [ ] Esc lands from any page while the window is focused.
- [ ] What the drone does when commands stop has been measured and recorded.
- [ ] With the props on, in open space: Climb, Descend and Land behave as expected, and Stop has been tried with the drone low.
- [ ] With the props on: hold starts, reduces drift, and hands back cleanly.

## Release decision

Do not call the candidate hardware-validated until every applicable checked item has
an attached result. A failed or unavailable device/platform is a release blocker for
that target, not evidence that the fail-closed desktop behavior was exercised.

**Open Wi-Fi security risk (REV-01):** over the **Wi-Fi** transport the Watch pairs and
streams over the LAN WebSocket without pairing-derived identity or an authenticated
session. A successful connectivity test does not clear this risk. Track its remediation in
[the project review](project-review-2026-11-06.md#rev-01--p1-authenticate-wi-fi-peers-before-accepting-telemetry-or-pairing)
and record the release decision explicitly; do not infer security acceptance from pairing success. The default **Bluetooth** transport adds OS bonding and an
explicit on-Watch approval of the desktop, but its Just Works bonding has no
man-in-the-middle protection (see the
[BLE transport doc](protocols/watch-ble-transport.md#known-limitations)).

Related references: [running the project](development/running-project.md),
[Watch setup](../apps/watch/README.md), [Watch protocol](protocols/watch-websocket-protocol.md),
[Watch BLE transport](protocols/watch-ble-transport.md),
[drone control](architecture/drone.md),
[components and deployment](architecture/components-and-deployment.md),
[safety and fail-closed behavior](architecture/safety-and-fail-closed-behavior.md),
[review remediation](review-remediation.md), and the
[project brief](architecture/project-brief.md).
