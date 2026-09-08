# Graph Report - gesture-controls  (2026-08-26)

## Corpus Check
- 88 files · ~69,686 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1299 nodes · 2171 edges · 88 communities (84 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `842d26f8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- volume-control/src/lib.rs
- App.tsx
- interaction-engine/src/lib.rs
- watch-bridge/src/lib.rs
- devDependencies
- OverlayRuntime
- head-tracking/src/lib.rs
- Changelog
- Changelog
- Sony Head Tracker
- PROJECT_BRIEF.md
- SonyUdpReceiver
- Sony Head Tracker
- volume_controller.rs
- protocol/src/lib.rs
- tauri.conf.json
- macOS support
- CalibrationRuntime
- compilerOptions
- ContentView
- Deploying to a Galaxy Watch 4
- run-system.mjs
- watch.rs
- scripts
- Development Milestones
- TrackerConnectionState
- TrackerViewModel
- default.json
- compilerOptions
- MacHIDHeadTracker.swift
- Head-tracking architecture
- MacHIDHeadTracker
- Wire format
- HeadPose
- Watch-to-Desktop Messages
- Head-tracking reference and compatibility tooling
- Desktop-to-Watch Messages
- check-tauri-icons.mjs
- tauri-config.test.mjs
- Watch Operating Modes
- Technology Stack
- Testing Strategy
- tsconfig.json
- Virtual Knob Overlay
- LiveTelemetry.tsx
- Project Brief: Spatial Gesture Control
- sony-head-tracking
- DesktopDiscovery
- WatchLinkManager
- Dashboard.tsx
- gradlew
- Wire format
- SpatialHeadTrackingApp
- OnDemandMedicalSampler
- WatchProtocol
- Troubleshooting
- MainActivity
- .dispatchSamples
- events.ts
- SensorCollector
- MedicalContinuousCollector.kt
- VolumeKnob.tsx
- [2.0.0] - 2026-07-04
- [1.0.0] - 2026-07-01
- [1.4.0] - 2026-07-03
- [2.1.0] - 2026-07-09
- [1.1.0] - 2026-07-02
- [1.2.0] - 2026-07-02
- StreamingForegroundService
- PpgCollector
- WatchPairingServer
- MedicalContinuousCollector
- MedicalTrackerState
- ConnectionState
- EndpointSource

## God Nodes (most connected - your core abstractions)
1. `WatchLinkManager` - 42 edges
2. `MainActivity` - 30 edges
3. `WatchBridgeServer` - 22 edges
4. `WatchProtocol` - 20 edges
5. `WatchEvent` - 20 edges
6. `Sony Head Tracker` - 20 edges
7. `Sony Head Tracker` - 20 edges
8. `VolumeError` - 19 edges
9. `MedicalContinuousCollector` - 18 edges
10. `OverlayRuntime` - 18 edges

## Surprising Connections (you probably didn't know these)
- `WatchLinkManager` --references--> `start`  [EXTRACTED]
  android-wearos/app/src/main/java/com/gesturecontrols/wearwatch/WatchLinkManager.kt → package.json
- `position_window_at_top_right()` --calls--> `top_right_overlay_position()`  [INFERRED]
  apps/desktop/src-tauri/src/overlay.rs → crates/interaction-engine/src/lib.rs
- `CalibrationRuntime` --references--> `HeadCalibration`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `emit_calibration_events()` --references--> `CalibrationEvent`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `VolumeRuntime` --references--> `VolumeController`  [EXTRACTED]
  apps/desktop/src-tauri/src/overlay.rs → crates/volume-control/src/lib.rs

## Import Cycles
- None detected.

## Communities (88 total, 4 thin omitted)

### Community 0 - "volume-control/src/lib.rs"
Cohesion: 0.08
Nodes (44): Command, adjust_system_volume(), AppleScriptRunner, ChildGuard, leader_exited_without_reaping(), MacOsVolumeController, MacOsVolumeController<OsascriptRunner>, MacOsVolumeController<R> (+36 more)

### Community 1 - "App.tsx"
Cohesion: 0.12
Nodes (16): App(), emptyOverlay, emptyStatus, emptyWatchStatus, { invoke, listeners, listen }, CALIBRATION_STATE_EVENT, HEAD_POSE_EVENT, HEAD_TARGET_ENTERED_EVENT (+8 more)

### Community 2 - "interaction-engine/src/lib.rs"
Cohesion: 0.15
Nodes (21): CalibrationConfig, CalibrationError, CalibrationEvent, CalibrationState, CalibrationTarget, clamp_i64_to_i32(), HeadCalibration, normalized_quaternion() (+13 more)

### Community 3 - "watch-bridge/src/lib.rs"
Cohesion: 0.10
Nodes (38): ClockOffsetEstimate, estimate_clock_offset(), handle_inbound(), handle_socket(), MdnsAdvertisement, MeasurementCommand, median_clock_offset(), now_ns() (+30 more)

### Community 4 - "devDependencies"
Cohesion: 0.05
Nodes (38): dependencies, react, react-dom, @tauri-apps/api, devDependencies, jsdom, @tauri-apps/cli, @testing-library/jest-dom (+30 more)

### Community 5 - "OverlayRuntime"
Cohesion: 0.14
Nodes (28): adjust_system_volume(), get_overlay_state(), hide_overlay(), OverlayRuntime, OverlayState, position_window_at_top_right(), prepare_window(), refresh_system_volume() (+20 more)

### Community 6 - "head-tracking/src/lib.rs"
Cohesion: 0.09
Nodes (26): circular_blend(), circular_delta_degrees(), HeadPoseError, HeadPoseEvent, HeadPoseProvider, normalized_quaternion_blend(), Arc, Duration (+18 more)

### Community 7 - "Changelog"
Cohesion: 0.18
Nodes (11): [0.1.0], [1.3.0] - 2026-07-02, [2.2.0] - 2026-07-11, Added, Added, Added, Changed, Changed (+3 more)

### Community 8 - "Changelog"
Cohesion: 0.06
Nodes (34): [0.1.0], [1.0.0] - 2026-07-01, [1.1.0] - 2026-07-02, [1.2.0] - 2026-07-02, [1.3.0] - 2026-07-02, [1.4.0] - 2026-07-03, [2.0.0] - 2026-07-04, [2.1.0] - 2026-07-09 (+26 more)

### Community 9 - "Sony Head Tracker"
Cohesion: 0.06
Nodes (31): Acknowledgements, Build, Candidate, Compatibility, Confirmed, Contents, Contributing, Default orientation: YXZ, X and Z inverted (+23 more)

### Community 10 - "PROJECT_BRIEF.md"
Cohesion: 0.06
Nodes (32): Button-Based Prototype, Configuration, Desktop Application Architecture, Error Handling, Galaxy Watch Communication, Gesture Dataset, Head Tracking Abstraction, Important Design Principles (+24 more)

### Community 11 - "SonyUdpReceiver"
Cohesion: 0.10
Nodes (18): Any, Send a single simulated Sony Head Tracker version-2 sample., _arguments(), main(), Command-line monitor for Sony head-pose samples., Sony headphone head-tracking receiver., HeadPose, PacketError (+10 more)

### Community 12 - "Sony Head Tracker"
Cohesion: 0.06
Nodes (31): Acknowledgements, Build, Candidate, Compatibility, Confirmed, Contents, Contributing, Default orientation: YXZ, X and Z inverted (+23 more)

### Community 13 - "volume_controller.rs"
Cohesion: 0.14
Nodes (15): adjustment_returns_the_whole_percentage_written_by_the_native_backend(), controller_rejects_invalid_values_and_backend_output(), FakeRunner, FakeVolumeController, keyboard_adjustment_reads_real_volume_clamps_and_writes_normalized_volume(), macos_controller_normalizes_volume_and_uses_argument_safe_set_commands(), macos_controller_reads_and_sets_mute_without_interpolating_arguments(), macos_controller_rounds_normalized_volume_at_integer_boundaries() (+7 more)

### Community 14 - "protocol/src/lib.rs"
Cohesion: 0.08
Nodes (55): DesktopConnectedPayload, DesktopMeasurementCommandPayload, DesktopOutboundEnvelope, DesktopOutboundEnvelope<T>, DesktopSensorControlPayload, DesktopTimeSyncPayload, HeadPose, Error (+47 more)

### Community 15 - "tauri.conf.json"
Cohesion: 0.08
Nodes (25): app, macOSPrivateApi, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+17 more)

### Community 16 - "macOS support"
Cohesion: 0.17
Nodes (12): Build and run the SwiftUI app, Build and test the CLI, Device support, Differences from the original Windows implementation, Download a prebuilt release, Hardware validation completed, Keeping Input Monitoring permission across local rebuilds, macOS support (+4 more)

### Community 17 - "CalibrationRuntime"
Cohesion: 0.24
Nodes (17): CalibrationRuntime, capture_calibration_target(), emit_calibration_events(), get_calibration_state(), AppHandle, Default, Instant, Mutex (+9 more)

### Community 18 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+16 more)

### Community 19 - "ContentView"
Cohesion: 0.21
Nodes (8): Button, ContentView, .body, .header, Double, String, .body, View

### Community 20 - "Deploying to a Galaxy Watch 4"
Cohesion: 0.05
Nodes (37): 1. Put the watch and your desktop on the same Wi-Fi network, 2. Enable Developer Options and Wi-Fi debugging on the watch, 3. Connect adb to the watch, 4. Install and run from Android Studio, 5. Start the desktop app, 6. Confirm automatic pairing, 7. Firewall, Deploying to a Galaxy Watch 4 (+29 more)

### Community 21 - "run-system.mjs"
Cohesion: 0.23
Nodes (13): buildTrackerInvocation(), bundledTrackerPath(), DEFAULT_PREBUILDS_ROOT, ensureTracker(), isExecutable(), processGroupExists(), PROJECT_ROOT, runCommand() (+5 more)

### Community 22 - "watch.rs"
Cohesion: 0.15
Nodes (27): batch_rate_hz(), EcgSampleSnapshot, EdaSampleSnapshot, get_controllable_sensor_ids(), get_medical_tracker_ids(), get_watch_status(), HeartRateSampleSnapshot, PpgSampleSnapshot (+19 more)

### Community 23 - "scripts"
Cohesion: 0.14
Nodes (13): name, private, scripts, build, check:tauri-icons, start, tauri, test (+5 more)

### Community 24 - "Development Milestones"
Cohesion: 0.14
Nodes (14): Development Milestones, Milestone 10: Pinch Classifier, Milestone 11: On-Watch Inference, Milestone 12: Cross-Platform Adapters, Milestone 13: Packaging and CI, Milestone 1: Tauri Project Setup, Milestone 2: Sony UDP Reader, Milestone 3: Head Calibration (+6 more)

### Community 25 - "TrackerConnectionState"
Cohesion: 0.20
Nodes (10): Bool, String, TrackerConnectionState, connected, error, .isConnected, permissionRequired, searching (+2 more)

### Community 26 - "TrackerViewModel"
Cohesion: 0.22
Nodes (6): AnyObject, Foundation, TrackerViewModel, HeadTrackerProvider, HeadTrackerHID, ObservableObject

### Community 27 - "default.json"
Cohesion: 0.22
Nodes (8): description, identifier, permissions, $schema, windows, core:default, main, overlay

### Community 28 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, module, moduleResolution, noEmit, skipLibCheck, include, vite.config.ts

### Community 29 - "MacHIDHeadTracker.swift"
Cohesion: 0.36
Nodes (6): macDeviceMatched(), macDeviceRemoved(), IOHIDDevice, IOKit.hid, IOReturn, UnsafeMutableRawPointer

### Community 30 - "Head-tracking architecture"
Cohesion: 0.25
Nodes (6): Active production boundary, Head-tracking architecture, Historical native experiment, Provider boundary, Historical development requirements, Historical native macOS head-tracking experiment

### Community 31 - "MacHIDHeadTracker"
Cohesion: 0.25
Nodes (4): MacHIDHeadTracker, HeadPose, IOHIDManager, Void

### Community 32 - "Wire format"
Cohesion: 0.29
Nodes (6): Compatibility, Example, Minimal Python reader, Port `N + 1` — JSON telemetry, Port `N` — OpenTrack doubles, Wire format

### Community 33 - "HeadPose"
Cohesion: 0.67
Nodes (6): Equatable, HeadPose, Quaternion, Double, Vector3, Sendable

### Community 34 - "Watch-to-Desktop Messages"
Cohesion: 0.29
Nodes (7): Heartbeat, Pinch held, Pinch released, Pinch started, Watch orientation, Watch-to-Desktop Messages, Wrist rotation

### Community 38 - "Head-tracking reference and compatibility tooling"
Cohesion: 0.40
Nodes (4): Boundary, Contents, Head-tracking reference and compatibility tooling, Manual simulator

### Community 39 - "Desktop-to-Watch Messages"
Cohesion: 0.40
Nodes (5): Connection acknowledgement, Desktop-to-Watch Messages, Haptic feedback, Start recording, Stop recording

### Community 40 - "check-tauri-icons.mjs"
Cohesion: 0.40
Nodes (4): config, configPath, root, tauriDir

### Community 41 - "tauri-config.test.mjs"
Cohesion: 0.40
Nodes (4): cargoUrl, configUrl, libSourceUrl, overlaySourceUrl

### Community 42 - "Watch Operating Modes"
Cohesion: 0.50
Nodes (4): Control Mode, Dataset Mode, Debug Mode, Watch Operating Modes

### Community 43 - "Technology Stack"
Cohesion: 0.50
Nodes (4): Desktop Application, Galaxy Watch Application, Machine Learning, Technology Stack

### Community 44 - "Testing Strategy"
Cohesion: 0.50
Nodes (4): Hardware Tests, Integration Tests, Testing Strategy, Unit Tests

### Community 48 - "Virtual Knob Overlay"
Cohesion: 0.67
Nodes (3): Main Window, Overlay Window, Virtual Knob Overlay

### Community 52 - "LiveTelemetry.tsx"
Cohesion: 0.15
Nodes (16): chartPath(), csvEscape(), CsvRow, formatBytes(), LiveTelemetry(), LiveTelemetryProps, number(), RingBuffer (+8 more)

### Community 57 - "DesktopDiscovery"
Cohesion: 0.13
Nodes (9): DesktopDiscovery, NsdManager, NsdManager, ConnectivityManager, NsdManager, NsdServiceInfo, InetAddress, Network (+1 more)

### Community 58 - "WatchLinkManager"
Cohesion: 0.09
Nodes (9): FloatArray, JSONObject, sensor, StateFlow, WebSocket, WatchLinkManager, enabled, Job (+1 more)

### Community 59 - "Dashboard.tsx"
Cohesion: 0.17
Nodes (15): CONTROLLABLE_SENSORS, Dashboard(), DashboardProps, IMU_SENSOR_IDS, number(), PPG_STATE_LABELS, ppgStateLabel(), connected (+7 more)

### Community 64 - "Wire format"
Cohesion: 0.20
Nodes (6): Compatibility, Example, Minimal Python reader, Port `N + 1` — JSON telemetry, Port `N` — OpenTrack doubles, Wire format

### Community 65 - "SpatialHeadTrackingApp"
Cohesion: 0.33
Nodes (4): App, SpatialHeadTrackingApp, Scene, SwiftUI

### Community 66 - "OnDemandMedicalSampler"
Cohesion: 0.24
Nodes (5): HealthTrackingService, StateFlow, OnDemandMedicalSampler, HealthTracker, Session

### Community 67 - "WatchProtocol"
Cohesion: 0.23
Nodes (5): InboundMessage, FloatArray, JSONObject, WatchProtocol, JSONArray

### Community 68 - "Troubleshooting"
Cohesion: 0.50
Nodes (4): No verified tracker is found, OpenTrack or JSON receives nothing, The tracker is configured but no YPR appears, Troubleshooting

### Community 69 - "MainActivity"
Cohesion: 0.14
Nodes (7): ConnectionPrefs, MainActivity, AppCompatActivity, Bundle, KeyEvent, PpgState, TextView

### Community 70 - ".dispatchSamples"
Cohesion: 0.18
Nodes (8): BiaResult, EcgSample, T, Spo2Sample, SweatLossSample, valueOrNull(), DataPoint, ValueKey

### Community 71 - "events.ts"
Cohesion: 0.13
Nodes (14): BiaResultSnapshot, EcgSampleSnapshot, EdaSampleSnapshot, HEAD_TARGET_EXITED_EVENT, HEAD_TRACKER_RESET_EVENT, HeartRateSampleSnapshot, PpgSampleSnapshot, Quaternion (+6 more)

### Community 72 - "SensorCollector"
Cohesion: 0.20
Nodes (5): FloatArray, Sensor, SensorCollector, SensorEvent, SensorEventListener

### Community 73 - "MedicalContinuousCollector.kt"
Cohesion: 0.29
Nodes (3): EdaSample, HeartRateSample, SkinTemperatureSample

### Community 74 - "VolumeKnob.tsx"
Cohesion: 0.50
Nodes (3): KnobStyle, VolumeKnob(), VolumeKnobProps

### Community 75 - "[2.0.0] - 2026-07-04"
Cohesion: 0.40
Nodes (5): [2.0.0] - 2026-07-04, Added, Changed, Compatibility, Fixed

### Community 76 - "[1.0.0] - 2026-07-01"
Cohesion: 0.50
Nodes (4): [1.0.0] - 2026-07-01, Added, Changed, Fixed

### Community 77 - "[1.4.0] - 2026-07-03"
Cohesion: 0.50
Nodes (4): [1.4.0] - 2026-07-03, Added, Changed, Fixed

### Community 78 - "[2.1.0] - 2026-07-09"
Cohesion: 0.50
Nodes (4): [2.1.0] - 2026-07-09, Added, Changed, Compatibility

### Community 79 - "[1.1.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.1.0] - 2026-07-02, Added, Changed

### Community 80 - "[1.2.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.2.0] - 2026-07-02, Added, Fixed

### Community 81 - "StreamingForegroundService"
Cohesion: 0.20
Nodes (9): start(), stop(), StreamingForegroundService, Context, IBinder, Intent, Notification, PowerManager (+1 more)

### Community 82 - "PpgCollector"
Cohesion: 0.12
Nodes (11): HealthTrackingService, StateFlow, PpgCollector, PpgSample, PpgState, CONNECTING, ERROR, IDLE (+3 more)

### Community 83 - "WatchPairingServer"
Cohesion: 0.24
Nodes (5): NsdManager, NsdServiceInfo, WatchPairingServer, NsdManager, ServerSocket

### Community 84 - "MedicalContinuousCollector"
Cohesion: 0.27
Nodes (4): HealthTrackingService, StateFlow, MedicalContinuousCollector, HealthTrackerType

### Community 85 - "MedicalTrackerState"
Cohesion: 0.18
Nodes (8): MedicalTrackerState, CONNECTING, ERROR, IDLE, MEASURING, PERMISSION_REQUIRED, STREAMING, UNAVAILABLE

### Community 86 - "ConnectionState"
Cohesion: 0.25
Nodes (6): ConnectionState, CONNECTED, CONNECTING, DISCONNECTED, FAILED, RECONNECTING

### Community 87 - "EndpointSource"
Cohesion: 0.50
Nodes (4): EndpointSource, DESKTOP_INITIATED, DISCOVERED, PERSISTED_FALLBACK

## Knowledge Gaps
- **381 isolated node(s):** `DISCOVERED`, `PERSISTED_FALLBACK`, `DESKTOP_INITIATED`, `IDLE`, `PERMISSION_REQUIRED` (+376 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MainActivity` connect `MainActivity` to `OnDemandMedicalSampler`, `SensorCollector`, `PpgCollector`, `WatchPairingServer`, `MedicalContinuousCollector`, `MedicalTrackerState`, `ConnectionState`, `EndpointSource`, `ContentView`, `DesktopDiscovery`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `VolumeController` connect `volume-control/src/lib.rs` to `volume_controller.rs`, `OverlayRuntime`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `DISCOVERED`, `PERSISTED_FALLBACK`, `DESKTOP_INITIATED` to the rest of the system?**
  _381 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `volume-control/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.07552447552447553 - nodes in this community are weakly interconnected._
- **Should `App.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.11904761904761904 - nodes in this community are weakly interconnected._
- **Should `watch-bridge/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.0975177304964539 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.05128205128205128 - nodes in this community are weakly interconnected._