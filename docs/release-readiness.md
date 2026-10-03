# Release-readiness acceptance checklist

This checklist is the real-device gate for a desktop release candidate. It supplements
automated tests; it does **not** claim that physical devices, platform volume backends,
or package installation have been validated. Record the release candidate commit, host
OS/architecture, device model/firmware, and outcome for every applicable row.

## Preconditions

- [ ] The working tree is the release candidate commit and `npm ci` completed.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`
  pass. Also run the two suites CI does not: the trainer
  (`cd tools/pinch-classifier && uv run --with pytest pytest tests -q`) and the
  watch (`cd apps/watch && ./gradlew :app:testDebugUnitTest`). If
  `native-head-tracking`'s `ffi_macos` smoke test aborts locally, confirm the
  `macos-14` CI job passes it instead.
- [ ] Run the platform bundle command, `npm run tauri -- build`, on every release
  platform. CI's packaging matrix exercises Ubuntu x64, macOS ARM64-host, and Windows
  x64 tooling; it is not a signed-release, cross-architecture, or install test.
- [ ] For a LiteRT candidate, build the desktop with the `litert-inference` Cargo
  feature and have a reviewed, validated TFLite bundle with complete model-versioned
  safe intent bindings. Use only the `npm run package:litert` entrypoint and
  its reviewed, target-native runtime inputs; see
  [LiteRT desktop runtime packaging](release/litert-runtime-packaging.md).
  The default build deliberately fails inference closed.
- [ ] Use an isolated test audio output and a test dataset. Do not enable Live on an
  unreviewed model or a production presentation/audio device.

**Status update (engineering-review remediation):** the findings in
`.hermes/reviews/` were addressed in code with automated tests; see
[Review remediation](review-remediation.md) for each finding's status. That work
changed behavior this checklist must now confirm on real hardware: the rows marked
*(remediation)* below. None of them has been exercised on a physical watch,
headset or audio backend.

**Status of this checklist as of GC-004:** GC-004 supplies source/configuration
for intentional feature-enabled LiteRT packaging, but no native runtime was
provided and no LiteRT package was created. Native-loader behavior, package
contents, signing, clean-host installation, model execution, safety behavior,
CI, and physical-device results are all **DEFERRED / NOT CLEARED**. The
async-feedback layer
(pending button states plus success/info/warning/error toasts), contextual help
tooltips, and the native CSV save dialog described below have been exercised only
through the automated frontend test suite and manual testing on Linux development
hardware. No macOS or Windows host was available in the environment that produced
this change, so the macOS- and Windows-specific rows in this checklist remain
unexecuted and are not being claimed as passed.

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

- [ ] In Model Lab, import a labeled dataset and check label coverage, roles, metadata,
  and archived-label history before training.
- [ ] Train/evaluate the candidate; inspect false-positive and quality results. Promote
  only through Draft → Evaluated → Approved, and record the model ID and bundle digest.
- [ ] Create/verify every deployable class's versioned binding. Bind only the offered
  safe intents (or no action); labels must never represent arbitrary desktop commands.
- [ ] Activate the reviewed bundle, then run offline replay on a managed dataset.
  Preserve the bounded replay report and compare the displayed decisions with expected
  labels before enabling any live control.
- [ ] Select **Monitor** and replay/live-stream telemetry. Confirm diagnostics record
  accepted/rejected decisions while no desktop volume or other action occurs.
  Check each window's diagnostics for a **window mismatch**: the live PPG window
  duration must be within 25% of the `window_ms` the bundle was trained on. The
  default 1 Hz Watch PPG flush gives roughly 960 ms windows, so a default 500 ms
  bundle will show a mismatch and **Live will refuse to start** until the PPG flush
  rate is aligned (about 2 Hz for 500 ms) or the model is retrained with a matching
  `--window-ms`. A bundle's `min_samples_per_window` is also enforced live.
- [ ] *(remediation)* Record the live PPG window duration the diagnostics show and the
  model's trained window. Confirm Live is refused with the actionable message while
  they disagree, and accepted once the flush rate (or the model) is aligned.
- [ ] *(remediation)* Quit and relaunch with Live selected: confirm the app starts in
  **Monitor** (not Live) and that the UI and the actual behavior agree.
- [ ] *(remediation)* Import a Timeline Capture dataset export: confirm it imports,
  that every label on it needs a training role before training starts, and that
  offline replay scores a user-defined target label as that target (not negative).
- [ ] *(remediation)* Import a hand-edited bundle with its conversion-parity record
  removed (or a one-sample minimum window): confirm it is rejected. Corrupt
  `registry.json` on a scratch profile: confirm the app reports an error and leaves
  the file untouched.
- [ ] Select **Live** only after the Monitor result is accepted. Confirm diagnostics
  identify the active model and each decision's intent/reason, and confirm only the
  approved binding is eligible to act.
- [ ] Switch to a previously approved model and then roll back. Confirm the active
  model and bindings change atomically, with no decision accepted from an incomplete
  or invalid bundle.

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

## Release decision

Do not call the candidate hardware-validated until every applicable checked item has
an attached result. A failed or unavailable device/platform is a release blocker for
that target, not evidence that the fail-closed desktop behavior was exercised.

**Known, intentionally excluded risk:** over the **Wi-Fi** transport the Watch pairs and
streams over the LAN WebSocket without pairing-derived identity or an authenticated
session. This is not a gap in the checklist above; it is an accepted, unrepaired risk
that remains out of scope for every release candidate until a dedicated remediation is
scoped and completed. The default **Bluetooth** transport adds OS bonding and an
explicit on-Watch approval of the desktop, but its Just Works bonding has no
man-in-the-middle protection (see the
[BLE transport doc](protocols/watch-ble-transport.md#known-limitations)).

Related references: [running the project](development/running-project.md),
[Watch setup](../apps/watch/README.md), [Watch protocol](protocols/watch-websocket-protocol.md),
[Watch BLE transport](protocols/watch-ble-transport.md),
[components and deployment](architecture/components-and-deployment.md),
[safety and fail-closed behavior](architecture/safety-and-fail-closed-behavior.md),
[review remediation](review-remediation.md), and the
[project brief](architecture/project-brief.md).
