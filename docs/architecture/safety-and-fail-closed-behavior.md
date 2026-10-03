# Safety and fail-closed behavior

The desktop's only external side effect is changing the system output volume
(plus a confirmatory haptic pulse on the watch). This document states the
invariants that bound that effect, where each one is enforced, and what is
*not* guaranteed. Every claim below names the code that enforces it; none has
been exercised against real hardware (see
[Components and deployment §6](components-and-deployment.md#6-what-is-and-is-not-validated)).

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

- `show_overlay` is accepted only while the **backend's** calibration state shows
  the top-right target active, so the webview cannot raise the volume
  capability gate by itself. `adjust_system_volume` still requires a visible overlay.
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
  `tools/pinch-classifier/tests/fixtures/valid_bundle` is validated by both the
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
  live. A default 500 ms bundle will not run in Live against the default 1 Hz PPG
  flush (about 960 ms windows) until the flush rate is aligned or the model is
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
