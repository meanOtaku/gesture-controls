# sony-head-tracker-sys

An isolated Rust crate that statically builds a callback-only, in-process C++20
Sony Android Head Tracker engine.

Supported native backends:

- Windows 11: descriptor-validated raw HID, then Windows Sensor API fallback.
- macOS 14+: descriptor-validated IOHID.
- Other targets: compiling unsupported stub; `start()` reports
  `EngineError::Unsupported` and emits `Status::Unsupported`.

The native engine does not spawn a process and contains no UDP output. Device
labels and samples are copied into owned Rust values before user callbacks run.
Native final teardown releases the Rust callback context, including when final
engine deletion is deferred because a callback dropped the last tracker owner.
See `../../third_party/sony-head-tracker/README.md` for upstream provenance.
