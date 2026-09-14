# Third-party notices — vendored sony-head-tracker engine/bridge sources

## Provenance

- Upstream repository: <https://github.com/NicholasSlattery/sony-head-tracker>
- Pinned revision: `602bde785541b80d6e4bbafa48b01adab95ca967`
- Snapshot date: 2026-09-14
- License evidence: the upstream repository's checked-out `LICENSE` file at the
  pinned revision (reproduced verbatim below and in `LICENSE-UPSTREAM`) is MIT.
  GitHub's repository-metadata license detector reports `NOASSERTION` for this
  project, so this file — not the GitHub UI badge — is the provenance record.

## Scope of this snapshot

This directory contains only the upstream engine and bridge sources needed to
build a native head-tracking provider, copied unmodified from the pinned
revision:

- `include/sony_head_tracker/*` — cross-platform engine headers (orientation
  math, HID descriptor parsing, device/protocol types, Bluetooth recovery,
  diagnostics).
- `src/*.cpp` — cross-platform and Windows-HID engine sources.
- `src/macos/*` — macOS engine sources (HID backend, Bluetooth recovery,
  logging, config persistence).
- `macos/Bridge/sony_head_tracker_c.h` and `sony_head_tracker_c.mm` — the
  upstream stable C ABI referenced by the cross-platform plan.

Deliberately excluded: the upstream SwiftUI/GUI application, its CLI/app entry
points (`src/main.cpp`, `src/macos/main_macos.cpp`, `src/gui.cpp`,
`include/sony_head_tracker/gui.hpp`), its own build scripts, tests, benchmarks,
CI configuration, and packaging assets. This repository owns its own FFI
contract, build wiring, and tests around the vendored engine (see
`crates/native-head-tracking`); the upstream GUI, CLI, and build system are
not part of the product surface here.

## Update policy

This snapshot is not auto-updated. Any future update must repin an explicit
upstream revision, re-copy only the needed files, and be reviewed and tested
before merge.

## License

MIT License

Copyright (c) 2026 Nicholas Slattery and the Sony Head Tracker contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
