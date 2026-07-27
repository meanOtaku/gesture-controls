# Spatial Head Tracking for macOS

Native macOS application that captures compatible headphone motion data
directly through IOHID and renders our own SwiftUI interface.

## Development requirements

- macOS 14 or newer
- full Xcode
- a paired WH-1000XM5 with current firmware
- Input Monitoring permission

The current machine has Command Line Tools selected, not full Xcode. After
installing Xcode, select it:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

Then verify:

```bash
xcodebuild -version
```

## Planned build flow

The checked-in XcodeGen specification is the source of truth for the project:

```bash
cd native-macos
xcodegen generate
open SpatialHeadTracking.xcodeproj
```

The application requires:

**System Settings → Privacy & Security → Input Monitoring**

Restart the application after granting permission.
