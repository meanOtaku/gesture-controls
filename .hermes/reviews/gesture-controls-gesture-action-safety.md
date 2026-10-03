# Gesture Controls Gesture, Action & Safety Review — Milestone 4

**Scope:** Milestone 4 of `.hermes/plans/2026-10-02_133139-gesture-controls-architecture-review.md`.
**Date:** 2026-10-03
**Baselines read first:** `.hermes/reviews/gesture-controls-architecture-baseline.md` (M1), `.hermes/reviews/gesture-controls-sensor-timing.md` (M2), `.hermes/reviews/gesture-controls-data-model-lifecycle.md` (M3) — all accepted. Their identifiers (`F-1…F-6`, `G-1`, `R-1…R-4`, `D-1…D-7`, `R-M2-1…R-M2-12`, `T-2/T-3/T-6`, `G-M2-1…G-M2-6`, `D-M3-1…D-M3-6`, `R-M3-1…R-M3-13`, `T-M3-1…T-M3-3`, `V-M3-1…V-M3-7`) are honoured and cross-referenced, never restated as new findings and never silently closed.
**Repository state:** branch `main`, local HEAD `6cb36c56d14463b089dd727471b205c9ccebdf6d`, `origin/main` `6cb36c56d14463b089dd727471b205c9ccebdf6d` (equal at the start of this milestone). The five pre-existing dirty paths (`package.json`, `package-lock.json`, `.hermes/`, `.presentation-build/`, `status-resp.json`) were left exactly as found; `git status --porcelain` was re-captured after every command and matched the opening capture.
**Nature:** Read-only tracing and verification. No product code, test, dependency, configuration, plan, generated artifact or existing document was modified. **No remediation is proposed or applied** — Milestone 6 owns ranking and fixes. Every scratch artifact produced by this review was written under this job's own scratch directory, outside the repository; nothing was added to the working tree except this report.
**Side effects:** no real OS volume or mute operation was performed. Every volume claim is from source, from the repository's own fake-runner tests, or from a temporary out-of-repo harness that links `interaction-engine` only and touches no audio backend.

### Milestone 1–3 conditions carried forward

1. **`spatial-gesture-desktop` is still unverified by execution on this host**, and this milestone's action-integration subject matter lives almost entirely inside it. `cargo test -p spatial-gesture-desktop --no-run` exits `101` (`pkg-config` absent, so `glib-sys` cannot configure) — re-confirmed as `V-M4-3`, identical to M3's `V-M3-1`. Every claim about `overlay.rs`, `inference.rs`, `calibration.rs`, `watch.rs`, `model_registry.rs` and `lib.rs` below is **source-level only**; those modules' own unit tests are cited as *present but unexecuted here* (`G-M4-1`). `apps/watch/` likewise remains unverified by execution; its one path in scope (haptic receipt) is source-level.
2. **M2's `D-1` is carried forward unchanged and unsoftened.** `WristRotationConfig::smoothing_alpha` and `::max_volume_points_per_second` are still validated on every write and read by nothing (`crates/interaction-engine/src/lib.rs:398-407`, `:638-653`). The in-source comments now describe this as deliberate retention "for config/UI compatibility"; that is an *acknowledgement*, not a resolution, because the UI still presents both as functional tuning controls. This milestone adds the behavioural consequence: see `D-M4-1`, where the measured volume-write rate exceeds `max_volume_points_per_second`'s own default.
3. **M2's `D-2` and `D-3` are carried forward and re-confirmed at HEAD.** `PpgIngestRuntime::last_timestamp_ns` (`apps/desktop/src-tauri/src/inference.rs:186-188`) has no clear, remove or reset path anywhere in the crate — grepped across `apps/desktop/src-tauri/src/`, the only writes are the `insert` at `:203` and the `Default` at `lib.rs:47`. `deviceId` remains a build constant. Their action-layer consequence is recorded under `R-M4-5`.
4. **M3's `R-M3-11` is carried forward** and this milestone sharpens its direction of failure (`R-M4-6`).
5. **Graphify:** the repository still has **no `.mcp.json`** (`ls .mcp.json` → "No such file or directory"), so the Graphify MCP server is unavailable and the **MCP fallback is reported explicitly here as required**. The `graphify query` CLI was used for orientation (`V-M4-1`) and its answer was truncated at 54 of 301 nodes. The graph is still stale (built at `e91f79d`). **Every citation below was confirmed by reading primary source at `6cb36c5`**; no claim rests on graph output.
6. R-1 (unignored presentation artifacts, non-product root dependencies) remains the repository owner's call.

---

## Executive findings

**The decision layer is the strongest piece of safety engineering in this repository. The actuation layer beneath it is where the bounds stop.**

`GesturePolicy` (`crates/interaction-engine/src/gesture_policy.rs`) is a pure, synchronous, fail-closed state machine with a genuinely closed action vocabulary: seven fixed `GestureIntent` variants (`:63-71`), of which only two are wired to anything (`inference.rs:658-664`), and a model can never name an arbitrary command. Seven independent abnormal conditions converge on a forced release (`:101-117`), a release is always safe to execute because it can only stop something (`:12-18`), and a release is additionally gated on whether the grab it ends was itself ever executed (`:337-343`) so Monitor-mode observability can never tear down a real interaction. Twenty-five unit tests cover it and all pass here. This part of the system does what its documentation says.

The problems begin where a decision becomes an external effect. Seven confirmed defects, seven risks, four evidence gaps and four deliberate tradeoffs are recorded below. The most consequential:

- **D-M4-1 (high) — the system's only external side effect has no rate limit, no cooldown and no in-flight guard.** Every accepted orientation sample that moves the target by more than `f32::EPSILON` performs one *blocking* native volume write. Proved with the real mapper: a 150 °/s wrist roll at the Watch's 50 Hz orientation rate produces **19 distinct volume writes in 400 ms** (`V-M4-4` scenario E), a rate of ~47.5 volume points per second — above `max_volume_points_per_second`'s own default of `30.0`, the control M2's `D-1` found is never read. On Linux each write is a `wpctl`/`pactl` subprocess serialized behind a process-global mutex; the only rate limit anywhere in the chain is the one on the **haptic** pulse (125 ms), not on the action it confirms.
- **D-M4-2 (high) — the `correct_grab_executed` protocol is documented as atomic and is not.** `gesture_policy.rs:312-322` states that a caller remapping a `Started` decision "must call this immediately afterward, **before any further transition arrives** -- otherwise the eventual `Released` sees the stale `executed` and may actuate a release for a grab that never really started." `inference.rs:299` and `:314` take the policy mutex in two separate acquisitions with `resolve_intent`'s own lock acquisition in between. Reproduced against the real policy: an interposed `Released` actuates a **live overlay release for a grab whose model bindings mapped it to `NoAction`** — exactly the harm the comment exists to prevent (`V-M4-4` scenario B; the correctly-ordered control case B2 is safe).
- **D-M4-3 (medium) — cancellation cannot preempt a hung volume adapter.** `overlay.rs:483-501` and `:442-462` hold the `OverlayState` mutex *across* the blocking native command. Bounded by `NATIVE_COMMAND_TIMEOUT` (2 s) plus `DEFERRED_REAP_TIMEOUT` (5 s) — so for up to ~7 s, `hide`, `release`, `grab`, `get_overlay_state` and **every force-release path** block on that mutex. Escape, button-up, watch disconnect and model swap all route through `release`.
- **D-M4-4 (medium) — the volume capability gate is set by the party it is supposed to constrain.** `set_system_volume`/`adjust_system_volume` refuse to act unless the overlay is visible (`crates/volume-control/src/lib.rs:818-820`, `:844-846`), and that is the only authority check. `visible` is set by `show_overlay` (`overlay.rs:638-645`), an ungated webview command. `show_overlay` followed by `adjust_system_volume { delta }` changes the real system volume with no gesture, no model, no active-model requirement and no inference mode. Same class as M3's `D-M3-2`.
- **D-M4-5 (medium) — `report_pinch_transition` is a webview command that injects a fabricated transition directly into the policy and actuates it** (`inference.rs:715-724`), bypassing the ordering watermark, the quality gate, telemetry fusion, the model, the intent bindings and `correct_grab_executed`. Containment is real but thin: `PolicyMode::Live` plus an already-visible overlay — and `D-M4-4` shows the webview owns visibility.
- **D-M4-7 (medium) — the first orientation sample after a grab opens is never velocity-checked.** `WristRotation::observe`'s outlier gate is skipped while `previous_raw_degrees` is `None` (`interaction-engine/src/lib.rs:610-622`). Proved: 170° over 20 ms — 8500 °/s, 23× the configured limit — moves a 50 % baseline to 100 % in one write, while the identical step as the *second* sample is frozen (`V-M4-4` scenario F/F2). Because `latest_orientation()` carries no freshness bound (`watch.rs:154-159`), a grab opened against a stale reference pose can traverse the entire volume range in a single write.

**Haptic feedback is clean on the software side and unverified on the physical side.** `notify_wrist_rotation_haptic` is called only after `set_absolute_system_volume` returns a state whose volume actually differs from the previous one (`overlay.rs:346-349`) — after an accepted, applied, real action, never before and never on a no-op. It is rate-limited to 125 ms, fixed at 20 ms duration, re-validated against the 10–200 ms protocol bounds on send (`watch-bridge/src/lib.rs:376-387`) and again on receipt (`WatchLinkManager.kt:358-363`), requires an active connection, and is fire-and-forget. **No code path exists from a haptic command back to any decision** — the risk is physical, not logical, and is recorded as an evidence gap (`G-M4-2`) with its three dampers cited rather than converted into a pass.

---

## Inference-to-action trace

Every hop below is cited. `[desk]` marks a desktop-monotonic clock reading, `[watch]` a raw Watch envelope timestamp — the M2 distinction, carried forward.

```text
WatchEvent::Ppg(batch)                              lib.rs:241-243
  └─> inference::ingest_ppg_window(app, sample)     inference.rs:237
       │
       ├─ gate 1: active model exists?              :238-240  active_model_runtime_config
       │           (None -> return, no action)
       ├─ gate 2: mode_classifies(mode)?            :241-243  Off -> return  (:217-222)
       ├─ gate 3: ordering watermark, per device    :250-257 -> PpgIngestRuntime::evaluate (:191-206)
       │           sample.timestamp_ns > last ?     :162-165  [watch]   STRICT >
       │           reject -> watermark NOT advanced  :171      (deliberate; :153-156)
       ├─ observability: PPG_WINDOW_OBSERVED_EVENT  :268-270  every window, accepted or not
       ├─ gate 4: sensor-quality gate               :174-177
       │           reject -> force_release_policy(SensorQualityRejected | StaleSensorWindow)
       │                                             :271-281
       ├─ gate 5: telemetry fusion                  :469-476  fuse_ppg_window(..., [desk] :472)
       │           reject -> force_release_policy(StaleSensorWindow)       :328-331
       ├─ gate 6: model (re)load + full revalidation :488-518  digest, contract, bindings
       │           fail  -> force_release_policy(ModelRuntimeFailure)      :324-327
       ├─ feature selection by declared index       :526      select_features
       └─ DesktopPinchRuntime::submit(selected,[desk] :532)
            └─ Some(PinchTransition) ──────────────> policy

GesturePolicy::on_transition(transition)            gesture_policy.rs:229
  ├─ validate confidence finite and in 0.0..=1.0    :232-234 -> ForcedRelease(ModelRuntimeFailure)
  ├─ validate timestamp not DECREASING              :235-239 -> ForcedRelease(ModelRuntimeFailure)
  │     (equality passes -- see D-M4-6)
  └─ state machine, 5 arms only                     :241-274
       Idle     + Started  -> VolumeGrab   / Started, records executed = decision.live  :242-253
       Grabbed  + Held     -> NoAction     / Held,    refreshes the staleness anchor     :254-257
       Grabbed  + Released -> VolumeRelease/ Released, live iff the grab was executed    :258-262
       Grabbed  + Started  -> NoAction     / IgnoredAlreadyGrabbed                       :263-269
       Idle     + Held|Rel -> NoAction     / IgnoredNotGrabbed                           :270-273

  ──> PinchInferenceRuntime::resolve_intent(decision)   inference.rs:546-560
        Started  -> this model's binding for "pinch_start"    (VolumeGrab | NoAction)
        Released -> this model's binding for "pinch_release"  (VolumeRelease | NoAction)
        any ForcedRelease -> passes through unchanged          :542-545
  ──> GesturePolicyRuntime::correct_grab_executed(...)   :312-317   SECOND lock acquisition -- D-M4-2
  ──> inference::apply_decision(app, decision)           :668
        ├─ emit GESTURE_POLICY_EVENT                     :669-671  ALWAYS, even when not executed
        ├─ decision_actuates(decision)?                  :658-664  live AND intent in {Grab, Release}
        │    false -> return                             :672-673  (this is the whole Monitor/Live seam)
        ├─ VolumeGrab   -> OverlayRuntime::begin_volume_interaction  :677-696
        └─ VolumeRelease-> OverlayRuntime::release                   :697-701
           (Mute / PlayPause / Previous / Next: reported, never executed  :702-706)

OverlayRuntime::begin_volume_interaction             overlay.rs:275-319
  ├─ grab(app)                                      :282 -> :220-233  no-op unless visible
  ├─ orientation is Some?        else release        :287-290   latest_orientation(), NO freshness bound
  ├─ native volume readable?     else release        :291-303   Ok(None) = unsupported -> release
  └─ WristRotation::begin_with_config(config, q, ts[watch], activation_volume)  :304-317
        validates config + volume + quaternion BEFORE mutating    lib.rs:511-533
        failure -> release(app)                       :314-317

WatchEvent::Orientation(sample)                      lib.rs:232-240
  └─> OverlayRuntime::apply_wrist_rotation           overlay.rs:321-355
       ├─ WristRotation::observe(q, ts[watch])       :332-334 -> lib.rs:580-635
       │    reject ts <= previous   -> Err           lib.rs:593-595   STRICT >
       │    velocity outlier -> freeze last target   lib.rs:610-622   (skipped on sample #1: D-M4-7)
       │    dead zone, then absolute target, clamped lib.rs:625-632
       ├─ throttled roll diagnostic (200 ms)         :337 -> :412-434
       ├─ early return unless grabbed AND changed    :339-345
       ├─ set_absolute_system_volume(target)         :346 -> :477-507
       │    gate: state.visible                      :487-489   (NOT state.grabbed)
       │    volume_control::set_system_volume        :491 -> volume-control:839-853
       │      gate: overlay_visible, finite, clamp   :844-851
       │      VolumeController::set_volume           :851
       │        macOS : osascript, 2 s timeout       :459-475, :410-456
       │        Linux : wpctl -> pactl fallback      :693-708, :670-677
       │        Windows: Core Audio, endpoint per op :605-614
       │        other : UnsupportedPlatform          :781-783
       └─ notify_wrist_rotation_haptic               :347-349  ONLY if applied != previous
            └─ WatchBridgeServer::send_haptic_command(20 ms)   watch-bridge:376-387
                 bounds 10..=200 ms, requires active link      :377-384
                 -> desktop.haptic envelope                     :956-968
                 -> WatchLinkManager.dispatchHapticCommand       WatchLinkManager.kt:321, :358-363
                      re-validates bounds, then Vibrator        :73, :361-362

Staleness watchdog, independent of any stream       lib.rs:134-146, every 200 ms (inference.rs:565)
  └─ GesturePolicyRuntime::tick([desk])              inference.rs:641-647
       └─ GesturePolicy::on_tick                     gesture_policy.rs:280-291
            grabbed AND now - last >= 750 ms -> ForcedRelease(StaleModelData)   :286-287
```

**Observability at every hop.** `GESTURE_POLICY_EVENT` carries every decision including the ones that are not executed (`inference.rs:669`), `PPG_WINDOW_OBSERVED_EVENT` carries every window including rejected ones (`:268`), and `OVERLAY_STATE_EVENT` carries the applied volume, the grab flag, the corner-demo phase and `last_native_volume_error` (`overlay.rs:50-67`). The frontend subscribes to the first in `ModelLab.tsx:178` and the third in `App.tsx:91`. Three observability notes: the error string is cleared on the next successful read *or* write (`overlay.rs:502`, `:537-540`), so a transient failure can vanish before anyone sees it; `GESTURE_POLICY_EVENT`'s name is duplicated as a local literal in `ModelLab.tsx:49` rather than owned by `shared/protocol/events.ts` which owns `OVERLAY_STATE_EVENT` (`R-M4-7`); and the haptic send failure is logged only (`overlay.rs:400-404`), never surfaced.

---

## Safety invariants and action authority

Each invariant is stated, then classified: **holds** (source-evidenced and either tested or reproduced here), **holds unverified** (source-evidenced, no executable proof available on this host), or **does not hold**.

### Action authority

| Authority | Who may grant it | Who may revoke it | Verdict |
| --- | --- | --- | --- |
| A model may name an action | Nobody. The vocabulary is the seven-variant `GestureIntent` enum (`gesture_policy.rs:61-71`); a model binds a class to one of them, and `negative` can never bind to an actuating intent (M3, `model_registry.rs:310-356`) | — | **holds** |
| An intent may initiate an effect | `PolicyMode::Live` only, via `requires_live_mode` (`gesture_policy.rs:81-83`) and `decision()` (`:345-351`) | `set_mode` on any change, which force-releases (`:215-223`) | **holds** — tested (`gesture_policy.rs` tests at `:480`, `:499`, `:564`, `:580`; `inference.rs:778`) |
| An intent may *stop* an effect | Always permitted by mode; permitted by this specific grab's `executed` flag (`:337-343`) | — | **holds** — reproduced (`V-M4-4` B2) and tested (`:466`, `:607`, `:661`) |
| A decision may reach an adapter | `decision_actuates`: `live` AND intent ∈ {`VolumeGrab`, `VolumeRelease`} (`inference.rs:658-664`) | — | **holds unverified** (`G-M4-1`); the pure predicate is tested at `inference.rs:750-758` |
| The system volume may change | `OverlayState::visible` (`volume-control:818-820`, `:844-846`) | `hide`/`release` (`overlay.rs:194-216`, `:237-262`) | **does not hold as an independent gate** — `D-M4-4` |
| A transition may enter the policy | The live inference path, *or* any webview caller of `report_pinch_transition` | — | **does not hold** — `D-M4-5` |

### Per-gesture invariants

**Pinch (model-driven grab).** A `Started` from `Idle` yields a provisional `VolumeGrab` and records `executed = decision.live` — "exactly what the caller was told to do, not what the mode merely allowed" (`gesture_policy.rs:244-250`). The binding remap then requires the two-step correction that `D-M4-2` shows is not atomic. A second `Started` while grabbed is `IgnoredAlreadyGrabbed` with `NoAction` (`:263-269`), reproduced (`V-M4-4` A2) — so a **replayed or duplicated grab cannot double-grab**. Confidence is never re-thresholded by the policy (`:24-26`); it is validated for finiteness and range only (`:232-234`), with thresholding owned upstream by `DesktopPinchRuntime` from the bundle's own `start_threshold`/`release_threshold` (`inference.rs:513-514`). **Holds**, with `D-M4-2` as the exception.

**Grab / release pairing.** Four independent paths end a grab, and all four converge on `OverlayRuntime::release`: a model-driven `VolumeRelease` (`inference.rs:697-701`), a Watch button-up (`lib.rs:218-225`), a head-target exit (`calibration.rs:208-216`), and `force_release_and_hide` for connection-level anomalies (`inference.rs:359-365`). `release` is idempotent — it early-returns when nothing is grabbed, visible or phased (`overlay.rs:242-244`) — which is what makes the "always safe to call" comments at `calibration.rs:209-212` true. `hide` performs the identical teardown so Escape fails an interaction closed exactly like every other exit (`overlay.rs:188-216`). **Holds unverified** (`G-M4-1`).

**Wrist rotation.** The mapping is absolute, not accumulated: `activation_volume + signed(relative_roll) × volume_points_per_degree`, clamped (`interaction-engine/src/lib.rs:630-632`). Holding an angle holds a volume; returning to the reference restores the activation volume exactly; nothing accumulates to drift. This is a deliberately strong design and `set_system_volume` protects it by never re-reading current volume (`volume-control:832-838`) — tested at `volume_controller.rs` (`set_system_volume_writes_the_target_without_ever_reading_current_volume`, `..._repeated_with_the_same_target_never_drifts`), both passing here. Timestamps must strictly increase (`lib.rs:593-595`) and the velocity-outlier gate freezes rather than scales a too-fast sample — reproduced: a sustained 450 °/s roll produces a completely frozen target (`V-M4-4` E2). **Holds from the second sample on; does not hold for the first** — `D-M4-7`.

**Volume changes.** Bounded in value: clamped to 0–100 in the mapper (`lib.rs:632`), clamped again in `set_system_volume` (`volume-control:850`), and validated to 0.0–1.0 at the adapter boundary (`:855-861`). Idempotent: an absolute write with the same target produces the same result with no rounding drift (`:837-838`, tested). **Not bounded in rate** — `D-M4-1`.

**Model activation and release.** Activation requires `Approved`, revalidates the full bundle contract and digest under the same lock as the state check, and calls `force_release_before_swap` *before* the swap so "a grab classified under the outgoing model's bindings could [not] survive into the incoming model's lifetime" (`model_registry.rs:659-670`, called at `:1006` for activation and `:1042` for rollback). That function resets the classifier *and* force-releases the policy with `ModelSwapped`. **Holds unverified** (`G-M4-1`); the policy half is tested (`gesture_policy.rs:639`, `model_swap_forces_a_live_release_of_an_active_grab`, passing here).

**Source loss.** Six distinct losses force a release, each cited: Watch disconnect (`lib.rs:226-231`), a malformed or out-of-order inbound message (`:244-250`), PPG sensor state `unavailable`/`error` (`:251-259`), a lagged or closed event channel (`:266-272`), Sony head-tracker disconnect → `CalibrationRuntime::disconnect` → `deactivate` → `TargetExited` → `release` (`head_pose.rs:234-236`, `calibration.rs:58-73`, `:208-216`), and recalibration invalidation (`head_pose.rs:256-257`). `WatchEvent::Disconnected` also resets `WatchStatus` to default (`watch.rs:173-175`), clearing `last_orientation`, so **a reconnect cannot reuse a pre-disconnect reference pose**. **Holds unverified** (`G-M4-1`), with `R-M4-1` on the closed-channel branch.

**Cancellation.** Escape → `hide_overlay` (`App.tsx:275-277`), button-up → `release`, target-exit → `release`, mode change → `set_mode` force-release. All are prompt **except** while a native volume command is in flight — `D-M4-3`.

**Shutdown.** `CloseRequested` is intercepted, both transports are torn down regardless of which is selected, then `handle.exit(0)` (`lib.rs:106-127`). `stop_ble` is bounded by `BLE_STOP_TIMEOUT` (`watch-bridge:563-578`). No volume restoration is attempted — correct, since a volume change is a user-intended persistent effect, not a lease. The policy, overlay and loaded-model state are all in-process and vanish with the process. **Holds unverified** (`G-M4-1`), with the `R-M4-4` caveat on teardown bounds.

---

## False-positive and stale-input containment

### What contains a false positive

| Mechanism | Where | Value | Proven by |
| --- | --- | --- | --- |
| Confidence thresholding | Bundle-declared, applied in `DesktopPinchRuntime` | per model (`inference.rs:513-514`) | M2 `C-4` (**diverges from the Python reference; Rust is the safe side**) |
| Confidence sanity gate | `gesture_policy.rs:232-234` | finite, 0.0–1.0 | tested `:537` |
| Sensor-quality gate | `inference.rs:174-177` | per model | tested `model_registry.rs:1080` |
| Raw-window ordering watermark | `inference.rs:162-165` | strict `>`, per device | tested `:1016`, `:1034` |
| Transition ordering gate | `gesture_policy.rs:235-239` | **non-strict** — rejects `<` only | reproduced, `V-M4-4` A/A3 — `D-M4-6` |
| Double-grab containment | `gesture_policy.rs:263-269` | state-based | reproduced, `V-M4-4` A2 |
| Held staleness watchdog | `gesture_policy.rs:280-291` | 750 ms, polled at 200 ms | tested `:511`; reproduced `V-M4-4` C |
| Dead zone | `interaction-engine/src/lib.rs:625-629` | 3.0° default | `wrist_rotation.rs` (23 tests, passing) |
| Angular-velocity outlier gate | `:610-622` | 360 °/s default | reproduced, `V-M4-4` E2; **skipped on sample #1** — `D-M4-7` |
| Volume-point rate cap | — | `30.0` default, **never read** | M2 `D-1`; exceeded in practice — `D-M4-1` |
| Haptic rate limit | `overlay.rs:393-397` | 125 ms | source |
| Keyboard volume in-flight guard | `App.tsx:287-288` | one at a time | `App.test.tsx:222`, `:226` |

The gap in that table is the shape of `D-M4-1`: **the one mechanism that would bound the rate of the external effect is the one that is never read, and the only live rate limits in the system bound the confirmation (125 ms) and a diagnostic (200 ms), not the action.**

### Conflicting gestures

Three producers can open a volume interaction — the Watch stem button (`lib.rs:195-217`), the head-target corner demo (`calibration.rs:276-352`), and a model decision (`inference.rs:677-696`) — and all three call the single `begin_volume_interaction` seam, which is documented as exactly that (`overlay.rs:268-271`). Conflict resolution is **first-writer-wins by construction**: `grab()` no-ops when already grabbed (`:225-227`), so a second producer's `begin` returns the existing state without disturbing the reference pose. The release side is asymmetric and deliberately so: a monitored grab's release is discarded rather than executed precisely "so a grab only ever recorded while monitoring is discarded silently instead of reaching the desktop" and cannot "tear down an unrelated Watch-button grab that monitoring has no business touching" (`:144-158`, `:329-336`). **This is careful, correct reasoning and it holds.** What it does *not* cover: an *executed* model release will tear down a Watch-button grab, because the policy cannot distinguish them — the overlay has one `grabbed` flag and no owner field. Recorded as `R-M4-3`.

### Stale and duplicated input

- **Stale raw windows:** caught by the watermark, which deliberately does not advance on a rejection so "a bad arrival can never advance the watermark and mask a real one that arrives later" (`inference.rs:153-156`). Carries M2's `D-2`: the watermark is never cleared, so a Watch reboot wedges ingestion permanently. Its *action-layer* consequence is a permanent forced release — the fail-safe direction (`R-M4-5`).
- **Stale transitions:** the 750 ms watchdog bounds how long a grab survives silence. Reproduced: with `Held` arriving every 700 ms the grab survived a simulated 700 s with no absolute cap, and the watchdog fired on the first tick past 750 ms once `Held` stopped (`V-M4-4` C). The absence of an absolute cap is intended (a user may hold a pinch) and recorded as `T-M4-2`.
- **Duplicated transitions:** an exactly-equal timestamp is not rejected (`D-M4-6`). In the normal path this is unreachable — `submit` is handed `desktop_monotonic_now_ns()` (`inference.rs:532`), which does not repeat — so it is a latent gap, not a live exploit. Via `report_pinch_transition` it is directly reachable (`D-M4-5`).
- **Stale orientation at grab time:** `latest_orientation()` has no freshness bound (`watch.rs:154-159`) and all three producers use it (`lib.rs:201`, `inference.rs:679-682`, `calibration.rs:286-289`). Compounds with `D-M4-7`.
- **Untrusted input:** `D-M4-4` and `D-M4-5`. Both treat the webview as trusted. M3 established the project's own standard here: `D-M3-2` is a confirmed defect precisely because the save path trusts what the import path verifies. **These are classified as confirmed defects on the same basis, not softened to risks** — while recording honestly that the webview is the application's own bundled frontend, that the reachable effect is bounded to the clamped 0–100 volume range, and that every such change is emitted on `OVERLAY_STATE_EVENT`.

### Reconnect

On `Connected`, `WatchStatus` is reset to default and the watch's settings are re-pushed (`lib.rs:187-194`, `watch.rs:167-172`). `last_orientation` is cleared, so the first post-reconnect grab cannot anchor to a pre-disconnect pose. The PPG watermark is **not** cleared — M2's `D-2`, carried forward.

---

## Platform action failure behavior

Every external side effect in this milestone's scope, with the six required properties. There are exactly three: the native volume write, the native volume read, and the watch haptic command.

### Native volume write — `VolumeController::set_volume`

| Property | Behaviour | Citation |
| --- | --- | --- |
| Permission failure | Surfaces as `VolumeError::Backend(stderr)`; the macOS runner was deliberately rewritten away from process groups because "macOS can return EPERM from killpg/waitid ... in sandboxed/hardened-runtime contexts, which previously spun the deferred-reap loop forever while holding the execution lock and froze the UI" | `volume-control:101-108`, `:410-419` |
| Unsupported platform | `UnsupportedVolumeController` on any non-Windows/macOS/Linux target; `available_volume` maps it to `Ok(None)` rather than an error, and `begin_volume_interaction` releases the grab with a logged warning | `:776-792`, `:794-811`, `overlay.rs:115-121`, `:293-298` |
| Timeout | 2 s (`NATIVE_COMMAND_TIMEOUT`) on both Unix runners; Windows Core Audio is synchronous with no timeout | `:38`, `:367-381`, `:436-446`; Windows `:605-614` |
| Retry bounds | **No retries.** Linux has exactly one fallback attempt: `wpctl`, then `pactl`, then a combined error naming both | `:670-677`; tested `linux_controller_falls_back_to_pulseaudio_and_uses_normalized_writes` |
| Idempotency | Full, for the absolute write: no read-before-write, clamp without rounding, same target → same result | `:832-853`; tested `set_system_volume_repeated_with_the_same_target_never_drifts` |
| Partial failure | Child-process cleanup is unusually thorough: `ChildGuard` with `Drop`, `WNOWAIT` leader polling, process-group kill, a 250 ms cleanup window, a 5 s deferred reaper on a named thread, `ESRCH` treated as absence, and poisoned-mutex recovery via `into_inner()` | `:115-255`, `:258-331`, `:177-180`, `:304-307` |
| Observability | `OverlayState::last_native_volume_error` is set and emitted on failure, cleared on the next success of either kind | `overlay.rs:494-500`, `:502`, `:537-540` |

The Linux and macOS adapters are genuinely well tested through their injected-runner seams — `LinuxCommandRunner` (`:86-89`) and `AppleScriptRunner` (`:76-78`) — and `crates/volume-control/tests/volume_controller.rs` exercises both backends, the fallback chain, the hidden-overlay refusal, clamping, invalid responses and argument safety. 17 integration plus 11 unit tests, all passing here (`V-M4-2`). The AppleScript programs are even compile-checked (`macos_tests::applescript_programs_compile`). **Windows Core Audio has no test and cannot be executed here** (`G-M4-3`); the endpoint-per-operation design (`:542-544`) and the paired `CoInitializeEx`/`CoUninitialize` including the `S_FALSE` case (`:555-588`) are source-evidenced only.

### Native volume read — `get_volume`

Same transport, same timeout, same absence of retries. Response validation is strict on every backend: macOS parses and range-checks (`:510-516`), `wpctl` requires the `Volume:` prefix and a 0.0–1.0 value (`:737-745`), `pactl` requires a `%`-suffixed 0–100 token (`:748-756`), Windows validates the scalar it read back (`:599-600`). A read failure during `show` emits the error and refuses to show (`overlay.rs:163-172`); during `begin_volume_interaction` it releases the grab (`:299-302`); during the 400 ms refresh poll it emits the error and returns (`:515-528`).

### Watch haptic command

Permission failure: none possible from the desktop side — the `Vibrator` is the watch's own, and `MainActivity` owns it (`WatchLinkManager.kt:72-73`). Unsupported: no active connection → `WatchBridgeError::NoActiveConnection` before anything is sent (`watch-bridge:382-384`). Timeout: none; the send is a non-blocking broadcast (`:385`). Retry bounds: none, deliberately — `let _ = ...send(command)` discards a full or subscriber-less channel. Idempotency: a lost pulse is simply a lost pulse. Partial failure: a 16-slot broadcast channel drops the oldest on overflow (`:270`). Observability: a `warn!` only (`overlay.rs:400-404`) — not surfaced in `OverlayState`, recorded as part of `R-M4-2`.

---

## Feedback and loop prevention

**The haptic fires only after an accepted, applied, real action.** The call site is `overlay.rs:346-349`:

```rust
let applied = self.set_absolute_system_volume(app, target_volume, volume_runtime)?;
if (applied.volume - state.volume).abs() >= f32::EPSILON {
    self.notify_wrist_rotation_haptic(app);
}
```

Four properties follow directly, each cited:

1. **It is strictly post-action.** `set_absolute_system_volume` returns `Err` on a hidden overlay (`:487-489`) or any backend failure (`:494-500`), and `?` propagates before the haptic line is reached. No pre-action or speculative pulse exists anywhere in the module.
2. **It fires on a real delta, not an attempt.** The comparison is against the *applied* state, and the function was already skipped when the target had not changed (`:339-345`). A no-op write produces no pulse.
3. **There is no software loop.** Grepping `haptic` across the repository returns `overlay.rs`, `protocol/src/lib.rs`, `watch-bridge/src/lib.rs` and the Kotlin link manager, and nothing else. The haptic path is write-only from the desktop's perspective: no haptic value, acknowledgement or completion is read back, and nothing in `ingest_ppg_window`, `apply_wrist_rotation`, `on_transition` or `apply_decision` consumes anything downstream of a send. **A logical feedback loop is structurally impossible.**
4. **The pulse is bounded three times over.** Fixed at 20 ms by `WRIST_ROTATION_HAPTIC_DURATION_MS` (`:24`), re-validated against 10–200 ms on send (`watch-bridge:377-381`) and again on receipt (`WatchLinkManager.kt:361`), with the protocol comment stating the intent: "Kept short so a haptic command can never be (ab)used as a sustained buzz" (`protocol:106-108`). The two bounds are mirrored constants in Rust and Kotlin and **agree exactly** (`10`/`200` in both, `protocol:112-113` ↔ `WatchProtocol.kt:49-50`) — `V-M4-5`.

**The risk that remains is physical and is not resolved here.** A 20 ms pulse on the wrist mechanically perturbs the same limb whose orientation drives the volume. Three dampers stand against a physical loop, all cited: the 125 ms minimum pulse interval (`overlay.rs:25`, `:393-397`), the 3° dead zone (`interaction-engine/src/lib.rs:418`), and the 360 °/s outlier gate that freezes rather than scales (`:610-622`). Whether a pulse can displace the rotation-vector estimate by more than 3° is a hardware question, and **no hardware was available** — this is recorded as `G-M4-2`, an evidence gap, and is explicitly **not** converted into a pass. It compounds with `D-M4-1`: at 19 writes per 400 ms the pulse train runs at its 8 Hz ceiling for the whole duration of a roll.

One asymmetry worth naming: `notify_wrist_rotation_haptic` consumes its rate-limit slot *before* attempting the send (`:398-399`, then `:400`). A failed send therefore costs 125 ms of feedback silence even though no pulse was delivered (`R-M4-2`).

---

## Concurrency, ordering, and shutdown

### Lock inventory

| Lock | Guards | Held across a blocking call? |
| --- | --- | --- |
| `OverlayRuntime::state` | `OverlayState` | **Yes** — across the native volume command (`overlay.rs:483-501`, `:442-462`) — `D-M4-3` |
| `OverlayRuntime::wrist_rotation` | `WristRotation` | No — scoped and dropped at `:336` before any adapter call |
| `OverlayRuntime::last_wrist_rotation_haptic_at` | haptic rate limit | No — explicitly dropped at `:399` before the send |
| `OverlayRuntime::last_relative_roll_diagnostic_at` | diagnostic throttle | No — dropped at `:429` before the emit |
| `GesturePolicyRuntime::policy` | `GesturePolicy` | No — but released *between* the two halves of one protocol — `D-M4-2` |
| `PinchInferenceRuntime::fusion` | `TelemetryFusion` | No — scoped to `:460-478` |
| `PinchInferenceRuntime::loaded` | model backend | **Yes** — across model load and `submit` (`:480-535`), which is correct: it is what makes revalidation-then-use atomic |
| `PpgIngestRuntime::last_timestamp_ns` | watermark map | No — `:196-205` |
| `WatchRuntime::state` | `WatchStatus` | No — `:162-165` |
| `volume-control::COMMAND_EXECUTION_LOCK` | all native commands, process-global | **Yes, by design** — `:47`, `:353-360` |

Every poisoned-mutex path returns a typed error rather than panicking, and `DEFERRED_CHILDREN` deliberately recovers with `into_inner()` because a poisoned child list must still be reaped (`volume-control:177-180`, `:304-307`). The `state_generation` counter plus `refresh_in_flight` CAS give the async volume refresh a correct stale-completion guard: the generation is captured before `spawn_blocking` and re-checked under the lock afterwards, so a refresh that finishes after a state change is discarded (`overlay.rs:533`, `:666-693`). `RefreshGuard`'s `Drop` releases the CAS even on an early return (`:94-100`). The frontend mirrors this with `volumeRequestVersion` (`App.tsx:289`, `:292`, `:295`) and `calibrationEventVersion` (`:255-258`). **This is a correctly-built stale-completion story on both sides of the boundary.**

### Ordering

Watch events are processed strictly in order by a single consumer task (`lib.rs:182-274`), so no cross-event reordering is possible. One intra-event ordering subtlety: the overlay and inference handlers run *before* `runtime.apply(&watch_handle, event)` stores the sample (`:262`), so `latest_orientation()` lags the stream by one event. Harmless — the live mapper receives the fresh sample directly at `:234`.

Native volume commands are serialized process-globally on Unix (`volume-control:47`), so two writes can never interleave at the adapter. Combined with `D-M4-1`'s unthrottled write rate, that serialization is also the back-pressure mechanism: at 50 Hz orientation against a subprocess-per-write adapter, the consumer falls behind, and the resulting broadcast lag lands in the `Err` branch at `lib.rs:266-272`, which force-releases. **Fail-safe, but by accident of saturation rather than by design.**

### Async overlap

`apply_wrist_rotation` is invoked directly inside the `async` watch-event task (`lib.rs:234`) and performs a blocking subprocess call. This **blocks a Tauri async-runtime worker thread** for the duration. Contrast `refresh_system_volume`, which does the same work correctly via `tauri::async_runtime::spawn_blocking` (`overlay.rs:686-690`) — the right pattern exists in the same module and is not used on the hot path. Recorded as part of `D-M4-1`/`D-M4-3`.

The `correct_grab_executed` window (`D-M4-2`) is the one genuine data race in the decision layer. Three concurrent holders of the policy mutex can enter it: the 200 ms watchdog task (`lib.rs:134-146`), any webview call to `report_pinch_transition`/`report_model_runtime_failure` (`inference.rs:715-736`), and `set_inference_mode` (`model_registry.rs:1070`). A watchdog force-release landing in the window is benign (the subsequent correction is a no-op on an `Idle` state). An interposed `Released` is not — reproduced at `V-M4-4` B.

### Shutdown

`CloseRequested` → `prevent_close` → spawn teardown → `stop_ble` (timeout-bounded, `watch-bridge:573`) → `stop` → `handle.exit(0)` (`lib.rs:106-127`). Both transports are stopped regardless of selection, "so neither a listener nor a GATT connection outlives the window" (`:114-116`). Three observations: the two watchdog/event tasks are `loop`s with no cancellation token and are killed by process exit rather than drained; no final `release` is issued, so the last applied volume persists (correct — see `T-M4-3`); and `handle.exit(0)` is sequenced after both awaits with no outer timeout, so an unbounded `stop()` would leave the window closed-but-alive (`R-M4-4`).

---

## Findings

### Confirmed defects

**D-M4-1 (high) — the native volume write has no rate limit, no cooldown and no in-flight guard.**
`overlay.rs:339-346` performs one blocking `set_absolute_system_volume` per accepted orientation sample whose target moved by more than `f32::EPSILON`. Reproduced against the real `WristRotation`: a 150 °/s roll at the Watch's 50 Hz rate yields **19 distinct targets in 400 ms**, i.e. 19 native writes, at ~47.5 volume points per second — exceeding `max_volume_points_per_second`'s own default of `30.0` (`interaction-engine/src/lib.rs:422`), the control M2's `D-1` established is never read (`V-M4-4` E). On Linux each write is a `wpctl`/`pactl` subprocess behind a process-global mutex (`volume-control:47`), executed on a Tauri async worker thread. The only rate limits in the chain bound the haptic confirmation (125 ms, `overlay.rs:25`) and a diagnostic (200 ms, `:30`) — never the action. The correct pattern (`spawn_blocking`) exists 200 lines away at `:686-690`.

**D-M4-2 (high) — the `correct_grab_executed` protocol is documented as atomic and is not.**
`gesture_policy.rs:312-322` requires the caller to correct the grab's `executed` flag "immediately afterward, before any further transition arrives". `inference.rs:299` (`on_transition`), `:301` (`resolve_intent`, a different lock) and `:314` (`correct_grab_executed`) are three separate acquisitions. Reproduced: an interposed `Released` sees `executed = true` from the generic pre-binding intent and actuates a **live overlay release for a grab the model bound to `NoAction`** — the exact harm `inference.rs:302-311` says it prevents (`V-M4-4` B; ordered control case B2 is safe). Reachable from the watchdog, from `report_pinch_transition`, and from `set_inference_mode`.

**D-M4-3 (medium) — the overlay state lock is held across the blocking native volume command, so cancellation cannot preempt a hung adapter.**
`overlay.rs:483-501` and `:442-462` hold the `OverlayState` `MutexGuard` across `set_native_volume`/`adjust_native_volume`. Worst-case bound: 2 s command timeout (`volume-control:38`) plus up to 5 s waiting on a previous deferred reap (`:44`, `:356-360`, `:397-408`), ≈7.25 s. During that window `hide` (`:198-201`), `release` (`:238-241`), `grab` (`:221-224`), `state()` (`:138-143`) and `set_corner_demo_phase` (`:368-371`) all block — which means Escape, Watch button-up, head-target exit, Watch disconnect and `force_release_before_swap` are all stalled behind a volume adapter.

**D-M4-4 (medium) — the volume capability gate is set by the party it constrains.**
`VolumeError::OverlayInactive` is the sole authority check on both volume entry points (`volume-control:818-820`, `:844-846`), and `OverlayState::visible` is set by `show_overlay` (`overlay.rs:638-645`) — a webview command with no mode, model or gesture precondition. `show_overlay` then `adjust_system_volume { delta }` (`:655-663`) changes the real system volume with no gesture involved. Bounded to the clamped 0–100 range and emitted on `OVERLAY_STATE_EVENT`. Classified as a defect on M3's own `D-M3-2` basis.

**D-M4-5 (medium) — `report_pinch_transition` lets a webview caller inject a fabricated transition straight into the policy and actuate it.**
`inference.rs:715-724` calls `on_transition` then `apply_decision` with a webview-supplied `PinchTransition`, bypassing the ordering watermark (`:162-165`), the quality gate (`:174-177`), telemetry fusion (`:469-476`), the model, the intent bindings (`:546-560`) and the `correct_grab_executed` correction (`:312-317`). The doc comment frames it as a replay/testing seam (`:710-714`). Containment: `PolicyMode::Live` plus an already-visible overlay — and `D-M4-4` shows the caller controls visibility. It also reaches `D-M4-2`'s window and `D-M4-6`'s duplicate-timestamp gap.

**D-M4-6 (medium) — an exactly-duplicated transition timestamp is accepted.**
`gesture_policy.rs:235-239` rejects only `timestamp_ns < last`; equality passes. Reproduced: `Started(0.9, 100)` then `Released(0.9, 100)` produces an actuating live release (`V-M4-4` A). The upstream *raw-window* watermark uses strict `>` (`inference.rs:163`) and `ForceReleaseReason::StaleSensorWindow`'s own doc names duplication as a rejection case (`:107-111`), so the asymmetry is between the two layers. In the normal path this is unreachable because `submit` is given `desktop_monotonic_now_ns()` (`inference.rs:532`); via `report_pinch_transition` it is directly reachable. **A latent gap in the normal path, live under `D-M4-5`** — stated at that strength rather than inflated or dismissed.

**D-M4-7 (medium) — the first orientation sample after a grab opens bypasses the velocity-outlier gate entirely.**
`WristRotation::observe`'s gate is inside `if let (Some(previous), Some(previous_at_ns))` (`interaction-engine/src/lib.rs:610-622`), and `begin`/`begin_with_config` set both to `None` (`:497-498`, `:527-528`). Reproduced: 170° over 20 ms — 8500 °/s, 23× the 360 °/s limit — moves a 50 % baseline to 100 % in a single write, while the identical step as the second sample is frozen (`V-M4-4` F/F2). Compounded by `latest_orientation()` carrying no freshness bound (`watch.rs:154-159`; used at `lib.rs:201`, `inference.rs:679-682`, `calibration.rs:286-289`), so a grab anchored to an arbitrarily old reference pose can traverse the whole volume range on its first fresh sample.

### Risks

**R-M4-1 (medium) — the watch event loop's error branch is an unbounded hot loop on a closed channel.** `lib.rs:266-272` force-releases and continues. `broadcast::error::RecvError::Lagged` is recoverable and the loop correctly resumes; `Closed` is permanent, and the loop would then spin calling `force_release_and_hide` indefinitely. The sender is held in app state for the process lifetime (`:164-165`), so `Closed` is not expected — but nothing distinguishes the two variants.

**R-M4-2 (low) — a failed haptic send still consumes its rate-limit slot.** `overlay.rs:398` stores `last_sent` before `:400` attempts the send, so a disconnected watch costs 125 ms of feedback silence per failure. The failure is logged only, never surfaced in `OverlayState`.

**R-M4-3 (medium) — the overlay has one `grabbed` flag and no owner.** An executed model-driven `VolumeRelease` calls `overlay.release` unconditionally (`inference.rs:697-701`) and will tear down a concurrent Watch-button or corner-demo grab. The policy reasons carefully about the *monitored* case (`gesture_policy.rs:144-158`) but cannot distinguish producers in the executed case.

**R-M4-4 (low) — process teardown has no outer bound.** `lib.rs:112-125` awaits `stop_ble` (internally bounded, `watch-bridge:573`) then `stop()` before `handle.exit(0)`, with no timeout around the pair.

**R-M4-5 (medium, carried from M2 `D-2`/`D-3`) — the un-clearable PPG watermark's action-layer consequence.** Re-confirmed at HEAD: no clear path exists for `PpgIngestRuntime::last_timestamp_ns`. Because every rejected window force-releases (`inference.rs:271-281`), a wedged watermark means the policy is force-released on every subsequent window for the rest of the process's life — gesture control is dead, but **in the fail-safe direction**. That is the one favourable property of `D-2` and it is worth recording as such.

**R-M4-6 (low, sharpened from M3 `R-M3-11`) — the inference mode has two sources of truth.** `set_inference_mode` persists the mode (`model_registry.rs:1066-1069`) *before* applying it to the policy (`:1070-1072`). `mode_classifies` reads the registry copy (`inference.rs:241`); `decision()` reads the policy copy (`gesture_policy.rs:349`). If the policy lock is poisoned the two desync. The direction matters: persisted-`Off`-while-policy-`Live` leaves real actions firing with a UI showing `Off`.

**R-M4-7 (low) — `GESTURE_POLICY_EVENT`'s name is duplicated rather than owned.** `inference.rs:55` and `ModelLab.tsx:49` each declare `"gesture-policy-decision"` as a literal, while `shared/protocol/events.ts:160` owns `OVERLAY_STATE_EVENT`. Same hand-maintained cross-language contract class as M1's `G-1`.

### Deliberate tradeoffs — not defects

**T-M4-1 — no retries on any volume operation.** Correct for an idempotent absolute write driven by a continuous stream: the next sample is the retry, and a retry would fight the mapper. Linux's single `wpctl`→`pactl` fallback is a backend-selection fallback, not a retry.

**T-M4-2 — a grab has no absolute duration cap.** Reproduced: 700 s of simulated `Held` kept the grab open (`V-M4-4` C). Intended — a user may hold a pinch — and bounded on every failure path by the 750 ms silence watchdog.

**T-M4-3 — shutdown does not restore the pre-session volume.** A volume change is a user-intended persistent effect, not a lease. Restoring it would be the surprising behaviour.

**T-M4-4 — four intents are reported but never executed.** `Mute`, `PlayPause`, `PreviousTrack`, `NextTrack` reach `apply_decision` and fall into a no-op arm, with the reason stated in source: "no model in this milestone produces them, and adding the action here without a real producer would be dead code" (`inference.rs:653-657`). Correct call; it also means **four of the seven action types in the vocabulary are unexercised by any path**, which bounds how much this milestone can conclude about them.

### Evidence gaps — not converted into passes

**G-M4-1 — the entire desktop action-integration layer is unverified by execution on this host.** `cargo test -p spatial-gesture-desktop --no-run` exits `101`. `overlay.rs` carries 2 unit tests (both for the pure `corner_demo_phase_after_sample`), `calibration.rs` 4, `inference.rs` 30 — none of which were executed here, and **none of which drive `apply_decision`, `OverlayRuntime` or any Tauri command**. Every `D-M4-1` through `D-M4-5` claim about desktop wiring is source-level; `D-M4-2`, `D-M4-6` and `D-M4-7` are additionally reproduced against the real `interaction-engine` types. Resolving this needs the Linux Tauri prerequisites or the CI run for `6cb36c5`.

**G-M4-2 — the physical haptic feedback loop is unverified.** No Watch hardware. The software loop is proven impossible by construction; whether a 20 ms pulse can displace the rotation-vector estimate past the 3° dead zone is unmeasured. Cheapest resolution: one hardware observation of `last_relative_roll_degrees` (already surfaced on `OverlayState:58-62`) while pulsing a stationary wrist.

**G-M4-3 — the Windows Core Audio adapter has no test and cannot be executed here.** `volume-control:542-635` is source-evidenced only, including the COM lifetime pairing and the no-timeout synchronous call.

**G-M4-4 — no end-to-end actuation was observed.** `litert` is still uncompiled (M3 condition 2), so no model has ever run inside the desktop runtime; `load_model_backend` falls back to `UnavailablePinchModel`, which fails closed on every window (`inference.rs:379-386`). The full chain from a real PPG window to a real volume change remains **unverified end to end by execution**, on this host and in M2 and M3 before it.

---

## Acceptance evidence

### Checks executed

| Id | Command | Exit | Outcome / limitation |
| --- | --- | --- | --- |
| V-M4-1 | `graphify query "gesture policy debounce hysteresis volume action" --limit 20` | 0 | Oriented to `GesturePolicy`, `PolicyDecision`, `VolumeController`, `apply_decision`, `run_command_with_timeout`. **Truncated at 54 of 301 nodes**; graph stale at `e91f79d`; **no `.mcp.json`, so the MCP server was unavailable and the CLI fallback is reported here as required.** Every citation re-confirmed by reading source at `6cb36c5`. |
| V-M4-2 | `cargo test -p interaction-engine -p volume-control` | 0 | **90 tests, 90 passed, 0 failed.** 25 `interaction-engine` unit (incl. all 25 gesture-policy tests), 7 calibration, 4 overlay-position, 1 overlay-visibility, 2 volume-simulation, 23 wrist-rotation, 11 `volume-control` unit, 17 `volume_controller` integration. No real audio backend touched: all volume tests use `MockAppleScriptRunner`/`FakeLinuxRunner`; the four `timeout_tests` spawn `/usr/bin/printf` and `/bin/kill` only. |
| V-M4-3 | `cargo test -p spatial-gesture-desktop --no-run` | **101** | `pkg-config` absent → `glib-sys` cannot configure. **Honestly a block, not a pass.** Identical to M3's `V-M3-1`. Source of `G-M4-1`. |
| V-M4-4 | `cargo run` on a temporary harness outside the repository, linking `interaction-engine` only | 0 | `ALL-ASSERTIONS-PASSED` across 10 asserted scenarios: **A** duplicate timestamp accepted and actuating (`D-M4-6`); **A2** replayed `Started` contained as `IgnoredAlreadyGrabbed`/`NoAction`; **A3** decreasing timestamp forces a live release; **B** interposed `Released` actuates for a never-executed grab (`D-M4-2`); **B2** ordered protocol is safe; **C** 700 s grab with no absolute cap, watchdog fires once `Held` stops (`T-M4-2`); **D** idle force-release is `live` but `actuates == false`, proving the *intent* gate not the mode gate stops it; **E** 19 writes / 400 ms at ~47.5 pts/s (`D-M4-1`); **E2** a 450 °/s roll is frozen, not scaled; **F/F2** first-sample velocity bypass, 50 % → 100 % in one write (`D-M4-7`). No audio backend, no Tauri, no OS volume call. Harness removed after the run. |
| V-M4-5 | `grep` of the haptic bound constants across Rust and Kotlin | 0 | `MIN/MAX_HAPTIC_DURATION_MS` = `10`/`200` in `protocol:112-113` and `WatchProtocol.kt:49-50` — **agree exactly**; validated on send (`watch-bridge:377-381`) and on receipt (`WatchLinkManager.kt:361`). |
| V-M4-6 | `grep -rn 'haptic\|Haptic\|vibrat' --include=*.rs --include=*.ts --include=*.tsx --include=*.kt` | 0 | Four production files only. **No read-back, acknowledgement or completion path from a haptic command into any decision** — the basis for the no-software-loop conclusion. |
| V-M4-7 | `grep -rn 'last_timestamp_ns\|PpgIngestRuntime' apps/desktop/src-tauri/src/` | 0 | The only writes are the `insert` at `inference.rs:203` and `Default` at `lib.rs:47`. **No clear/remove/reset exists** — M2's `D-2` re-confirmed at HEAD. |
| V-M4-8 | `git status --porcelain`, re-captured after every command | 0 | Matched the opening capture every time: the same five pre-existing dirty paths, no additions beyond this report. |

### Milestone 4 acceptance criteria

| Criterion | Verdict | Where |
| --- | --- | --- |
| Cited end-to-end trace: inference → policy → debounce/hysteresis → action → command/event → adapter → visible state → watch feedback | **met** | *Inference-to-action trace* — every hop cited, with clock domains marked and the observability note |
| Safety invariants and action authority explicit for pinch, grab/release, wrist rotation, volume, activation releases, source loss, cancellation, shutdown | **met** | *Safety invariants and action authority* — authority table plus eight per-gesture invariants, each classified holds / holds unverified / does not hold |
| False-positive containment, thresholds, cooldowns, rate limiting, conflicting gestures, duplicated/stale inference, reconnect, untrusted input proven by source/tests or labelled as gaps | **met** | *False-positive and stale-input containment* — 13-row mechanism table with per-row proof, plus `D-M4-4`/`D-M4-5`/`D-M4-6` and `G-M4-1`…`G-M4-4` |
| Every external side effect documents permission failures, unsupported platforms, timeouts, retry bounds, idempotency, partial failure, observability | **met** | *Platform action failure behavior* — all three side effects, seven properties each; `G-M4-3` names the untested adapter |
| Haptic shown to occur only after accepted real actions, or pre-action/loop risk identified with exact evidence | **met** | *Feedback and loop prevention* — post-action proven at `overlay.rs:346-349`; software loop proven impossible (`V-M4-6`); **physical loop labelled `G-M4-2`, not passed** |
| Async overlap, lock/thread safety, command ordering, stale completion, disconnect races, shutdown tested or reproducibly bounded | **met** | *Concurrency, ordering, and shutdown* — 10-row lock inventory, `D-M4-2` reproduced, `D-M4-3` bounded at ≈7.25 s with cited constants |
| High-impact actions cannot be triggered by stale, duplicated or untrusted data without detection; violations classified as confirmed defects rather than softened | **met** | `D-M4-4`, `D-M4-5`, `D-M4-6`, `D-M4-7` are all recorded as **confirmed defects**, on M3's own `D-M3-2` precedent, with containment stated factually rather than used to downgrade them |
| Findings cite exact files, symbols, line ranges; observed facts, inferences, tradeoffs and missing evidence distinguished | **met** | Throughout; four separate finding classes (`D-`/`R-`/`T-`/`G-`), and every reproduced claim keyed to a `V-M4-*` row |
| Only the review report committed; pre-existing dirty work and product code untouched | **met** | `V-M4-8`; the harness lived outside the repository and was removed |

### Self-review performed before delivery

1. Re-read M1, M2 and M3 and confirmed no finding of theirs is restated as new or closed here. `D-1`, `D-2`, `D-3`, `R-M3-11` and `D-M3-2` are carried forward by explicit reference; `D-1`'s in-source "retained for compatibility" comments were found and are reported as an acknowledgement rather than treated as a resolution.
2. Re-read every line range cited in this report against the file at `6cb36c5`. Four citations were corrected during review: an initial suspicion that the Linux volume adapter was untested was **wrong** — `crates/volume-control/tests/volume_controller.rs:207`, `:225` cover both backends and the fallback, and that claim was removed rather than hedged.
3. The harness initially asserted that an idle force-release is not `live`. It is — `NoAction` never requires Live mode, so `live` is `true` and the **intent** gate in `decision_actuates` is what stops it. The assertion was wrong, not the code; it was corrected to mirror `inference.rs:658-664` and the distinction is now recorded explicitly under `V-M4-4` D.
4. The harness's first rate measurement used a 450 °/s roll, which the outlier gate correctly froze, producing zero writes. That was a harness error, not a finding; it was re-run at a realistic 150 °/s and became `D-M4-1`'s evidence, with the frozen case retained as `E2`.
5. Confirmed every "unverified" label is load-bearing: no desktop-crate behaviour is asserted as proven, and `G-M4-4` states plainly that no model has ever run in the desktop runtime on any host in this review.
6. Re-ran `git status --porcelain` and confirmed the five pre-existing dirty paths are byte-identical to the opening capture and that only this report is new.

---

## Milestone verdict

**Milestone 4 is complete.** The chain from an accepted PPG window to a changed system volume and a watch pulse is traced with a citation at every hop; action authority is tabulated; eight per-gesture invariant sets are classified; all three external side effects are documented against seven failure properties each; the haptic is proven post-action and loop-free in software; and ten concurrency, ordering and containment properties were reproduced against the real `GesturePolicy` and `WristRotation` rather than argued from source. Eight checks were executed with exit codes recorded, and one is reported honestly as blocked rather than converted into a pass.

**Inference results can cause only intended, bounded, observable actions — in kind. They are not bounded in rate, and the authority gate is weaker than the decision logic it protects.**

- *Intended* — yes, structurally. The action vocabulary is a seven-variant closed enum, only two variants are wired, a model can bind a class only to a safe intent, and `negative` can never bind to an actuating one. No path exists from a model output to an arbitrary command. This is the single best-engineered property in the system.
- *Bounded in value* — yes. Volume is clamped three times along the path; the haptic is clamped by two mirrored constants that agree exactly; the mapping is absolute and provably drift-free.
- *Bounded in rate* — **no.** `D-M4-1`: 19 blocking native writes in 400 ms, at a rate above the system's own configured cap, through a control that is never read.
- *Observable* — yes, and unusually well. Every decision is emitted whether or not it executes; every window is emitted whether or not it is accepted; the applied volume, the grab flag and the last native error all reach the frontend. The weak spots are a self-clearing error string and a silent haptic failure.
- *Cancellable* — yes, through four convergent paths that all reach one idempotent `release` — **except while a native volume command is in flight**, where `D-M4-3` bounds the stall at ≈7.25 s and blocks every one of them.
- *Safe under stale, duplicated, conflicting, disconnected, concurrent, failed and shutdown conditions* — stale and disconnected: yes, by seven converging forced releases with quantified bounds. Duplicated: partially (`D-M4-6`). Conflicting: by first-writer-wins, with `R-M4-3` as the asymmetry. Concurrent: no — `D-M4-2` is a reproduced race in the one protocol whose own documentation declares the invariant it breaks. Failed: yes, with genuinely thorough child-process cleanup. Shutdown: yes, bounded except for `R-M4-4`.

**The single highest-impact finding is `D-M4-2`**, because it is the only place where a safety invariant is *stated in source* and then not enforced, and because the harm it permits — actuating a real release for a grab the model's own bindings mapped to `NoAction` — is exactly what the comment at `inference.rs:302-311` exists to prevent. `D-M4-1` is close behind and is the broader architectural signal: the system invested its engineering in deciding *whether* to act and almost none in pacing *how often*, and the one knob that would pace it is the one M2 already found wired to nothing.

**The pattern across all four milestones is now unmistakable.** M2 found two user-facing controls wired to nothing and four places where a comment asserts what the code does not do. M3 found a validator that checks shape and not meaning, and a trust boundary where the save path accepts what the import path verifies. M4 finds a documented atomicity precondition that is not atomic, a configured rate cap that is never read, and a capability gate set by the party it constrains. **In every case the design is sound and the enforcement is one layer short of it.** That, rather than any individual defect, is what Milestone 6 should be asked to rank.

**Nothing found here blocks Milestone 5.** The module-depth and testability signals M5 owns are located and cited: `overlay.rs` carries 2 unit tests for 737 lines and both cover the same pure function; no test anywhere drives a Tauri command or `OverlayRuntime`; the correct `spawn_blocking` pattern exists in the same module as the blocking hot path that does not use it; and the `LinuxCommandRunner`/`AppleScriptRunner` seams show the project already knows how to make an adapter testable — `volume-control` is the best-tested crate in the repository and `spatial-gesture-desktop` the least, for the same structural reason.

**Conditions carried into Milestone 5:**

1. **Treat every claim about `overlay.rs`, `inference.rs`, `calibration.rs`, `watch.rs` and `lib.rs` as source-evidenced and unverified by execution** (`G-M4-1`), exactly as M3 required for its own subjects. `D-M4-2`, `D-M4-6` and `D-M4-7` are the exceptions: they are reproduced against the real `interaction-engine` types and may be treated as proven.
2. **Do not treat `G-M4-2` as closed by the absence of a reported problem.** The software loop is proven impossible; the physical one is unmeasured, and the cheapest resolution is one hardware observation of the already-surfaced `last_relative_roll_degrees`.
3. **Carry `G-M4-4` forward unchanged.** No model has executed inside the desktop runtime on any host in this review; `litert` remains uncompiled. No end-to-end actuation has been observed, in M2, M3 or M4.
4. Carry `D-M4-1`…`D-M4-7`, `R-M4-1`…`R-M4-7`, `T-M4-1`…`T-M4-4` and `G-M4-1`…`G-M4-4` into the Milestone 6 finding set for ranking, alongside M1's `F-1`…`F-6`/`G-1`, M2's `D-1`…`D-7`/`R-M2-1`…`R-M2-12` and M3's `D-M3-1`…`D-M3-6`/`R-M3-1`…`R-M3-13`. **This milestone proposes no fixes.**
5. Leave the five pre-existing dirty paths untouched; `R-1` remains the repository owner's call.
