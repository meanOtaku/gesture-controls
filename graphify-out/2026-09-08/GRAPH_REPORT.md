# Graph Report - gesture-controls  (2026-09-08)

## Corpus Check
- 132 files · ~104,529 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2050 nodes · 4169 edges · 123 communities (117 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3bd77cd5`
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
- PpgState
- volume_controller.rs
- protocol/src/lib.rs
- tauri.conf.json
- Development Milestones
- CalibrationRuntime
- compilerOptions
- ContentView
- Deploying to a Galaxy Watch 4
- run-system.mjs
- watch.rs
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
- label_registry.rs
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
- runtime.rs
- Desktop-to-Watch Messages
- [1.0.0] - 2026-07-01
- [2.0.0] - 2026-07-04
- Compatibility
- Head-tracking reference and compatibility tooling
- SpatialHeadTrackingApp
- PpgCollector
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
- ModelLab.test.tsx
- Galaxy Watch client (Wear OS)
- [1.4.0] - 2026-07-03
- StreamingForegroundService
- [2.1.0] - 2026-07-09
- gesture_policy.rs
- MedicalContinuousCollector
- [2.2.0] - 2026-07-11
- Virtual Knob Overlay
- macOS 14 or later
- [1.4.0] - 2026-07-03
- model_registry.rs
- [1.3.0] - 2026-07-02
- Build
- gradlew
- Compatibility
- VolumeKnob.tsx
- EndpointSource
- test_desktop_runtime.py
- desktop/ARCHITECTURE.md
- watch/ARCHITECTURE.md
- make_dataset_csv
- WindowConfig
- model_lab.rs
- ModelLab.tsx
- inference.rs
- TelemetryStore
- pinch-classifier
- pinch-classifier
- train.py
- [2.1.0] - 2026-07-09
- Build
- train_tflite.py
- bundle.py
- Spatial Gesture Control
- README.md
- Galaxy Watch WebSocket protocol
- features.rs
- [2.0.0] - 2026-07-04
- [1.1.0] - 2026-07-02
- DesktopPinchRuntime

## God Nodes (most connected - your core abstractions)
1. `TelemetryStore` - 48 edges
2. `WatchLinkManager` - 46 edges
3. `VolumeError` - 35 edges
4. `MainActivity` - 33 edges
5. `WatchBridgeServer` - 26 edges
6. `OverlayRuntime` - 25 edges
7. `make_dataset_csv()` - 22 edges
8. `WatchProtocol` - 20 edges
9. `WatchEvent` - 20 edges
10. `WindowConfig` - 20 edges

## Surprising Connections (you probably didn't know these)
- `position_window_at_top_right()` --calls--> `top_right_overlay_position()`  [INFERRED]
  apps/desktop/src-tauri/src/overlay.rs → crates/interaction-engine/src/lib.rs
- `WatchLinkManager` --references--> `start`  [EXTRACTED]
  apps/watch/app/src/main/java/com/gesturecontrols/wearwatch/data/connection/WatchLinkManager.kt → package.json
- `CalibrationRuntime` --references--> `HeadCalibration`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `emit_calibration_events()` --references--> `CalibrationEvent`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `load_model_backend()` --references--> `PinchModel`  [EXTRACTED]
  apps/desktop/src-tauri/src/inference.rs → crates/pinch-inference/src/model.rs

## Import Cycles
- None detected.

## Communities (123 total, 6 thin omitted)

### Community 0 - "volume-control/src/lib.rs"
Cohesion: 0.06
Nodes (60): Command, adjust_system_volume(), AppleScriptRunner, ChildGuard, deferred_reap_wait_uses_the_full_reaper_lifetime(), leader_exited_without_reaping(), LinuxCommandRunner, LinuxVolumeController (+52 more)

### Community 1 - "events.ts"
Cohesion: 0.08
Nodes (33): App(), emptyOverlay, { invoke, listeners, listen }, clamp(), CONTROLLABLE_SENSORS, DEFAULT_SETTINGS, Settings(), SettingsProps (+25 more)

### Community 2 - "interaction-engine/src/lib.rs"
Cohesion: 0.13
Nodes (25): CalibrationConfig, CalibrationError, CalibrationEvent, CalibrationState, CalibrationTarget, clamp_i64_to_i32(), HeadCalibration, normalized_quaternion() (+17 more)

### Community 3 - "WatchBridgeServer"
Cohesion: 0.09
Nodes (40): ClockOffsetEstimate, estimate_clock_offset(), handle_inbound(), handle_socket(), HapticCommand, MdnsAdvertisement, MeasurementCommand, median_clock_offset() (+32 more)

### Community 4 - "devDependencies"
Cohesion: 0.05
Nodes (38): dependencies, react, react-dom, @tauri-apps/api, devDependencies, jsdom, @tauri-apps/cli, @testing-library/jest-dom (+30 more)

### Community 5 - "OverlayRuntime"
Cohesion: 0.12
Nodes (30): adjust_system_volume(), get_overlay_state(), hide_overlay(), OverlayRuntime, OverlayState, position_window_at_top_right(), prepare_window(), refresh_system_volume() (+22 more)

### Community 6 - "head-tracking/src/lib.rs"
Cohesion: 0.09
Nodes (26): circular_blend(), circular_delta_degrees(), HeadPoseError, HeadPoseEvent, HeadPoseProvider, normalized_quaternion_blend(), Arc, Duration (+18 more)

### Community 7 - "project-brief.md"
Cohesion: 0.06
Nodes (34): Button-Based Prototype, Configuration, Desktop Application Architecture, Error Handling, Galaxy Watch Communication, Gesture Dataset, Head Tracking Abstraction, Important Design Principles (+26 more)

### Community 8 - "Sony Head Tracker"
Cohesion: 0.12
Nodes (17): Acknowledgements, Contents, Contributing, Default orientation: YXZ, X and Z inverted, Featured in, Gyroscope and accelerometer, License, OpenTrack (+9 more)

### Community 9 - "telemetryStore.ts"
Cohesion: 0.11
Nodes (22): chartPath(), csvEscape(), formatBytes(), LiveTelemetry(), number(), TimeChart(), CsvRow, DATASET_CSV_COLUMNS (+14 more)

### Community 10 - "Sony Head Tracker"
Cohesion: 0.12
Nodes (17): Acknowledgements, Contents, Contributing, Default orientation: YXZ, X and Z inverted, Featured in, Gyroscope and accelerometer, License, OpenTrack (+9 more)

### Community 11 - "WatchPairingServer"
Cohesion: 0.07
Nodes (23): NsdManager, NsdServiceInfo, WatchPairingServer, NsdManager, ServerSocket, Socket, Send a single simulated Sony Head Tracker version-2 sample., _arguments() (+15 more)

### Community 12 - "PpgState"
Cohesion: 0.18
Nodes (8): PpgSample, PpgState, CONNECTING, ERROR, IDLE, PERMISSION_REQUIRED, STREAMING, UNAVAILABLE

### Community 13 - "volume_controller.rs"
Cohesion: 0.13
Nodes (18): adjustment_returns_the_whole_percentage_written_by_the_native_backend(), controller_rejects_invalid_values_and_backend_output(), FakeLinuxRunner, FakeRunner, FakeVolumeController, keyboard_adjustment_reads_real_volume_clamps_and_writes_normalized_volume(), linux_controller_falls_back_to_pulseaudio_and_uses_normalized_writes(), linux_controller_prefers_pipewire_and_parses_volume_and_mute() (+10 more)

### Community 14 - "protocol/src/lib.rs"
Cohesion: 0.08
Nodes (56): DesktopConnectedPayload, DesktopHapticPayload, DesktopMeasurementCommandPayload, DesktopOutboundEnvelope, DesktopOutboundEnvelope<T>, DesktopSensorControlPayload, DesktopSensorRateCommandPayload, DesktopTimeSyncPayload (+48 more)

### Community 15 - "tauri.conf.json"
Cohesion: 0.08
Nodes (25): app, macOSPrivateApi, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+17 more)

### Community 16 - "Development Milestones"
Cohesion: 0.14
Nodes (14): Development Milestones, Milestone 10: Pinch Classifier, Milestone 11: Desktop Inference and Gesture Policy, Milestone 12: Cross-Platform Adapters, Milestone 13: Packaging and CI, Milestone 1: Tauri Project Setup, Milestone 2: Sony UDP Reader, Milestone 3: Head Calibration (+6 more)

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

### Community 22 - "watch.rs"
Cohesion: 0.15
Nodes (28): batch_rate_hz(), EcgSampleSnapshot, EdaSampleSnapshot, get_controllable_sensor_ids(), get_medical_tracker_ids(), get_watch_status(), HeartRateSampleSnapshot, PpgSampleSnapshot (+20 more)

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
Cohesion: 0.12
Nodes (16): Build and run the SwiftUI app, Build and test the CLI, Device support, Differences from the original Windows implementation, Download a prebuilt release, Hardware validation completed, Keeping Input Monitoring permission across local rebuilds, macOS support (+8 more)

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
Cohesion: 0.12
Nodes (17): [0.1.0], [1.1.0] - 2026-07-02, [1.2.0] - 2026-07-02, [1.3.0] - 2026-07-02, [2.2.0] - 2026-07-11, Added, Added, Added (+9 more)

### Community 38 - "Wire format"
Cohesion: 0.20
Nodes (6): Compatibility, Example, Minimal Python reader, Port `N + 1` — JSON telemetry, Port `N` — OpenTrack doubles, Wire format

### Community 39 - "label_registry.rs"
Cohesion: 0.24
Nodes (23): contains_label(), create_model_label(), CreateLabelInput, default_index(), emit(), LabelIndex, LabelRecord, LabelRegistryRuntime (+15 more)

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

### Community 59 - "runtime.rs"
Cohesion: 0.07
Nodes (40): CompiledModel, LiteRtPinchModel, PinchModelError, Error, From, Path, Result, Self (+32 more)

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

### Community 66 - "PpgCollector"
Cohesion: 0.24
Nodes (3): HealthTrackingService, StateFlow, PpgCollector

### Community 67 - "WatchProtocol"
Cohesion: 0.23
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

### Community 78 - "ModelLab.test.tsx"
Cohesion: 0.22
Nodes (7): DATASET_A, eventHandlers, invokeMock, listenMock, MODEL_CARD, REGISTRY_MODEL_A, TRAINED_MODEL_A

### Community 79 - "Galaxy Watch client (Wear OS)"
Cohesion: 0.25
Nodes (8): Expected dashboard evidence, Galaxy Watch client (Wear OS), Limitations, Opening the project, Project layout, Raw PPG (Galaxy Watch 4+ Samsung Wear OS only), Requirements, What it implements

### Community 80 - "[1.4.0] - 2026-07-03"
Cohesion: 0.50
Nodes (4): [1.4.0] - 2026-07-03, Added, Changed, Fixed

### Community 81 - "StreamingForegroundService"
Cohesion: 0.20
Nodes (9): start(), stop(), StreamingForegroundService, Context, IBinder, Intent, Notification, PowerManager (+1 more)

### Community 82 - "[2.1.0] - 2026-07-09"
Cohesion: 0.50
Nodes (4): [2.1.0] - 2026-07-09, Added, Changed, Compatibility

### Community 83 - "gesture_policy.rs"
Cohesion: 0.13
Nodes (33): DecisionReason, double_started_is_ignored_the_second_time(), force_release_when_already_idle_reports_no_action(), force_release_while_grabbed_releases_live_regardless_of_mode(), ForceReleaseReason, GestureIntent, GesturePolicy, GesturePolicyConfig (+25 more)

### Community 84 - "MedicalContinuousCollector"
Cohesion: 0.27
Nodes (4): HealthTrackingService, StateFlow, MedicalContinuousCollector, HealthTrackerType

### Community 85 - "[2.2.0] - 2026-07-11"
Cohesion: 0.50
Nodes (4): [2.2.0] - 2026-07-11, Added, Changed, Compatibility

### Community 86 - "Virtual Knob Overlay"
Cohesion: 0.67
Nodes (3): Main Window, Overlay Window, Virtual Knob Overlay

### Community 87 - "macOS 14 or later"
Cohesion: 0.33
Nodes (6): macOS 14 or later, Option 1 — Download the prebuilt package (no Xcode required), Option 2 — Build the native macOS application, Option 3 — Command-line bridge, Quick start, Windows 11

### Community 88 - "[1.4.0] - 2026-07-03"
Cohesion: 0.50
Nodes (4): [1.4.0] - 2026-07-03, Added, Changed, Fixed

### Community 89 - "model_registry.rs"
Cohesion: 0.13
Nodes (48): activate_model(), active_model_file_path(), active_model_runtime_config(), emit_registry(), evaluate_quality_gate(), find_model_mut(), get_model_registry(), InferenceMode (+40 more)

### Community 90 - "[1.3.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.3.0] - 2026-07-02, Added, Changed

### Community 91 - "Build"
Cohesion: 0.67
Nodes (3): Build, macOS, Windows

### Community 93 - "Compatibility"
Cohesion: 0.40
Nodes (5): Candidate, Compatibility, Confirmed, Not compatible, Why AirPods can't work (yet)

### Community 97 - "VolumeKnob.tsx"
Cohesion: 0.50
Nodes (3): KnobStyle, VolumeKnob(), VolumeKnobProps

### Community 98 - "EndpointSource"
Cohesion: 0.50
Nodes (4): EndpointSource, DESKTOP_INITIATED, DISCOVERED, PERSISTED_FALLBACK

### Community 99 - "test_desktop_runtime.py"
Cohesion: 0.14
Nodes (16): fixture, parametrize, bundle_dir(), _FakeInterpreter, _make_runtime(), DesktopPinchRuntime, ndarray, Trains one small real TFLite bundle and reuses it across this module's tests. (+8 more)

### Community 102 - "make_dataset_csv"
Cohesion: 0.12
Nodes (26): _carry_forward(), CsvFormatError, load_recording(), load_recordings(), ndarray, Path, ValueError, Loads Milestone 9 dataset-recorder CSV exports into arrays ready for windowing.… (+18 more)

### Community 103 - "WindowConfig"
Cohesion: 0.15
Nodes (27): One parsed CSV export: a single session, timestamp-ordered, carry-forward…, Recording, build_dataset(), build_dataset_from_recordings(), Dataset, Path, Assembles a feature matrix, target vector, and group vector from CSV exports.…, extract_features() (+19 more)

### Community 104 - "model_lab.rs"
Cohesion: 0.09
Nodes (63): ActiveJob, cancel_training_job(), dataset_csv_path(), dataset_csv_path_stays_inside_dir_for_valid_ids(), DatasetIndex, datasets_dir(), DatasetSummary, delete_model_dataset() (+55 more)

### Community 105 - "ModelLab.tsx"
Cohesion: 0.10
Nodes (26): appendRuntimeEvent(), DatasetLabel, DatasetSummary, describeDiagnosticValue(), describeWindow(), DEV_RUNNER_NOTICE, EXPORT_UNAVAILABLE_REASON, formatPercent() (+18 more)

### Community 106 - "inference.rs"
Cohesion: 0.09
Nodes (47): apply_decision(), ClassifyOutcome, evaluate_ppg_window(), evaluate_ppg_window_accepts_first_window_with_no_watermark(), evaluate_ppg_window_accepts_strictly_later_window(), evaluate_ppg_window_quality(), evaluate_ppg_window_quality_accepts_clean_window(), evaluate_ppg_window_quality_fails_closed_on_malformed_batch() (+39 more)

### Community 107 - "TelemetryStore"
Cohesion: 0.07
Nodes (10): RingBuffer, TelemetryStore, HeadPosePayload, quaternionToEulerDegrees(), WatchEdaBatch, WatchHeartRateBatch, WatchOrientationSample, WatchPpgBatch (+2 more)

### Community 108 - "pinch-classifier"
Cohesion: 0.20
Nodes (9): Artifacts, Baseline training (scikit-learn), CSV contract, False-activation metrics, Grouping rule, Neural TFLite/LiteRT training and export, pinch-classifier, Running tests (+1 more)

### Community 111 - "train.py"
Cohesion: 0.13
Nodes (18): RandomForestClassifier, Offline training package for the pinch gesture classifier (Milestone 10, slice…, positive_targets(), Maps recorder labels onto classifier targets. pinch_start and pinch_release are…, Targets that count as an activation (used for the false-activation metric)., _build_arg_parser(), main(), ArgumentParser (+10 more)

### Community 112 - "[2.1.0] - 2026-07-09"
Cohesion: 0.50
Nodes (4): [2.1.0] - 2026-07-09, Added, Changed, Compatibility

### Community 113 - "Build"
Cohesion: 0.67
Nodes (3): Build, macOS, Windows

### Community 114 - "train_tflite.py"
Cohesion: 0.19
Nodes (23): _false_activation_metrics(), ndarray, _split_by_group(), _build_arg_parser(), build_model(), _encode_targets(), _evaluation(), export_tflite() (+15 more)

### Community 115 - "bundle.py"
Cohesion: 0.19
Nodes (17): build_metadata(), BundleValidationError, Any, Path, ValueError, Validated deployment-bundle metadata for the TFLite pinch classifier., The deployment metadata or its model payload violates the bundle contract., Build the portable inference contract; timestamps are intentionally omitted. (+9 more)

### Community 116 - "Spatial Gesture Control"
Cohesion: 0.18
Nodes (11): Architecture, Current capabilities, License, Linux, macOS, Platform notes, Run the complete system, Security and provenance (+3 more)

### Community 117 - "README.md"
Cohesion: 0.28
Nodes (3): Documentation, Sony Head Tracker, Third-party notices

### Community 118 - "Galaxy Watch WebSocket protocol"
Cohesion: 0.29
Nodes (7): Desktop runtime controls, Galaxy Watch WebSocket protocol, Local discovery, Raw PPG (Galaxy Watch 4+ Samsung Wear OS only), Time synchronization, Volume overlay grab (STEM button), Watch messages

### Community 119 - "features.rs"
Cohesion: 0.11
Nodes (25): constant_stat_block(), extract_features(), extract_features_accel_magnitude_matches_euclidean_norm(), extract_features_produces_expected_length_and_order(), extract_features_quat_delta_is_zero_for_carried_snapshot(), FusedWindow, OrientationSnapshot, quat_delta_angle_deg() (+17 more)

### Community 120 - "[2.0.0] - 2026-07-04"
Cohesion: 0.40
Nodes (5): [2.0.0] - 2026-07-04, Added, Changed, Compatibility, Fixed

### Community 121 - "[1.1.0] - 2026-07-02"
Cohesion: 0.67
Nodes (3): [1.1.0] - 2026-07-02, Added, Changed

### Community 123 - "DesktopPinchRuntime"
Cohesion: 0.29
Nodes (6): DesktopPinchRuntime, PinchTransition, ndarray, Path, Fail-closed desktop state machine around a validated LiteRT bundle., Infer one desktop-fused feature window; invalid input fails closed.

## Knowledge Gaps
- **419 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+414 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WatchPpgBatchSample` connect `inference.rs` to `protocol/src/lib.rs`, `features.rs`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Why does `WatchEvent` connect `protocol/src/lib.rs` to `inference.rs`, `WatchBridgeServer`, `watch.rs`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `WatchBridgeServer` connect `WatchBridgeServer` to `settings.rs`, `watch.rs`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _419 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `volume-control/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.057236842105263155 - nodes in this community are weakly interconnected._
- **Should `events.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08170731707317073 - nodes in this community are weakly interconnected._
- **Should `interaction-engine/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.12580943570767808 - nodes in this community are weakly interconnected._