# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony headset orientation and, in later milestones, Samsung Galaxy Watch gestures.

The repository includes the desktop foundation, Sony JSON UDP input, head calibration, volume overlay, Galaxy Watch telemetry and wrist controls, dataset recording, and Model Lab training and deployment workflows. Platform volume adapters exist for macOS, Windows, and Linux; physical-device and release acceptance remain separate validation steps. On macOS, `npm start` runs the Sony head tracker in-process (see [`crates/native-head-tracking`](crates/native-head-tracking)); Windows and Linux still use the background Sony Head Tracker CLI bridge, and the Tauri dashboard is the only tracker window on every platform.

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

1. On macOS, skips the external tracker entirely: the in-process
   `native-head-tracking` provider owns Bluetooth/IOKit acquisition inside the
   Tauri binary. Setting `SONY_HEAD_TRACKER_PROVIDER=external` restores the old
   two-process behavior as a documented recovery fallback.
2. On Windows and Linux, selects the committed upstream v2.2.0 CLI bridge
   prebuild and starts it in the background. It discovers the sensor and
   emits its protocol-v2 JSON stream on `127.0.0.1:4243`.
3. Starts the Tauri application.
4. Stops every process it started when the application exits or the launcher
   receives Ctrl+C.

After center and top-right calibration, hold your gaze on the top-right target for the configured dwell time. The dedicated volume overlay appears without taking focus. On macOS, use the arrow keys or `+`/`-` in the main window to change the real system output volume; leaving the target, losing Sony tracking, or pressing Escape hides it. Windows uses Core Audio; Linux uses PipeWire or PulseAudio command adapters. Each platform still requires device validation.

On Windows and Linux the external CLI tracker is deliberately not compiled into, bundled with, or owned by the Tauri binary; the launcher is an operator convenience around two independent processes. On macOS the native provider is linked directly into the Tauri binary instead, so `npm start` there is a single process unless `SONY_HEAD_TRACKER_PROVIDER=external` is set.

To use an existing or custom CLI tracker build instead of the committed prebuild (Windows/Linux, or macOS with the external fallback enabled):

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
- macOS: in-process native Sony head-tracker provider (`crates/native-head-tracking`), with typed permission/scanning/device diagnostics surfaced in the dashboard
- Windows/Linux: loopback-only Sony protocol-v2 JSON listener on `127.0.0.1:4243`, fed by a background CLI bridge with one-command orchestration and a single Tauri tracker UI
- `SONY_HEAD_TRACKER_PROVIDER=external` recovery fallback to the CLI bridge on macOS
- Committed upstream v2.2.0 tracker prebuilds for macOS universal and Windows x64
- Provider-neutral Rust pose types and `SonyUdpHeadPoseProvider`
- Strict schema validation, connection timeout, and reset-counter detection
- Live device, orientation, quaternion, gyroscope, packet-rate, and latency diagnostics
- Guided center/top-right quaternion calibration using `nalgebra`
- Adjustable activation threshold and dwell duration (400 ms by default)
- `head-target-entered` / `head-target-exited` events for calibrated targets
- Dedicated transparent, borderless, click-through, always-on-top volume overlay
- Automatic knob display when the calibrated top-right target activates
- Keyboard control of real macOS system output volume with arrow or +/- keys, clamped from 0–100%
- Automatic recalibration prompt after Sony reference-frame resets
- React, Rust, UDP integration, launcher, Python compatibility, and packaging tests

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
volume-control trait ──► macOS AppleScript system-volume adapter
```

On macOS, `crates/native-head-tracking` replaces the first two stages above:
IOKit/IOBluetooth samples are converted to the same generic `HeadPose` inside
the Tauri process, with no external tracker and no UDP hop, unless
`SONY_HEAD_TRACKER_PROVIDER=external` restores the diagram above as a
fallback. Sony wire types are converted immediately into a generic `HeadPose`
either way, so calibration does not depend on Sony packet structures.

```text
apps/desktop/              React frontend + Tauri application
crates/protocol/           Sony wire types and generic pose domain types
crates/head-tracking/      Provider abstraction and strict UDP listener
crates/interaction-engine/ Quaternion calibration and target dwell state
crates/pinch-inference/    Desktop-side pinch feature extraction and LiteRT inference
crates/volume-control/      Normalized controller trait and macOS adapter
crates/watch-bridge/        Local-network Galaxy Watch WebSocket intake
crates/native-head-tracking/ In-process macOS Sony provider (IOKit/IOBluetooth FFI + conversion)
scripts/run-system.mjs     one-command external-process orchestrator (Windows/Linux tracker, or macOS external fallback)
tools/sony-head-tracker/   compatibility tests, sample sender, and reference work
```

The desktop listens for one Galaxy Watch client at `ws://DESKTOP_IP:8766/ws/watch`.
The desktop and watch automatically discover each other with local mDNS/DNS-SD;
the desktop can request the watch to connect without either device typing an IP.
It publishes connection, IMU, heartbeat, and clock-synchronization status in the
dashboard. The versioned message contract is documented in
[`docs/protocols/watch-websocket-protocol.md`](docs/protocols/watch-websocket-protocol.md). The Wear OS
client that implements this protocol lives in
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
- The pinned upstream Windows artifact is x64-only; Windows ARM64 is not currently verified.
- If Windows has not created the headset sensor node, use the upstream tracker’s documented Repair Tracker flow, then rerun `npm start`.

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
cargo test -p spatial-protocol -p head-tracking -p interaction-engine -p volume-control -p pinch-inference -p watch-bridge --all-targets
cargo clippy -p spatial-protocol -p head-tracking -p interaction-engine -p volume-control -p pinch-inference -p watch-bridge --all-targets -- -D warnings
```

For complete prerequisites, troubleshooting, build commands, and launcher details, see [`docs/development/running-project.md`](docs/development/running-project.md).

## Security and provenance

- Upstream: <https://github.com/NicholasSlattery/sony-head-tracker>
- Pinned launcher version: `2.2.0`
- Official upstream prebuilt executables and their license/documentation are
  committed under `tools/sony-head-tracker/prebuilds/` and reviewed through normal Git history.
- Tracker telemetry stays on loopback.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`tools/sony-head-tracker/THIRD_PARTY_NOTICES.md`](tools/sony-head-tracker/THIRD_PARTY_NOTICES.md) for the external-bridge fallback attribution and [`third_party/sony-head-tracker/THIRD_PARTY_NOTICES.md`](third_party/sony-head-tracker/THIRD_PARTY_NOTICES.md) for the vendored native engine/bridge sources (see [`crates/native-head-tracking`](crates/native-head-tracking)).
