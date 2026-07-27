# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony WH-1000XM5 head orientation and, in later milestones, Samsung Galaxy Watch gestures.

This repository currently implements **Milestones 1 and 2** from [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md): the desktop foundation and Sony JSON UDP input. Watch communication, volume control, overlays, projector control, and pinch ML are intentionally out of scope until later milestones.

## Current capabilities

- Tauri 2 desktop shell with a React, TypeScript, and Vite frontend
- Structured Rust workspace with provider-independent protocol types
- Loopback-only Sony JSON UDP listener on `127.0.0.1:4243`
- Strongly typed protocol-v2 parser that ignores forward-compatible unknown fields
- Replaceable `HeadPoseProvider` interface and `SonyUdpHeadPoseProvider`
- Connection timeout and reset-counter change detection
- Tauri events carrying generic head poses to the frontend
- Live dashboard for device, yaw, pitch, roll, quaternion, gyroscope, packet rate, latency, and reset counter
- Structured `tracing` logs
- Unit and UDP integration tests
- Initial GitHub Actions quality and desktop build matrix

## Architecture

```text
sony-head-tracker JSON output
       │ UDP JSON (loopback:4243)
       ▼
SonyUdpHeadPoseProvider ──► HeadPose events ──► Tauri event bridge
       │                                            │
       ▼                                            ▼
connection/reset monitoring                  React diagnostics dashboard
```

Sony-specific wire types live in `crates/protocol`. They are converted immediately into a generic `HeadPose`, so calibration and future providers do not depend on Sony packet structures.

```text
apps/desktop/              React frontend + Tauri application
crates/protocol/           Shared Sony wire types and generic domain events
crates/head-tracking/      Provider abstraction, UDP listener, connection monitor
head-tracking/             Earlier interoperability and native-macOS experiments
```

## Prerequisites

- Node.js 20 or newer
- npm
- Current stable Rust toolchain
- [`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker) configured to emit JSON UDP packets on `127.0.0.1:4243`
- Tauri 2 system prerequisites for your OS

### Debian/Ubuntu Tauri packages

```bash
sudo apt update
sudo apt install -y   libwebkit2gtk-4.1-dev   libayatana-appindicator3-dev   librsvg2-dev   patchelf   pkg-config   libssl-dev
```

See the official Tauri prerequisites if your distribution uses different package names.

## Install and run

```bash
npm install
npm run tauri dev
```

Start the Sony bridge before or after the desktop application. The dashboard changes to **Connected** after the first valid protocol-v2 packet and returns to a waiting state when packets stop.

To exercise the input without headphones, send the included sample datagram:

```bash
python3 head-tracking/scripts/send_sample.py
```

## Test and build

```bash
# React component tests
npm test

# TypeScript and production frontend bundle
npm run typecheck
npm run build

# Rust protocol and UDP tests (does not require desktop GUI libraries)
cargo test -p spatial-protocol -p head-tracking

# Complete desktop build (requires Tauri OS packages)
npm run tauri build
```

## Event contract

The backend emits:

- `head-tracker-connection` — boolean connectivity state
- `head-pose-updated` — generic pose and diagnostics in camelCase
- `head-tracker-reset` — previous/current reset counters

The Sony socket is deliberately loopback-only. Unknown or malformed datagrams are logged and ignored; they never reach the UI.

## Scope discipline

The next planned milestone is head calibration. In accordance with the project brief, the watch-button interaction must work end to end before any pinch model is trained.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`head-tracking/THIRD_PARTY_NOTICES.md`](head-tracking/THIRD_PARTY_NOTICES.md) for related attribution.
