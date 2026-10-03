# Watch application structure

The Wear OS application uses package boundaries that reflect runtime responsibility. For how it fits with the desktop see
[Components and deployment](../../docs/architecture/components-and-deployment.md); for its transports see
[Watch BLE transport](../../docs/protocols/watch-ble-transport.md) and
[Watch WebSocket protocol](../../docs/protocols/watch-websocket-protocol.md).

```text
app/                    # Activity composition, permissions, lifecycle, UI binding, transport switching
data/
├── connection/         # Transports and wire serialization
│   ├── WatchLinkManager.kt     transport-agnostic: sequencing, heartbeat, batching, replies
│   ├── WatchTransportLink.kt   the seam both transports implement
│   ├── BleGattTransport.kt     Bluetooth LE GATT server + app-level trust gate (default)
│   ├── BleFraming.kt           fragmentation/reassembly, byte-compatible with the desktop
│   ├── WebSocketTransport.kt   OkHttp WebSocket (Wi-Fi)
│   └── WatchProtocol.kt        v1 envelope encode/decode
├── discovery/          # mDNS/LAN desktop discovery and pairing endpoint (Wi-Fi transport only)
└── preferences/        # Persisted transport, endpoint, trusted desktop, install device id
feature/
├── health/             # Samsung Health Sensor SDK trackers and medical sample models
└── motion/             # Android IMU collection, orientation clock rebasing, sample models
platform/service/       # Android foreground-service and wake-lock lifecycle
```

Rules:
- `app` composes dependencies; it must not implement transport or sensor algorithms.
- `data` owns networking, discovery, and persistence boundaries.
- `feature` owns sensor-specific orchestration and data translation.
- `platform` contains Android OS integration that does not belong to a feature.
- The application ID remains `com.gesturecontrols.wearwatch`; package moves are internal only.
- `WatchLinkManager` never reaches past `WatchTransportLink` and never substitutes one transport for the other; a transport owns its own connection establishment and retry policy.
- Every outgoing envelope's `timestampNs` is on the `SystemClock.elapsedRealtimeNanos()` base. Orientation, built from `SensorEvent.timestamp`, is verified and, if needed, rebased by `SensorClockRebaser`.
- `deviceId` comes from `ConnectionPrefs.deviceId` (unique per install); over Bluetooth the desktop overrides it with the peripheral's identity, so the watch never needs to be trusted to name itself.
- The watch is a sensor source only: it never classifies a gesture or changes the desktop's volume itself.

Tests live in `app/src/test` (JVM, no emulator): `./gradlew :app:testDebugUnitTest`.
