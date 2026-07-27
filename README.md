# Spatial Gesture Control

A cross-platform Tauri 2 desktop coordinator for spatial controls using Sony WH-1000XM5 head orientation and, in later milestones, Samsung Galaxy Watch gestures.

This repository currently implements **Milestones 1 and 2** from [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md): the desktop foundation and a Tauri-owned Sony head tracker. Watch communication, volume control, overlays, projector control, and pinch ML are intentionally out of scope until later milestones.

## Current capabilities

- Tauri 2 desktop shell with a React, TypeScript, and Vite frontend
- Sony tracking engine compiled into the Tauri process—no separately launched tracker app or sidecar
- Descriptor-verified Android Head Tracker HID discovery on Windows 11 and macOS 14+
- Windows HID with Sensor API fallback and macOS IOHID platform adapters
- Safe Rust wrapper over a narrow callback-only native ABI
- Replaceable `HeadPoseProvider` interface with Tauri-owned startup, reconnect, recenter, and shutdown
- Compatibility-only Sony JSON protocol-v2 UDP provider for tests and simulation
- Connection, permission, unsupported-platform, timeout, and reset-counter status reporting
- Tauri events carrying generic head poses to the frontend
- Live dashboard for device, yaw, pitch, roll, quaternion, gyroscope, packet rate, latency, and reset counter
- Structured `tracing` logs
- Unit, lifecycle, ABI, and UDP compatibility tests
- GitHub Actions quality and desktop build matrix

## Architecture

```text
Sony headphones
       │ Android Head Tracker HID protocol
       ▼
Native Sony engine (inside the Tauri process)
       │ callback-only C ABI
       ▼
SonyDirectHeadPoseProvider ──► HeadPose events ──► Tauri event bridge
       │                                                   │
       ▼                                                   ▼
discovery/reconnect/reset monitoring              React diagnostics dashboard
```

The native engine is derived from the MIT-licensed [`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker) v2.2.0 implementation and pinned to the upstream commit recorded under `third_party/sony-head-tracker/`. It is compiled as a static library; the upstream GUI, CLI bridge, UDP output, and branding are not bundled.

Native samples are converted immediately into the generic `HeadPose` type, so calibration and future providers do not depend on Sony HID or JSON structures.

```text
apps/desktop/                 React frontend + Tauri application
crates/protocol/              Shared compatibility wire types and generic domain events
crates/head-tracking/         Provider abstraction, direct provider, compatibility UDP provider
crates/sony-head-tracker-sys/ Safe Rust wrapper and native build boundary
third_party/sony-head-tracker/ Pinned MIT-licensed native source subset
head-tracking/                Compatibility simulator and earlier native experiments
```

## Platform status

- **Windows 11:** built-in direct tracking through the Windows HID backend with Sensor API fallback.
- **macOS 14+:** built-in direct tracking through IOHID. Input Monitoring permission is required and surfaced by the app.
- **Linux:** the desktop app builds and runs, but direct Sony hardware acquisition is reported as unsupported until a Linux backend is validated with physical hardware. The compatibility simulator remains available for development.

## Prerequisites

- Node.js 20 or newer
- npm
- Current stable Rust toolchain
- A C++20 compiler supplied by the normal Tauri platform prerequisites
- Tauri 2 system prerequisites for your OS
- A compatible, paired Sony headset for live hardware tracking

No separate `sony-head-tracker` installation or process is required.

### Debian/Ubuntu Tauri packages

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  pkg-config \
  libssl-dev
```

See the official Tauri prerequisites if your distribution uses different package names.

## Install and run

For complete Windows, macOS, and Linux setup instructions, see [`RUNNING_THE_PROJECT.txt`](RUNNING_THE_PROJECT.txt).

```bash
npm install
npm run tauri dev
```

Pair and connect the supported Sony headset, then launch this application. The built-in provider discovers and manages the tracker automatically. Use **Recenter** while facing forward.

To exercise the compatibility input without headphones, explicitly select the simulator source and send the included sample datagram:

```bash
SGC_HEAD_TRACKER_SOURCE=udp npm run tauri dev
python3 head-tracking/scripts/send_sample.py
```

On Windows PowerShell, set the environment variable with:

```powershell
$env:SGC_HEAD_TRACKER_SOURCE = "udp"
npm run tauri dev
py head-tracking\scripts\send_sample.py
```

## Test and build

```bash
# React component tests and packaging configuration checks
npm test

# TypeScript and production frontend bundle
npm run typecheck
npm run build

# Rust protocol, provider, native-wrapper, and compatibility tests
cargo test --workspace

# Complete desktop build (requires Tauri OS packages)
npm run tauri build
```

## Event contract

The backend emits:

- `head-tracker-status` — native runtime state, message, and optional device
- `head-tracker-connection` — boolean connectivity state retained for compatibility
- `head-pose-updated` — generic pose and diagnostics in camelCase
- `head-tracker-reset` — previous/current reset counters

The webview never receives raw HID handles or unrestricted native access. The optional compatibility socket is loopback-only; malformed datagrams are logged and ignored.

## Scope discipline

The next planned milestone is head calibration. In accordance with the project brief, the watch-button interaction must work end to end before any pinch model is trained.

## License

MIT. This is an unofficial project and is not affiliated with or endorsed by Sony or Samsung. See [`head-tracking/THIRD_PARTY_NOTICES.md`](head-tracking/THIRD_PARTY_NOTICES.md) and the vendored license/provenance files for attribution.
