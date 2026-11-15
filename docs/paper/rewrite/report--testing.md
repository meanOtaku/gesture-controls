# Rewrite: `report/testing.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Software Testing

<!-- block testing/p001 -->
#### ¶ p001

**Current:**

> Alongside the detection results above, the software is checked by automated tests at several levels. This section describes what those tests cover, how they are run, and what they cannot show.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p001 -->

### Test suites

<!-- block testing/p002 -->
#### ¶ p002

**Current:**

> Table [ref:tab:tests] lists the automated tests by component. The counts are the number of test functions or test cases in the repository at the time of writing.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p002 -->

🖼️ *[table tab:tests, kept as it is]*

<!-- block testing/c003 -->
#### 🏷️ caption c003

**Current:**

> Automated tests by component.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/c003 -->

<!-- block testing/p004 -->
#### ¶ p004

**Current:**

> The Rust total, 950 tests, also includes 117 tests for the separate drone-control crate, which is outside the scope of this report and left out of the table.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p004 -->

### What the tests check

<!-- block testing/p005 -->
#### ¶ p005 — Fail-closed behaviour.

**Current:**

> Many of the backend tests feed the decision chain with bad input (out-of-order timestamps, stale orientation, a different device, non-finite values, a model that returns something other than a probability) and check that an open grab is released and no volume change is made. The gesture policy has tests for its cancellation paths and for the rule that a simultaneous release beats a start.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p005 -->

<!-- block testing/p006 -->
#### ¶ p006 — Model integrity.

**Current:**

> The label-inference tests try to load bundles that are malformed, oversized, carry the wrong hash, declare the wrong features or contain non-finite weights, and check that each one is refused.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p006 -->

<!-- block testing/p007 -->
#### ¶ p007 — Training--runtime parity.

**Current:**

> The features are computed twice, by the Python trainer and by the Rust runtime. Four shared fixture files hold reference cases for the pulse features, the motion features, the CNN input and the detection rule. Both implementations are tested against the same fixtures, so a change on one side that is not made on the other fails the tests. This is what allows a model trained in Python to be trusted when it runs in Rust.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p007 -->

<!-- block testing/p008 -->
#### ¶ p008 — Transport and protocol.

**Current:**

> The watch-bridge and watch tests cover message framing and reassembly over Bluetooth, sequence handling, device identity, the default transport choice and the watch's sensor-clock rebasing.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p008 -->

<!-- block testing/p009 -->
#### ¶ p009 — Label handling.

**Current:**

> The trainer tests confirm that a non-empty `manual_label` overrides the original label, that a blank one keeps it and that `-` removes it.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p009 -->

### Continuous integration

<!-- block testing/p010 -->
#### ¶ p010

**Current:**

> Two GitHub Actions workflows run on every change. They check Rust formatting, run Clippy with warnings treated as errors, and run the full Rust test suite on Ubuntu, macOS 14 and Windows Server 2022. They also run the front-end tests, type checks and production build, the native head-tracking tests on macOS and Windows, and a package build for each platform. The Python trainer tests and the watch unit tests are not yet part of continuous integration and are run by hand.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p010 -->

### Limits of the automated tests

<!-- block testing/p011 -->
#### ¶ p011

**Current:**

> The automated tests run without physical devices. They show that the code behaves as intended on the inputs they supply; they do not show that the system works with a real watch, real headphones or every operating system's volume control. A successful package build in CI is evidence that the application builds, not that it installs and runs on a clean machine. Testing with real hardware was done by hand during development: recording sessions with the watch and headphones, the Bluetooth load measurements in Chapter [ref:ch:implementation], and the detection results reported earlier in this chapter. A structured hardware test against the project's release checklist is still to be done. \todo{add any manual hardware test results you want to report, e.g. a short table of scenarios tried and outcomes.}

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end testing/p011 -->
