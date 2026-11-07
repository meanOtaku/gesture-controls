# Safety and fail-closed behavior

The desktop has two external effects: changing the system output volume (plus a
confirmatory haptic pulse on the watch), and, when a user connects one, flying a
Wi-Fi drone. This document states the invariants that bound those effects, where
each one is enforced, and what is *not* guaranteed. Every claim below names the
code that enforces it. Sections 1 to 6 are about volume and have not been
exercised against real hardware (see
[Components and deployment §6](components-and-deployment.md#6-what-is-and-is-not-validated)).
[Section 7](#7-the-drone) covers the drone, which is a physical object that can
hurt someone, and says what has been tested on it.

## 1. The decision chain

```text
PPG batch ─► ordering watermark ─► quality gate ─► window check ─► fusion ─► features ─► model
                                                                                          │
              intent bindings ◄── gesture policy (Off / Monitor / Live) ◄─ transition ◄───┘
                     │
                     ▼
              apply_decision ─► overlay (grab / release) ─► native volume write (+ haptic)
```

Every stage that rejects a window **forces a release**; it never lets a bad
window quietly pass or quietly do nothing while a grab is open.

| Stage | Rejects when | Enforced in |
| --- | --- | --- |
| Ordering watermark | Window timestamp is not strictly later than the last accepted one for that device. Cleared when the watch disconnects (a reboot restarts its boot-relative clock) | `inference.rs` `PpgIngestRuntime` |
| Quality gate | Fewer samples than `max(registry gate, bundle's min_samples_per_window)`, or contact quality worse than the gate | `model_registry.rs` `evaluate_quality_gate`, `inference.rs` |
| Window check | Live window duration is outside ±25% of the bundle's declared `window_ms` (**Live only**) | `model_registry.rs` `check_window`, `inference.rs` `window_mismatch_blocks` |
| Fusion | No orientation ever seen, wrong device, orientation older than 500 ms (desktop clock), non-finite values, non-monotonic PPG timestamps | `pinch-inference/src/fusion.rs` |
| Model | Backend cannot load, or returns something that is not a probability distribution | `inference.rs`, `pinch-inference/src/runtime.rs` |
| Gesture policy | Confidence not finite or out of range, a transition timestamp that is not **strictly** increasing, or a held grab silent for 750 ms | `interaction-engine/src/gesture_policy.rs` |

## 2. Inference modes

| Mode | Classifies | Can act on the desktop |
| --- | --- | --- |
| **Off** | No (a window never reaches the model) | No |
| **Monitor** | Yes; decisions and rejections are reported, and a window-mismatch is flagged in diagnostics | No |
| **Live** | Yes, but a mismatched window is refused | Yes, only the intent explicitly bound to the model's class (`VolumeGrab` / `VolumeRelease`) |

- The mode has **one source of truth in effect**: a change is applied to the
  policy first, then persisted, and the policy is restored if persisting fails.
- A persisted `Live` is **capped to `Monitor` at startup** (`startup_inference_mode`),
  so real actions only begin after an explicit Live selection in the current
  session. The registry and the policy are reconciled at launch.
- **Live cannot be selected** while the active model's most recent live window
  did not match its training window; the error says how to fix it. Monitor stays
  available to inspect the mismatch.
- A mode downgrade, model swap, watch disconnect, stale or rejected window,
  runtime error or Escape all force-release an active interaction.

## 3. The action layer

### Who may start and end a grab

The overlay has one `grabbed` flag, so it also records an **owner**:
`WatchButton`, `GestureModel` or `CornerDemo`.

- A producer may begin an interaction only when nothing is grabbed or it already
  owns the grab. It never takes over, or resets the reference pose of, another
  producer's grab.
- A producer's *normal* end (Watch button-up, a model's `pinch_release`) only
  ends a grab it owns.
- *Forced* ends are unconditional: Escape, watch disconnect, head-target exit,
  model swap, a mode change, and any policy forced release.

### What bounds a volume change

- The wrist mapper computes an **absolute** target from a reference pose captured
  at grab time (no accumulated drift). The target the mapper returns moves toward
  it by at most `max_volume_points_per_second` × elapsed time (default 30).
- The **first** orientation sample after a grab begins is velocity-checked against
  the reference pose like every later sample; samples above
  `max_angular_velocity_degrees_per_second` freeze the target.
- Native volume writes from wrist rotation are paced to at least 100 ms apart and
  are applied by a dedicated writer thread, not on the watch event loop. Every
  orientation sample still passes through the wrist mapper on the loop (so the
  velocity-outlier and monotonicity checks see all of them); only the native call is
  handed off, and a newer target replaces an older one that has not been written yet.
  The haptic pulse is limited to one per 125 ms. A failed haptic send does not
  consume the slot, and a failure streak logs once.
- Each volume interaction has an *epoch*, bumped whenever one begins or ends. A write
  that was waiting for the writer when the grab was released (or a new one began) is
  dropped, as is one whose target is no longer the applied volume. At most the single
  write already in flight when a release happens can still complete.
- Every write is clamped to 0–100 and never claims a change the OS did not make.

### What cannot be reached from the webview

- There is no webview command that shows the overlay. Only the backend's recipe
  engine does, when a recipe's head stage holds, so the webview cannot raise the
  volume capability gate by itself. `adjust_system_volume` still requires a visible
  overlay, and `hide_overlay` (Escape) also cancels the recipe that had it up.
- There is **no command that injects a gesture transition** into the policy
  (`report_pinch_transition` was removed). Transitions enter only through
  `ingest_ppg_window`.
- `report_model_runtime_failure` remains callable; it can only force a release.

### Concurrency

- Intent resolution through the model's bindings and the policy's "was this grab
  actually executed" bookkeeping happen under **one** policy-lock acquisition, so
  a release from another producer can never see a half-updated grab.
- The watch event loop never waits on a native volume call during wrist rotation (on macOS
  one such call, an `osascript` process, takes 130-190 ms). The overlay state lock is
  **never held across a native volume call**. Writes
  order on a separate lock, so a hung audio adapter cannot stall Escape,
  button-up, disconnect or a model swap, and a write queued behind a slow one is
  dropped if the overlay was hidden in the meantime. The native command itself is
  bounded at 2 s (plus a 5 s reap of an abandoned one).
- At window close the watch transports are stopped under a 10 s overall bound,
  then the process exits regardless.

## 4. Model and data integrity

- **Registry.** A `registry.json` that exists but cannot be read or parsed is an
  error and is left on disk; mutations stop. A missing file is a fresh install.
  With no readable registry the live path treats it as "no active model".
- **Bundle contract.** `load_and_verify_bundle` holds a bundle (trained or
  imported) to the same contract as the trainer's `validate_metadata`:
  schema version, class order, feature subset, tensor shapes and `float32` dtypes,
  the exact preprocessing policy, `window_config` (with at least 2 samples per
  window), a passed and in-tolerance conversion parity record, training provenance
  with no train/test session leak, and the lowercase SHA-256 of `model.tflite`
  recomputed from disk. A shared fixture under
  `tools/label-trainer/tests/fixtures/valid_bundle` is validated by both the
  Python and Rust suites so the two validators cannot drift.
- **Intent bindings** are a closed, per-model mapping; `negative` can never bind
  to an actuating intent, and activation revalidates everything under one lock.
- **Recording bundles.** `save_recording_bundle` verifies the CSV against the
  import contract, that the declared row and per-source counts match it, and that
  every annotation interval resolves to existing rows in order. Raw data is
  immutable once written.
- **Replay** resolves labels through the training run's own `label_mapping.json`
  (an imported bundle without one uses the legacy vocabulary and rejects unknown
  labels instead of scoring them `negative`).

## 5. Identity and time

- **Device identity.** Over BLE the desktop assigns `ble-<peripheral id>` and
  replaces any `deviceId` in the envelope; over Wi-Fi it trusts the watch's
  per-install `watch-<uuid>`. A watch cannot choose which device it is over BLE.
- **One clock for the watch.** All watch envelope timestamps are on the
  `elapsedRealtimeNanos` base. Orientation is the only message built from a sensor
  event timestamp; the watch verifies that clock on every event and rebases it if a
  device's sensor clock differs.
- **Desktop-owned decisions.** Staleness, dwell and the policy watchdog use the
  desktop's own monotonic receive time. Watch timestamps are used for ordering
  and diagnostics only (plus the wrist mapper's own velocity window).

## 6. Known limits (not guaranteed)

- **Live and training inputs are not identical.** The live path builds one window
  per PPG batch and attaches the orientation samples that arrived during it by
  desktop receive time; training windows are merged rows of both streams. The
  orientation statistics now match the trainer's formulas for the same samples
  (verified against `features.py`), but which samples a window contains can differ.
  Only a trained bundle measured on hardware can quantify the remaining gap.
- **Window length is a guard, not an alignment.** There is no sliding window
  live. A default 500 ms bundle will not run in Live against a 1 Hz PPG
  flush (about 960 ms windows; the default flush is now 10 Hz) until the flush rate is aligned or the model is
  retrained.
- **A stale reference pose** at grab time is not bounded by the velocity check; the
  orientation reference has no freshness limit.
- **Timeline annotation data** (`annotations.json`, curation status, interval
  boundaries) does not reach training; only a Timeline export's per-row labels do.
- **The Wi-Fi link is unauthenticated** plain `ws://`. The BLE link adds OS
  bonding and an explicit on-watch "Trust this computer" gate, with the limits
  listed in the [BLE transport doc](../protocols/watch-ble-transport.md).
- **No physical validation** of any of the above; see the
  [release-readiness checklist](../release-readiness.md).

## 7. The drone

The drone reports nothing back, so the desktop can never know whether it is flying
or heard a command. The rules below hold whichever is true. The protocol and what
is known about it are in [WIFI UAV drone](../protocols/wifi-uav-drone.md).

| Rule | Enforced in |
| --- | --- |
| A session opens only when the user connects or this computer joins the drone's Wi-Fi. That sends start packets and idle frames, and never arms. Disconnect holds until the user connects again or leaves the Wi-Fi | desktop `drone.rs` `AutoConnect` |
| No control is sent if the drone never sends a first video frame | `drone-link` `link.rs` `open_session` |
| Up and sticks need arming, which is never persisted and needs video moving and the watch streaming | `drone-link` `pilot.rs`, `link.rs` `arm`, desktop `drone.rs` `arm` |
| Sticks are limited to ±38, and throttle to ±64. Steering moves aileron and elevator only, so throttle and rudder stay centred | `drone-link` `pilot.rs` `limited`, `steering.rs` |
| Steering needs the watch button held. Letting go centres the sticks. A pinch cannot steer | `drone-link` `steering.rs`, desktop `lib.rs` |
| Sticks older than 200 ms are centred, and after 1 s without updates the pilot presses Down and disarms | `drone-link` `pilot.rs` `tick` |
| Something must keep checking in: the watch's stream or the open Drone page. If the page closes or stalls with no watch streaming, the timeout above lands. Hold corrections do not count as checking in | desktop `drone.rs` `heartbeat`, `DronePage.tsx`; `drone-link` `pilot.rs` |
| A watch disconnect lands at once, unless the page is keeping the link alive, when it only ends steering | desktop `drone.rs` `watch_lost` |
| Camera corrections reach the sticks only while Hold is on, which needs arming and is off again after every landing or stop. Each is at most 12 steps and within the ±38 limit. A correction older than 300 ms, or from a picture with under 25% agreement, is dropped | `drone-link` `hold.rs`, `pilot.rs` `corrected` |
| Hold measures each axis with test pushes before steering, and refuses if a push shows no clear change or drift swamps it. Those pushes do move the drone. It gives up and centres the sticks after 1 s with no trusted picture | `drone-link` `hold.rs` |
| The height buttons move only the throttle, within ±40 and the throttle limit. They are sent with each heartbeat and lapse after 300 ms | desktop `drone.rs` `heartbeat`, `DronePage.tsx` |
| Malformed watch data or a lagging event stream ends steering but keeps the hover | desktop `drone.rs` `release` |
| Landing or stopping cannot be steered, and Stop cannot be interrupted | `drone-link` `pilot.rs` |
| Esc lands, from any page. Closing the app or disconnecting lands first | desktop `App.tsx`, `drone.rs`; `drone-link` `link.rs` `fly` |

Esc presses Down rather than Stop on purpose. Down is the only way of stopping the
motors proven on the drone, and Stop may cut them in the air.

### What has been tested

See [Drone control](drone.md#what-has-been-tested). In short, on the real drone the Python
scripts started and stopped the motors with the props off, and the desktop app has held a
session with live video and tracking. Every rule in the table has been tested only against
a stand-in drone or in unit tests.

### What is not guaranteed

- **A lost Wi-Fi link cannot be handled from here.** The landing rules work by
  sending Down, which needs a working link. What the drone does when frames stop is
  unknown. Until that is measured, assume it can fly on.
- **Down has only been seen on the bench.** It may land gently or cut the motors.
- **Stop has never been sent by us**, and its effect is inferred from its name.
- **Which way each tilt moves the drone is unknown**, so a first flight may steer
  backwards.
- **Esc needs this window focused.** There is no system-wide key.
- **Video is not a sign of link health.** It nearly stalled while the motors ran in
  our first tools, and a skip for lost frames has not been tested with them running.
- **Position is not held.** The drone drifts, and only the person flying corrects it.
  Camera hold reduces drift at best. A forward camera cannot tell a drift from a turn or a
  tilt, the drone reports no attitude to separate them, and hold has never run in flight.
- **Hold could still push the wrong way.** Calibration measures direction, but a gust or a
  person walking past during a test push could mislead it. A wrong result would push the
  drone up to the 12-step limit until someone lands or stops it. Stay ready to land.
- **Simulated flights are not flights.** Their physics are estimates.
