# Graph Report - gesture-controls  (2026-08-17)

## Corpus Check
- 70 files · ~48,299 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 913 nodes · 1416 edges · 57 communities (53 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4fe9f586`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- volume-control/src/lib.rs
- App.tsx
- interaction-engine/src/lib.rs
- watch-bridge/src/lib.rs
- devDependencies
- OverlayRuntime
- SonyUdpHeadPoseProvider
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
- TrackerViewModel
- Spatial Gesture Control
- run-system.mjs
- WatchStatus
- scripts
- Development Milestones
- TrackerConnectionState
- Foundation
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
- send_sample.py
- Project Brief: Spatial Gesture Control
- sony-head-tracking

## God Nodes (most connected - your core abstractions)
1. `Sony Head Tracker` - 20 edges
2. `Sony Head Tracker` - 20 edges
3. `VolumeError` - 19 edges
4. `compilerOptions` - 17 edges
5. `CalibrationRuntime` - 16 edges
6. `OverlayRuntime` - 16 edges
7. `SonyUdpHeadPoseProvider` - 16 edges
8. `HeadCalibration` - 16 edges
9. `run_command_with_timeout()` - 16 edges
10. `OverlayState` - 14 edges

## Surprising Connections (you probably didn't know these)
- `position_window_at_top_right()` --calls--> `top_right_overlay_position()`  [INFERRED]
  apps/desktop/src-tauri/src/overlay.rs → crates/interaction-engine/src/lib.rs
- `CalibrationRuntime` --references--> `HeadCalibration`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `emit_calibration_events()` --references--> `CalibrationEvent`  [EXTRACTED]
  apps/desktop/src-tauri/src/calibration.rs → crates/interaction-engine/src/lib.rs
- `VolumeRuntime` --references--> `VolumeController`  [EXTRACTED]
  apps/desktop/src-tauri/src/overlay.rs → crates/volume-control/src/lib.rs
- `adjustment_returns_the_whole_percentage_written_by_the_native_backend()` --calls--> `adjust_system_volume()`  [INFERRED]
  crates/volume-control/tests/volume_controller.rs → crates/volume-control/src/lib.rs

## Import Cycles
- None detected.

## Communities (57 total, 4 thin omitted)

### Community 0 - "volume-control/src/lib.rs"
Cohesion: 0.08
Nodes (44): Command, adjust_system_volume(), AppleScriptRunner, ChildGuard, leader_exited_without_reaping(), MacOsVolumeController, MacOsVolumeController<OsascriptRunner>, MacOsVolumeController<R> (+36 more)

### Community 1 - "App.tsx"
Cohesion: 0.09
Nodes (31): App(), emptyOverlay, emptyStatus, emptyWatchStatus, { invoke, listeners, listen }, Dashboard(), DashboardProps, number() (+23 more)

### Community 2 - "interaction-engine/src/lib.rs"
Cohesion: 0.12
Nodes (25): CalibrationConfig, CalibrationError, CalibrationEvent, CalibrationState, CalibrationTarget, clamp_i64_to_i32(), commit_visibility_after(), HeadCalibration (+17 more)

### Community 3 - "watch-bridge/src/lib.rs"
Cohesion: 0.10
Nodes (35): ClockOffsetEstimate, estimate_clock_offset(), handle_inbound(), handle_socket(), median_clock_offset(), now_ns(), Arc, AtomicBool (+27 more)

### Community 4 - "devDependencies"
Cohesion: 0.05
Nodes (38): dependencies, react, react-dom, @tauri-apps/api, devDependencies, jsdom, @tauri-apps/cli, @testing-library/jest-dom (+30 more)

### Community 5 - "OverlayRuntime"
Cohesion: 0.17
Nodes (24): adjust_system_volume(), get_overlay_state(), hide_overlay(), OverlayRuntime, OverlayState, position_window_at_top_right(), prepare_window(), refresh_system_volume() (+16 more)

### Community 6 - "SonyUdpHeadPoseProvider"
Cohesion: 0.10
Nodes (21): HeadPoseError, HeadPoseEvent, HeadPoseProvider, Arc, Duration, Error, HeadPose, Instant (+13 more)

### Community 7 - "Changelog"
Cohesion: 0.06
Nodes (34): [0.1.0], [1.0.0] - 2026-07-01, [1.1.0] - 2026-07-02, [1.2.0] - 2026-07-02, [1.3.0] - 2026-07-02, [1.4.0] - 2026-07-03, [2.0.0] - 2026-07-04, [2.1.0] - 2026-07-09 (+26 more)

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
Cohesion: 0.11
Nodes (16): Any, _arguments(), main(), Command-line monitor for Sony head-pose samples., Sony headphone head-tracking receiver., HeadPose, PacketError, Validated data models for Sony Head Tracker protocol version 2. (+8 more)

### Community 12 - "Sony Head Tracker"
Cohesion: 0.06
Nodes (31): Acknowledgements, Build, Candidate, Compatibility, Confirmed, Contents, Contributing, Default orientation: YXZ, X and Z inverted (+23 more)

### Community 13 - "volume_controller.rs"
Cohesion: 0.14
Nodes (15): adjustment_returns_the_whole_percentage_written_by_the_native_backend(), controller_rejects_invalid_values_and_backend_output(), FakeRunner, FakeVolumeController, keyboard_adjustment_reads_real_volume_clamps_and_writes_normalized_volume(), macos_controller_normalizes_volume_and_uses_argument_safe_set_commands(), macos_controller_reads_and_sets_mute_without_interpolating_arguments(), macos_controller_rounds_normalized_volume_at_integer_boundaries() (+7 more)

### Community 14 - "protocol/src/lib.rs"
Cohesion: 0.13
Nodes (23): DesktopConnectedPayload, DesktopOutboundEnvelope, DesktopOutboundEnvelope<T>, DesktopTimeSyncPayload, HeadPose, Error, Option, Result (+15 more)

### Community 15 - "tauri.conf.json"
Cohesion: 0.08
Nodes (25): app, macOSPrivateApi, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+17 more)

### Community 16 - "macOS support"
Cohesion: 0.08
Nodes (22): Build and run the SwiftUI app, Build and test the CLI, Device support, Differences from the original Windows implementation, Download a prebuilt release, Hardware validation completed, Keeping Input Monitoring permission across local rebuilds, macOS support (+14 more)

### Community 17 - "CalibrationRuntime"
Cohesion: 0.24
Nodes (17): CalibrationRuntime, capture_calibration_target(), emit_calibration_events(), get_calibration_state(), AppHandle, Default, Instant, Mutex (+9 more)

### Community 18 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+16 more)

### Community 19 - "TrackerViewModel"
Cohesion: 0.15
Nodes (13): App, ContentView, .body, .header, Double, String, SpatialHeadTrackingApp, .body (+5 more)

### Community 20 - "Spatial Gesture Control"
Cohesion: 0.11
Nodes (16): Galaxy Watch WebSocket protocol, Time synchronization, Watch messages, Sony Head Tracker, Third-party notices, Architecture, Current capabilities, License (+8 more)

### Community 21 - "run-system.mjs"
Cohesion: 0.23
Nodes (13): buildTrackerInvocation(), bundledTrackerPath(), DEFAULT_PREBUILDS_ROOT, ensureTracker(), isExecutable(), processGroupExists(), PROJECT_ROOT, runCommand() (+5 more)

### Community 22 - "WatchStatus"
Cohesion: 0.26
Nodes (11): get_watch_status(), AppHandle, Mutex, Option, Result, State, String, WatchHeartbeatSample (+3 more)

### Community 23 - "scripts"
Cohesion: 0.14
Nodes (13): name, private, scripts, build, check:tauri-icons, start, tauri, test (+5 more)

### Community 24 - "Development Milestones"
Cohesion: 0.14
Nodes (14): Development Milestones, Milestone 10: Pinch Classifier, Milestone 11: On-Watch Inference, Milestone 12: Cross-Platform Adapters, Milestone 13: Packaging and CI, Milestone 1: Tauri Project Setup, Milestone 2: Sony UDP Reader, Milestone 3: Head Calibration (+6 more)

### Community 25 - "TrackerConnectionState"
Cohesion: 0.20
Nodes (10): Bool, String, TrackerConnectionState, connected, error, .isConnected, permissionRequired, searching (+2 more)

### Community 26 - "Foundation"
Cohesion: 0.22
Nodes (4): AnyObject, Foundation, HeadTrackerProvider, HeadTrackerHID

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

## Knowledge Gaps
- **330 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+325 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `VolumeController` connect `volume-control/src/lib.rs` to `volume_controller.rs`, `OverlayRuntime`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `VolumeRuntime` connect `OverlayRuntime` to `volume-control/src/lib.rs`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `commit_visibility_after()` connect `interaction-engine/src/lib.rs` to `OverlayRuntime`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _330 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `volume-control/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.07552447552447553 - nodes in this community are weakly interconnected._
- **Should `App.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08859357696567 - nodes in this community are weakly interconnected._
- **Should `interaction-engine/src/lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.12427409988385599 - nodes in this community are weakly interconnected._