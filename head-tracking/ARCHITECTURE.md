# Head-tracking architecture

## Active production boundary

```text
Sony headset
    │ Android Head Tracker HID
    ▼
external sony-head-tracker v2.2.0
    │ protocol-v2 JSON over 127.0.0.1:4243/UDP
    ▼
SonyUdpHeadPoseProvider
    │ provider-neutral HeadPose events
    ▼
interaction-engine quaternion calibration and dwell detection
    │ HeadTargetEntered / HeadTargetExited
    ▼
Tauri coordinator -> React diagnostics and calibration workflow
```

The external upstream process owns HID discovery, descriptor validation,
permissions, recovery, orientation, and UDP serialization. The Tauri application
does not import IOHID/Windows HID APIs or link Sony acquisition code.

`scripts/run-system.mjs` is an operator launcher, not a provider. It selects the
committed native UI prebuild, starts it alongside Tauri, and cleans both process
trees up together.

## Provider boundary

`crates/head-tracking` defines the replaceable provider interface and currently
implements `SonyUdpHeadPoseProvider`. `crates/protocol` validates protocol-v2
Sony packets and converts them into provider-neutral pose values.
`crates/interaction-engine` stores center/top-right calibration quaternions,
computes shortest quaternion angular distance with `nalgebra`, applies the
configurable activation threshold and dwell, and invalidates calibration when
the Sony reference frame resets.

Future providers can implement the same interface without changing calibration
or interaction logic:

- webcam pose
- phone IMU
- ESP32 pose

## Historical native experiment

`head-tracking/native-macos/` contains an earlier first-party Swift/IOHID
experiment. Its modules (`HeadTrackingCore`, `MacHeadTracking`, and
`SpatialHeadTrackingApp`) are retained only as protocol and UI reference
material. They are not built, launched, or packaged by the active system.
