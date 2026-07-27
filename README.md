# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony headset orientation and, in later milestones, Samsung Galaxy Watch gestures.

The repository currently implements Milestones 1 and 2 from [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md): the desktop foundation and the Sony JSON UDP input. Sony Head Tracker remains a separate process, while one launcher starts and stops both applications together.

## Run the complete system

Install the JavaScript dependencies once:

```bash
npm ci
```

Then use one command on macOS 14+ or Windows 11:

```bash
npm start
```

`npm start` runs `scripts/run-system.mjs`, which:

1. Locates Sony Head Tracker or downloads the pinned upstream v2.2.0 release on first use.
2. Verifies the release archive against a hard-coded SHA-256 digest before extraction.
3. Stores the ignored tool under `.tools/sony-head-tracker/v2.2.0/` so its macOS permission identity and path remain stable.
4. Runs the tracker's read-only `probe`; if no verified sensor is available, it
   keeps the diagnostics visible and does not start Tauri.
5. Starts the external tracker in `bridge --port 4242` mode; its protocol-v2
   JSON stream is therefore sent to `127.0.0.1:4243`.
6. Starts the Tauri application.
7. Stops both process trees when either application exits or the launcher receives Ctrl+C.

The tracker is deliberately not compiled into, bundled with, or owned by the Tauri binary. The launcher is only an operator convenience around two independent processes.

To use an existing or custom tracker build instead of the pinned download:

```bash
# macOS/Linux shell
SONY_HEAD_TRACKER_BIN=/absolute/path/to/sony-head-tracker-macos npm start

# Windows PowerShell
$env:SONY_HEAD_TRACKER_BIN = "C:\absolute\path\sony-head-tracker.exe"
npm start
```

The override must be an executable that supports `bridge --port 4242`.

## Current capabilities

- Tauri 2 desktop shell with a React, TypeScript, and Vite frontend
- Loopback-only Sony protocol-v2 JSON listener on `127.0.0.1:4243`
- Separate Sony Head Tracker process with one-command orchestration
- Pinned, checksum-verified automatic tracker setup for macOS and Windows
- Provider-neutral Rust pose types and `SonyUdpHeadPoseProvider`
- Strict schema validation, connection timeout, and reset-counter detection
- Live device, orientation, quaternion, gyroscope, packet-rate, and latency diagnostics
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
Tauri event bridge ──► React diagnostics dashboard
```

Sony wire types are converted immediately into a generic `HeadPose`, so calibration and future providers do not depend on Sony packet structures.

```text
apps/desktop/              React frontend + Tauri application
crates/protocol/           Sony wire types and generic pose domain types
crates/head-tracking/      Provider abstraction and strict UDP listener
scripts/run-system.mjs     one-command external-process orchestrator
head-tracking/             compatibility tests, sample sender, and reference work
```

## Platform notes

### macOS

- Requires macOS 14 or newer for upstream Sony Head Tracker.
- Grant Input Monitoring to the stable CLI under `.tools/sony-head-tracker/v2.2.0/`, then stop and rerun `npm start`.
- The first download may require network access; later runs use the verified local copy.

### Windows

- Requires Windows 11 and the usual Tauri C++/WebView2 prerequisites.
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
cargo test -p spatial-protocol -p head-tracking --all-targets
cargo clippy -p spatial-protocol -p head-tracking --all-targets --all-features -- -D warnings
```

For complete prerequisites, troubleshooting, build commands, and launcher details, see [`RUNNING_THE_PROJECT.txt`](RUNNING_THE_PROJECT.txt).

## Security and provenance

- Upstream: <https://github.com/NicholasSlattery/sony-head-tracker>
- Pinned launcher version: `2.2.0`
- Downloads use the official GitHub release assets and are accepted only when their SHA-256 matches the digest committed in `scripts/run-system.mjs`.
- Tracker telemetry stays on loopback.
- Downloaded tools and archives are excluded from Git.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`head-tracking/THIRD_PARTY_NOTICES.md`](head-tracking/THIRD_PARTY_NOTICES.md) for upstream attribution.
