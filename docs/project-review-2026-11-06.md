# Project review and AI-agent handoff — 6 November 2026

## Baseline and scope

- Reviewed commit: `e0ddc46b9dc93505084a05d9d6f280549f04eb74`.
- Initial working tree: clean. The initial review added documentation only. The follow-up implementation below records later code changes; recordings, model training and live gesture activation were not changed.
- Scope: repository structure, desktop/frontend build, Rust workspace, watch transport and build, Python trainer, model research evidence, CI, and operational documentation. This is a targeted engineering review, not an exhaustive audit of every source line or dependency.
- Evidence labels: **confirmed** means source or local command evidence; **proposal** means a recommended improvement; **unverified** means additional runtime/hardware evidence is required.
- Prior work: read `docs/review-remediation.md` and `.hermes/reviews/gesture-controls-regression-review-2026-10-12.md` before implementing. The latter records repairs to all 18 historical findings. Do not reopen those findings merely because they appear in its earlier sections.
- P1 = fix before relying on the affected feature; P2 = next engineering iteration; P3 = measured improvement. Effort estimates below are relative, not delivery promises.

## Assessment

The architecture is worth keeping: Tauri/React for the desktop, Rust for inference and action control, Kotlin for watch acquisition, and Python for offline training. There are extensive tests, explicit failure handling, transport diagnostics, model-validation contracts, and unusually useful research records. A framework rewrite would distract from the largest remaining risks.

Prioritize Wi-Fi identity and reconnection correctness, reliable automated gates, and trustworthy release documentation. For gesture accuracy, prioritize independent recordings and continuous replay evaluation before adding another architecture. Existing research explicitly does not establish readiness for everyday live control.

## Architecture map for the next agent

| Concern | Primary entry points |
| --- | --- |
| Desktop composition, event routing | `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/app/App.tsx` |
| Watch transport and protocol | `crates/watch-bridge/src/{lib,ble}.rs`, `crates/protocol`, `apps/watch/app/src/main/java/com/gesturecontrols/wearwatch/data/connection/` |
| Watch discovery and pairing | watch `data/discovery/`, watch `app/MainActivity.kt` |
| Sensor timing/acquisition | watch `feature/motion/`, `feature/health/`, `feature/wear/` |
| Head tracking | `crates/head-tracking`, `crates/native-head-tracking`, `tools/sony-head-tracker` |
| Recording and labels | desktop Rust `recording_bundle.rs`, `dataset_files.rs`, `labelling.rs`; frontend `features/telemetry/store/telemetryStore.ts` |
| Training and model lifecycle | desktop Rust `label_training.rs`, `model_lab.rs`, `label_registry.rs`; `crates/model-lab-core`; `tools/label-trainer` |
| Inference and effects | `crates/label-inference`, desktop Rust `label_runtime.rs`, `automation.rs`, `overlay.rs`, `actuators.rs`; `crates/automation`, `crates/volume-control` |
| Validation and history | `.github/workflows/`, `docs/release-readiness.md`, `docs/research/`, `docs/review-remediation.md` |

Paths below are repository-relative so this document works on another machine. Line numbers describe this baseline; prefer the named symbols after files change.

## Prioritized findings

### REV-01 — P1: authenticate Wi-Fi peers before accepting telemetry or pairing

**Status:** confirmed missing authentication; no live exploitation attempted. **Effort:** medium/large. **Affected mode:** Wi-Fi, not a claim about the default BLE trust gate.

**Evidence:** `apps/desktop/src-tauri/src/lib.rs:34` configures the listener on all IPv4 interfaces, port 8766. `crates/watch-bridge/src/lib.rs`, `ws_handler` (~1017) upgrades without credentials or an Origin check; `handle_socket` claims the single active slot and announces Connected before proving peer identity. Its Wi-Fi path preserves the envelope's claimed device ID. Watch `WatchPairingServer.kt`, `handleConnection`, accepts `GET /pair` and derives a `ws://` endpoint from the requester. `MainActivity.kt`, `connectDesktop` (~590), protects an already connected session but allows replacing a disconnected/retrying endpoint. The manifest allows cleartext traffic.

**Impact:** a reachable LAN peer can occupy the desktop's watch slot or supply fabricated telemetry. A disconnected/retrying watch can be directed to the requester's server. Whether fabricated gestures produce native actions depends on configured recipes and other gates; this review does not claim unconditional remote control. Sensor traffic also lacks transport encryption.

**Fix:** design explicit user-approved pairing with a revocable per-device credential, authenticate before allocating the active session or emitting Connected, and use authenticated encryption for Wi-Fi traffic. Treat discovery and claimed device IDs as hints, not identity. Preserve BLE as the default. Add bounded handshake time, explicit message limits, and a deliberate Origin policy; Origin filtering alone does not authenticate non-browser clients.

**Done when:** tests reject unknown credentials, replayed handshakes, wrong device identity, and disallowed browser origins without blocking the approved watch; reconnect succeeds after address changes; revoked peers cannot reconnect. A fake pairing request cannot replace the trusted endpoint without approval. Verify both transports on devices.

### REV-02 — P1: fence old WebSocket callbacks from the replacement connection

**Status:** confirmed source-level race; needs deterministic regression reproduction. **Effort:** small/medium.

**Evidence:** watch `data/connection/WebSocketTransport.kt`, `openSocket`, `closeSocket`, listener callbacks, and `handleDisconnect` (~97–180). One shared listener and one `closeExpected` boolean cover all socket generations. Callbacks receive a socket argument but never check it against the active socket. `handleDisconnect()` unconditionally sets the field `webSocket = null` before checking `closeExpected`.

**Failure sequence:** connection A is closed during pause/restart; B is opened; A's asynchronous close callback arrives and clears the field holding B. B may remain physically connected but sends see no socket. Old onOpen/onMessage callbacks can likewise change state or deliver data after replacement. The shared close flag can also be consumed by the wrong connection's failure.

**Fix:** bind a monotonically increasing generation to each listener/attempt. Ignore callbacks unless their generation is current, including inside the dispatched coroutine. Scope expected-close/error state to that attempt; invalidate the generation on stop/pause/shutdown. Keep intentional reconnect/backoff behavior.

**Done when:** a fake transport test delivers A's open, message, close, and failure callbacks after B opens and confirms B remains active, accepts sends, and schedules no extra retry. Cover stop during connect, pause/resume, and B failing before A's delayed close.

### REV-03 — P1: make CI exercise the training and action-critical suites

**Status:** confirmed CI coverage gap, also acknowledged in earlier documentation. **Effort:** medium.

**Evidence:** `.github/workflows/ci.yml` runs Python tests only for `tools/sony-head-tracker`; neither workflow invokes the label trainer or watch Gradle tests. The union of explicit Rust test package lists in `ci.yml` and `desktop-ci.yml` omits `automation`, `system-control`, `label-inference`, and `model-lab-core`. Building/clippy-checking those dependencies does not execute their unit tests. Both workflows duplicate frontend checks and multi-platform packaging.

**Fix:** add locked trainer tests (including a clearly identified CNN-enabled job), watch JVM tests and debug assembly, and workspace Rust tests where platform support allows. Document any explicit platform exclusions. Consolidate duplicate jobs without losing native macOS/Windows FFI checks. Add least-privilege workflow permissions and cancellation consistently.

**Done when:** an intentional test failure in each omitted component fails a required PR check; CI reports optional-dependency skips; all intended OS-specific tests still execute; package jobs depend on the relevant checks.

### REV-04 — P2: restore a stable formatting, lint and performance-test baseline

**Status:** confirmed local formatting failure and variable timing test. **Effort:** small.

**Evidence:** `cargo fmt --all -- --check` produces differences across many files (368 diff sections on Rust 1.97.1). Both workflows require this gate. Workspace clippy also fails with 11 findings: needless borrows in `label_training.rs:551–552`, `model_lab.rs:1007–1018`, and `recording_bundle.rs:932,951`, plus a collapsible conditional in `labelling.rs:329`. Initial frontend run: 906 passed, one failed; `features/gestureLibrary/calibration.test.ts:105` measured 102.38 ms against a hard 100 ms bound while builds/tests were running concurrently. A second full run failed the same bound at 153.02 ms; its isolated rerun passed all nine tests. Load sensitivity is a hypothesis, not proven causality. The host uses Node 21.7.3 despite README/.nvmrc specifying Node 22.

**Fix:** reproduce on the declared Node version and one agreed Rust toolchain; commit formatting and lint cleanup separately from behavior changes. Keep correctness assertions in unit tests and move strict wall-clock budgets to a controlled benchmark with warmup, repeated samples, and a defined host/load policy. Do not merely raise the threshold or claim the implementation is slow from this single run.

**Done when:** formatting and clippy pass on the pinned toolchain, the full suite passes on supported Node, and the performance gate detects a deliberate slowdown without flaking under routine test scheduling.

### REV-05 — P2: reconcile release instructions with the current inference stack

**Status:** confirmed stale operational instructions. **Effort:** small.

**Evidence:** `docs/release-readiness.md` Preconditions still directs agents to `npm run package:litert`, Cargo feature `litert-inference`, and `docs/release/litert-runtime-packaging.md`. The current package scripts and desktop Cargo manifest expose neither that command nor that feature; the referenced document is absent. Current inference uses trees/CNN and is documented elsewhere. Historical LiteRT status also appears in remediation records.

**Fix:** rewrite the active checklist for the current tree/CNN deployment path, and explicitly label historical runtime statements as superseded. Keep old reviews as history. Check documentation links and named scripts/features automatically.

**Done when:** every active release command exists, local documentation links resolve, and a fresh agent can distinguish current release gates from historical experiments without reconstructing Git history.

### REV-06 — P2: enforce training environment reproducibility

**Status:** confirmed launch behavior; reproducibility improvement, not evidence of corrupt models. **Effort:** small/medium.

**Evidence:** desktop `label_training.rs`, `trainer_command` (~433), invokes `uv run --project ...` with an optional `--extra cnn` but without `--locked`. `tools/label-trainer/uv.lock` already exists. Rust CI uses moving `stable`; Node is specified only by major version in CI.

**Fix:** make approved training runs fail on a stale lockfile instead of implicitly resolving it; use a separate intentional dependency-update workflow. Record the trainer revision, lockfile hash, Python/backend versions, seed, dataset hashes, split roles, and relevant hardware in exported provenance where not already captured. Preserve existing provenance and parity checks. Pin the Rust toolchain used for formatting/builds and make the Node minimum explicit.

**Done when:** an inconsistent lockfile produces an actionable error; an approved checkout can reproduce its environment; any nondeterminism is measured and documented. uv distinguishes normal sync from locked operation in its [official documentation](https://docs.astral.sh/uv/concepts/projects/sync/) (checked 2026-11-06).

## Improvements and upgrades

These are proposals, not newly discovered correctness defects.

| ID / priority | Upgrade and rationale | Implementation boundary / acceptance |
| --- | --- | --- |
| IMP-01 / P1 before live model promotion | Collect untouched session/day/fit/activity test data and long everyday negatives. The curriculum report shows only 19 starts per target, 78.9%/52.6% recall and 469/390 ms median latency on the same reserved pair used to choose thresholds. This is validation, not an independent test. | Follow `docs/research/cnn-curriculum-old-noise-2026-11.md`; freeze model, preprocessing, thresholds and test protocol first. Report recall, false activations/hour, negative exposure duration, latency, repeats and per-condition failures. Preserve the report's research-only status until existing activation gates and independent evidence are satisfied. |
| IMP-02 / P2 | Establish a signed release and clean-machine install track. Current workflows build packages; signing-status commands tolerate failures and do not prove install readiness. | Sign/notarize macOS and sign Windows artifacts; exercise first launch, permissions, upgrades and uninstall on clean hosts. Preserve the explicit hardware checklist. Auto-update is a later step, after signed release/rollback handling works. |
| IMP-03 / P2 | Plan Wear OS SDK/permission migration as a compatibility project. The watch compiles/targets API 34 and uses BODY_SENSORS plus a dataSync foreground service. | Before changing target SDK, review health permissions and background/foreground behavior with the Samsung SDK. Test grants, denial, revocation, screen-off streaming and off-wrist behavior on old/new supported watches. Do not blindly replace Samsung raw-PPG APIs with Health Services or claim current API 34 behavior is broken. |
| IMP-04 / P2 | Turn dependency upgrades into small, observable changes. Keep the existing Tauri 2/React 19/Rust/Kotlin architecture. | Inventory resolved versions from Cargo.lock/package-lock.json/uv.lock; run registry-backed security audits, then patch/minor upgrades by ecosystem. Major upgrades require migration review, inference parity and package tests. No dependency vulnerability scan was completed here and no “latest version” is asserted. |
| IMP-05 / P2 | Extract high-change responsibilities from large modules. `recording_bundle.rs` is ~5,964 lines; desktop `automation.rs` ~2,422; bridge `lib.rs` ~2,111; telemetryStore.ts ~1,464 (counts include tests). | Split recording parsing/evidence/persistence/cache and bridge discovery/session lifecycle along existing contracts. Move tests with their behavior. Avoid a sweeping rewrite; unchanged replay, serialization, failure handling and performance are acceptance criteria. |
| IMP-06 / P3 | Measure packaged startup, sensor-to-action latency and memory before more optimization. Production build warns about a ~527 kB main JS chunk; pages already have separate chunks. | Profile on supported packaged webviews, then split only dependencies proven to delay startup. Track p50/p95/p99 latency, missed samples, CPU and watch battery. Preserve the measured optimizations in `docs/performance.md`; increasing a warning limit is not an optimization. |
| IMP-07 / P2 | Make real-device acceptance repeatable. Unit tests cannot establish reconnection, permission or native-volume behavior on a watch/headset. | Record commit, host, firmware, transport, rates and results for suspend/resume, radio loss, off-wrist, permission revocation, device restart, camera loss, stale-stream release and Escape. Use an isolated audio output and test data. Keep failures and evidence alongside the release record. |

External upgrade references, checked 2026-11-06: [Tauri macOS signing](https://tauri.app/distribute/sign/macos/), [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/), [Android health permissions](https://developer.android.com/health-and-fitness/health-services/permissions). The Android guidance describes permission changes for API 36+; Samsung raw-sensor compatibility needs its own verification. Recheck these sources when implementing; versions and platform requirements change.

## Verification performed

Local host: macOS; Node 21.7.3 (outside the project's declared Node 22 line), Rust 1.97.1, Python 3.14.4. Existing installed dependencies/caches were used; no clean `npm ci` or cross-platform package/install run was performed. Consequently these results are local evidence, not release certification.

| Command | Observed result |
| --- | --- |
| `npm test` (two full runs) | Both failed only the calibration timing assertion: 906 passed, 1 failed across 147 files. Root script stopped before launcher/config/icon checks. |
| `npm run test --workspace @spatial-gesture/desktop -- src/features/gestureLibrary/calibration.test.ts` | 9 passed in isolation. Does not supersede the full-suite failures. |
| `npm run test:launcher`; `npm run test:tauri-config`; `npm run check:tauri-icons` | Run separately: 21 launcher tests, 5 config tests and 5 configured icons passed. |
| `npm run build` | Passed TypeScript build and Vite production build; main chunk size warning. |
| `cargo test --workspace --locked --offline` | Initial restricted run could not bind UDP sockets. Rerun with local socket access passed: 701 tests passed, 14 ignored, including doc-test summaries. Platform-gated Windows tests execute zero cases on macOS. |
| `cargo fmt --all -- --check` | Failed: formatting differences. No formatter changes applied. |
| `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` | Failed: 11 lint findings in desktop code (REV-04). |
| `tools/label-trainer/.venv/bin/python -m pytest tools/label-trainer/tests -q` | 79 passed, 1 skipped in 72 seconds. Existing environment; not proof of a freshly locked install or every optional backend. |
| Watch: `./gradlew --offline testDebugUnitTest` | First blocked by cache write restrictions; approved rerun succeeded. The unit-test task was UP-TO-DATE, so this is cached Gradle success, not a forced fresh execution. Compilation also emitted deprecation/redundant-branch warnings. |

The Sony bridge Python suite was not run separately in this review. No claim is made that all optional feature combinations or ignored tests passed.

No physical watch/headset test, native action exercise, production Wi-Fi attack test, full dependency audit, or clean Windows/Linux installation was performed. A successful native FFI smoke test is not evidence of hardware correctness. Temporary command logs were written under `/tmp/gesture-review-*`; this document preserves the useful conclusions because those files are not durable artifacts.

## Follow-up implementation — 6 November 2026

These changes are in the working tree, not committed. The baseline findings and original
verification results above remain as an audit trail.

| Item | Current status | Changes and verification |
| --- | --- | --- |
| REV-02 | Fixed in code; device validation pending | WebSocket listeners carry an attempt generation checked inside the main-dispatcher callback. Close/stop/pause and terminal failures invalidate older callbacks; error categories are scoped to the callback. Three deterministic fake-socket tests reproduce failures on the original implementation and pass after the fix. The full watch JVM task actually reran: 74 tests, zero failures. No new test dependency was needed. |
| REV-04 | Fixed locally; hosted CI pending | Rust 1.97.1 pinned in `rust-toolchain.toml` and both workflows; workspace formatted and all 11 lint findings repaired. Node 22.12.0 full frontend suite: 907 passed plus launcher/config/icon checks. Long-recording correctness remains in the unit suite; a separate single-worker performance command retains the 100 ms median budget with five warmups and 21 measurements. Local median 29.66 ms, p95 31.77 ms. Injecting an artificial 110 ms delay made that gate fail; the injection was removed. Desktop CI runs the benchmark separately. |
| REV-05 | Active checklist updated | Replaced removed LiteRT packaging commands and obsolete batch-window/model-binding instructions with current tree/CNN, per-label, recipe and Monitor/Live acceptance. Historical remediation entries are explicitly marked as historical. All relative links in the release checklist resolve. Hardware/install/signing gates remain uncleared. |
| REV-01, REV-03, REV-06 | Open | Wi-Fi authentication, broader CI coverage and locked training/provenance are still pending. Pinning Rust addresses only part of REV-06. No security remediation is implied by the reconnection fix. |

Validation after implementation: frontend production build passes (the existing main-chunk
size warning remains); formatting check passes on the pinned Rust toolchain; workspace
clippy passes with warnings denied. See the final Rust test result below. The first Rust
version installation attempt failed; a retry installed 1.97.1 successfully. Rustup's own
optional self-update reported an error, but the pinned compiler and formatter were verified.

Final workspace test run: `cargo +stable test --workspace --locked --offline` passed
with 701 tests passed, 0 failed and 14 ignored (including doc-test summaries).
The installed stable compiler and the newly pinned toolchain both identify as Rust 1.97.1
(`8bab26f4f`). `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets
--locked --offline -- -D warnings` also passed using the pinned toolchain.

Most Rust changes in this batch are mechanical `cargo fmt` output; behavior edits in Rust
are limited to the identified needless borrows and equivalent collapsed conditional. No
package release, registry change, recording edit, model activation or dependency upgrade
was performed. On-device pause/resume and reconnect acceptance remains required for REV-02.

## Suggested implementation sequence

1. Establish supported toolchains and a reliable green baseline (REV-04); repair misleading release instructions (REV-05).
2. Reproduce and repair the WebSocket callback race (REV-02). Design/test Wi-Fi pairing authentication (REV-01) before broad Wi-Fi use.
3. Expand and consolidate CI (REV-03), enforce locked training (REV-06), and require the resulting checks for subsequent changes.
4. Collect independent model evidence (IMP-01) in parallel with human-led device acceptance (IMP-07). Do not promote research models just to finish a task.
5. Prepare signed distribution and SDK migration (IMP-02/03); upgrade dependencies in small batches (IMP-04).
6. Refactor and optimize from measured maintenance/runtime costs (IMP-05/06).

## Instructions for a future AI agent

This document is a review backlog, not blanket authorization to deploy, send data, retrain, relabel recordings, or enable live actions. Follow the user's current request and applicable repository instructions.

- First read this file, `docs/README.md`, `docs/review-remediation.md`, and the documentation for the affected subsystem. Check `git status` and compare HEAD to the baseline above.
- Revalidate each finding against current code. Mark fixed/superseded items with commit and evidence; never treat this dated review as timeless truth.
- Implement one coherent change at a time. For a defect, add a regression test that fails on the old behavior, then make it pass. Preserve fail-closed release behavior, monitor/live boundaries, data identity, and training/runtime parity.
- Preserve original recordings and annotations. Do not overwrite model research evidence or silently alter split roles. Keep validation separate from untouched testing.
- Run checks relevant to the change, then the required project gates. Separate environment failures and skipped tests from application failures; do not weaken gates to obtain a green result.
- For each item record: ID, status, affected commit, implementation summary, exact verification commands/results, remaining hardware/platform limits, and rollback/migration notes if relevant.

Suggested completion record:

```text
ID: REV-02
Status: open | in progress | fixed | superseded
Implementation commit:
Evidence/reproduction:
Changes:
Tests and results:
Unverified platform/hardware cases:
Migration or rollback notes:
```
