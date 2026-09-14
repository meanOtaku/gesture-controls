SPATIAL GESTURE CONTROL - RUNNING THE PROJECT
================================================

On Linux, the production development workflow uses two independent processes:

1. Sony Head Tracker owns Bluetooth/HID access and sends protocol-v2 JSON to
   127.0.0.1:4243.
2. The Tauri application owns the UDP listener, pose state, and user interface.

You do not need to start them separately. The repository launcher starts and
stops both with one command.

On macOS and Windows, there is only one process: the native
`native-head-tracking` crate (IOKit/IOBluetooth on macOS, HID/SetupAPI on
Windows) is linked into the Tauri binary and owns Bluetooth/HID access
directly. `SONY_HEAD_TRACKER_PROVIDER=external` restores the two-process
behavior above as a documented recovery fallback on either platform. See
sections 3 and 4 below.

Repository:
https://github.com/meanOtaku/gesture-controls


1. COMMON REQUIREMENTS
----------------------

All systems require:

- Git
- Node.js 20 or newer; Node.js 22 LTS is recommended
- npm
- Current stable Rust installed through rustup
- Tauri 2 prerequisites for the host OS
- A graphical desktop session

Install repository dependencies once:

  npm ci

Run the complete system:

  npm start

The repository includes the official Sony Head Tracker v2.2.0 prebuilds under:

  tools/sony-head-tracker/prebuilds/

The launcher selects the macOS universal or Windows x64 UI executable directly.
There is no download, cache, extraction, or separate setup command.
The UI is started without command-line arguments. While open, it discovers the
headset, displays live diagnostics, emits OpenTrack data on port 4242, and emits
protocol-v2 JSON on port 4243. Tauri listens only on 127.0.0.1:4243.

Ctrl+C, closing Tauri, or a tracker failure causes the launcher to stop both
process trees. Sony Head Tracker remains a separate executable; it is not linked
into or bundled inside the Tauri binary.


2. OPTIONAL TRACKER OVERRIDE
----------------------------

Set SONY_HEAD_TRACKER_BIN to use an existing compatible UI executable instead of the
committed prebuild.

macOS:

  SONY_HEAD_TRACKER_BIN=/absolute/path/to/SonyHeadTracker.app/Contents/MacOS/SonyHeadTracker npm start

Windows PowerShell:

  $env:SONY_HEAD_TRACKER_BIN = "C:\absolute\path\sony-head-tracker.exe"
  npm start

Paths containing spaces are supported. The executable must open its UI and begin
streaming when launched without command-line arguments.


3. macOS SETUP
--------------

Requirements:

- macOS 14 or newer
- Xcode Command Line Tools (needed to build `crates/native-head-tracking`'s
  vendored C++/Objective-C++ sources; see `crates/native-head-tracking/build.rs`)

Install the command-line tools if necessary:

  xcode-select --install

Then run:

  npm start

This builds and starts Spatial Gesture Control as a single process. The
native provider (`crates/native-head-tracking`) owns Bluetooth/IOKit
acquisition directly; no separate Sony executable is launched and there is no
approve-on-first-run step for a bundled tracker binary.

3.1 GRANTING INPUT MONITORING (macOS)
--------------------------------------

macOS gates HID sensor access behind the Input Monitoring privacy permission,
and the running app -- not a separate tracker process -- is what needs it now:

1. Launch the app once with `npm start`. Until permission is granted, the
   Headphones tab shows the "Input Monitoring permission needed" diagnostic
   (`head-tracker-diagnostic` event, id `permission-denied`; see
   `apps/desktop/src-tauri/src/head_pose.rs`) instead of connecting.
2. Open System Settings -> Privacy & Security -> Input Monitoring.
3. Enable **Spatial Gesture Control**.
4. Quit the app fully and run `npm start` again.

Unlike the old CLI bridge, this permission is tied to the Tauri app's own
code signature. A `cargo build`/`npm start` development build and an official
signed release build are different signatures, so switching between them (or
rebuilding an unsigned/ad-hoc-signed binary) can require re-granting the
permission. A stable, signed release build does not normally need to be
re-granted.

3.2 RECOVERY: FALLING BACK TO THE EXTERNAL CLI BRIDGE
-------------------------------------------------------

If the native provider cannot acquire the headset (for example, a native
build/link problem, or to compare behavior against the old path), set
SONY_HEAD_TRACKER_PROVIDER=external to use the same two-process CLI bridge
Windows and Linux use:

  SONY_HEAD_TRACKER_PROVIDER=external npm start

This follows the "OPTIONAL TRACKER OVERRIDE" and general Input Monitoring
steps in sections 1-2 above, granted to the bundled
`sony-head-tracker-macos` CLI executable (or a custom `SONY_HEAD_TRACKER_BIN`)
instead of to Spatial Gesture Control itself. Do not grant Input Monitoring
to both the app and the CLI bridge as a default setup step; grant it to
whichever one you are actually running.

If no verified tracker appears (native or external):

- Confirm the headset is paired and connected.
- Update its firmware using Sony Sound Connect.
- Temporarily disconnect phones or other multipoint hosts.
- Power-cycle the headset.
- Confirm the correct binary (the app itself for native, or the CLI bridge
  for the external fallback) has Input Monitoring granted.
- Use the upstream probe and troubleshooting documentation when necessary.

**Not yet exercised with physical hardware in this repository's own testing:**
the permission-grant flow above, device discovery/reconnect, and the
native-vs-external fallback switch have been verified by code review and the
no-hardware CI smoke tests in `crates/native-head-tracking/tests/ffi_macos.rs`
(run on `macos-14` in CI), not by running against a physical Sony headset. See
`docs/release-readiness.md` for the outstanding physical-validation checklist
items before calling this hardware-validated.


4. WINDOWS x64 SETUP
--------------------

Requirements:

- Windows 11 x64 (the native provider and the pinned upstream Windows release
  are both x64-only)
- Microsoft C++ Build Tools with Desktop development with C++ (MSVC; needed
  to build `crates/native-head-tracking`'s vendored HID/SetupAPI sources --
  the mingw/gnu Rust toolchain is not supported, see
  `crates/native-head-tracking/build.rs`)
- Microsoft Edge WebView2 Evergreen Runtime
- Rust through rustup (the `*-pc-windows-msvc` target)

After installing prerequisites, open a new PowerShell window and run:

  npm ci
  npm start

This builds and starts Spatial Gesture Control as a single process. The
native provider (`crates/native-head-tracking`) owns HID/SetupAPI
acquisition directly; no separate Sony executable is launched.

Windows ARM64 and x64-emulation behavior are not currently verified.

4.1 IF THE SENSOR NODE IS MISSING (WINDOWS)
--------------------------------------------

If Windows pairs the headset but does not create the head-tracker sensor
node, the dashboard shows a "Head tracker device access denied" diagnostic
(`head-tracker-diagnostic` event, id `permission-denied`; see
`apps/desktop/src-tauri/src/head_pose.rs`). Follow Sony Head Tracker's
documented Repair Tracker instructions yourself, then rerun `npm start`. The
one-command launcher does not silently perform elevated driver repair.

4.2 RECOVERY: FALLING BACK TO THE EXTERNAL CLI BRIDGE (WINDOWS)
------------------------------------------------------------------

If the native provider cannot acquire the headset (for example, a native
build/link problem, or to compare behavior against the old path), set
SONY_HEAD_TRACKER_PROVIDER=external to use the same two-process CLI bridge
Linux uses:

  $env:SONY_HEAD_TRACKER_PROVIDER = "external"
  npm start

This follows the "OPTIONAL TRACKER OVERRIDE" steps in section 2 above if you
also need a custom `SONY_HEAD_TRACKER_BIN`.

**Not yet exercised with physical hardware in this repository's own testing:**
the native-vs-external fallback switch, device discovery/reconnect, and the
sensor-node-missing diagnostic have been verified by code review and the
no-hardware CI smoke tests in
`crates/native-head-tracking/tests/ffi_windows.rs` (run on `windows-2022` in
CI), not by running against a physical Sony headset. See
`docs/release-readiness.md` for the outstanding physical-validation checklist
items before calling this hardware-validated.


5. LINUX SETUP
--------------

Install the normal Tauri dependencies for your distribution. Debian/Ubuntu:

  sudo apt update
  sudo apt install -y \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    pkg-config

Upstream Sony Head Tracker v2.2.0 has no Linux hardware backend, so npm start
reports that automatic Sony setup is unsupported. For UI/UDP development use:

Terminal 1:

  npm run tauri -- dev

Terminal 2:

  python3 tools/sony-head-tracker/scripts/send_sample.py

The sample sends one packet. Run it repeatedly to keep producing updates.


6. MANUAL DEVELOPMENT COMMANDS
------------------------------

Run only Tauri, without managing a tracker:

  npm run tauri -- dev

Build the desktop application for the current platform:

  npm run tauri -- build

Preview only the React frontend:

  npm run dev --workspace @spatial-gesture/desktop

Frontend preview does not start Rust, UDP, Tauri IPC, or Sony Head Tracker.


7. TESTS AND QUALITY CHECKS
---------------------------

Frontend, launcher, icon, and resource tests:

  npm test

Launcher tests only:

  npm run test:launcher

TypeScript and frontend production build:

  npm run typecheck
  npm run build

Rust protocol and UDP provider tests:

  cargo test -p spatial-protocol -p head-tracking --all-targets

Rust formatting and linting:

  cargo fmt --all -- --check
  cargo clippy -p spatial-protocol -p head-tracking \
    --all-targets --all-features -- -D warnings

Python compatibility tests:

  uv run --directory tools/sony-head-tracker --with pytest pytest -q

Continuous integration runs the JavaScript tests, typecheck, frontend build,
Rust formatting, and platform-independent Rust tests in the `quality` job on
Ubuntu. Dedicated `native-head-tracking-macos` (`macos-14`) and
`native-head-tracking-windows` (`windows-2022`) jobs build and link the real
native providers (`crates/native-head-tracking` against the vendored
`third_party/sony-head-tracker` sources) and run their no-hardware FFI smoke
tests -- the only CI coverage that actually compiles each native path, since
the `quality` job only compiles its target-gated stubs. A `desktop-build`
matrix job then builds a native Tauri bundle on Ubuntu, Windows
(`windows-latest`), and macOS (`macos-latest`, an Apple Silicon/arm64 host;
there is no Intel macOS runner in this matrix). This intentionally verifies
each platform's packaging toolchain without publishing artifacts, installing
the package, or requiring repository secrets -- it is CI package-build
evidence, not an install test or a physical-device test. See
`.github/workflows/ci.yml`.


8. BUNDLED TRACKER ASSETS AND OFFLINE USE
-----------------------------------------

Pinned release:

  NicholasSlattery/sony-head-tracker v2.2.0

The official macOS universal and Windows x64 prebuilt executables, documentation,
and MIT license are committed under tools/sony-head-tracker/prebuilds. The launcher performs no
network request or extraction, so the tracker is available on the first offline
run after cloning the repository.

To use a separately reviewed compatible executable, set SONY_HEAD_TRACKER_BIN.


9. CONNECTION TROUBLESHOOTING
-----------------------------

On macOS or Windows with the native provider (the default on both), the
dashboard's Headphones tab shows a typed diagnostic instead of a generic
"waiting" state: scanning, permission-denied, device-not-found,
device-not-verified, feature-write-failed, or error. On macOS, grant Input
Monitoring to Spatial Gesture Control itself for permission-denied (section
3.1). On Windows, follow Sony Head Tracker's Repair Tracker instructions for
permission-denied (section 4.1).

If Tauri says Waiting for Sony tracker (external CLI bridge -- Linux, or
macOS/Windows with SONY_HEAD_TRACKER_PROVIDER=external):

- Read the Sony Head Tracker output in the same terminal.
- Confirm the tracker reports a verified device and live samples.
- Confirm no other process is bound to UDP port 4243.
- Confirm the Sony Head Tracker UI is open; it emits JSON on port 4243.
- Confirm the packet schema is protocol version 2.
- On macOS, verify Input Monitoring for the CLI bridge executable (not the
  app -- see section 3.2 above).
- On Windows, run upstream Repair Tracker if the sensor node is absent (see
  section 4.1).

A working Bluetooth audio connection does not by itself prove that the operating
system exposed the Android Head Tracker HID sensor.
