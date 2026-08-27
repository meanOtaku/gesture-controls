# Historical native macOS head-tracking experiment

> Reference-only: this Swift/IOHID application is not the production provider,
> is not started by `npm start`, and is not packaged with Tauri.

The active architecture uses the separate upstream `sony-head-tracker` v2.2.0
process and receives its protocol-v2 JSON stream over loopback UDP. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).

This directory preserves an earlier experiment that captures compatible
headphone motion directly through IOHID and renders a SwiftUI interface. Keep it
for protocol comparison and possible future research; do not treat it as setup
instructions for the complete Spatial Gesture Control system.

## Historical development requirements

- macOS 14 or newer
- full Xcode
- a paired compatible Sony headset with current firmware
- Input Monitoring permission
- XcodeGen

Historical project generation flow:

```bash
cd tools/sony-head-tracker/native-macos
xcodegen generate
open SpatialHeadTracking.xcodeproj
```

For the supported external-process workflow, return to the repository root and
run:

```bash
npm start
```
