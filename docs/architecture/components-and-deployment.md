# Components and deployment

What runs where, how the pieces talk to each other, where state lives on disk,
and how each piece is built, tested and packaged. For the *why* behind the
desktop's safety behavior see
[Safety and fail-closed behavior](safety-and-fail-closed-behavior.md); for the
original design intent see the [project brief](project-brief.md).

## 1. The deployable pieces

| Component | Where | Runs on | Built with | Ships as |
| --- | --- | --- | --- | --- |
| **Desktop application** | `apps/desktop` (React/TS frontend) + `apps/desktop/src-tauri` (Rust backend) | macOS 14+, Windows 11 x64, Linux (development) | Tauri 2, Vite, Cargo | A Tauri bundle per OS (`npm run tauri -- build`) |
| **Galaxy Watch app** | `apps/watch` | Wear OS 3+ (API 30+), Galaxy Watch 4 or later for PPG | Gradle 9.5 / Kotlin, AGP 9.3 | An APK (sideloaded over adb) |
| **Sony head-tracker provider** | `crates/native-head-tracking` (in-process) or `tools/sony-head-tracker` (external CLI) | Same host as the desktop app | Cargo (native) / committed upstream prebuilds (external) | Linked into the desktop binary on macOS and Windows; separate process on Linux or with `SONY_HEAD_TRACKER_PROVIDER=external` |
| **Per-label trainer** | `tools/pinch-classifier` | A developer checkout with `uv` | Python 3.11+, optional PyTorch | **Not shipped.** Invoked by the desktop through `uv run`; requires a full repository checkout |

The watch and the headphones are **sensor sources only**. Training, inference,
policy decisions and every action run on the desktop.

### Rust workspace crates

| Crate | Responsibility |
| --- | --- |
| `spatial-protocol` (`crates/protocol`) | Sony wire types, the watch envelope/message types, generic pose types |
| `head-tracking` | Provider abstraction and the strict loopback UDP listener |
| `native-head-tracking` | In-process Sony provider: IOKit/IOBluetooth (macOS), HID/SetupAPI (Windows) |
| `interaction-engine` | Head calibration and dwell, wrist-rotation mapper, gesture policy state machine |
| `pinch-inference` | Telemetry fusion, the 55-feature extractor, the model trait, the LiteRT backend |
| `volume-control` | Native system-volume adapters (macOS, Windows Core Audio, Linux `wpctl`/`pactl`) |
| `watch-bridge` | The two watch transports (Wi-Fi WebSocket server, BLE central), framing, sequencing, time sync |
| `spatial-gesture-desktop` (`apps/desktop/src-tauri`) | The Tauri backend that wires all of the above together |

## 2. Runtime topology

```text
Sony headset ──HID/BLE──► head-tracker provider ──► ┐
                         (in-process on macOS/Win;  │
                          UDP 127.0.0.1:4243 else)  │
                                                    ▼
Galaxy Watch ──BLE (default) or Wi-Fi WebSocket──► Tauri backend (Rust)
  IMU + PPG + button                               │  calibration · fusion · features
  ◄── haptic / sensor / rate commands ──           │  model · gesture policy · overlay
                                                   │
                                  Tauri events/IPC ▼
                              React main window + overlay window
                                                   │
                                                   ▼
                                  volume-control ──► OS output volume
```

- **Watch transport.** Exactly one of two transports is live at a time, chosen
  in Settings (and mirrored on the watch). **Bluetooth LE is the default.** The
  watch is the GATT peripheral and the desktop the central; see
  [Watch BLE transport](../protocols/watch-ble-transport.md). Wi-Fi is the
  alternative: the desktop runs an Axum WebSocket server on `0.0.0.0:8766`
  (`/ws/watch`) and the watch finds it through mDNS; see
  [Watch WebSocket protocol](../protocols/watch-websocket-protocol.md). A failing
  transport never silently falls back to the other.
- **Message layer.** Both transports carry the same JSON envelopes
  (`type`, `version`, `deviceId`, `sequence`, `timestampNs`, `payload`) and share
  one decoder (`handle_inbound`) and one command encoder.
- **Device identity.** Over BLE the desktop derives the device id from the
  discovered peripheral and overrides any `deviceId` the watch claims; over
  Wi-Fi it uses the watch's own persisted per-install id. Per-device state (the
  PPG ordering watermark, orientation/PPG fusion identity) keys on that id.
- **Clocks.** Every watch envelope `timestampNs` is on the watch's
  `SystemClock.elapsedRealtimeNanos()` base (the watch verifies and rebases
  orientation if a device's sensor clock differs). Freshness and dwell decisions
  are always made on the **desktop's** own monotonic clock, never on a watch
  timestamp; the single exception is the wrist mapper's monotonicity and velocity
  window.
- **Windows.** The Tauri app has a `main` window and a transparent, borderless,
  always-on-top, non-focusable `overlay` window for the volume knob.
- **Loopback and listening ports.** Sony JSON arrives on `127.0.0.1:4243` only
  when the external bridge is in use (the bridge also emits OpenTrack on `4242`).
  The watch WebSocket binds `0.0.0.0:8766` while the Wi-Fi transport is selected;
  plain `ws://`, no TLS, no authentication, trusted-LAN only.

### Background tasks in the desktop backend

| Task | Cadence / trigger | Purpose |
| --- | --- | --- |
| Watch event loop | per watch event | Routes orientation, PPG, button, disconnect and invalid-message events to the overlay, the PPG ingest and the policy; stops on a closed channel |
| Gesture-policy watchdog | every 200 ms | Force-releases a held grab whose model data went stale (750 ms) |
| Time sync | every 5 s while connected | Estimates the watch/desktop clock offset (displayed only; never applied to samples) |
| BLE session loop | scan 20 s, retry 5 s | Scan, connect, wait for the watch's trust approval, stream |
| Head-pose provider | continuous | Feeds calibration and dwell |
| Wrist volume writer | on demand, paced to at least 100 ms between writes | A dedicated thread that applies the newest wrist-rotation volume target; keeps the blocking native call off the watch event loop |

## 3. Data at rest

All per-user state lives in the platform's Tauri app directories
(app data for datasets, models and recordings; app config for settings). The
identifier is `dev.meanotaku.spatial-gesture-control`.

| Path (under the app directory) | Contents | Written by |
| --- | --- | --- |
| `settings.json` (app config) | Validated settings: rates, wrist-rotation tuning, watch transport, demo toggles | `settings.rs`, atomic write |
| `recording/<id>/` | Immutable recording bundle: `raw.csv`, `recording.json`, `annotations.json` | `recording_bundle.rs`, staged then renamed |
| `model-lab/labels.json` | Label catalogue (stable ids, roles, archive state) | `label_registry.rs` |
| `model-lab/datasets/<id>.csv`, `index.json` | Imported training sessions and their index | `model_lab.rs` |
| `model-lab/models/<id>/` | A model bundle: `model.tflite`, `metadata.json`, `label_mapping.json`, `model_card.json` | The trainer, or an explicit bundle import |
| `model-lab/registry.json` | Model lifecycle state, thresholds, quality gates, intent bindings, active model, **inference mode** | `model_registry.rs`, atomic write |

Caches (memory only, never persisted): a bounded cache of parsed `raw.csv` columns (4 entries, keyed on the file's size and modification time and dropped when a recording is deleted) serves the raw-image viewer, so scrubbing does not re-parse the file on every step.

Integrity rules: a corrupt `registry.json` is an **error that leaves the file
untouched** (never an empty registry that the next write would persist); a model
bundle's digest and full contract are recomputed on activation, rollback and
every runtime load; a recording bundle is written once and never rewritten.

## 4. Build, run and package

| Task | Command | Notes |
| --- | --- | --- |
| Install | `npm ci` | Node 22.12+ in the 22 line (`.nvmrc`) |
| Run everything | `npm start` | `scripts/run-system.mjs`; one process on macOS/Windows, tracker + app on Linux or with the external provider |
| Tauri dev only | `npm run tauri -- dev` | |
| Frontend preview | `npm run dev --workspace @spatial-gesture/desktop` | No Rust, no IPC |
| Package desktop | `npm run tauri -- build` | One bundle for the current OS; run per platform |
| Package with LiteRT | `npm run package:litert` | Needs `LITERT_RUNTIME_TARGET`, `LITERT_RUNTIME_DIR`, `LITERT_RUNTIME_NOTICE_FILE`; see [LiteRT packaging](../release/litert-runtime-packaging.md) |
| Build the watch APK | `cd apps/watch && ./gradlew :app:assembleDebug` | Deploy over adb; see the [watch README](../../apps/watch/README.md) |

Environment variables: `SONY_HEAD_TRACKER_PROVIDER=external` (use the CLI
bridge on macOS/Windows), `SONY_HEAD_TRACKER_BIN` (use a specific tracker
executable), and the three `LITERT_*` variables above.

Cargo features: `litert-inference` on the desktop crate (and `litert` on
`pinch-inference`). **Off by default**; without it every model window fails
closed.

## 5. Tests and CI

| Suite | Command | Where it runs in CI |
| --- | --- | --- |
| Frontend, launcher, tauri config, icons | `npm test` | Both workflows |
| Typecheck, production build | `npm run typecheck`, `npm run build` | Both workflows |
| Rust format, clippy, tests | `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test` | `Desktop CI` runs the full workspace set including `watch-bridge` and `spatial-gesture-desktop` on Ubuntu, macOS 14 and Windows 2022 |
| LiteRT backend | `cargo test -p pinch-inference --features litert --locked --all-targets` | `Desktop CI` (Ubuntu) |
| Native head-tracking FFI | `cargo test -p native-head-tracking` | `CI` jobs on `macos-14` and `windows-2022` |
| Sony tracker compatibility | `uv run --directory tools/sony-head-tracker --with pytest pytest -q` | `CI` |
| Package build | `npm run tauri -- build` | `Desktop CI` package matrix and `CI` desktop-build matrix |
| Raw-CSV parse and cache timing probes | `cargo test --release -p spatial-gesture-desktop --lib perf_probes -- --ignored --nocapture` | Not run by default; see [Performance review](../performance.md) |
| **Trainer / replay (Python)** | `cd tools/pinch-classifier && uv run --with pytest pytest tests -q` | **Not in CI** |
| **Watch JVM unit tests** | `cd apps/watch && ./gradlew :app:testDebugUnitTest` | **Not in CI** |

The two suites marked *not in CI* are run by hand today. One test is
environment-sensitive: `native-head-tracking`'s `ffi_macos` smoke test
touches the macOS Bluetooth stack and can abort on a developer machine; it is
covered by the dedicated `macos-14` job instead.

A successful CI package build is **packaging evidence only**. It is not a signed
release, an install test, a cross-architecture build or a physical-device test.

## 6. What is and is not validated

Nothing in this repository has been validated against a physical Sony headset, a
physical Galaxy Watch, a platform volume backend on all three OSes, or a clean-host
install. The real-device gate is the
[release-readiness checklist](../release-readiness.md); the per-finding status of
the engineering review is in [Review remediation](../review-remediation.md).
