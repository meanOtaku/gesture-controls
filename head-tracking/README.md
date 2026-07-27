# Spatial Head Tracking

First-party head-tracking application for the Spatial Gesture Volume
Controller. It connects directly to the Android Head Tracker HID sensor exposed
by compatible Sony headphones. It does **not** require SonyHeadTracker.app, a
UDP bridge, or the Samsung Health Sensor SDK.

## Projects

- `native-macos/` — native SwiftUI application and macOS IOHID backend
- `src/sony_head_tracking/` — earlier UDP protocol monitor, retained only as a
  development and interoperability tool

## Native macOS application

The application is being built around the protocol rather than Sony model
numbers:

- HID usage page `0x20`
- top-level usage `0xE1`
- `#AndroidHeadTracker#` sensor-description marker
- rotation-vector usage `0x0544`
- angular-velocity usage `0x0545`
- reset-counter usage `0x0546`

See [native-macos/README.md](native-macos/README.md) for setup.

## Independence and attribution

The design is informed by the MIT-licensed
[`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker)
project and Android's public Head Tracker HID specification. Any adapted source
will retain the required MIT notice in `THIRD_PARTY_NOTICES.md`.

This is an unofficial application and is not affiliated with or endorsed by
Sony.
