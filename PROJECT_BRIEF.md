# Project Brief: Spatial Gesture Control

## Project Goal

Build a cross-platform desktop application that allows users to control laptop, desktop, or projector volume using:

1. Sony WH-1000XM5 headphones for head tracking
2. Samsung Galaxy Watch 4 for wrist, hand, and finger gesture detection
3. A Tauri 2 desktop application as the central coordinator

Primary interaction:

```text
User looks toward the top-right edge of the screen
        ↓
Sony headphones detect head orientation
        ↓
A virtual volume knob appears
        ↓
User performs a pinch gesture
        ↓
User rotates wrist
        ↓
System volume increases or decreases
        ↓
User releases pinch
        ↓
Volume is committed and knob disappears
```

The head-tracking system selects or activates a control.

The watch performs the grab, rotation, and release interaction.

---

# Technology Stack

## Desktop Application

Use:

```text
Tauri 2
Rust
React
TypeScript
Vite
```

Rust handles:

* Sony head-tracking UDP input
* Galaxy Watch WebSocket communication
* State machine
* Quaternion and sensor calculations
* System volume control
* Session logging
* Configuration
* Cross-platform platform adapters

React and TypeScript handle:

* Settings interface
* Device status
* Calibration screens
* Sensor diagnostics
* Virtual volume knob
* Data recording controls
* Live charts

## Galaxy Watch Application

Use:

```text
Android Studio
Kotlin
Jetpack Compose for Wear OS
Samsung Health Sensor SDK
Android SensorManager
OkHttp WebSocket
LiteRT or TensorFlow Lite
```

The watch application will:

* Record accelerometer data
* Record gyroscope data
* Record orientation or rotation-vector data
* Record raw PPG data where available
* Allow gesture dataset collection
* Detect wrist rotation
* Initially use a button as the pinch replacement
* Eventually perform pinch inference on-device
* Send gesture events to the desktop application

## Machine Learning

Use:

```text
Python
NumPy
Pandas
SciPy
PyTorch
scikit-learn
TensorFlow Lite or LiteRT
```

Initial models:

```text
Random Forest
SVM
```

Later models:

```text
1D CNN
CNN-LSTM
```

---

# Supported Desktop Platforms

The desktop application should support:

```text
Windows x86-64
Windows ARM64

macOS x86-64
macOS ARM64
macOS Universal Binary

Linux x86-64
Linux ARM64
```

These are release-roadmap targets. During Milestones 1–2, CI validates one
host architecture per operating-system runner. ARM64 packaging remains a later
release task until dedicated runners are added. The pinned Sony Head Tracker
release currently provides a Windows x64 executable and a macOS universal
binary. Automatic Windows tracker setup is supported on x64 hosts; Windows
ARM64 and x64-emulation behavior are not currently verified.

Maintain one codebase but produce separate native builds for every operating system and architecture.

Build each platform on a compatible CI runner:

```text
Windows build → Windows runner
macOS build   → macOS runner
Linux build   → Linux runner
```

Use GitHub Actions with a platform and architecture build matrix.

---

# System Architecture

```text
Sony WH-1000XM5
        │
        │ Android Head Tracker HID protocol
        ▼
sony-head-tracker
        │
        │ UDP JSON
        │ localhost:4243
        ▼
Tauri 2 Desktop Coordinator
        ▲
        │
        │ WebSocket over local Wi-Fi
        │
Samsung Galaxy Watch 4
        │
        ▼
PPG + IMU + gesture events
```

The Tauri desktop application is the central source of truth.

It receives head orientation from `sony-head-tracker`, receives watch data over WebSocket, controls the interaction state machine, renders the overlay, and changes system volume.

Sony Head Tracker remains an independent executable rather than being compiled
into the Tauri binary. A repository launcher must provide one-command operation:
it starts the headless Sony Head Tracker CLI bridge and Tauri together, and stops
both process trees on exit. The Tauri dashboard is the only user-facing tracker UI.

---

# Sony Head Tracking

Use:

```text
https://github.com/NicholasSlattery/sony-head-tracker
```

Do not communicate directly with the headphones.

Use the local JSON UDP stream provided by the tool.

Pin the launcher integration to upstream release `v2.2.0`. Keep the official
macOS universal and Windows x64 prebuilt executables under `assets/pre-builds/`
and run the matching committed executable directly, without a download, cache,
or extraction step. Launch the CLI bridge with its `bridge` argument so it can
discover the tracker and stream data without opening a native tracker window.
Support `SONY_HEAD_TRACKER_BIN` as an explicit CLI executable override.

Default JSON port:

```text
127.0.0.1:4243
```

The default OpenTrack binary stream is on:

```text
127.0.0.1:4242
```

Use port `4243`.

Example Sony packet:

```json
{
  "version": 2,
  "device": "WH-1000XM5",
  "rotationVector": [0.012, -0.004, 0.31],
  "quaternion": [0.987, 0.006, -0.002, 0.155],
  "yprDegrees": [17.84, -0.46, 1.37],
  "gyroscope": [0.01, 0.0, -0.02],
  "accelerometer": null,
  "angularVelocity": [0.01, 0.0, -0.02],
  "resetCounter": 0,
  "packetsPerSecond": 25.0,
  "receiveLatencyMs": -1.0
}
```

Create a Rust structure:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SonyHeadSample {
    pub version: u32,
    pub device: Option<String>,

    #[serde(rename = "rotationVector")]
    pub rotation_vector: [f64; 3],

    pub quaternion: [f64; 4],

    #[serde(rename = "yprDegrees")]
    pub ypr_degrees: [f64; 3],

    pub gyroscope: Option<[f64; 3]>,
    pub accelerometer: Option<[f64; 3]>,

    #[serde(rename = "resetCounter")]
    pub reset_counter: u64,

    #[serde(rename = "packetsPerSecond")]
    pub packets_per_second: f64,

    #[serde(rename = "receiveLatencyMs")]
    pub receive_latency_ms: f64,
}
```

The UDP reader should:

* Bind to `127.0.0.1:4243`
* Parse one JSON object per datagram
* Ignore unknown JSON fields
* Validate the schema version
* Track packet rate
* Detect missing tracker data
* Detect reset-counter changes
* Publish head-pose events internally

Only one process should bind to the Sony JSON port.

The Tauri application should be that process.

---

# Head Tracking Abstraction

Create a replaceable interface:

```rust
pub trait HeadPoseProvider: Send + Sync {
    async fn start(&self) -> Result<(), HeadPoseError>;
    async fn stop(&self) -> Result<(), HeadPoseError>;
}
```

The initial implementation is:

```text
SonyUdpHeadPoseProvider
```

Possible future implementations:

```text
WebcamHeadPoseProvider
PhoneImuHeadPoseProvider
Esp32HeadPoseProvider
```

The rest of the application must not depend directly on Sony JSON structures.

Convert Sony packets into a generic format:

```rust
pub struct HeadPose {
    pub timestamp_ns: u64,
    pub quaternion: [f64; 4],
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
    pub angular_velocity: Option<[f64; 3]>,
    pub reset_counter: u64,
}
```

---

# Screen Calibration

The application must calibrate head orientation relative to the user's screen.

Calibration targets:

```text
Center
Top-left
Top-right
Bottom-left
Bottom-right
```

For the initial volume interaction, center and top-right are sufficient.

Store a quaternion for every calibrated target.

Example:

```rust
pub struct CalibrationTarget {
    pub name: String,
    pub quaternion: [f64; 4],
}
```

Use quaternion angular distance rather than only fixed yaw and pitch thresholds.

For normalized quaternions:

```text
angular_distance =
2 × acos(abs(dot(current_quaternion, target_quaternion)))
```

Use `nalgebra` for quaternion operations.

The application should:

* Ask the user to face the screen center
* Save the center quaternion
* Ask the user to look at the top-right target
* Save the target quaternion
* Determine the nearest calibrated target during runtime
* Support adjustable activation thresholds
* Support a dwell duration before activation
* Invalidate calibration if the Sony `resetCounter` changes

Default activation dwell:

```text
400 ms
```

This value should be configurable.

---

# Desktop Application Architecture

Recommended structure:

```text
spatial-gesture-control/
│
├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── pages/
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   ├── protocol/
│   │   │   └── main.tsx
│   │   │
│   │   └── src-tauri/
│   │       ├── src/
│   │       │   ├── head_tracking/
│   │       │   ├── watch/
│   │       │   ├── interaction/
│   │       │   ├── volume/
│   │       │   ├── overlay/
│   │       │   ├── calibration/
│   │       │   ├── logging/
│   │       │   ├── config/
│   │       │   ├── events/
│   │       │   ├── app_state.rs
│   │       │   ├── lib.rs
│   │       │   └── main.rs
│   │       └── Cargo.toml
│   │
│   └── galaxy-watch/
│       └── Android Wear OS project
│
├── crates/
│   ├── protocol/
│   ├── sensor-math/
│   ├── interaction-engine/
│   ├── head-tracking/
│   ├── volume-core/
│   └── session-logging/
│
├── ml/
│   ├── data_collection/
│   ├── preprocessing/
│   ├── models/
│   ├── evaluation/
│   └── export/
│
├── datasets/
├── docs/
├── scripts/
└── .github/
    └── workflows/
```

---

# Rust Libraries

Use:

```toml
tokio = { version = "1", features = ["full"] }

serde = { version = "1", features = ["derive"] }
serde_json = "1"

axum = { version = "0.8", features = ["ws"] }

nalgebra = "0.33"

tracing = "0.1"
tracing-subscriber = "0.3"

thiserror = "2"
anyhow = "1"

uuid = { version = "1", features = ["v4", "serde"] }

chrono = { version = "0.4", features = ["serde"] }

csv = "1"

directories = "6"
```

Potential additional libraries:

```text
sqlx or rusqlite
tokio-tungstenite
futures-util
config
toml
```

Use Axum if the application exposes:

```text
GET /health
GET /api/status
GET /api/calibration
GET /api/devices
WS  /ws/watch
```

Use Tokio channels for communication between backend modules:

```text
tokio::sync::mpsc
tokio::sync::watch
tokio::sync::broadcast
```

---

# Shared Application State

Use a central state object:

```rust
pub struct AppState {
    pub head_pose: Option<HeadPose>,
    pub watch_state: WatchState,
    pub interaction_state: InteractionState,
    pub calibration: CalibrationData,
    pub current_volume: f32,
    pub selected_display: Option<String>,
    pub sony_connected: bool,
    pub watch_connected: bool,
}
```

Protect shared state using:

```rust
Arc<RwLock<AppState>>
```

However, prefer event-driven channels for high-frequency sensor updates instead of locking global state for every sample.

---

# Internal Event System

Define events such as:

```rust
pub enum AppEvent {
    SonyConnected,
    SonyDisconnected,
    HeadPoseUpdated(HeadPose),
    HeadTargetEntered(TargetId),
    HeadTargetExited(TargetId),

    WatchConnected,
    WatchDisconnected,
    WatchOrientationUpdated(WatchOrientation),

    PinchStarted { confidence: f32 },
    PinchHeld { confidence: f32 },
    PinchReleased { confidence: f32 },

    WristRotationUpdated { angle_deg: f32 },

    KnobShown,
    KnobGrabbed,
    KnobReleased,
    KnobHidden,

    VolumeChanged { value: f32 },

    CalibrationInvalidated,
}
```

Use an event-driven architecture so head tracking, watch communication, interaction logic, UI, and volume control remain loosely coupled.

---

# Interaction State Machine

Use:

```rust
pub enum InteractionState {
    Idle,
    Targeting,
    KnobVisible,
    KnobGrabbed,
    Adjusting,
    Committed,
}
```

State flow:

```text
IDLE
  │
  │ head enters top-right activation zone
  ▼
TARGETING
  │
  │ head remains in zone for dwell duration
  ▼
KNOB_VISIBLE
  │
  │ watch sends PINCH_STARTED
  ▼
KNOB_GRABBED
  │
  │ wrist begins rotating
  ▼
ADJUSTING
  │
  │ watch sends PINCH_RELEASED
  ▼
COMMITTED
  │
  │ timeout or head leaves target
  ▼
IDLE
```

Required safety behaviour:

* Head movement alone must not change volume
* Wrist rotation alone must not change volume
* Volume changes only while the knob is grabbed
* Pinch release commits the final value
* Turning the head back to the center can cancel the interaction
* Disconnecting the watch must cancel the interaction
* Losing Sony tracking must hide the overlay
* A maximum volume-change rate must be enforced

Suggested defaults:

```text
Head dwell:            400 ms
Rotation dead zone:    5 degrees
Overlay timeout:       2 seconds
Release timeout:       500 ms
Maximum volume rate:   20 points per second
```

All values should be configurable.

---

# Galaxy Watch Communication

Use WebSocket over local Wi-Fi.

Desktop runs a WebSocket server.

Default endpoint:

```text
ws://DESKTOP_IP:PORT/ws/watch
```

The watch is a WebSocket client.

All messages should contain:

```text
type
version
deviceId
sequence
timestampNs
payload
```

Example base structure:

```json
{
  "type": "watch.orientation",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1042,
  "timestampNs": 918273645,
  "payload": {}
}
```

---

# Watch-to-Desktop Messages

## Watch orientation

```json
{
  "type": "watch.orientation",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1042,
  "timestampNs": 918273645,
  "payload": {
    "quaternion": [0.97, 0.02, 0.19, 0.12],
    "accelerometer": [0.12, -0.08, 9.74],
    "gyroscope": [0.03, 0.48, -0.11]
  }
}
```

## Pinch started

```json
{
  "type": "gesture.pinch_started",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1043,
  "timestampNs": 918273710,
  "payload": {
    "confidence": 0.94
  }
}
```

## Pinch held

```json
{
  "type": "gesture.pinch_held",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1044,
  "timestampNs": 918273760,
  "payload": {
    "confidence": 0.91
  }
}
```

## Pinch released

```json
{
  "type": "gesture.pinch_released",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1045,
  "timestampNs": 918273810,
  "payload": {
    "confidence": 0.90
  }
}
```

## Wrist rotation

```json
{
  "type": "gesture.rotation",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1046,
  "timestampNs": 918273850,
  "payload": {
    "angleDegrees": 16.4,
    "angularVelocity": 22.8
  }
}
```

## Heartbeat

```json
{
  "type": "watch.heartbeat",
  "version": 1,
  "deviceId": "galaxy-watch-4",
  "sequence": 1047,
  "timestampNs": 918273900,
  "payload": {
    "batteryPercent": 78
  }
}
```

---

# Desktop-to-Watch Messages

## Connection acknowledgement

```json
{
  "type": "desktop.connected",
  "version": 1,
  "timestampNs": 918274000,
  "payload": {
    "sessionId": "uuid",
    "serverTimeNs": 918274000
  }
}
```

## Start recording

```json
{
  "type": "recording.start",
  "version": 1,
  "timestampNs": 918274100,
  "payload": {
    "label": "pinch_start",
    "durationMs": 2000
  }
}
```

## Stop recording

```json
{
  "type": "recording.stop",
  "version": 1,
  "timestampNs": 918274200,
  "payload": {}
}
```

## Haptic feedback

```json
{
  "type": "watch.haptic",
  "version": 1,
  "timestampNs": 918274300,
  "payload": {
    "pattern": "knob_grabbed"
  }
}
```

---

# Time Synchronization

Sony data is local to the desktop and uses desktop receive time.

Watch data uses the watch monotonic timestamp.

Implement clock-offset estimation:

1. Desktop sends a timestamp
2. Watch responds immediately with its timestamp
3. Desktop calculates round-trip delay
4. Estimate offset using half the round-trip time
5. Repeat several times
6. Use the median offset
7. Periodically resynchronize

Store:

```text
Watch device timestamp
Desktop receive timestamp
Estimated synchronized timestamp
Sequence number
```

Exact synchronization is not initially required for volume control, but it is required for reliable sensor fusion and research-quality logging.

---

# Watch Application Structure

```text
galaxy-watch/
└── app/
    └── src/main/java/
        ├── sensors/
        │   ├── ImuSensorManager.kt
        │   ├── PpgSensorManager.kt
        │   ├── OrientationTracker.kt
        │   └── SensorSynchronizer.kt
        │
        ├── gesture/
        │   ├── PinchDetector.kt
        │   ├── WristRotationTracker.kt
        │   └── GestureStateMachine.kt
        │
        ├── network/
        │   ├── WatchWebSocketClient.kt
        │   ├── ProtocolMessages.kt
        │   └── ClockSynchronizer.kt
        │
        ├── recording/
        │   ├── SessionRecorder.kt
        │   ├── CsvExporter.kt
        │   └── RecordingLabel.kt
        │
        ├── ml/
        │   └── PinchInferenceEngine.kt
        │
        ├── ui/
        │   ├── ConnectionScreen.kt
        │   ├── RecordingScreen.kt
        │   ├── SensorScreen.kt
        │   └── CalibrationScreen.kt
        │
        └── MainActivity.kt
```

---

# Watch Operating Modes

## Control Mode

Send:

```text
Orientation
Wrist rotation
Pinch events
Heartbeat
```

Do not stream raw PPG continuously in production control mode.

## Dataset Mode

Record or stream:

```text
PPG green
PPG red
PPG infrared
Accelerometer XYZ
Gyroscope XYZ
Quaternion
Timestamp
Gesture label
Contact quality
```

## Debug Mode

Display:

```text
Connection state
Sensor values
Sample rate
Pinch confidence
Rotation angle
Battery level
Latency
```

---

# Wrist Rotation

Initially use the watch IMU.

When the knob is grabbed:

```text
Q_start = current watch quaternion
```

During rotation:

```text
Q_relative =
inverse(Q_start) × Q_current
```

Extract rotation around the forearm or intended twist axis.

Map rotation to volume:

```text
-90 degrees → -30 volume points
+90 degrees → +30 volume points
```

Make sensitivity configurable.

Apply:

* Dead zone
* Low-pass smoothing
* Maximum angular velocity filtering
* Maximum volume-change rate
* Clamp output between 0 and 100

Suggested smoothing:

```text
smoothed =
alpha × current +
(1 - alpha) × previous
```

Start with:

```text
alpha = 0.2
```

This value should be configurable.

---

# Pinch Gesture Detection

A Galaxy Watch cannot directly observe finger joints.

Pinch detection must infer movement from:

* PPG changes
* Tendon or muscle movement
* Contact-pressure changes
* Wrist vibration
* Accelerometer data
* Gyroscope data

Initial gesture classes:

```text
Idle
Pinch start
Pinch hold
Pinch release
```

Later classes:

```text
Double pinch
Fist
Index-thumb tap
Middle-thumb tap
```

Do not begin with many gestures.

---

# Button-Based Prototype

Before ML pinch detection works, use a watch UI button as the grab control.

Initial full interaction:

```text
Look at top-right
        ↓
Virtual knob appears
        ↓
Press and hold watch button
        ↓
Rotate wrist
        ↓
Volume changes
        ↓
Release button
        ↓
Knob commits and disappears
```

This milestone must be completed before training the pinch model.

It validates:

* Head activation
* Watch communication
* Wrist rotation
* Virtual knob
* Volume control
* State machine
* Latency

---

# Gesture Dataset

Required gesture labels:

```text
idle
pinch_start
pinch_hold
pinch_release
```

Required negative activity examples:

```text
walking
typing
using_mouse
touching_face
adjusting_headphones
picking_up_cup
scratching
normal_wrist_rotation
standing
sitting
```

Recommended CSV format:

```csv
timestamp_ns,
sequence,
ppg_green,
ppg_red,
ppg_ir,
accel_x,
accel_y,
accel_z,
gyro_x,
gyro_y,
gyro_z,
quat_w,
quat_x,
quat_y,
quat_z,
contact_quality,
label
```

For an initial personal prototype:

```text
One participant
Multiple recording sessions
Different watch tightness
Sitting and standing
At least 50-100 repetitions per class
```

For research:

```text
10-20 participants
Multiple sessions
Both wrists where possible
Different movement conditions
```

---

# Machine Learning Pipeline

```text
Raw recordings
        ↓
Signal cleaning
        ↓
Timestamp synchronization
        ↓
Window segmentation
        ↓
Feature extraction
        ↓
Baseline model
        ↓
Deep-learning model
        ↓
Evaluation
        ↓
LiteRT/TFLite export
        ↓
On-watch inference
```

Suggested window parameters:

```text
Window size: 0.5-2 seconds
Initial window: 1 second
Overlap: 50%
```

Baseline features:

```text
Mean
Standard deviation
RMS
Peak-to-peak amplitude
Signal energy
First derivative energy
Dominant frequency
Spectral entropy
Axis correlation
```

Baseline models:

```text
Random Forest
SVM
```

Later models:

```text
1D CNN
CNN-LSTM
```

Pinch event logic should use temporal confirmation:

```text
Pinch starts when:
confidence > threshold
for multiple consecutive windows

Pinch releases when:
release confidence > threshold
or pinch confidence remains low
for a configured duration
```

The final watch application should emit events rather than raw classifications:

```text
PINCH_STARTED
PINCH_HELD
PINCH_RELEASED
```

---

# Virtual Knob Overlay

Use a dedicated Tauri window.

The application should have:

```text
Main window
Overlay window
```

## Main Window

Contains:

* Device status
* Calibration
* Settings
* Sensor diagnostics
* Recording controls
* Live graphs
* Logs
* Platform configuration

## Overlay Window

Requirements:

* Transparent
* Borderless
* Always on top
* Does not steal keyboard focus
* Click-through when inactive
* Appears on the selected display
* Shows current volume
* Shows grabbed state
* Shows rotation direction
* Automatically hides

Overlay state:

```rust
pub struct OverlayState {
    pub visible: bool,
    pub grabbed: bool,
    pub volume: f32,
    pub rotation_angle: f32,
    pub screen_x: f64,
    pub screen_y: f64,
}
```

Potential visual feedback:

```text
Current volume percentage
Circular progress
Grabbed highlight
Clockwise arrow
Anticlockwise arrow
Connection-loss warning
```

Use SVG or Canvas for the knob.

Use Framer Motion for animations if needed.

---

# React Frontend

Recommended structure:

```text
src/
├── pages/
│   ├── Dashboard.tsx
│   ├── Calibration.tsx
│   ├── Devices.tsx
│   ├── Recordings.tsx
│   └── Settings.tsx
│
├── components/
│   ├── VolumeKnob.tsx
│   ├── HeadPoseViewer.tsx
│   ├── WatchStatus.tsx
│   ├── SonyStatus.tsx
│   ├── SensorChart.tsx
│   └── ConnectionIndicator.tsx
│
├── stores/
│   ├── deviceStore.ts
│   ├── interactionStore.ts
│   └── settingsStore.ts
│
├── hooks/
│   ├── useTauriEvents.ts
│   └── useDeviceStatus.ts
│
└── protocol/
    └── events.ts
```

Use:

```text
Zustand for frontend state
uPlot for high-frequency charts
SVG or Canvas for the knob
```

Avoid Redux unless the frontend becomes significantly more complex.

---

# Volume Control Architecture

Create a common Rust trait:

```rust
pub trait VolumeController: Send + Sync {
    fn get_volume(&self) -> Result<f32, VolumeError>;
    fn set_volume(&self, volume: f32) -> Result<(), VolumeError>;
    fn get_muted(&self) -> Result<bool, VolumeError>;
    fn set_muted(&self, muted: bool) -> Result<(), VolumeError>;
}
```

Implement:

```text
MacOsVolumeController
WindowsVolumeController
LinuxVolumeController
ProjectorVolumeController
```

Normalize volume:

```text
0.0 to 1.0 internally
0 to 100 in the UI
```

---

# Windows Volume Control

Use the Rust `windows` crate.

Use Windows Core Audio APIs:

```text
IMMDeviceEnumerator
IMMDevice
IAudioEndpointVolume
```

Support:

* Get master volume
* Set master volume
* Get mute state
* Set mute state
* Detect default output-device changes

---

# macOS Volume Control

Initial prototype:

```bash
osascript -e 'set volume output volume 50'
```

Read volume:

```bash
osascript -e 'output volume of (get volume settings)'
```

Production implementation:

```text
Core Audio
coreaudio-sys
or a small Swift/Objective-C bridge
```

The production application should avoid invoking AppleScript for every high-frequency volume update.

---

# Linux Volume Control

Support PipeWire first.

Prototype command:

```bash
wpctl set-volume @DEFAULT_AUDIO_SINK@ 50%
```

Fallback:

```bash
pactl set-sink-volume @DEFAULT_SINK@ 50%
```

Detect which backend is available:

```text
PipeWire / wpctl
PulseAudio / pactl
```

Later, direct PipeWire integration can replace command execution.

---

# Projector Control

Treat projector support as a plugin system.

Possible adapters:

```text
LaptopVolumeController
HdmiCecController
PjLinkController
Rs232Controller
VendorNetworkController
InfraredController
```

The initial projector behaviour should simply control the laptop's HDMI audio output volume.

Direct projector volume support can be added later.

---

# Volume Adapter Factory

Example:

```rust
pub fn create_volume_controller() -> Box<dyn VolumeController> {
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsVolumeController::new())
    }

    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsVolumeController::new())
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxVolumeController::new())
    }
}
```

Keep platform-specific code in separate modules.

---

# Configuration

Store configuration in the application data directory.

Example:

```json
{
  "sony": {
    "host": "127.0.0.1",
    "jsonPort": 4243
  },
  "watch": {
    "webSocketPort": 8766,
    "heartbeatTimeoutMs": 3000
  },
  "interaction": {
    "activationTarget": "top_right",
    "headDwellMs": 400,
    "rotationDeadzoneDegrees": 5,
    "volumePointsPer90Degrees": 30,
    "overlayTimeoutMs": 2000,
    "maximumVolumePointsPerSecond": 20
  },
  "overlay": {
    "alwaysOnTop": true,
    "clickThrough": true
  }
}
```

Calibration data should be stored separately.

---

# Session Logging

Log every important event.

Store:

```text
Sony orientation
Sony reset counter
Watch orientation
Watch accelerometer
Watch gyroscope
PPG when recording
Gesture probabilities
Gesture events
Interaction-state transitions
Volume changes
Communication latency
Device connection changes
Timestamps
```

Use structured logs with `tracing`.

For development, log to readable text.

For sensor recordings, use CSV or SQLite.

Recommended:

```text
Application logs → tracing
Settings → JSON
Calibration → JSON
Session metadata → SQLite
Raw ML recordings → CSV or binary format
```

---

# Error Handling

Use typed errors with `thiserror`.

Examples:

```rust
pub enum HeadTrackingError {
    SocketBindFailed,
    InvalidPacket,
    UnsupportedVersion,
    TrackerDisconnected,
}

pub enum WatchError {
    ConnectionFailed,
    InvalidMessage,
    HeartbeatTimeout,
    ClockSyncFailed,
}

pub enum VolumeError {
    BackendUnavailable,
    DeviceUnavailable,
    ReadFailed,
    WriteFailed,
}
```

The UI should clearly show:

```text
Sony tracker disconnected
Watch disconnected
Calibration invalid
Volume backend unavailable
Unsupported platform
Sensor data unavailable
```

The application must fail gracefully.

---

# Security

Sony UDP input is loopback-only.

Do not expose the Sony UDP port over the network.

The Galaxy Watch WebSocket should initially be local-network-only.

Later add:

```text
Pairing code
Device authorization
Session token
Optional TLS
Allowed-device list
```

Do not accept control events from unknown network devices.

---

# Development Milestones

## Milestone 1: Tauri Project Setup

Create:

```text
Tauri 2
React
TypeScript
Vite
Rust workspace
```

Add:

* Main window
* Basic settings page
* Structured logging
* Shared protocol crate
* CI skeleton

Success criterion:

```text
Application builds and starts on the current platform.
```

## Milestone 2: Sony UDP Reader

Implement:

* UDP listener on port 4243
* Sony JSON parsing
* Device connection status
* Display yaw, pitch, roll
* Display quaternion
* Display packet rate
* Detect reset-counter changes
* One-command launcher for the separate Sony Head Tracker UI and Tauri application
* Committed Sony Head Tracker UI prebuilds for macOS universal and Windows x64

Success criterion:

```text
`npm start` launches both processes, and moving the XM5 updates live data in the
Tauri UI.
```

## Milestone 3: Head Calibration

Implement:

* Center calibration
* Top-right calibration
* Quaternion distance
* Activation threshold
* Dwell detection
* Recalibration prompt after reset-counter changes

Success criterion:

```text
Looking at top-right reliably emits HeadTargetEntered.
```

## Milestone 4: Virtual Volume Knob

Implement:

* Transparent overlay window
* Always-on-top behaviour
* Show and hide commands
* Keyboard-controlled volume simulation
* Display current volume
* Smooth animation

Success criterion:

```text
Looking at top-right displays the virtual knob.
```

## Milestone 5: Native Volume Control

Implement one platform first.

Recommended first target:

```text
macOS if developing on Mac
Windows if developing on Windows
```

Success criterion:

```text
Keyboard input through the virtual knob changes real system volume.
```

## Milestone 6: Watch WebSocket Connection

Implement:

* Axum WebSocket server
* Device connection
* Heartbeat
* Message parsing
* Time synchronization
* Watch status in UI

Success criterion:

```text
Galaxy Watch connects and streams IMU data to the desktop.
```

## Milestone 7: Watch Button Grab

Implement the complete interaction without pinch ML:

```text
Look at top-right
Show knob
Hold watch button
Rotate wrist
Change volume
Release button
Hide knob
```

Success criterion:

```text
Full interaction works reliably using a button.
```

## Milestone 8: Wrist Rotation

Implement:

* Relative quaternion
* Forearm twist extraction
* Dead zone
* Smoothing
* Sensitivity configuration
* Volume rate limit
* Haptic feedback

Success criterion:

```text
Wrist rotation controls the volume smoothly.
```

## Milestone 9: Dataset Recorder

Implement on-watch recording:

* PPG
* Accelerometer
* Gyroscope
* Quaternion
* Labels
* CSV export
* Session metadata

Success criterion:

```text
Labeled gesture datasets can be collected and exported.
```

## Milestone 10: Pinch Classifier

Implement:

* Preprocessing
* Windowing
* Baseline model
* Evaluation
* False-activation testing
* TFLite or LiteRT export

Success criterion:

```text
Pinch start and release are detected with acceptable false-positive rates.
```

## Milestone 11: On-Watch Inference

Replace button events with:

```text
PinchStarted
PinchHeld
PinchReleased
```

Success criterion:

```text
Complete interaction works without touching the watch screen.
```

## Milestone 12: Cross-Platform Adapters

Add:

```text
Windows volume adapter
macOS volume adapter
Linux volume adapter
```

Success criterion:

```text
The same interaction works on every supported desktop OS.
```

## Milestone 13: Packaging and CI

Create:

```text
Windows x86-64 build
Windows ARM64 build
macOS x86-64 build
macOS ARM64 build
macOS universal build
Linux x86-64 build
Linux ARM64 build
```

Add:

* GitHub Actions matrix
* Artifact generation
* Release workflow
* Code signing placeholders
* Platform installation documentation

---

# Testing Strategy

## Unit Tests

Test:

```text
Sony JSON parsing
Quaternion angular distance
Target detection
State transitions
Rotation-to-volume mapping
Volume clamping
WebSocket message parsing
Configuration loading
```

## Integration Tests

Test:

```text
Mock Sony UDP stream
Mock watch WebSocket client
Head target activation
Button-grab workflow
Watch disconnect during adjustment
Sony reset during adjustment
Volume backend failure
```

## Hardware Tests

Test:

```text
Sony WH-1000XM5 on Windows
Sony WH-1000XM5 on macOS
Galaxy Watch 4 streaming
Different watch tightness
Different user positions
Multiple monitors
Bluetooth reconnect
Wi-Fi reconnect
Laptop sleep and resume
```

---

# Important Design Principles

1. Tauri desktop application is the central source of truth.

2. Keep head tracking behind a `HeadPoseProvider` abstraction.

3. Keep system volume control behind a `VolumeController` abstraction.

4. Use event-driven communication between backend components.

5. Do not allow head motion alone to change volume.

6. Do not allow watch motion alone to change volume.

7. Require explicit grab state before volume adjustment.

8. Complete the watch-button prototype before pinch ML.

9. Keep platform-specific code isolated.

10. Build and test one milestone at a time.

11. Avoid streaming raw PPG during normal control mode.

12. Perform pinch inference on the watch in the final system.

13. Use normalized quaternions for orientation calculations.

14. Invalidate calibration when the Sony reference frame resets.

15. Prioritize low false-positive rates over maximum gesture accuracy.

---

# Initial Implementation Priority

Start with the desktop application only.

Order:

```text
1. Create Tauri 2 application
2. Implement Sony UDP receiver
3. Display head orientation
4. Add head calibration
5. Detect top-right activation
6. Add transparent volume-knob overlay
7. Add keyboard-controlled volume
8. Add native volume control
9. Add Galaxy Watch WebSocket server
10. Add button-based grab
11. Add wrist rotation
12. Add PPG dataset collection
13. Add pinch ML
```

Do not begin the pinch model before the button-controlled complete interaction works.

---

# Initial Hermes Development Task

Begin by scaffolding the repository and implementing Milestones 1 and 2.

Required output:

```text
Tauri 2 desktop app
React + TypeScript frontend
Rust backend
Sony UDP listener on 127.0.0.1:4243
Strongly typed Sony JSON parser
Tauri events from Rust to React
Dashboard showing:
- Sony connection status
- Device name
- Yaw
- Pitch
- Roll
- Quaternion
- Gyroscope
- Packet rate
- Receive latency
- Reset counter
Structured logging
Basic tests for Sony packet parsing
README with setup and run instructions
```

The first implementation should not yet include:

```text
Galaxy Watch communication
Machine learning
Volume control
Overlay window
Projector control
```

Design the code so these modules can be added later without refactoring the Sony input pipeline.
