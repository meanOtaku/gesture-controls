# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony headset orientation and Samsung Galaxy Watch input (wrist rotation, stem button, and a trainable pinch model).

The repository includes the desktop foundation, Sony JSON UDP input, head calibration, volume overlay, Galaxy Watch telemetry and wrist controls, dataset recording, and Model Lab training and deployment workflows. Platform volume adapters exist for macOS, Windows, and Linux; physical-device and release acceptance remain separate validation steps. On macOS and Windows, `npm start` runs the Sony head tracker in-process (see [`crates/native-head-tracking`](crates/native-head-tracking)); Linux still uses the background Sony Head Tracker CLI bridge, since upstream has no Linux hardware backend. The Tauri dashboard is the only tracker window on every platform.

## Run the complete system

Use Node.js 22.12 or newer in the Node 22 release line (see `.nvmrc`), then install the JavaScript dependencies once:

```bash
npm ci
```

### Model Lab first-run requirements

Open **Model Lab** after launching the desktop app to see local readiness checks for
the system-volume backend, optional desktop LiteRT inference, and the offline
training/replay runner. The checks do not send telemetry or inspect user data.

Training and replay deliberately remain development workflows, not bundled desktop
features. They require a complete repository checkout and
[uv](https://docs.astral.sh/uv/) on `PATH`; `uv` provisions the Python 3.11+ training
environment from `tools/pinch-classifier/pyproject.toml` when a job starts. TFLite
training also installs the package's TensorFlow optional dependency. The setup screen
will identify a missing runner and provides the exact remediation.

Desktop inference stays fail-closed unless the app is built with the
`litert-inference` Cargo feature, a validated TFLite bundle is active, and every
deployable class has a safe intent binding. It never runs on the Watch or headphones.

Then use one command on macOS 14+ or Windows 11 x64:

```bash
npm start
```

`npm start` runs `scripts/run-system.mjs`, which:

1. On macOS and Windows, skips the external tracker entirely: the in-process
   `native-head-tracking` provider owns Bluetooth/IOKit (macOS) or
   HID/SetupAPI (Windows) acquisition inside the Tauri binary. Setting
   `SONY_HEAD_TRACKER_PROVIDER=external` restores the old two-process
   behavior as a documented recovery fallback on either platform.
2. On Linux, selects the committed upstream v2.2.0 CLI bridge prebuild and
   starts it in the background. It discovers the sensor and emits its
   protocol-v2 JSON stream on `127.0.0.1:4243`. (Linux has no native provider
   -- upstream has no Linux hardware backend.)
3. Starts the Tauri application.
4. Stops every process it started when the application exits or the launcher
   receives Ctrl+C.

After center calibration and at least one other location (top right by default; you can add more and choose which one drives volume), hold your gaze on the volume-knob location for the configured dwell time. The dedicated volume overlay appears without taking focus. On macOS, use the arrow keys or `+`/`-` in the main window to change the real system output volume; leaving the target, losing Sony tracking, or pressing Escape hides it. Windows uses Core Audio; Linux uses PipeWire or PulseAudio command adapters. Each platform still requires device validation.

On Linux the external CLI tracker is deliberately not compiled into, bundled with, or owned by the Tauri binary; the launcher is an operator convenience around two independent processes. On macOS and Windows the native provider is linked directly into the Tauri binary instead, so `npm start` there is a single process unless `SONY_HEAD_TRACKER_PROVIDER=external` is set.

To use an existing or custom CLI tracker build instead of the committed prebuild (Linux, or macOS/Windows with the external fallback enabled):

```bash
# macOS/Linux shell
SONY_HEAD_TRACKER_BIN=/absolute/path/to/sony-head-tracker-macos npm start

# Windows PowerShell
$env:SONY_HEAD_TRACKER_BIN = "C:\absolute\path\sony-head-tracker.exe"
npm start
```

The override must be the upstream CLI executable; the launcher invokes it with
the `bridge` argument to stream JSON without opening a second window.

## Current capabilities

- Tauri 2 desktop shell with a React, TypeScript, and Vite frontend
- macOS and Windows: in-process native Sony head-tracker provider (`crates/native-head-tracking`), with typed permission/scanning/device diagnostics surfaced in the dashboard
- Linux: loopback-only Sony protocol-v2 JSON listener on `127.0.0.1:4243`, fed by a background CLI bridge with one-command orchestration and a single Tauri tracker UI
- `SONY_HEAD_TRACKER_PROVIDER=external` recovery fallback to the CLI bridge on macOS and Windows
- Committed upstream v2.2.0 tracker prebuilds for macOS universal and Windows x64
- Provider-neutral Rust pose types and `SonyUdpHeadPoseProvider`
- Strict schema validation, connection timeout, and reset-counter detection
- Live device, orientation, quaternion, gyroscope, packet-rate, and latency diagnostics
- Guided quaternion calibration of center plus any number of named locations, calibration using `nalgebra`
- Adjustable activation threshold and dwell duration (400 ms by default)
- `head-target-entered` / `head-target-exited` events for calibrated targets
- Dedicated transparent, borderless, click-through, always-on-top volume overlay
- Automatic knob display when the calibrated volume-knob location activates
- Keyboard control of real macOS system output volume with arrow or +/- keys, clamped from 0–100%
- Automatic recalibration prompt after Sony reference-frame resets
- Galaxy Watch telemetry (IMU orientation, raw PPG, health sensors, stem button) over **Bluetooth LE by default**, or over a local-network WebSocket; haptic confirmation back to the watch
- Wrist-rotation volume control with a Watch-button fallback: absolute angle-to-volume mapping, dead zone, velocity-outlier rejection, a volume-rate cap, and write throttling
- Dataset recording (Quick and Timeline Capture), a Model Lab for training and evaluating a pinch classifier (scikit-learn baseline or deployable TFLite), a model lifecycle with safe intent bindings, offline replay, and Off/Monitor/Live desktop inference
- Fail-closed safety behavior throughout; see [Safety and fail-closed behavior](docs/architecture/safety-and-fail-closed-behavior.md)
- React, Rust, UDP integration, launcher, Python trainer, Kotlin watch, and packaging tests

## Architecture

```text
Sony headset
    │ Android Head Tracker HID
    ▼
sony-head-tracker v2.2.0       separate process
    │ JSON UDP 127.0.0.1:4243
    ▼
SonyUdpHeadPoseProvider
    │ generic HeadPose events
    ▼
interaction-engine calibration + dwell detection
    │ target entered / exited events
    ▼
Tauri event bridge ──► React dashboard + dedicated volume overlay
    │
    ▼
volume-control trait ──► native system-volume adapter (macOS / Windows / Linux)
```

The Galaxy Watch and the model pipeline join at the desktop backend:

```text
Galaxy Watch ──BLE (default) or Wi-Fi WebSocket──► watch-bridge
    │ orientation · PPG · button                      │ decode, sequence, device identity
    ▼                                                 ▼
                          pinch-inference: fuse ► features ► model (LiteRT)
                                                      │ transition
                                                      ▼
                          interaction-engine gesture policy (Off / Monitor / Live)
                                                      │ decision
                                                      ▼
                              overlay grab / release ► volume-control
```

For what runs where, ports, on-disk state, packaging and CI, see
[Components and deployment](docs/architecture/components-and-deployment.md).

On macOS and Windows, `crates/native-head-tracking` replaces the first two
stages above: IOKit/IOBluetooth (macOS) or HID/SetupAPI (Windows) samples are
converted to the same generic `HeadPose` inside the Tauri process, with no
external tracker and no UDP hop, unless `SONY_HEAD_TRACKER_PROVIDER=external`
restores the diagram above as a fallback. Sony wire types are converted
immediately into a generic `HeadPose` either way, so calibration does not
depend on Sony packet structures.

```text
apps/desktop/              React frontend + Tauri application (src-tauri/ is the Rust backend)
apps/watch/                Wear OS (Galaxy Watch) client: Kotlin, standalone Gradle project
crates/protocol/           Sony wire types, watch message types, and generic pose domain types
crates/head-tracking/      Provider abstraction and strict UDP listener
crates/interaction-engine/ Quaternion calibration, target dwell, wrist-rotation mapper, gesture policy
crates/pinch-inference/    Telemetry fusion, feature extraction, model trait, and LiteRT inference
crates/volume-control/     Normalized controller trait; macOS, Windows, and Linux adapters
crates/watch-bridge/       Galaxy Watch transports: Bluetooth LE central and Wi-Fi WebSocket server
crates/native-head-tracking/ In-process macOS/Windows Sony provider (IOKit/IOBluetooth or HID/SetupAPI FFI + conversion)
scripts/                   run-system.mjs launcher, LiteRT packaging, config checks
tools/pinch-classifier/    Python training, export, and offline replay (development workflow, not shipped)
tools/sony-head-tracker/   compatibility tests, sample sender, committed upstream prebuilds
third_party/               vendored Sony head-tracker engine sources and notices
vendor/                    vendored Samsung Health Sensor SDK (watch app)
docs/                      user guide, architecture, protocols, decisions, release checklist
```

The desktop serves one Galaxy Watch at a time over one of two transports, chosen
in Settings:

- **Bluetooth LE (the default).** The watch is the GATT peripheral and the desktop
  scans for its service, connects, and subscribes. The watch holds an explicit
  "Trust this computer" gate, so nothing streams until you approve the desktop on
  the watch. See [`docs/protocols/watch-ble-transport.md`](docs/protocols/watch-ble-transport.md).
- **Wi-Fi.** The desktop listens at `ws://DESKTOP_IP:8766/ws/watch` and the watch
  finds it with local mDNS/DNS-SD; the desktop can also ask the watch to connect
  without either device typing an IP. Plain `ws://`, trusted LAN only.

Both carry the same versioned JSON messages, documented in
[`docs/protocols/watch-websocket-protocol.md`](docs/protocols/watch-websocket-protocol.md).
Over Bluetooth the desktop identifies the watch from the peripheral it discovered
rather than from anything the watch claims. The dashboard publishes connection, IMU,
heartbeat, and clock-synchronization status. The Wear OS client lives in
[`apps/watch/`](apps/watch/README.md), a standalone Gradle project.

## Platform notes

### macOS

- Requires macOS 14 or newer. `npm start` and the packaged app run the native
  provider in-process; no separate tracker executable is started or needs
  Input Monitoring granted to it.
- Grant Input Monitoring to **Spatial Gesture Control itself** (System
  Settings -> Privacy & Security -> Input Monitoring), then quit and reopen
  the app. Until granted, the dashboard shows a "Input Monitoring permission
  needed" diagnostic instead of connecting.
- Because CI and local development builds are unsigned/ad-hoc-signed, macOS
  can ask for the permission again after a rebuild that changes the binary's
  signature; a stable, signed release build avoids repeat prompts.
- If native acquisition fails outright (`native-head-tracking-macos` CI job,
  or a local build issue), set `SONY_HEAD_TRACKER_PROVIDER=external` to fall
  back to the CLI bridge documented above as a recovery path, then rerun
  `npm start`.
- No download or separate build step is required for the native path; the
  vendored engine sources build as part of `cargo build`/`npm start`.

### Windows x64

- Requires Windows 11 x64 and the usual Tauri C++/WebView2 prerequisites.
- `npm start` and the packaged app run the native provider in-process by
  default; no separate tracker executable is started. Setting
  `SONY_HEAD_TRACKER_PROVIDER=external` restores the old two-process CLI
  bridge behavior as a documented recovery fallback.
- The native provider is x64-only, matching the pinned upstream Windows
  artifact; Windows ARM64 is not currently verified.
- If Windows has not created the headset sensor node (surfaced in the
  dashboard as a "Head tracker device access denied" diagnostic), follow Sony
  Head Tracker's documented Repair Tracker flow yourself, then rerun
  `npm start`. Spatial Gesture Control never performs elevated driver repair
  on its own.
- No download or separate build step is required for the native path; the
  vendored engine sources build as part of `cargo build`/`npm start`.
- No physical Windows hardware was available to validate this provider
  end-to-end; only no-hardware CI smoke tests
  (`native-head-tracking-windows`) and code review have run so far. See
  [`docs/release-readiness.md`](docs/release-readiness.md).

### Linux

The Tauri app and UDP provider remain buildable, but upstream Sony Head Tracker does not provide a Linux hardware backend. Use the sample sender while developing:

```bash
npm run tauri -- dev
python3 tools/sony-head-tracker/scripts/send_sample.py
```

## Testing

```bash
npm test
npm run typecheck
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd tools/pinch-classifier && uv run --with pytest pytest tests -q)
(cd apps/watch && ./gradlew :app:testDebugUnitTest)
```

The Python trainer and the watch's Gradle unit tests are not run by CI yet; run
them locally. `native-head-tracking`'s `ffi_macos` smoke test touches the macOS
Bluetooth stack and can abort on a developer machine; CI runs it on a dedicated
`macos-14` job.

For complete prerequisites, troubleshooting, build commands, and launcher details, see [`docs/development/running-project.md`](docs/development/running-project.md).

## Documentation

Start at [`docs/README.md`](docs/README.md). The most useful entry points:
[using the application](docs/using-the-application.md),
[components and deployment](docs/architecture/components-and-deployment.md),
[safety and fail-closed behavior](docs/architecture/safety-and-fail-closed-behavior.md),
the [release-readiness checklist](docs/release-readiness.md), and the status of the
engineering review findings in [`docs/review-remediation.md`](docs/review-remediation.md).

## Security and provenance

- Upstream: <https://github.com/NicholasSlattery/sony-head-tracker>
- Pinned launcher version: `2.2.0`
- Official upstream prebuilt executables and their license/documentation are
  committed under `tools/sony-head-tracker/prebuilds/` and reviewed through normal Git history.
- Tracker telemetry stays on loopback.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`tools/sony-head-tracker/THIRD_PARTY_NOTICES.md`](tools/sony-head-tracker/THIRD_PARTY_NOTICES.md) for the external-bridge fallback attribution and [`third_party/sony-head-tracker/THIRD_PARTY_NOTICES.md`](third_party/sony-head-tracker/THIRD_PARTY_NOTICES.md) for the vendored native engine/bridge sources (see [`crates/native-head-tracking`](crates/native-head-tracking)).
