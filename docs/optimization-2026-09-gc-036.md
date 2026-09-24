# GC-036: optimization and documentation pass (2026-09-24)

**Scope:** first safe, high-impact optimization/documentation pass across four
authorized areas — Wear OS battery life, desktop performance/connectivity,
macOS-first OS volume API behavior, and reusable raw-image derivative
processing. This document is the durable record of what was inspected, what
changed, what was deliberately left alone and why, and what remains to
measure. See also
[`decisions/2026-09-24-wifi-vs-ble-transport.md`](decisions/2026-09-24-wifi-vs-ble-transport.md)
for the Wi-Fi-vs-BLE record.

Constraint honored throughout: uncommitted work already in progress at the
start of this session (`apps/desktop/src-tauri/src/settings.rs`,
`crates/watch-bridge/src/lib.rs`, `package.json`, `package-lock.json`, and the
untracked `.claude/`/`.hermes/`/`.presentation-build/` directories — GC-035
watch-sensor-settings and reconnect-subscription work) was **not read for
edits, staged, or modified**. Nothing below touches those paths.

## 1. Wear OS battery life — baseline, no code change

Inspected `PpgCollector.kt`, `SensorCollector.kt`, `MainActivity.kt`'s
lifecycle handlers, and `StreamingForegroundService.kt`. Findings:

- **Already good:** `MainActivity.onPause()` drops `SensorCollector` to a
  reduced-rate, wakelock-free `startMonitoring()` mode (rotation vector only,
  `SENSOR_DELAY_UI`) whenever the watch is not actively connected to the
  desktop, and `onResume()` restores full discovery. Active capture (full
  `SENSOR_DELAY_GAME` IMU rate plus `StreamingForegroundService`'s wake lock)
  is untouched while backgrounded during a live connection — correct, since a
  live stream must keep running.
- **Already good:** `PpgCollector`/`MedicalContinuousCollector` are only
  started from `startBodySensorCollection()`, itself only called from
  `connectToDesktop()` — they are never running unless the watch is actively
  connecting/connected. `PpgCollector.stop()` fully tears down the SDK
  connection (`unsetEventListener`, `disconnectService`) rather than just
  pausing callbacks.
- **Already good:** `PpgCollector`'s retry logic (`scheduleRetryOrGiveUp`)
  uses bounded exponential backoff (`MAX_RETRY_ATTEMPTS = 5`,
  `RETRY_MAX_DELAY_MS = 16s`) and gives up to `UNAVAILABLE` rather than
  retrying forever — no unbounded background retry loop.

**No code change made here.** Every continuous-sensor-work pattern this pass
was authorized to fix (streaming that keeps running when inactive, unbounded
retry/reconnect loops) was already handled correctly by prior work
(referenced as GC-035 in code comments). No battery-life claim is made —
nothing here was measured on-device this session, and none should be inferred
from "the code looks correct."

**Deferred/measured next step:** an actual on-device battery drain
comparison (screen-off, watch connected vs. idle vs. disconnected) has never
been run and is the only way to validate the above reasoning with real
numbers.

## 2. Desktop performance/connectivity

### Implemented: stop a 4 Hz diagnostics re-render loop once it's not needed

`apps/desktop/src/features/settings/components/CornerWristVolumeDiagnosticsSection.tsx`
ran `window.setInterval(forceTick, 250)` unconditionally for the component's
entire mount lifetime (empty dependency array) purely to re-render so a
"live" orientation label could age into "stale" over wall-clock time — even
with no watch ever connected (`lastOrientation === null`) or once the label
had already flipped to "stale" and nothing would change again until a new
sample arrived (which already re-renders the component via its
`watchStatus` prop).

**Change:** the interval effect now depends on the computed
`orientationStatus` and only runs while it is `"live"`; it stops itself the
moment the status becomes `"stale"` or `"absent"`, and a new orientation
sample (which changes `watchStatus` via props, not via this timer) restarts
it. This preserves the exact same stale-detection behavior and timestamp
math — verified by the pre-existing
`marks the Watch orientation stale once no new sample has arrived for a
while` test, which still passes unmodified. No raw timestamp or IMU sample
handling was touched; this affects only a Settings-page diagnostics card's
own re-render cadence.

### Inspected, not changed: `GesturePolicyRuntime` staleness watchdog

`apps/desktop/src-tauri/src/lib.rs` spawns a `tokio::time::interval(200ms)`
loop for the app's entire lifetime that calls
`GesturePolicyRuntime::tick()` unconditionally. This is a genuine always-on
timer, but it was **not changed**: it is the safety mechanism that forces a
stale in-progress gesture/grab to release even if no further events ever
arrive (e.g. a dropped Watch connection mid-gesture), so gating it on
"watch connected" or "policy active" risks silently disabling exactly the
failure-handling path GC-035's own commits (`fix(interaction-engine): exit
hysteresis...`) were hardening. Per-tick cost is one mutex lock plus a cheap
state check at 5 Hz — not a proven high-impact target, and not something to
touch without dedicated review of the interaction-safety implications. Left
as a documented, deliberately-deferred candidate rather than changed
speculatively.

### Inspected, not changed: watch-bridge reconnect hardening

`crates/watch-bridge/src/lib.rs` already had an uncommitted fix in progress
at session start (subscribing to all four broadcast command channels before
announcing `Connected`, so a settings replay on reconnect can't race a
receiver that doesn't exist yet). That fix directly addresses this task's
"harden reconnect behavior" goal; it was left exactly as found per the
preservation constraint, and no further reconnect changes were layered on
top of an in-flight change to the same function.

### Inspected, no other continuous-work waste found

`apps/desktop/src/app/App.tsx`'s 400 ms system-volume poll is already gated
on `overlay.visible` (stops entirely once the overlay is hidden). No
`requestAnimationFrame` render loop exists anywhere in `apps/desktop/src`.
Rust event loops in `lib.rs`/`head_pose.rs` block on
`broadcast::Receiver::recv().await` and do no polling.

## 3. Raw image viewer: reusable derivative extraction

The real Savitzky–Golay first-derivative implementation lives in
`apps/desktop/src-tauri/src/recording_bundle.rs` (M2/M3/GC-032 work), behind
the Tauri command `get_raw_recording_derivative_window`. It already had two
callers — `compute_sg_derivative_window` (time-based derivative, the
default) and `compute_sample_order_derivative_window` (an opt-in legacy
"preview by sample order" fallback for cadence-irregular recordings) — that
independently inlined the same windowed Savitzky–Golay convolution loop,
differing only in whether the accumulated value is divided by elapsed time
afterward.

**Extracted:** `convolve_symmetric_sg(present: &[(usize, f64)], coefficients:
&[f64], half_width: usize) -> HashMap<usize, f64>` — the shared, pure,
dependency-free convolution, taking `(row_index, value)` pairs in the
caller's chosen order and returning the raw "value units per sample"
accumulation per row that has a full symmetric window of genuine neighbors.
Both `compute_sg_derivative_window` and `compute_sample_order_derivative_window`
now call it; the former still divides the result by `dt_seconds`, the latter
still doesn't (matching the pre-existing unit contract:
`"per_second"` vs. `"per_sample"`). No output-shape, unit, or availability
semantics changed — this is a pure refactor removing the one real
duplication in the derivative path, not a new abstraction layer (no trait,
no generic module, nothing speculative added).

**Test added:**
`convolve_symmetric_sg_matches_known_linear_slope_and_respects_window_edges`
in `recording_bundle.rs`'s existing test module — checks the extracted
function against the known closed-form derivative of a linear signal
(constant slope `2.0`) and confirms it produces values for exactly the
interior rows with a full `SG_HALF_WIDTH`-wide window on both sides and
`None`/absent everywhere else, matching the edge behavior the two
pre-extraction inlined loops had.

## 4. OS volume: current guarantees and limitations (documented, no change)

Reviewed `crates/volume-control/src/lib.rs` (macOS/`osascript`,
Windows/`IAudioEndpointVolume`, Linux/`wpctl`+`pactl` fallback). No specific,
provable correctness or performance defect was found to fix this pass — the
module already:

- Never re-reads current volume before an absolute `set_system_volume` call
  (documented and tested: `set_system_volume_writes_the_target_without_ever_
  reading_current_volume`, `set_system_volume_repeated_with_the_same_target_
  never_drifts`), specifically to avoid the drift/race class of bug this
  task asked to look for.
- Runs every native command through argument-safe invocation (no shell
  interpolation — see `osascript_runner_does_not_spawn_native_commands`,
  `macos_controller_reads_and_sets_mute_without_interpolating_arguments`),
  with a bounded timeout (`NATIVE_COMMAND_TIMEOUT = 2s`) and forced
  process-group cleanup (`ChildGuard`) so a hung `osascript`/`wpctl`/`pactl`
  child can't leak or block indefinitely.
- Gates every native volume call on `overlay_visible` (`OverlayError::
  OverlayInactive` otherwise, tested by
  `hidden_overlay_cannot_change_system_volume`), and the desktop-side caller
  (`overlay.rs::apply_wrist_rotation`) already skips calling the native
  setter at all when the computed target volume hasn't changed
  (`(target_volume - state.volume).abs() < f32::EPSILON`), so a native
  process (`osascript`/`wpctl`/`pactl`) is spawned only on an actual volume
  change, not once per orientation sample.
- Falls back Linux PipeWire (`wpctl`) → PulseAudio (`pactl`) with a combined
  error message on double failure, and reports `UnsupportedPlatform`
  (fail-closed, not a guess) on any other OS.

**Known limitation, unchanged:** every get/set is a synchronous subprocess
spawn (`osascript`/`wpctl`/`pactl`), each with up to a 2-second timeout on
failure. This is a real per-call cost, but it is already bounded and already
only triggered on genuine volume changes gated by the overlay's visibility
and epsilon-change check above — there is no evidence in the code or tests
of it firing at a wasteful frequency, so replacing it (e.g. with a
persistent native session instead of one-shot commands) was not attempted
without a measured case for it, and doing so on macOS would mean replacing
AppleScript with a new dependency/framework, which is out of scope without
separate user approval.

## 5. Backlog for the next pass (prioritized, not started here)

1. **Measure, don't infer, Wear OS battery behavior.** Run the on-device
   comparison described in §1 before making any further watch-side power
   claims or changes.
2. **Review whether the `GesturePolicyRuntime` staleness watchdog interval
   can be safely narrowed** (e.g. only run while a gesture/grab is actually
   in progress) — requires deliberate review of the interaction-safety
   guarantee it exists for, not a quick gate.
3. **BLE feasibility trial**, per the decision record — native desktop BLE
   central implementation, Android permission/pairing/security design, and
   real battery/latency numbers, strictly before any transport code change.
4. **Volume-control native-session alternative** to per-call subprocess
   spawns — only worth pursuing if a real workload is found where the
   existing epsilon-gated, overlay-visibility-gated call pattern still
   spawns processes often enough to matter; no such workload was found this
   pass.

## Verification run this session

- `apps/desktop`: `npx vitest run src/features/settings/components/
  CornerWristVolumeDiagnosticsSection.test.tsx` — targeted test for the one
  frontend behavior change (§2).
- `spatial-gesture-desktop` (Rust, `apps/desktop/src-tauri`):
  `cargo test -p spatial-gesture-desktop --lib recording_bundle::` for the
  one Rust behavior change (§3). This crate has a pre-existing, host-level
  build blocker independent of this session's changes — `pkg-config` is not
  installed on this host, so `glib-sys`'s build script fails before any of
  this crate's own code compiles (documented previously in `CHECKPOINT.md`'s
  "Known blocker" section; `.github/workflows/desktop-ci.yml` installs the
  missing system packages in CI). See the exact command output captured in
  this session's report for whether it reproduced the pre-existing blocker
  or something new.
- `git diff --check` for trailing-whitespace/conflict-marker hygiene across
  all changed files.
- `graphify update .` to refresh the knowledge graph after edits.

No full test/build/lint suite was run, per the task's "smallest relevant
check" policy.
