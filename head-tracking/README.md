# Head-tracking compatibility and reference material

Production Sony tracking now runs inside the Tauri backend through
`crates/sony-head-tracker-sys` and `crates/head-tracking`. Users do not install,
launch, or authorize a separate tracker application or sidecar.

This directory is retained for development compatibility and historical protocol
reference:

- `scripts/send_sample.py` and `src/sony_head_tracking/` — protocol-v2 UDP
  simulator/model code used only when `SGC_HEAD_TRACKER_SOURCE=udp` is selected.
- `native-macos/` — earlier SwiftUI/IOHID experiment retained as implementation
  reference; it is not part of the packaged runtime and is not the normal way to
  run the project.

The integrated native engine discovers devices by protocol identity rather than
Sony model number:

- HID usage page `0x20`
- top-level usage `0xE1`
- `#AndroidHeadTracker#` sensor-description marker
- rotation-vector usage `0x0544`
- angular-velocity usage `0x0545`
- reset-counter usage `0x0546`

The implementation is derived from the MIT-licensed
[`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker)
project and Android's public Head Tracker HID specification. The exact vendored
revision and complete MIT notice are under `third_party/sony-head-tracker/`.

This is an unofficial application and is not affiliated with or endorsed by
Sony.
