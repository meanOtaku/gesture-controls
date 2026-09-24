# Watch-to-desktop transport: Wi-Fi (current) vs. BLE (deferred)

**Status:** Accepted — Wi-Fi stays the transport for GC-036 and until the criteria below are met.
**Scope:** `crates/watch-bridge` (desktop WebSocket server) and the watch app's `WatchLinkManager`/`DesktopDiscovery`/`WatchPairingServer`. No transport code changes are implied by this record.

## Current transport

The Watch and desktop connect over local Wi-Fi: the desktop runs a WebSocket
server (`crates/watch-bridge`, bound to `0.0.0.0:8766`), and the watch either
discovers it via mDNS-style broadcast (`DesktopDiscovery`) or connects to a
persisted/desktop-initiated endpoint (`WatchPairingServer`,
`ConnectionPrefs`). This is unchanged by this optimization pass.

## Why Bluetooth (BLE) is not adopted here

BLE was raised as a possible way to cut Wear OS battery draw by replacing the
Wi-Fi radio's continuous-association cost with BLE's lower idle/active power
profile. It is **explicitly deferred**, not rejected, because none of the
following exist yet and each is a real engineering and trust-boundary
project, not a drop-in swap:

1. **No cross-platform native desktop BLE implementation.** The desktop app
   (Tauri/Rust) has no BLE central-role stack today. macOS, Windows, and
   Linux each require a distinct native BLE API (CoreBluetooth, WinRT
   `Windows.Devices.Bluetooth`, BlueZ/D-Bus respectively) with materially
   different pairing, permission, and background-execution models — this is
   at least as much platform-specific surface as `crates/volume-control`
   already carries per-OS, but for a real-time data transport instead of a
   handful of one-shot commands.
2. **No Android-side permission/pairing/security design.** BLE on Android
   requires `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` runtime permissions (a
   third permission layer alongside the existing `BODY_SENSORS` grant and
   the Samsung Health Sensor SDK's own consent — see `PpgCollector`'s kdoc),
   a GATT service/characteristic contract to replace the current JSON-over-
   WebSocket wire format, and an explicit pairing/bonding and encryption
   story. None of this has been designed, let alone reviewed.
3. **No real battery/latency trial data.** BLE's power advantage over Wi-Fi
   is throughput- and duty-cycle-dependent: at the sample rates this app
   already streams (up to ~50 Hz fused IMU plus PPG), BLE's lower idle power
   can be offset by more frequent radio wake-ups, connection-interval
   negotiation overhead, and (depending on the Android BLE stack's batching)
   possible latency regressions for the button/haptic round-trip the
   interaction engine depends on. Nothing in this codebase or session
   measures any of that on real hardware.

## Path to reconsidering this decision

Before migrating any part of the watch-to-desktop link to BLE:

- Build and merge a native BLE central implementation for at least the
  primary desktop target platform, reviewed the same way
  `crates/volume-control`'s per-OS backends are (explicit runner
  abstraction, argument-safe commands, fail-closed on unsupported
  platforms).
- Design and review the Android permission/pairing/security model
  end-to-end (scan/connect permission requests, bonding, GATT service
  versioning compatible with `docs/protocols/watch-websocket-protocol.md`'s
  existing wire-format discipline).
- Run real-device battery and latency trials comparing Wi-Fi vs. BLE at the
  app's actual streaming rates, on the actual Galaxy Watch 4+ hardware this
  app targets, and record the measured numbers (not projected ones) before
  any transport-swap implementation work starts.

Until then, Wi-Fi remains the supported and only transport, and this
optimization pass makes no changes to `crates/watch-bridge`'s protocol.
