# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony headset orientation and, in later milestones, Samsung Galaxy Watch gestures.

The repository currently implements Milestones 1–4 from [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md): the desktop foundation, Sony JSON UDP input, head calibration, and the virtual volume knob. Sony Head Tracker remains a separate process, while one launcher starts and stops both applications together.

## Run the complete system

Install the JavaScript dependencies once:

```bash
npm ci
```

Then use one command on macOS 14+ or Windows 11 x64:

```bash
npm start
```

`npm start` runs `scripts/run-system.mjs`, which:

1. Selects the committed upstream v2.2.0 prebuild for macOS universal or Windows x64.
2. Opens the native Sony Head Tracker UI, which discovers the sensor and emits
   its protocol-v2 JSON stream on `127.0.0.1:4243` while open.
3. Starts the Tauri application.
4. Stops both process trees when either application exits or the launcher receives Ctrl+C.

After center and top-right calibration, hold your gaze on the top-right target for the configured dwell time. The dedicated volume overlay appears without taking focus. Use the arrow keys or `+`/`-` in the main window to simulate volume changes; leaving the target, losing Sony tracking, or pressing Escape hides it.

The tracker is deliberately not compiled into, bundled with, or owned by the Tauri binary. The launcher is only an operator convenience around two independent processes.

To use an existing or custom tracker build instead of the committed prebuild:

```bash
# macOS/Linux shell
SONY_HEAD_TRACKER_BIN=/absolute/path/to/SonyHeadTracker.app/Contents/MacOS/SonyHeadTracker npm start

# Windows PowerShell
$env:SONY_HEAD_TRACKER_BIN = "C:\absolute\path\sony-head-tracker.exe"
npm start
```

The override must open the Sony Head Tracker UI and stream JSON when launched
without command-line arguments.

## Current capabilities

- Tauri 2 desktop shell with a React, TypeScript, and Vite frontend
- Loopback-only Sony protocol-v2 JSON listener on `127.0.0.1:4243`
- Separate Sony Head Tracker process with one-command orchestration
- Committed upstream v2.2.0 tracker prebuilds for macOS universal and Windows x64
- Provider-neutral Rust pose types and `SonyUdpHeadPoseProvider`
- Strict schema validation, connection timeout, and reset-counter detection
- Live device, orientation, quaternion, gyroscope, packet-rate, and latency diagnostics
- Guided center/top-right quaternion calibration using `nalgebra`
- Adjustable activation threshold and dwell duration (400 ms by default)
- `head-target-entered` / `head-target-exited` events for calibrated targets
- Dedicated transparent, borderless, click-through, always-on-top volume overlay
- Automatic knob display when the calibrated top-right target activates
- Keyboard volume simulation with arrow or +/- keys, clamped from 0–100%
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
interaction-engine calibration + dwell detection + simulated volume
    │ target entered / exited events
    ▼
Tauri event bridge ──► React dashboard + dedicated volume overlay
```

Sony wire types are converted immediately into a generic `HeadPose`, so calibration and future providers do not depend on Sony packet structures.

```text
apps/desktop/              React frontend + Tauri application
crates/protocol/           Sony wire types and generic pose domain types
crates/head-tracking/      Provider abstraction and strict UDP listener
crates/interaction-engine/ Quaternion calibration and target dwell state
scripts/run-system.mjs     one-command external-process orchestrator
head-tracking/             compatibility tests, sample sender, and reference work
```

## Platform notes

### macOS

- Requires macOS 14 or newer for upstream Sony Head Tracker.
- Grant Input Monitoring to Sony Head Tracker from the committed
  `SonyHeadTracker.app`, then stop and rerun `npm start`.
- Tracker startup requires no download or build step.

### Windows x64

- Requires Windows 11 x64 and the usual Tauri C++/WebView2 prerequisites.
- The pinned upstream Windows artifact is x64-only; Windows ARM64 is not currently verified.
- If Windows has not created the headset sensor node, use the upstream tracker’s documented Repair Tracker flow, then rerun `npm start`.

### Linux

The Tauri app and UDP provider remain buildable, but upstream Sony Head Tracker does not provide a Linux hardware backend. Use the sample sender while developing:

```bash
npm run tauri -- dev
python3 head-tracking/scripts/send_sample.py
```

## Testing

```bash
npm test
npm run typecheck
npm run build
cargo test -p spatial-protocol -p head-tracking -p interaction-engine --all-targets
cargo clippy -p spatial-protocol -p head-tracking -p interaction-engine --all-targets --all-features -- -D warnings
```

For complete prerequisites, troubleshooting, build commands, and launcher details, see [`RUNNING_THE_PROJECT.txt`](RUNNING_THE_PROJECT.txt).

## Security and provenance

- Upstream: <https://github.com/NicholasSlattery/sony-head-tracker>
- Pinned launcher version: `2.2.0`
- Official upstream prebuilt executables and their license/documentation are
  committed under `assets/pre-builds/` and reviewed through normal Git history.
- Tracker telemetry stays on loopback.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`head-tracking/THIRD_PARTY_NOTICES.md`](head-tracking/THIRD_PARTY_NOTICES.md) for upstream attribution.
