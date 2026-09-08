# Release-readiness acceptance checklist

This checklist is the real-device gate for a desktop release candidate. It supplements
automated tests; it does **not** claim that physical devices, platform volume backends,
or package installation have been validated. Record the release candidate commit, host
OS/architecture, device model/firmware, and outcome for every applicable row.

## Preconditions

- [ ] The working tree is the release candidate commit and `npm ci` completed.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `cargo fmt --all -- --check`,
  and `cargo test -p spatial-protocol -p head-tracking -p interaction-engine -p volume-control --all-targets` pass.
- [ ] Run the platform bundle command, `npm run tauri -- build`, on every release
  platform. CI's packaging matrix exercises Ubuntu x64, macOS ARM64-host, and Windows
  x64 tooling; it is not a signed-release, cross-architecture, or install test.
- [ ] For a LiteRT candidate, build the desktop with the `litert-inference` Cargo
  feature and have a reviewed, validated TFLite bundle with complete model-versioned
  safe intent bindings. The default build deliberately fails inference closed.
- [ ] Use an isolated test audio output and a test dataset. Do not enable Live on an
  unreviewed model or a production presentation/audio device.

## Watch raw-telemetry and quality gate

- [ ] Install the Watch app on a supported Galaxy Watch, place it and the desktop on
  the same non-isolated Wi-Fi/LAN, grant the documented permissions, and start the
  desktop app.
- [ ] Confirm mDNS pairing reaches **Connected** and the Watch connection card shows
  increasing sequence numbers, heartbeat, clock synchronization, and raw IMU data.
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
- [ ] Reconnect the Watch. Confirm desktop-owned live settings are replayed, raw
  telemetry resumes, and no old grab/action state is resurrected.
- [ ] Disconnect Sony tracking during an overlay interaction and press Escape. Confirm
  the overlay hides and keyboard volume control is fail-closed while hidden.

## Platform adapters and package installation

- [ ] **macOS 14+:** grant Input Monitoring to the pinned or reviewed Sony tracker,
  verify headset samples, and verify the macOS system-volume adapter reads and changes
  the selected test output with rate limiting.
- [ ] **Windows 11 x64:** verify the pinned tracker discovers the headset (use its
  documented Repair Tracker flow if needed), then verify the platform volume adapter
  changes the selected test output.
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

**Known, intentionally excluded risk:** the Watch pairs and streams over the LAN
WebSocket without pairing-derived identity or an authenticated session. This is not a
gap in the checklist above; it is an accepted, unrepaired risk that remains out of
scope for every release candidate until a dedicated remediation is scoped and
completed.

Related references: [running the project](development/running-project.md),
[Watch setup](../apps/watch/README.md), [Watch protocol](protocols/watch-websocket-protocol.md),
and the [project brief](architecture/project-brief.md).
