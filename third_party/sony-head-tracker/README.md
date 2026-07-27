# Vendored Sony Head Tracker native core

This directory contains the minimal native sources used by the in-process
`sony-head-tracker-sys` crate.

- Upstream: https://github.com/NicholasSlattery/sony-head-tracker
- Release tag: `v2.2.0`
- Commit: `e351e9d98b4ab83973f10c502a2294737c1eb729`
- License: MIT (the complete upstream text is in `LICENSE`)

The `include/` and `src/` files originate from that revision. Three narrowly
scoped safety patches are maintained in this vendored copy:

- Windows revalidates the reopened HID identity, usage, Android marker, and
  report sizes before any feature-report write.
- macOS rejects zero-length and greater-than-64-KiB input reports before
  allocating callback buffers.
- Windows Sensor API sampling uses `ISensorEvents` instead of synchronous
  `ISensor::GetData`; leave/unavailable callbacks end the connected state so
  shutdown and reconnection remain bounded.

The crate adds a separate callback-only C ABI and supervisor; it does not vendor
the upstream executable, GUI, UDP output, configuration, diagnostics, Bluetooth
repair, or audio-wake code. On Windows, the integration intentionally omits the
upstream Bluetooth repair/probing implementation and uses the validated HID
product label instead.
