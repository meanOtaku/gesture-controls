# Graph Report - gesture-controls  (2026-09-07)

## Corpus Check
- 122 files · ~92,290 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1734 nodes · 3237 edges · 120 communities (112 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.7)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e1d7900e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- volume-control/src/lib.rs
- events.ts
- interaction-engine/src/lib.rs
- WatchBridgeServer
- devDependencies
- OverlayRuntime
- head-tracking/src/lib.rs
- project-brief.md
- Sony Head Tracker
- telemetryStore.ts
- Sony Head Tracker
- WatchPairingServer
- PpgCollector
- volume_controller.rs
- protocol/src/lib.rs
- tauri.conf.json
- Development Milestones
- CalibrationRuntime
- compilerOptions
- ContentView
- Deploying to a Galaxy Watch 4
- run-system.mjs
- PinchInferenceEngine
- scripts
- Changelog
- TrackerConnectionState
- TrackerViewModel
- default.json
- compilerOptions
- MacHIDHeadTracker.swift
- macOS support
- MacHIDHeadTracker
- Dashboard.tsx
- HeadPose
- Changelog
- Wire format
- .push
- check-tauri-icons.mjs
- tauri-config.test.mjs
- Head-tracking architecture
- OnDemandMedicalSampler
- Watch-to-Desktop Messages
- tsconfig.json
- Wire format
- MedicalTrackerState
- macOS 14 or later
- sony-head-tracking
- DesktopDiscovery
- WatchLinkManager
- [2.0.0] - 2026-07-04
- Desktop-to-Watch Messages
- [1.0.0] - 2026-07-01
- [2.0.0] - 2026-07-04
- Compatibility
- Head-tracking reference and compatibility tooling
- SpatialHeadTrackingApp
- [1.4.0] - 2026-07-03
- WatchProtocol
- Watch Operating Modes
- MainActivity
- .dispatchSamples
- ConnectionState
- SensorCollector
- Technology Stack
- MedicalContinuousCollector.kt
- Testing Strategy
- settings.rs
- [1.1.0] - 2026-07-02
- Troubleshooting
- [1.4.0] - 2026-07-03
- StreamingForegroundService
- [2.1.0] - 2026-07-09
- Settings.tsx
- MedicalContinuousCollector
- [2.2.0] - 2026-07-11
- Virtual Knob Overlay
- [1.2.0] - 2026-07-02
- Galaxy Watch client (Wear OS)
- PinchPhase
- [1.3.0] - 2026-07-02
- Build
- gradlew
- VolumeKnob.tsx
- EndpointSource
- WatchProtocolTest
- desktop/ARCHITECTURE.md
- watch/ARCHITECTURE.md
- make_dataset_csv
- dataset.py
- model_lab.rs
- ModelLab.tsx
- ModelLab.test.tsx
- TelemetryStore
- pinch-classifier
- pinch-classifier
- WindowConfig
- [2.1.0] - 2026-07-09
- [1.1.0] - 2026-07-02
- train_tflite.py
- bundle.py
- Spatial Gesture Control
- README.md
- Galaxy Watch WebSocket protocol
- _carry_forward
- CsvFormatError

## God Nodes (most connected - your core abstractions)
1. `TelemetryStore` - 48 edges
2. `WatchLinkManager` - 47 edges
3. `MainActivity` - 35 edges
4. `WatchBridgeServer` - 26 edges
5. `OverlayRuntime` - 25 edges
6. `WatchProtocol` - 24 edges
7. `WatchEvent` - 21 edges
8. `VolumeError` - 20 edges
9. `WindowConfig` - 20 edges
10. `make_dataset_csv()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `position_window_at_top_right()` --calls--> `top_right_overlay_position()`  [INFERRED]
  apps/desktop/src-tauri/src/overlay.rs → crates/interaction-engine/src/lib.rs
- `WatchLinkManager` --references--> `start`  [EXTRACTED]
  apps/watch/app/src/main/java/com/gesturecontrols/wearwatch/data/connection/WatchLinkManager.kt → package.json
- `CalibrationRuntime` --references--> `HeadCalibration`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `emit_calibration_events()` --references--> `CalibrationEvent`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `OverlayRuntime` --references--> `WristRotation`  [EXTRACTED]
  apps/desktop/src-tauri/src/overlay.rs → crates/interaction-engine/src/lib.rs

## Import Cycles
- None detected.

## Communities (120 total, 8 thin omitted)

### Community 0 - "volume-control/src/lib.rs"
Cohesion: 0.08
Nodes (42): Command, adjust_system_volume(), AppleScriptRunner, ChildGuard, deferred_reap_wait_uses_the_full_reaper_lifetime(), leader_exited_without_reaping(), MacOsVolumeController, MacOsVolumeController<R> (+34 more)

### Community 1 - "events.ts"
Cohesion: 0.10
Nodes (27): App(), emptyOverlay, { invoke, listeners, listen }, BiaResultSnapshot, CALIBRATION_STATE_EVENT, EcgSampleSnapshot, EdaSampleSnapshot, HEAD_POSE_EVENT (+19 more)

### Community 2 - "interaction-engine/src/lib.rs"
Cohesion: 0.13
Nodes (25): CalibrationConfig, CalibrationError, CalibrationEvent, CalibrationState, CalibrationTarget, clamp_i64_to_i32(), HeadCalibration, normalized_quaternion() (+17 more)

### Community 3 - "WatchBridgeServer"
Cohesion: 0.06
Nodes (68): batch_rate_hz(), EcgSampleSnapshot, EdaSampleSnapshot, get_controllable_sensor_ids(), get_medical_tracker_ids(), get_watch_status(), HeartRateSampleSnapshot, PpgSampleSnapshot (+60 more)

### Community 4 - "devDependencies"
Cohesion: 0.05
Nodes (38): dependencies, react, react-dom, @tauri-apps/api, devDependencies, jsdom, @tauri-apps/cli, @testing-library/jest-dom (+30 more)

### Community 5 - "OverlayRuntime"
Cohesion: 0.10
Nodes (35): adjust_system_volume(), get_overlay_state(), hide_overlay(), OverlayRuntime, OverlayState, position_window_at_top_right(), prepare_window(), refresh_system_volume() (+27 more)

### Community 6 - "head-tracking/src/lib.rs"
Cohesion: 0.09
Nodes (26): circular_blend(), circular_delta_degrees(), HeadPoseError, HeadPoseEvent, HeadPoseProvider, normalized_quaternion_blend(), Arc, Duration (+18 more)

### Community 7 - "project-brief.md"
Cohesion: 0.06
Nodes (34): Button-Based Prototype, Configuration, Desktop Application Architecture, Error Handling, Galaxy Watch Communication, Gesture Dataset, Head Tracking Abstraction, Important Design Principles (+26 more)

### Community 8 - "Sony Head Tracker"
Cohesion: 0.06
Nodes (31): Acknowledgements, Build, Candidate, Compatibility, Confirmed, Contents, Contributing, Default orientation: YXZ, X and Z inverted (+23 more)

### Community 9 - "telemetryStore.ts"
Cohesion: 0.13
Nodes (20): chartPath(), csvEscape(), formatBytes(), LiveTelemetry(), number(), TimeChart(), CsvRow, DATASET_CSV_COLUMNS (+12 more)

### Community 10 - "Sony Head Tracker"
Cohesion: 0.12
Nodes (17): Acknowledgements, Contents, Contributing, Default orientation: YXZ, X and Z inverted, Featured in, Gyroscope and accelerometer, License, OpenTrack (+9 more)

### Community 11 - "WatchPairingServer"
Cohesion: 0.07
Nodes (23): NsdManager, NsdServiceInfo, WatchPairingServer, NsdManager, ServerSocket, Socket, Send a single simulated Sony Head Tracker version-2 sample., _arguments() (+15 more)

### Community 12 - "PpgCollector"
Cohesion: 0.11
Nodes (11): HealthTrackingService, StateFlow, PpgCollector, PpgSample, PpgState, CONNECTING, ERROR, IDLE (+3 more)

### Community 13 - "volume_controller.rs"
Cohesion: 0.14
Nodes (15): adjustment_returns_the_whole_percentage_written_by_the_native_backend(), controller_rejects_invalid_values_and_backend_output(), FakeRunner, FakeVolumeController, keyboard_adjustment_reads_real_volume_clamps_and_writes_normalized_volume(), macos_controller_normalizes_volume_and_uses_argument_safe_set_commands(), macos_controller_reads_and_sets_mute_without_interpolating_arguments(), macos_controller_rounds_normalized_volume_at_integer_boundaries() (+7 more)

### Community 14 - "protocol/src/lib.rs"
Cohesion: 0.08
Nodes (60): DesktopConnectedPayload, DesktopHapticPayload, DesktopMeasurementCommandPayload, DesktopOutboundEnvelope, DesktopOutboundEnvelope<T>, DesktopSensorControlPayload, DesktopSensorRateCommandPayload, DesktopTimeSyncPayload (+52 more)

### Community 15 - "tauri.conf.json"
Cohesion: 0.08
Nodes (25): app, macOSPrivateApi, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+17 more)

### Community 16 - "Development Milestones"
Cohesion: 0.14
Nodes (14): Development Milestones, Milestone 10: Pinch Classifier, Milestone 11: On-Watch Inference, Milestone 12: Cross-Platform Adapters, Milestone 13: Packaging and CI, Milestone 1: Tauri Project Setup, Milestone 2: Sony UDP Reader, Milestone 3: Head Calibration (+6 more)

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
Cohesion: 0.20
Nodes (10): 1. Put the watch and your desktop on the same Wi-Fi network, 2. Enable Developer Options and Wi-Fi debugging on the watch, 3. Connect adb to the watch, 4. Install and run from Android Studio, 5. Start the desktop app, 6. Confirm automatic pairing, 7. Firewall, Deploying to a Galaxy Watch 4 (+2 more)

### Community 21 - "run-system.mjs"
Cohesion: 0.23
Nodes (13): buildTrackerInvocation(), bundledTrackerPath(), DEFAULT_PREBUILDS_ROOT, ensureTracker(), isExecutable(), processGroupExists(), PROJECT_ROOT, runCommand() (+5 more)

### Community 22 - "PinchInferenceEngine"
Cohesion: 0.10
Nodes (27): BundleMetadata, create(), extractFeatures(), finiteDouble(), FloatArray, loadAndValidate(), mean(), Motion (+19 more)

### Community 23 - "scripts"
Cohesion: 0.14
Nodes (13): name, private, scripts, build, check:tauri-icons, start, tauri, test (+5 more)

### Community 24 - "Changelog"
Cohesion: 0.15
Nodes (11): [0.1.0], [1.0.0] - 2026-07-01, [1.2.0] - 2026-07-02, Added, Added, Added, Changed, Changelog (+3 more)

### Community 25 - "TrackerConnectionState"
Cohesion: 0.20
Nodes (10): Bool, String, TrackerConnectionState, connected, error, .isConnected, permissionRequired, searching (+2 more)

### Community 26 - "TrackerViewModel"
Cohesion: 0.22
Nodes (6): AnyObject, Foundation, ObservableObject, TrackerViewModel, HeadTrackerProvider, HeadTrackerHID

### Community 27 - "default.json"
Cohesion: 0.22
Nodes (8): description, identifier, permissions, $schema, windows, core:default, main, overlay

### Community 28 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, module, moduleResolution, noEmit, skipLibCheck, include, vite.config.ts

### Community 29 - "MacHIDHeadTracker.swift"
Cohesion: 0.36
Nodes (6): IOHIDDevice, IOKit.hid, IOReturn, macDeviceMatched(), macDeviceRemoved(), UnsafeMutableRawPointer

### Community 30 - "macOS support"
Cohesion: 0.17
Nodes (12): Build and run the SwiftUI app, Build and test the CLI, Device support, Differences from the original Windows implementation, Download a prebuilt release, Hardware validation completed, Keeping Input Monitoring permission across local rebuilds, macOS support (+4 more)

### Community 31 - "MacHIDHeadTracker"
Cohesion: 0.25
Nodes (4): IOHIDManager, MacHIDHeadTracker, HeadPose, Void

### Community 32 - "Dashboard.tsx"
Cohesion: 0.18
Nodes (13): CONTROLLABLE_SENSORS, Dashboard(), DashboardProps, IMU_SENSOR_IDS, number(), PPG_STATE_LABELS, ppgStateLabel(), connected (+5 more)

### Community 33 - "HeadPose"
Cohesion: 0.67
Nodes (6): Equatable, Sendable, HeadPose, Quaternion, Double, Vector3

### Community 34 - "Changelog"
Cohesion: 0.18
Nodes (11): [0.1.0], [1.3.0] - 2026-07-02, [2.2.0] - 2026-07-11, Added, Added, Added, Changed, Changed (+3 more)

### Community 38 - "Wire format"
Cohesion: 0.20
Nodes (6): Compatibility, Example, Minimal Python reader, Port `N + 1` — JSON telemetry, Port `N` — OpenTrack doubles, Wire format

### Community 39 - ".push"
Cohesion: 0.13
Nodes (8): RingBuffer, HeadPosePayload, quaternionToEulerDegrees(), WatchEdaBatch, WatchHeartRateBatch, WatchOrientationSample, WatchPpgBatch, WatchSkinTemperatureBatch

### Community 40 - "check-tauri-icons.mjs"
Cohesion: 0.40
Nodes (4): config, configPath, root, tauriDir

### Community 41 - "tauri-config.test.mjs"
Cohesion: 0.40
Nodes (4): cargoUrl, configUrl, libSourceUrl, overlaySourceUrl

### Community 42 - "Head-tracking architecture"
Cohesion: 0.25
Nodes (6): Active production boundary, Head-tracking architecture, Historical native experiment, Provider boundary, Historical development requirements, Historical native macOS head-tracking experiment

### Community 43 - "OnDemandMedicalSampler"
Cohesion: 0.24
Nodes (5): HealthTrackingService, StateFlow, OnDemandMedicalSampler, HealthTracker, Session

### Community 44 - "Watch-to-Desktop Messages"
Cohesion: 0.29
Nodes (7): Heartbeat, Pinch held, Pinch released, Pinch started, Watch orientation, Watch-to-Desktop Messages, Wrist rotation

### Community 48 - "Wire format"
Cohesion: 0.29
Nodes (6): Compatibility, Example, Minimal Python reader, Port `N + 1` — JSON telemetry, Port `N` — OpenTrack doubles, Wire format

### Community 52 - "MedicalTrackerState"
Cohesion: 0.18
Nodes (8): MedicalTrackerState, CONNECTING, ERROR, IDLE, MEASURING, PERMISSION_REQUIRED, STREAMING, UNAVAILABLE

### Community 53 - "macOS 14 or later"
Cohesion: 0.33
Nodes (6): macOS 14 or later, Option 1 — Download the prebuilt package (no Xcode required), Option 2 — Build the native macOS application, Option 3 — Command-line bridge, Quick start, Windows 11

### Community 57 - "DesktopDiscovery"
Cohesion: 0.13
Nodes (9): DesktopDiscovery, NsdManager, NsdManager, ConnectivityManager, NsdManager, NsdServiceInfo, InetAddress, Network (+1 more)

### Community 58 - "WatchLinkManager"
Cohesion: 0.08
Nodes (11): FloatArray, JSONObject, sensor, StateFlow, WebSocket, WatchLinkManager, durationMs, enabled (+3 more)

### Community 59 - "[2.0.0] - 2026-07-04"
Cohesion: 0.40
Nodes (5): [2.0.0] - 2026-07-04, Added, Changed, Compatibility, Fixed

### Community 60 - "Desktop-to-Watch Messages"
Cohesion: 0.40
Nodes (5): Connection acknowledgement, Desktop-to-Watch Messages, Haptic feedback, Start recording, Stop recording

### Community 61 - "[1.0.0] - 2026-07-01"
Cohesion: 0.50
Nodes (4): [1.0.0] - 2026-07-01, Added, Changed, Fixed

### Community 62 - "[2.0.0] - 2026-07-04"
Cohesion: 0.40
Nodes (5): [2.0.0] - 2026-07-04, Added, Changed, Compatibility, Fixed

### Community 63 - "Compatibility"
Cohesion: 0.40
Nodes (5): Candidate, Compatibility, Confirmed, Not compatible, Why AirPods can't work (yet)

### Community 64 - "Head-tracking reference and compatibility tooling"
Cohesion: 0.40
Nodes (4): Boundary, Contents, Head-tracking reference and compatibility tooling, Manual simulator

### Community 65 - "SpatialHeadTrackingApp"
Cohesion: 0.33
Nodes (4): App, Scene, SwiftUI, SpatialHeadTrackingApp

### Community 66 - "[1.4.0] - 2026-07-03"
Cohesion: 0.50
Nodes (4): [1.4.0] - 2026-07-03, Added, Changed, Fixed

### Community 67 - "WatchProtocol"
Cohesion: 0.22
Nodes (5): InboundMessage, FloatArray, JSONObject, WatchProtocol, JSONArray

### Community 68 - "Watch Operating Modes"
Cohesion: 0.50
Nodes (4): Control Mode, Dataset Mode, Debug Mode, Watch Operating Modes

### Community 69 - "MainActivity"
Cohesion: 0.12
Nodes (8): AppCompatActivity, MainActivity, ConnectionPrefs, Bundle, KeyEvent, PpgState, TextView, Vibrator

### Community 70 - ".dispatchSamples"
Cohesion: 0.18
Nodes (8): BiaResult, EcgSample, T, Spo2Sample, SweatLossSample, valueOrNull(), DataPoint, ValueKey

### Community 71 - "ConnectionState"
Cohesion: 0.29
Nodes (6): ConnectionState, CONNECTED, CONNECTING, DISCONNECTED, FAILED, RECONNECTING

### Community 72 - "SensorCollector"
Cohesion: 0.20
Nodes (5): FloatArray, Sensor, SensorCollector, SensorEvent, SensorEventListener

### Community 73 - "Technology Stack"
Cohesion: 0.50
Nodes (4): Desktop Application, Galaxy Watch Application, Machine Learning, Technology Stack

### Community 74 - "MedicalContinuousCollector.kt"
Cohesion: 0.29
Nodes (3): EdaSample, HeartRateSample, SkinTemperatureSample

### Community 75 - "Testing Strategy"
Cohesion: 0.50
Nodes (4): Hardware Tests, Integration Tests, Testing Strategy, Unit Tests

### Community 77 - "settings.rs"
Cohesion: 0.14
Nodes (31): apply_watch_settings(), AppSettings, default_ppg_flush_rate_hz(), default_wrist_dead_zone_degrees(), default_wrist_max_angular_velocity_degrees_per_second(), default_wrist_max_volume_points_per_second(), default_wrist_smoothing_alpha(), default_wrist_volume_points_per_degree() (+23 more)

### Community 78 - "[1.1.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.1.0] - 2026-07-02, Added, Changed

### Community 79 - "Troubleshooting"
Cohesion: 0.50
Nodes (4): No verified tracker is found, OpenTrack or JSON receives nothing, The tracker is configured but no YPR appears, Troubleshooting

### Community 80 - "[1.4.0] - 2026-07-03"
Cohesion: 0.50
Nodes (4): [1.4.0] - 2026-07-03, Added, Changed, Fixed

### Community 81 - "StreamingForegroundService"
Cohesion: 0.20
Nodes (9): start(), stop(), StreamingForegroundService, Context, IBinder, Intent, Notification, PowerManager (+1 more)

### Community 82 - "[2.1.0] - 2026-07-09"
Cohesion: 0.50
Nodes (4): [2.1.0] - 2026-07-09, Added, Changed, Compatibility

### Community 83 - "Settings.tsx"
Cohesion: 0.38
Nodes (6): clamp(), CONTROLLABLE_SENSORS, DEFAULT_SETTINGS, Settings(), SettingsProps, AppSettings

### Community 84 - "MedicalContinuousCollector"
Cohesion: 0.27
Nodes (4): HealthTrackingService, StateFlow, MedicalContinuousCollector, HealthTrackerType

### Community 85 - "[2.2.0] - 2026-07-11"
Cohesion: 0.50
Nodes (4): [2.2.0] - 2026-07-11, Added, Changed, Compatibility

### Community 86 - "Virtual Knob Overlay"
Cohesion: 0.67
Nodes (3): Main Window, Overlay Window, Virtual Knob Overlay

### Community 87 - "[1.2.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.2.0] - 2026-07-02, Added, Fixed

### Community 88 - "Galaxy Watch client (Wear OS)"
Cohesion: 0.25
Nodes (8): Expected dashboard evidence, Galaxy Watch client (Wear OS), Limitations, Opening the project, Project layout, Raw PPG (Galaxy Watch 4+ Samsung Wear OS only), Requirements, What it implements

### Community 89 - "PinchPhase"
Cohesion: 0.50
Nodes (4): PinchPhase, HELD, RELEASED, STARTED

### Community 90 - "[1.3.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.3.0] - 2026-07-02, Added, Changed

### Community 91 - "Build"
Cohesion: 0.67
Nodes (3): Build, macOS, Windows

### Community 97 - "VolumeKnob.tsx"
Cohesion: 0.50
Nodes (3): KnobStyle, VolumeKnob(), VolumeKnobProps

### Community 98 - "EndpointSource"
Cohesion: 0.50
Nodes (4): EndpointSource, DESKTOP_INITIATED, DISCOVERED, PERSISTED_FALLBACK

### Community 102 - "make_dataset_csv"
Cohesion: 0.14
Nodes (23): load_recording(), Path, Returns (remaining_lines, leading_comment_count)., _strip_leading_comments(), make_dataset_csv(), Path, Synthetic CSV fixtures matching the Milestone 9 dataset-recorder contract. No…, Writes a synthetic dataset CSV with one uniform label, mirroring… (+15 more)

### Community 103 - "dataset.py"
Cohesion: 0.13
Nodes (27): load_recordings(), Loads Milestone 9 dataset-recorder CSV exports into arrays ready for windowing.…, One parsed CSV export: a single session, timestamp-ordered, carry-forward…, Recording, build_dataset_from_recordings(), Assembles a feature matrix, target vector, and group vector from CSV exports.…, extract_features(), ndarray (+19 more)

### Community 104 - "model_lab.rs"
Cohesion: 0.09
Nodes (61): ActiveJob, cancel_training_job(), dataset_csv_path(), dataset_csv_path_stays_inside_dir_for_valid_ids(), DatasetIndex, datasets_dir(), DatasetSummary, delete_model_dataset() (+53 more)

### Community 105 - "ModelLab.tsx"
Cohesion: 0.15
Nodes (16): DatasetSummary, DEV_RUNNER_NOTICE, EXPORT_UNAVAILABLE_REASON, formatPercent(), LabelRole, ModelCard, ModelLab(), POSITIVE_LABELS (+8 more)

### Community 106 - "ModelLab.test.tsx"
Cohesion: 0.29
Nodes (5): DATASET_A, invokeMock, listenMock, MODEL_CARD, TRAINED_MODEL_A

### Community 108 - "pinch-classifier"
Cohesion: 0.20
Nodes (9): Artifacts, Baseline training (scikit-learn), CSV contract, False-activation metrics, Grouping rule, Neural TFLite/LiteRT training and export, pinch-classifier, Running tests (+1 more)

### Community 111 - "WindowConfig"
Cohesion: 0.15
Nodes (20): RandomForestClassifier, build_dataset(), Dataset, Path, Offline training package for the pinch gesture classifier (Milestone 10, slice…, positive_targets(), Targets that count as an activation (used for the false-activation metric)., _build_arg_parser() (+12 more)

### Community 112 - "[2.1.0] - 2026-07-09"
Cohesion: 0.50
Nodes (4): [2.1.0] - 2026-07-09, Added, Changed, Compatibility

### Community 113 - "[1.1.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.1.0] - 2026-07-02, Added, Changed

### Community 114 - "train_tflite.py"
Cohesion: 0.25
Nodes (18): _build_arg_parser(), build_model(), _encode_targets(), _evaluation(), export_tflite(), Any, ArgumentParser, Namespace (+10 more)

### Community 115 - "bundle.py"
Cohesion: 0.22
Nodes (16): build_metadata(), BundleValidationError, Any, Path, ValueError, Validated deployment-bundle metadata for the TFLite pinch classifier., The deployment metadata or its model payload violates the bundle contract., Build the portable inference contract; timestamps are intentionally omitted. (+8 more)

### Community 116 - "Spatial Gesture Control"
Cohesion: 0.18
Nodes (11): Architecture, Current capabilities, License, Linux, macOS, Platform notes, Run the complete system, Security and provenance (+3 more)

### Community 117 - "README.md"
Cohesion: 0.28
Nodes (3): Documentation, Sony Head Tracker, Third-party notices

### Community 118 - "Galaxy Watch WebSocket protocol"
Cohesion: 0.25
Nodes (8): Desktop runtime controls, Galaxy Watch WebSocket protocol, Local discovery, Raw PPG (Galaxy Watch 4+ Samsung Wear OS only), Time synchronization, Typed pinch transitions, Volume overlay grab (STEM button), Watch messages

### Community 119 - "_carry_forward"
Cohesion: 0.67
Nodes (3): _carry_forward(), ndarray, Forward-fills NaNs from the last known (past) sample only — never from the…

### Community 120 - "CsvFormatError"
Cohesion: 0.67
Nodes (3): CsvFormatError, ValueError, Raised when a CSV export does not match the recorder's stable contract.

## Knowledge Gaps
- **415 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+410 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WatchBridgeServer` connect `WatchBridgeServer` to `settings.rs`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `MainActivity` connect `MainActivity` to `EndpointSource`, `SensorCollector`, `WatchPairingServer`, `OnDemandMedicalSampler`, `PpgCollector`, `ContentView`, `MedicalTrackerState`, `MedicalContinuousCollector`, `PinchInferenceEngine`, `DesktopDiscovery`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `VolumeController` connect `volume-control/src/lib.rs` to `volume_controller.rs`, `OverlayRuntime`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _415 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `volume-control/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.08294930875576037 - nodes in this community are weakly interconnected._
- **Should `events.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0962566844919786 - nodes in this community are weakly interconnected._
- **Should `interaction-engine/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.12580943570767808 - nodes in this community are weakly interconnected._