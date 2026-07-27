# Head-tracking architecture

```text
WH-1000XM5
    │ Bluetooth HID
    ▼
macOS IOHID backend
    │ raw descriptor values
    ▼
Head Tracker protocol decoder
    │ rotation vector + gyroscope
    ▼
Orientation engine
    │ quaternion + yaw/pitch/roll
    ├──► SwiftUI diagnostics and calibration UI
    └──► Desktop coordinator event interface
```

## Module boundaries

### `HeadTrackingCore`

Platform-independent value types and math:

- raw motion samples
- quaternion normalization and composition
- axis mapping
- recentering
- Euler-angle conversion
- smoothing

### `MacHeadTracking`

macOS hardware implementation:

- discover usage `0x20:0xE1` with `IOHIDManager`
- verify the `#AndroidHeadTracker#` marker
- inspect descriptor-defined feature and input elements
- configure power, event reporting, and sample interval
- capture rotation-vector and gyroscope reports
- surface permission, disconnection, and stalled-stream errors

### `SpatialHeadTrackingApp`

Our SwiftUI application:

- connection state and device inspection
- live orientation visualization
- yaw, pitch, roll, gyro, sample rate, and latency
- recenter action
- center and corner calibration
- activation-zone preview

## Cross-platform direction

The protocol decoder and orientation engine must not import Apple frameworks.
A future Windows backend can implement the same sensor-provider interface using
Windows HID APIs without changing calibration or interaction logic.
