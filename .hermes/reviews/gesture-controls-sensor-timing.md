# Gesture Controls Sensor & Timing Review — Milestone 2

**Scope:** Milestone 2 of `.hermes/plans/2026-10-02_133139-gesture-controls-architecture-review.md`.
**Date:** 2026-10-02
**Baseline:** `.hermes/reviews/gesture-controls-architecture-baseline.md` (Milestone 1), read first; its five carried conditions are honoured below.
**Repository state:** branch `main`, local HEAD `a2e7d58935bf3235500934969b5dd58d75e25bd2`, `origin/main` `a2e7d58935bf3235500934969b5dd58d75e25bd2` (equal). The five pre-existing dirty paths (`package.json`, `package-lock.json`, `.hermes/`, `.presentation-build/`, `status-resp.json`) were left exactly as found; `git status --porcelain` was re-captured after every command in this review and matched the opening capture.
**Nature:** Read-only tracing and verification. No product code, test, dependency, configuration, plan, generated artifact, or existing document was modified. **No remediation is proposed or applied** — Milestone 6 owns ranking and fixes.

### Milestone 1 conditions carried forward

1. `apps/watch/` and `spatial-gesture-desktop` remain **unverified by execution** on this host (no Android SDK, no `pkg-config`/GTK). Every Kotlin and Tauri-crate claim below is source-level, and each check that could not be executed says so (G-M2-3, G-M2-4).
2. C-1, C-2 and C-4 were **mechanically diffed** in this milestone, as C-3 was in M1 — see *Cross-language contract comparison*. C-1/C-2 agree; C-4 does not.
3. `graphify-out/graph.json` is stale (built at `e91f79d`) and the repository still has **no `.mcp.json`**, so the Graphify MCP server is unavailable. The `graphify query` CLI was used for orientation and the MCP fallback is reported explicitly here as required; **every statement in this report was then confirmed against primary source**, and no claim below rests on graph output alone.
4. F-1…F-6 and G-1 from M1 are untouched and still carried to Milestone 6.
5. R-1 (unignored presentation artifacts, non-product root dependencies) is left for the repository owner.

---

## Executive findings

The system has a **deliberate, documented and correctly implemented clock-domain rule**: raw device timestamps are preserved on the wire and used only for ordering and diagnostics, while every freshness, staleness and dwell decision is made against a desktop-owned clock (`fusion.rs:9-12`, `inference.rs:567-578`). That rule is respected by the inference path, the gesture policy watchdog and head calibration. It is **violated in exactly one place** — the volume mapper, which drives a velocity-outlier rate limit from the watch's own envelope timestamp (`interaction-engine/src/lib.rs:580-624`) — and it is **undermined in one other** by an incorrect premise about *which* watch clock the orientation envelope carries (D-4).

Seven confirmed defects, twelve risks, seven intentional tradeoffs and six evidence gaps are recorded. The most consequential:

- **D-1** Two user-facing wrist-rotation controls (`wristSmoothingAlpha`, `wristMaxVolumePointsPerSecond`) are plumbed UI → `settings.json` → `WristRotationConfig`, validated on every write, and then **never read** by the mapper. Two settings the user can change have no effect.
- **D-2** The per-device PPG ordering watermark is never cleared — not on disconnect, not on transport switch, not on forced release. Because the watch's envelope clock is boot-relative, **a watch reboot mid-session wedges PPG ingestion for the rest of the desktop process's life**: every subsequent window is rejected as stale and forces a release.
- **D-3** `deviceId` is a compile-time constant (`"galaxy-watch-4"`), so three separate per-device guards cannot actually distinguish devices.
- **D-4** Orientation envelopes carry `SensorEvent.timestamp`; every other message type carries `SystemClock.elapsedRealtimeNanos()`. The frontend's PPG clock-domain translation is anchored on the belief that these are the same domain, and then merges and sorts rows from both into one `raw.csv`.
- **C-4 is not behaviourally identical.** A scripted 10-step probability sequence run through the real Rust `DesktopPinchRuntime` and the Python reference's branch logic diverged at step 8: an unnormalized model output keeps the Python grab alive (`held`) and forces a Rust release. Rust is the safe side; the "behaviorally identical" claim at `runtime.rs:5-7` is nonetheless inaccurate.
- **R-M2-1** 13 of the 55 features are **structurally zero** in the live path and demonstrably non-zero in training windows (11/13 reproduced), and `sample_count`/`duration_ms` are computed on different bases offline and live.

C-1 (29 string literals, 11 numeric bounds) and C-2 (3 GATT UUIDs, 5 framing constants, and the fragment byte layout at three message sizes) were verified to agree mechanically.

---

## Watch IMU and PPG flow

Watch-side timestamps are shown as `[clock]`. Every arrow is cited.

```text
PHYSICAL ACQUISITION (Wear OS)
  TYPE_ROTATION_VECTOR ──┐  SensorCollector.kt:219-227
  TYPE_LINEAR_ACCELERATION (fallback TYPE_ACCELEROMETER)  SensorCollector.kt:26-27, 211-214
  TYPE_GYROSCOPE ────────┘  SensorCollector.kt:215-218
     │  accel/gyro are EMA-smoothed in place (alpha 0.2 / 0.15, SensorCollector.kt:233-239)
     │  and attached to the NEXT rotation-vector event only if fresher than
     │  MAX_COMPANION_SENSOR_AGE_NS = 100 ms, judged against the rotation event's own
     │  timestamp (SensorCollector.kt:240-243, 248). Otherwise the channel is sent null.
     ▼
  onOrientation(quat, accel?, gyro?, event.timestamp [SensorEvent.timestamp])
     │  SensorCollector.kt:220-226  →  MainActivity.kt:154-156
     ▼
  WatchLinkManager.sendOrientation  (WatchLinkManager.kt:145-163)
     │  seq = AtomicLong.incrementAndGet()  — ONE counter shared by every message type
     │  envelope timestampNs = the SENSOR event timestamp, passed through unchanged
     ▼
  WatchProtocol.orientationMessage → JSON envelope  (WatchProtocol.kt:99-112, 75-90)

  PPG ACQUISITION (Samsung Health Sensor SDK 1.4.1, Galaxy Watch 4+ only)
  HealthTracker PPG_CONTINUOUS {GREEN, RED, IR}  (PpgCollector.kt:244-252)
     │  flushTick asks the SDK to release buffered callbacks every flushIntervalMs
     │  (default 1000 ms, PpgCollector.kt:200-214, 327). Samsung alone owns the
     │  physical sampling rate (PpgCollector.kt:101).
     ▼
  onDataReceived → PpgSample{ timestampNs = DataPoint.getTimestamp() [SDK clock] }
     │  PpgCollector.kt:274-286; hopped to the main looper at :290
     ▼
  WatchLinkManager.enqueuePpgSamples  (WatchLinkManager.kt:166-170)
     │  dropped outright unless state == CONNECTED; buffered under `synchronized`
     ▼
  ppgFlushJob drains every PPG_DELIVERY_INTERVAL_MS = 40 ms (WatchLinkManager.kt:387-410, 464)
     │  chunked at PPG_BATCH_MAX_SAMPLES = 32 (:405, :466)
     │  envelope timestampNs = SystemClock.elapsedRealtimeNanos() AT FLUSH (:406)
     │  per-sample timestampsNs = the SDK values, unchanged (WatchProtocol.kt:147)
     ▼
  WatchProtocol.ppgBatchMessage  (WatchProtocol.kt:139-155)

TRANSPORT (one at a time; Bluetooth is the default — watch-bridge/src/lib.rs:171-174)
  BLE (default): BleGattTransport.send → BleFraming.fragment → bounded outbound deque
     │  MAX_QUEUED_FRAGMENTS = 512; on overflow the WHOLE backlog is dropped, never the
     │  oldest fragments, so the desktop reassembler is not left mid-envelope
     │  (BleGattTransport.kt:137-154, 147-149, 517)
     │  pumpOutbound sends one notification at a time, gated on onNotificationSent
     │  (BleGattTransport.kt:307-343); a refused frame clears the queue (:334-342)
     ▼  GATT notify on 6b1d0002-… (BleGattTransport.kt:499; Rust ble.rs:45)
  Wi-Fi: WebSocketTransport.send → okhttp (WebSocketTransport.kt:82); no app-level bound

DESKTOP INGEST (crates/watch-bridge)
  BleLink::recv → Reassembler::push  (ble.rs:157-198)   |  WebSocket::recv (lib.rs:660-674)
     │  gap/reorder/oversize drops the partial buffer; a fresh index 0 after a desync is
     │  accepted rather than stalling (ble.rs:166-182)
     ▼
  run_connection  (lib.rs:876-991)
     │  last_activity = Instant::now() on every inbound frame (:973); heartbeat timeout
     │  3 s (lib.rs:25 → :892-897, :983-986)
     │  desktop.time_sync every 5 s (:58, :900-911)
     ▼
  handle_inbound  (lib.rs:993-1088)
     │  WatchEnvelope::from_json → version + non-empty deviceId only (protocol:292-303)
     │  SEQUENCE GATE: reject sequence <= watermark, watermark NOT advanced (:1011-1026)
     │  → WatchEvent::InvalidMessage (consumer force-releases)
     │  decode() interprets payload per type (protocol:306-601); no timestamp checks
     ▼
  broadcast::Sender<WatchEvent>, capacity 256  (lib.rs:266)

DESKTOP CONSUMPTION — single sequential loop, apps/desktop/src-tauri/src/lib.rs:182-274
  Orientation (:232-240)
     ├─ overlay.apply_wrist_rotation (:234) → overlay.rs:321-355
     │     └─ WristRotation::observe(quat, sample.timestamp_ns)  ← WATCH clock
     │        interaction-engine/src/lib.rs:580-635: rejects timestamp <= previous (:593),
     │        velocity outlier uses (timestamp - previous_at_ns) (:613-621), dead zone,
     │        absolute target from the activation volume baseline (:630-632)
     │     └─ on an applied change: haptic, min interval 125 ms, desktop Instant
     │        (overlay.rs:385-405, :24-25)
     │     └─ relative-roll diagnostic throttled to 200 ms, desktop Instant (:407-430, :30)
     ├─ PinchInferenceRuntime::observe_orientation (:237-239) → inference.rs:428-434
     │     └─ TelemetryFusion keeps quat + last non-null accel/gyro and stamps
     │        desktop_monotonic_now_ns() (fusion.rs:76-86; inference.rs:430, 574-578)
     └─ WatchRuntime::apply (:262) → watch.rs:176-180 emits WATCH_ORIENTATION_EVENT,
           then WATCH_STATUS_EVENT with the full cloned WatchStatus (watch.rs:386-387)
  Ppg (:241-243) → inference::ingest_ppg_window (inference.rs:237-333)
     ├─ gate 1: no active model → return (:238-240)
     ├─ gate 2: InferenceMode::Off → return before the window is inspected (:241-243, 217-222)
     ├─ gate 3: ordering — envelope timestamp_ns must strictly exceed this device's
     │          watermark, else RejectedStaleOrOutOfOrder and the watermark does NOT
     │          advance (:157-179, 190-207)
     ├─ gate 4: quality gate on mean contact quality = max(green,red,ir) per sample
     │          (:115-148)
     ├─ observation emitted for EVERY window, accepted or not, carrying the RAW watch
     │          envelope timestamp (:259-270, 57-66)
     ├─ rejection → force_release_policy (:271-281, 345-352)
     └─ accepted → TelemetryFusion::fuse_ppg_window (:469-473 → fusion.rs:95-137)
            ├─ rejects: never observed / device mismatch / orientation older than
            │  ORIENTATION_STALENESS_TIMEOUT_NS = 500 ms on the DESKTOP clock /
            │  non-finite / PPG sample timestamps not strictly increasing
            │  (fusion.rs:21, 101-128)
            ├─ extract_features → 55 values (features.rs:175-276)
            ├─ select_features per the model's verified contract (inference.rs:526)
            └─ DesktopPinchRuntime::submit(selected, desktop_monotonic_now_ns())
               (inference.rs:532; runtime.rs:64-111) → GesturePolicy → apply_decision
  Button down/up (:195-225) → overlay.begin_volume_interaction / release
  Disconnected (:226-231), InvalidMessage (:244-250), PPG unavailable/error (:251-259),
  recv() Err (:266-272) → force_release_and_hide (inference.rs:359-365)
  Staleness watchdog: 200 ms tick (inference.rs:565), forced release after 750 ms of no
  model event while grabbed (gesture_policy.rs:167-180, 280-291)

FRONTEND (apps/desktop/src/)
  App.tsx:323-325 WATCH_ORIENTATION_EVENT → ingestWatchOrientation
  App.tsx:320-322 WATCH_STATUS_EVENT   → ingestWatchStatus → ALSO ingestWatchOrientation
        (telemetryStore.ts:866-871) — deduped only by sequence equality (:878-879)
  App.tsx:326-328 WATCH_PPG_BATCH_EVENT → ingestPpgBatch
        └─ translateToWatchClockDomain re-anchors SDK per-sample timestamps on the
           envelope timestamp, preserving the SDK's intra-batch deltas
           (telemetryStore.ts:103-122, 935)
        └─ ingestTimestampedBatch back-dates each sample's wall-clock `at` from
           Date.now() minus the remaining intra-batch delta (:1108-1119)
  Rows: visible series bounded at MAX_VISIBLE_SAMPLES = 600, CSV at MAX_CSV_ROWS = 200_000
        (:135-136, 251-253, 297)
  Dataset recorder: one row per channel sample, the OTHER channel's columns left null
        (GC-030 — :901-927 for orientation, :951-973 for PPG), inserted at its
        chronological position by timestampNs (:650-676)
  Recording bundle: raw.csv rows verbatim; actual_start/actual_end monotonic_ns from
        performance.now() (:746-747, 778-779)
```

### Active-IMU behaviour

- Acceleration and gyroscope are **never sent on their own**: both ride on a rotation-vector event, so disabling `orientation` silences every IMU sample (`SensorCollector.kt:100-107`; `protocol/src/lib.rs:151-156`).
- A companion channel older than 100 ms relative to the rotation event is replaced by `null` rather than carried stale (`SensorCollector.kt:240-243`). `TelemetryFusion` then keeps its own previous value for that channel rather than zeroing it (`fusion.rs:71-86`), and the dataset recorder writes `null` (`telemetryStore.ts:914-919`).
- The smoothing filter seeds from a zero vector, so the first accepted accel/gyro sample after `start()`/a re-registration is attenuated to `alpha ×` its true value (`SensorCollector.kt:233-239`). Bounded, transient, and not reported as a defect.
- **T-5 (tradeoff).** A PPG window is never blocked waiting for a fresh orientation sample: the last-known snapshot is carried forward, and only an orientation older than 500 ms on the desktop clock rejects the window (`fusion.rs:1-7, 109`). The accepted cost is that a window up to 500 ms old in orientation terms is classified as if the wrist attitude were current — and, per R-M2-1, that the carried snapshot collapses 13 features to zero.
- `startMonitoring()` registers only the rotation vector at `SENSOR_DELAY_UI` and deliberately ignores desktop rate commands; the requested rate is still remembered for the next `start()` (`SensorCollector.kt:84-89, 133-159`).
- Rate changes re-register only the affected sensor, always unregister-then-register so a rate-only change takes effect immediately (`SensorCollector.kt:168-207`).

---

## Sony motion flow

```text
PROVIDER SELECTION  (apps/desktop/src-tauri/src/head_pose.rs:52-67)
  native_available = cfg!(macos) || cfg!(windows);  SONY_HEAD_TRACKER_PROVIDER=external
  forces the external bridge. Any other override value is ignored (:52-59, tests :430-440).
  Linux therefore always uses the external UDP bridge; `native-head-tracking` declares no
  extern block on Linux at all (native-head-tracking/src/lib.rs:26-27).

PATH A — external bridge (Linux, or the explicit override)
  external CLI ──UDP──▶ 127.0.0.1:4243  (head_pose.rs:28)
     ▼  SonyUdpHeadPoseProvider task (head-tracking/src/lib.rs:238-313)
     ├─ SonyHeadSample::from_json: strict version == 2 or the datagram is dropped
     │    (protocol/src/lib.rs:6, 49-56; head-tracking:261-267)
     ├─ SOURCE IDENTITY: the first sender address is latched for the connection; datagrams
     │    from any other sender are dropped so two trackers cannot interleave reference
     │    frames (head-tracking:246-275). Cleared only on disconnect (:305).
     ├─ TrackerMonitor.observe(Instant::now(), reset_counter) (:277, 48-63)
     ├─ reset-counter change (and a previous value existing) → pose filter reset +
     │    HeadPoseEvent::ResetCounterChanged (:282-289)
     ├─ TIMESTAMP SYNTHESIS: timestamp_ns = SystemTime::now() since UNIX_EPOCH (:290-295).
     │    The Sony packet carries NO source timestamp — SonyHeadSample has no timestamp
     │    field (protocol/src/lib.rs:8-22). Only packets_per_second and
     │    receive_latency_ms are source-reported.
     ├─ StationaryPoseFilter::apply (:296 → :80-134): holds the previous pose for a
     │    >= 20 deg jump at <= 0.2 rad/s angular speed, otherwise blends with
     │    alpha 0.12 (within a 1 deg deadband) or 0.65 (in motion) (:101-133, 136-140)
     └─ broadcast::Sender<HeadPoseEvent>, capacity 256 (:208)
          ▼  run_external loop (head_pose.rs:283-288)

PATH B — native in-process provider (macOS/Windows default)
  NativeProvider::start(Box<NativeSink>)  (head_pose.rs:362-377)
     ▼  NativeSink::on_sample (head_pose.rs:312-338)
     ├─ TIMESTAMP SYNTHESIS: SystemTime::now() again (:315-319)
     ├─ reset counter widened u8 → u64; a change emits ResetCounterChanged BEFORE the pose
     │    (:320-331; tests :570-589)
     ├─ NO StationaryPoseFilter and NO TrackerMonitor on this path — staleness comes only
     │    from the native backend's own StreamTimeout status (:340-349; tests :529-539)
     └─ tokio::sync::mpsc::UNBOUNDED channel (:368) — no backpressure bound
          ▼  run_native loop (:382-389)

SHARED CONSUMER  handle_head_event (head_pose.rs:227-262)
  Connected      → clear diagnostic, emit head-tracker-connection true
  Disconnected   → CalibrationRuntime::disconnect, emit connection false
  Pose           → CalibrationRuntime::observe(quaternion)  — ALWAYS, un-throttled
                   (:242-247). Calibration dwell is measured against the runtime's own
                   Instant baseline, never the pose timestamp (calibration.rs:20, 29, 51;
                   interaction-engine/src/lib.rs:158-162)
                 → DESKTOP ACCEPTANCE GATE: SettingsRuntime::accept_headphones_pose()
                   (:248) → settings.rs:413-434. headphonesEnabled off ⇒ never; otherwise
                   a min-interval throttle of 1/headphonesRateHz measured on a desktop
                   Instant (:422-432). Full incoming fidelity is retained internally; only
                   the UI/recording path is thinned (:407-412).
                 → emit POSE_EVENT (head-pose-updated)
  ResetCounterChanged → CalibrationRuntime::invalidate + emit head-tracker-reset (:254-260)

FRONTEND / RECORDING / INFERENCE
  App.tsx:208-210 HEAD_POSE_EVENT → telemetryStore.ingestHeadPose
     ├─ HeadPosePayload has NO timestamp field at all (events.ts:13-23), so the
     │    synthesized timestamp_ns is dropped at the UI boundary
     ├─ graph point stamped Date.now() (telemetryStore.ts:841-842)
     └─ CSV row: sourceTimestampNs = "" (:846) — the head channel persists no source
          timestamp, and is throttled only by recordingRateHz (canRecord, :843, 1093-1098)
  Head pose is NOT part of the dataset recorder's raw.csv: sources = [{source_id:"watch"}]
     (telemetryStore.ts:783-785) and RAW_CSV_HEADER has no head columns
     (recording_bundle.rs:45).
  INFERENCE: head pose reaches the pinch pipeline nowhere. `pinch-inference` consumes only
     WatchOrientationSample and WatchPpgBatchSample (fusion.rs:14, 76, 95); the 55-feature
     contract has no head columns (features.rs:15-71). Head pose influences gestures only
     indirectly, by dwelling on the calibrated target that shows the overlay
     (docs/protocols/watch-websocket-protocol.md:38-45).
```

---

## Timestamp and clock domains

Every timestamp that crosses a boundary, classified on the required axes. "Authority" = whether this value is allowed to drive a decision.

| # | Field | Unit | Origin | Clock domain | Monotonic? | Authority | Conversion / replacement / rounding / synthesis | Persistence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `watch.orientation` `timestampNs` | ns | Android `SensorEvent.timestamp` (`SensorCollector.kt:225`) | **Watch sensor clock** (boot-relative; Android does not guarantee it shares `elapsedRealtime`'s base) | Per-sensor yes; across sensors unspecified | **Yes** — sole input to `WristRotation::observe`'s monotonicity check and velocity window (`interaction-engine/src/lib.rs:593, 613`) | Passed through unmodified end to end (`WatchLinkManager.kt:149, 154`) | `raw.csv` `timestamp_ns`, dataset CSV, `resolved_*.source_timestamp_ns` (`telemetryStore.ts:909, 799-800`) |
| 2 | `watch.ppg_batch` / `watch.*_batch` envelope `timestampNs` | ns | `SystemClock.elapsedRealtimeNanos()` at flush (`WatchLinkManager.kt:406, 429, 445, 455`) | **Watch SystemClock** (boot-relative) | Yes within a boot; **resets to 0 on reboot** | **Yes** — the PPG ingest ordering watermark (`inference.rs:163`) | Captured at flush, not at acquisition: a 32-sample batch's envelope stamp is later than every sample it carries | `PpgWindowObservation.timestamp_ns` (`inference.rs:262`), batch snapshots (`watch.rs:222`) |
| 3 | `watch.ppg_batch` `timestampsNs[]` (per sample) | **undetermined** — field name says ns; `DataPoint.getTimestamp()`'s unit is asserted nowhere (G-M2-1) | Samsung SDK (`PpgCollector.kt:278`) | **SDK clock** — the protocol doc states explicitly it is "monotonic but on their own clock domain" (`docs/protocols/watch-websocket-protocol.md:111-113`) | Asserted monotonic by doc; **enforced** by `fusion.rs:122-128` (strictly increasing or the window is rejected) | **Yes** — `duration_ms`/`slope` features (`features.rs:127-139, 265-272`) and the displayed PPG Hz (`watch.rs:196-203`) | Rust: used raw, assumed ns. Frontend: re-anchored onto domain 2 by `translateToWatchClockDomain`, preserving intra-batch deltas (`telemetryStore.ts:118-122`) — a translation, not a synthesis | Translated value persisted in `raw.csv`; raw value never persisted |
| 4 | `watch.heartbeat` / `watch.button` / `watch.*_status` `timestampNs` | ns | `SystemClock.elapsedRealtimeNanos()` (`WatchLinkManager.kt:181, 189, 260, 268`) | Watch SystemClock | Yes within a boot | **No** — never read for a decision; button handling is edge-triggered on `payload.state` (`lib.rs:195-225`) | None | `WatchStatus.last_heartbeat` only (`watch.rs:183`) |
| 5 | `watch.time_sync` `watchTimeNs` | ns | `SystemClock.elapsedRealtimeNanos()` (`WatchLinkManager.kt:329-331`) | Watch SystemClock | Yes | Diagnostic only | Mixed with domain 7 to produce an offset | `WatchStatus.clock_offset_ns` / `round_trip_ns` (`watch.rs:190-191`) |
| 6 | `ClockOffsetEstimate.offset_ns` | ns | `watch_time_ns - (sent_at_ns + rtt/2)` (`watch-bridge/src/lib.rs:1096-1109`) | **Cross-domain difference** (watch boot-relative minus desktop wall clock) | n/a | **Never applied.** Nothing converts a watch timestamp through it; it is displayed only | Median of the last 5 samples (`:59, 1037-1041, 1090-1094`); `round_trip_ns` uses `saturating_sub`, so a backward desktop step reads 0 | Not persisted; `estimated_at_ns` is destructured away unused (`watch.rs:185-189`) |
| 7 | Desktop `now_ns()` | ns since UNIX epoch | `SystemTime::now()` (`watch-bridge/src/lib.rs:1119-1125`) | **Desktop wall clock** | **No** — NTP/manual steps | Authority for `desktop.time_sync` and the session id | `.unwrap_or_default()` on a pre-epoch clock; `.min(u64::MAX)` saturation | `session_id` string (`:853`) |
| 8 | `desktop_monotonic_now_ns()` | ns since first call | `Instant` anchored in a `OnceLock` (`inference.rs:574-578`) | **Desktop monotonic** | Yes | **The authority for every freshness decision**: orientation staleness, `PinchTransition` stamps, `GesturePolicy::on_tick` (`fusion.rs:108`, `inference.rs:430, 472, 532, 646`) | `as_nanos() as u64` truncation (harmless below 584 years) | Not persisted |
| 9 | `HeadPose.timestamp_ns` (Sony) | ns since UNIX epoch | **Synthesized at receive** — `SystemTime::now()` (`head-tracking/src/lib.rs:290-295`; `head_pose.rs:315-319`) | Desktop wall clock | No | **No** — never read downstream | Pure synthesis: the Sony wire format carries no timestamp (`protocol/src/lib.rs:8-22`). The stationary filter copies the new sample's timestamp onto a held pose (`head-tracking:105`) | **Dropped** at the UI boundary (`events.ts:13-23`); head CSV rows persist `""` (`telemetryStore.ts:846`) |
| 10 | Telemetry series / CSV `at` and `recordedAt` | ms (ISO string in CSV) | `Date.now()` (`telemetryStore.ts:841, 880, 1114`) | **WebView wall clock** | No | Authority for the graph x-axis, `canRecord`, and `canAcceptHealth` throttles | For batches, back-dated per sample: `receivedAt - (lastTs - ts)/1e6` — mixing a wall-clock anchor with watch-domain deltas (`:1117`). Rounded to ms by `Date` | `recordedAt` ISO-8601 in the ordinary CSV |
| 11 | Bundle `actual_start`/`actual_end` `monotonic_ns` | ns | `performance.now() × 1e6`, explicitly chosen over `Date.now()` so a wall-clock step cannot skew it (`telemetryStore.ts:289-296, 746-747`) | **WebView monotonic** | Yes | Metadata authority for session span | `Math.round` to ns | `recording.json` (`recording_bundle.rs:108-109, 134-136`) |
| 11b | …the same fields on an **imported** bundle | ns | The first/last `raw.csv` `timestamp_ns` — i.e. domain 1/2 (`recording_bundle.rs:544-550, 567-568`) | **Watch** clock | Yes | Same field, different domain → **D-5** | No conversion | `recording.json` |
| 12 | `requested_*_monotonic_ns` on a timeline interval | ns | `performance.now()` at interval close (`telemetryStore.ts:677`) | WebView monotonic | Yes | Interval resolution input | `Math.round` | `annotations.json` |
| 13 | Python `Recording.timestamps_ns` | ns assumed | `raw.csv` column 0 (`csv_io.py:93-107`) | Whatever domain the recorder wrote (1 and 3-translated, interleaved) | **Enforced non-decreasing**, out-of-order rows are a hard load error (`csv_io.py:101-106`) | Authority for window boundaries and segment splitting (`windowing.py:57-104`) | `int()` parse; `MS_TO_NS = 1_000_000` for the window/stride/gap config (`windowing.py:17, 73-75`) | Training artifacts |

### Clock-domain rules that hold

- **Raw timestamps stay raw.** No code path rewrites a watch-sourced timestamp before persisting it. The one transformation (row 3, frontend) re-anchors while preserving the source's own deltas and documents itself as a translation rather than a synthesis (`telemetryStore.ts:103-116`).
- **T-1 (tradeoff) — freshness is never judged across domains, by design.** `fusion.rs:9-12` states the rule ("never against the watch's own envelope timestamps, which run on an unrelated, unsynchronized device clock"); `inference.rs:567-573` restates it; both are implemented (rows 8 and 2 are never compared). `GesturePolicy::on_tick` compares domain 8 against domain 8 (`inference.rs:646` vs `:532`). The accepted cost is that a window delayed in transport looks fresh, and a window whose *source* was stale looks fresh too — transport latency and sensor latency are deliberately not distinguished.
- **A non-finite source timestamp is rejected, never invented.** `telemetryStore.ts:875-877, 1116` drop the sample; `protocol/src/lib.rs:259` types the field `u64`, so a negative value fails to parse.
- **The one documented exception is the volume mapper.** `WristRotation::observe` takes its monotonicity check and its velocity-outlier window from the watch's own orientation timestamp (`interaction-engine/src/lib.rs:593, 613`), not from a desktop clock — the single place a watch-sourced timestamp has decision authority.

### Clock-domain problems

**R-M2-7 (risk) — the time-sync and Sony timestamp basis is the non-monotonic wall clock.** `now_ns()` reads `SystemTime::now()` (`watch-bridge/src/lib.rs:1119-1125`), and so do both Sony timestamp synthesis sites (`head-tracking:290-295`; `head_pose.rs:315-319`). An NTP or manual step during a session therefore (a) shifts every subsequent clock-offset estimate by the step size — the 5-sample median smooths jitter, not a step (`:1037-1041`); (b) can make `round_trip_ns` read exactly 0 through `saturating_sub` if the step is backwards (`:1102`); and (c) makes `HeadPose.timestamp_ns` non-monotonic. Impact is bounded because none of these three values is ever applied to a sample (rows 6 and 9) — the offset is displayed, and the Sony timestamp is dropped at the UI boundary — so this is a diagnostics-quality risk, not a control-path one.

**R-M2-9 (risk) — PPG sample timestamps lose precision at the frontend if the SDK domain is epoch-scale.** `WatchPpgBatch.timestampsNs` is typed `number[]` in the frontend contract (`events.ts:161, 171`; the medical batch interfaces and `PpgSampleSnapshot` at `:96-112` are the same), i.e. an IEEE-754 double. Rust holds the same values as `u64` (`protocol:685`). For boot-relative values this is exact for ~104 days of uptime, but an epoch-nanosecond value (~1.8 × 10¹⁸) exceeds 2⁵³ and would be rounded before it reaches `translateToWatchClockDomain` and `raw.csv` — so the timestamps the recorder persists would differ from the ones inference saw. Whether this is reachable depends entirely on G-M2-1.

**D-4 (confirmed).** `telemetryStore.ts:106-108` states the envelope timestamp is "the watch `SystemClock`-based envelope timestamp used everywhere else, **including** `WatchOrientationSample.timestampNs`". It is not: orientation alone carries `SensorEvent.timestamp` (row 1), while every other sender calls `SystemClock.elapsedRealtimeNanos()` inline (row 2/4/5). The same claim is restated independently in the typed event contract — "the same clock domain `WatchOrientationSample.timestampNs` uses" (`events.ts:163-169`) — and `docs/protocols/watch-websocket-protocol.md:28` describes one undifferentiated "watch monotonic-clock timestamp" for the whole protocol. Consequences, all cited:
- `translateToWatchClockDomain`'s anchor is in domain 1's *sibling* domain, not domain 1 — the PPG rows are re-anchored onto the batch-flush clock, and orientation rows remain on the sensor clock.
- `pushDatasetRowSorted` then merges and sorts both channels' rows against each other by `timestampNs` (`telemetryStore.ts:650-676`), and `csv_io.py` carries values forward across that merged order (`csv_io.py:130, 141-155`). Any constant offset between the two Android bases shifts orientation rows relative to PPG rows inside every training window.
- The *interleaving* defect is confined to the recorder. The live inference path never compares the two: fusion uses the desktop clock for freshness and the PPG batch's own timestamps for monotonicity.
- Severity is bounded by G-M2-5: on devices where the two bases coincide, the merge is correct. This is a correctness claim resting on an unverified device property, which is itself the defect.

---

## Rate-control authority

Requested, physical, accepted and displayed rates are distinct everywhere. The table states who owns each.

| Stream | Requested by | Who owns the physical rate | What the request actually changes | Accepted rate (what reaches UI/CSV) | Displayed rate |
| --- | --- | --- | --- | --- | --- |
| Watch IMU: orientation / acceleration / gyroscope | Desktop `desktop.set_sensor_rate`, 1–200 Hz, validated on both sides (`protocol:133-134`; `MotionSensorProtocol.kt:15-16`; `watch-bridge/src/lib.rs:349-371`) | **Android + hardware.** The watch converts Hz to `samplingPeriodUs = (1e6/hz).toInt().coerceAtLeast(1)` and re-registers only that sensor (`SensorCollector.kt:142-159`). `docs/…/watch-websocket-protocol.md:88-90` says plainly that "Hardware and Android may deliver a different measured rate" | `registerListener` sampling period; ignored while in `startMonitoring`'s reduced-rate mode, but remembered (`SensorCollector.kt:133-141`) | Everything that arrives — orientation is **never** throttled desktop-side on the inference or event path | Not measured anywhere for IMU |
| Watch raw PPG | Desktop `desktop.set_sensor_rate` with `sensor: "ppg_continuous"`, **0.1–10 Hz** (`protocol:135-136, 160`; `PpgCollector.kt:328-329`) | **Samsung Health Sensor SDK.** `PpgCollector.kt:101` states it outright: "Samsung remains authoritative for physical PPG sampling" | Only the `HealthTracker.flush()` schedule — how often buffered callbacks are released (`PpgCollector.kt:102-112, 200-214`). It cannot manufacture callback cadence (`docs/…:96-98`) | Every sample in every accepted batch; no desktop PPG throttle on the inference path | `WatchStatus.ppg_rate_hz`, derived from the first/last **SDK** timestamp of the most recent batch and assuming ns (`watch.rs:196-203`). Correct only under G-M2-1 |
| Samsung medical continuous (heart rate, skin temperature, EDA) | **Nobody.** `protocol:126-127` states it explicitly: "Samsung Health Sensor SDK owns their physical sampling rate and it is never requested or overridden here." `RATE_CONTROLLABLE_SENSOR_IDS` excludes them (`protocol:163-168`) | Samsung SDK | Only enable/disable, via `desktop.set_sensor` (`protocol:175-182`) | **Desktop acceptance throttle**, 0.1–200 Hz per channel, applied in the frontend store only (`settings.rs:26-27, 59-64`; `telemetryStore.ts:823-836`, `canAcceptHealth`). These values are never sent to the watch (`apply_watch_settings` sends only the four IMU/PPG-flush rates — `settings.rs:468-482`) | `heart_rate_rate_hz` / `skin_temperature_rate_hz` / `eda_rate_hz` from `batch_rate_hz` over SDK timestamps (`watch.rs:137-146, 243, 269, 292`) |
| Samsung on-demand (SpO2, ECG, BIA, sweat loss) | Bounded sessions only — `desktop.start_measurement`/`stop_measurement`; rate control is structurally impossible (`protocol:194-202`) | Samsung SDK + its consent policy | Session start/stop | Sent immediately on arrival, chunked at 32 (`WatchLinkManager.kt:216-255`) | None |
| Sony head pose | `headphonesRateHz`, 1–200 Hz (`settings.rs:20-21`) | The tracker (external CLI or native engine). `packets_per_second` is source-reported (`protocol:20`) | **Nothing on the device.** This is purely a desktop **acceptance** gate, measured on a desktop `Instant` (`settings.rs:413-434`) | Only poses that pass the gate reach `POSE_EVENT`. Calibration observes **every** pose regardless (`head_pose.rs:242-252`) — a deliberate split, documented at `settings.rs:407-412` | `packetsPerSecond` passed through to the UI (`events.ts:20`) |
| Desktop graph refresh | `graphRefreshRateHz`, 1–60 Hz (`settings.rs:24-25`) | n/a | Only how often store subscribers are notified. Explicitly **not** a data-loss gate: ring buffers still receive every accepted sample (`telemetryStore.ts:269-272, 811-815, 1150-1156`) | n/a | n/a |
| Desktop CSV recording | `recordingRateHz`, 1–200 Hz (`settings.rs:22-23`) | n/a | A per-channel min-interval gate on the ordinary `rows` buffer only (`telemetryStore.ts:273-276, 817-821, 1093-1098`). The **dataset recorder is not throttled by it** — `pushDatasetRowSorted` is called unconditionally (`:901, 951`) | Throttled per channel | n/a |
| Inference | **Not rate-controlled at all.** One PPG batch = one classification attempt (`inference.rs:237`); no decimation, no debounce. Cadence is whatever the Samsung flush schedule and the 40 ms drain produce | Samsung + the 40 ms flush timer | — | — | — |
| Haptic feedback | Fixed: 20 ms pulse, min 125 ms between pulses on the desktop `Instant` (`overlay.rs:24-25, 385-405`), bounds re-validated at the bridge (`watch-bridge/src/lib.rs:376-387`) and again on the watch (`WatchLinkManager.kt:358-363`) | — | — | — | — |

### Confirmed defect D-1 — two rate/smoothing controls with no effect

`WristRotationConfig.smoothing_alpha` and `max_volume_points_per_second` are:
declared (`interaction-engine/src/lib.rs:401, 407`), defaulted to 0.2 and 30.0 (`:419, 422`), exposed in the settings UI and clamped there (`settings.rs:30-37, 67-74`), persisted (`:121, 125`), rebuilt into the config on every read (`:173, 177`), re-validated on every write (`:270, 288`), and rejected when invalid (`validate_wrist_config`, `:638-652`).

They are then **never read**. `WristRotation::observe` (`interaction-engine/src/lib.rs:580-635`) uses only `dead_zone_degrees`, `volume_points_per_degree`, `max_angular_velocity_degrees_per_second` and `invert_direction`. A repository-wide search over `crates/` and `apps/desktop/src-tauri/src` for both identifiers returns only the declaration, default, validation and plumbing sites listed above — no read site (V-M2-5). The user-visible effect: changing "smoothing" or the volume-points-per-second limit changes nothing about the volume response.

---

## Ordering, buffering, and backpressure

### Source identity

| Source | Identity key | How unique it is |
| --- | --- | --- |
| Watch | `deviceId`, validated non-empty only (`protocol:299-301`) | **A compile-time constant**: `WatchProtocol.DEVICE_ID = "galaxy-watch-4"` (`WatchProtocol.kt:53`), used as `WatchLinkManager`'s default parameter (`:45`) and never overridden (`MainActivity.kt:57`) → **D-3** |
| Watch connection slot | A single `AtomicBool active`, claimed by compare-exchange on both transports (`watch-bridge/src/lib.rs:186, 825-836, 750-761`) | Exactly one watch at a time; a second WebSocket client is closed with code 4409 (`:60, 830-833`) |
| Sony (UDP) | First sender `SocketAddr`, latched per connection (`head-tracking:246-275`) | **T-7 (tradeoff):** robust against a second tracker process interleaving two reference frames on the same loopback port, at the cost that a restarted tracker binding a new ephemeral source port is ignored until the 1 s disconnect timeout clears the latch (`head-tracking:302-309`) |
| Sony (native) | None — one in-process provider | n/a |

**D-3's reach.** Three separate guards are keyed on an identity that cannot vary: `PpgIngestRuntime.last_timestamp_ns`'s per-device map (`inference.rs:187, 200-203`), `FusionRejection::OrientationDeviceMismatch` (`fusion.rs:32, 104-106`), and the bundle's `sources: [{source_id: "watch"}]` (`telemetryStore.ts:783`). The device-mismatch guard is unreachable in practice; the watermark map is effectively single-keyed; recordings from two different watches are indistinguishable. Both the Rust and the frontend code are written as if the id varied — `inference.rs`'s own tests use `"watch-a"`/`"watch-b"` (`:1037-1039`).

### Sequence handling

- **Allocation:** one `AtomicLong` shared by every outgoing message type (`WatchLinkManager.kt:58`), incremented in `sendOrientation`, `sendStoredPpgStatus`, `sendButtonEvent`, each on-demand sender, each flush chunk, the heartbeat and the time-sync reply (`:152, 182, 190, 222, 233, 244, 253, 262, 269, 330, 372, 407, 430, 445, 455`).
- **Reset:** `sequence.set(0)` on each *fresh* transition into `CONNECTED` (`WatchLinkManager.kt:286-293`). The desktop's watermark is a `run_connection` local initialised to `None` (`watch-bridge/src/lib.rs:885`), so it resets per connection on both transports. A reconnect therefore cannot be poisoned by the old watermark in either direction.
- **Gate:** strictly increasing, enforced once for all types (`:1011-1026`), covered by four unit tests (`:1164-1254`). A **gap is tolerated** (only `<=` is rejected), which is what makes the BLE backlog drop below survivable.
- **Duplicate / out-of-order:** rejected, the watermark is **not** advanced (`:1024-1026`, test `:1185-1199`), and the rejection is published as `WatchEvent::InvalidMessage`, which the consumer treats as a stale-sensor condition and force-releases (`lib.rs:244-250`). An **undecodable payload advances the watermark anyway** so one bad message cannot wedge the stream — deliberate and tested (`:1229-1254`).
- **Ordering guarantee (R-M2-6):** `sequence.incrementAndGet()` and `link.send()` are two separate steps (e.g. `WatchLinkManager.kt:152, 161`). Order is preserved only because every sender runs on the main looper: `WatchLinkManager`'s scope is `Dispatchers.Main.immediate` (`:47`), `registerListener` is called without a `Handler` so sensor callbacks land on the main looper (`SensorCollector.kt:175, 187, 200`), and PPG callbacks are explicitly hopped (`PpgCollector.kt:287-295`). `BleGattTransport.kt:72-73` nonetheless documents the opposite — "read on the sensor threads that call `send`". If any sender ever moved off the main thread, two envelopes could reach the transport in the wrong order and the desktop would **permanently discard the lower-numbered one** and force a release. Latent, with its precondition stated.
- **Frontend dedup:** orientation arrives twice (as `WATCH_ORIENTATION_EVENT` and inside `WATCH_STATUS_EVENT`, `App.tsx:320-325`) and is deduped by `sequence === lastWatchOrientationSequence` only (`telemetryStore.ts:878-879`) — equality, not a watermark. `sequence` is not globally monotonic across channels on the recorder side, which `csv_io.py:126-128` records and works around by ignoring the column.

### Coordinate frames

| Value | Frame | Where it is fixed |
| --- | --- | --- |
| Watch quaternion | Android rotation-vector convention, reordered to `(w, x, y, z)` by `SensorManager.getQuaternionFromVector` | `SensorCollector.kt:220`; `events.ts:4-11`; `features.rs:82-84` |
| Watch acceleration | Gravity-compensated `TYPE_LINEAR_ACCELERATION` **preferred**, raw `TYPE_ACCELEROMETER` only as a hardware fallback — and nothing on the wire says which one was used | `SensorCollector.kt:23-27`. A **frame ambiguity**: on a device lacking the fused sensor, accel features carry a ~9.81 gravity component that varies with wrist attitude. Recorded as R-M2-11 |
| Wrist roll | Relative to a reference pose captured at grab time: `start.conjugate() * current`, roll extracted as `2·atan2(q.i, q.w)` with ±180° wrapping | `interaction-engine/src/lib.rs:597-605` |
| Sony pose | Tracker-relative; the frame is re-established by the headset on reconnect, signalled by `resetCounter` | `protocol:19`; `head-tracking:282-289`; `head_pose.rs:320-331`. A change **invalidates calibration** (`head_pose.rs:254-260`) and resets the pose filter (`head-tracking:283`) |
| Sony Euler | `ypr_degrees[0..2]` mapped positionally to yaw/pitch/roll | `protocol:63-65` |
| Head-target geometry | Quaternion-space angular distance against calibrated targets | `interaction-engine/src/lib.rs:158-239` |

### Reconnect, replay and source switching

- **Watch reconnect replay:** `WatchEvent::Connected` triggers `apply_watch_settings`, re-pushing six enable/disable commands and four rate commands (`lib.rs:187-194`; `settings.rs:456-483`). Both transports **subscribe to all four command channels before announcing `Connected`**, because a `tokio::broadcast` only reaches receivers that exist at send time — stated and implemented on both paths (`watch-bridge/src/lib.rs:838-846, 763-769`). Command channel capacity is 16 each (`:267-270`), comfortably above the 10 replayed commands.
- **Watch-side reconnect:** `handleState` restarts the heartbeat and both flush timers only on a *fresh* `CONNECTED`, and any non-connected state tears every timer down and **drops all buffered batches** (`WatchLinkManager.kt:282-311`). No stale batch survives a reconnect. The last PPG status is re-sent on reconnect (`:292, 178-184`).
- **BLE session loop:** scan → connect → trust gate → claim the slot → `run_connection` → close → 5 s retry, cancellable at every await (`watch-bridge/src/lib.rs:693-802`). `BleStatus::Streaming` is reported only after a first real envelope arrives (`ble.rs:15-24`; `:807-815`), and that first envelope is held in `BleLink.pending` so it still reaches the protocol layer (`ble.rs:206-208, 323-331`).
- **Transport switching:** starting one transport stops the other outright — no residual listener, mDNS registration, pairing browser or GATT connection (`settings.rs:485-510`). `start()` rebinds the listener when a previous `stop()` dropped it, so Wi-Fi → BLE → Wi-Fi works for the process's lifetime (`watch-bridge/src/lib.rs:398-413`). **Never falls back silently:** a failed BLE start is surfaced through `BleStatus`, never papered over (`:537-539`).
- **Sony source switching:** decided once per process at startup from `cfg!` plus one env var (`head_pose.rs:52-67, 205-222`). There is **no runtime switch and no fallback** — if the native provider fails to start, the UI is told the tracker is disconnected and that is the end of it (`:362-377`); the documented remedy is an env var plus a restart (`:128-136`).
- **D-2 (confirmed).** `PpgIngestRuntime` is registered once as app-managed state (`lib.rs:47`) and its watermark map is written only on an accepted window (`inference.rs:202-204`). Nothing clears it: not `WatchEvent::Disconnected`, not `force_release_and_hide`, not `PinchInferenceRuntime::reset` (which touches only the model runtime, `inference.rs:441-447`), not a transport switch. Since the key is constant (D-3) and the value lives in a boot-relative clock (domain 2), **any event that moves the watch's `elapsedRealtimeNanos` backwards wedges PPG ingestion permanently**: every window is `RejectedStaleOrOutOfOrder` and each one calls `force_release_policy`. A watch reboot is the obvious trigger; swapping to a second watch with lower uptime is another. Reproducible scenario S-2.

### Queue bounds, broadcast lag and backpressure

| Stage | Bound | Overflow behaviour |
| --- | --- | --- |
| Watch PPG buffer | Unbounded `mutableListOf` between 40 ms flushes (`WatchLinkManager.kt:52, 169`) | Bounded in practice by the flush period; cleared wholesale on any non-connected state (`:307`) |
| Watch medical buffers | Same, drained every 100 ms (`:412-420, 465`) | Same |
| Watch BLE outbound | **512 fragments** (`BleGattTransport.kt:517, 147`) | The **entire backlog** is dropped, not the oldest fragments, so the desktop reassembler is never left mid-envelope (`:142-149`). Recovery is verified by construction: the reassembler resets and accepts a fresh index 0 after a desync (`ble.rs:166-177`, test `reassembler_recovers_on_the_next_message_after_a_desync`) |
| Watch Wi-Fi outbound | None at the app layer (`WebSocketTransport.kt:82`) | okhttp's own internal limit |
| One BLE envelope | 16 KiB (`ble.rs:56`; `BleFraming.kt:25`) | Refused before sending; dropped on reassembly |
| `WatchEvent` broadcast | **256** (`watch-bridge/src/lib.rs:266`) | `RecvError::Lagged` → the consumer force-releases and continues (`lib.rs:266-272`) |
| Command broadcasts | 16 each (`:267-270`) | Send errors ignored (`let _ =`); a missing receiver silently drops the command |
| `HeadPoseEvent` broadcast (UDP) | 256 (`head-tracking:208`) | Lag logged and skipped (`head_pose.rs:286`) |
| Native head-pose channel | **Unbounded** mpsc (`head_pose.rs:368`) | None — R-M2-8 |
| Frontend series | 600 points per series (`telemetryStore.ts:135, 251`) | Ring eviction |
| Frontend CSV / dataset rows | 200 000 rows each (`:136, 253, 297`) | Ring eviction; a row older than everything retained at full capacity is dropped (`:243`) |
| Wire batch caps | Kotlin chunks at 32; Rust rejects > 512 (`WatchLinkManager.kt:466-467`; `protocol:220, 236`) | Rust rejects with `InvalidPpgBatch` → `InvalidMessage` → forced release |

**R-M2-2 — the lag chain.** `lib.rs:182-274` is a single sequential consumer. `ingest_ppg_window` runs **inline** on it, including model (re)load, bundle revalidation, digest verification and inference (`inference.rs:494-518, 532`). While that runs, nothing drains the 256-slot channel. At 200 Hz orientation plus PPG plus medical traffic, 256 slots is roughly a second of headroom; exceeding it yields `Lagged`, which force-releases — a safe outcome, but one where heavy inference causes the very fail-closed event it is trying to avoid.

**R-M2-3 — unbounded error loop.** `events.recv()` returning `Err` is handled without a `break` or any backoff (`lib.rs:266-272`). `Lagged` is fine (the next `recv` succeeds), but `Closed` returns immediately and forever, producing a hot spin that calls `force_release_and_hide` on every iteration. In practice `Closed` is unreachable while the app holds `Arc<WatchBridgeServer>` (`lib.rs:165`), so this is a risk with a stated precondition, not a live defect. `head_pose.rs:283-288` has the identical shape.

**R-M2-4 — BLE cannot carry PPG at the default MTU.** 512 fragments × 17 usable bytes ≈ 8.7 KB of queue. A 32-sample PPG batch envelope is a few KB (`ble.rs:54-55`), so roughly three batches fill the queue, and `pumpOutbound` sends one notification per `onNotificationSent` round trip. The 40 ms flush can therefore outrun the radio until the MTU is negotiated upward (`BleGattTransport.kt:397`). Sequence gaps are tolerated, so the symptom is data loss, not a forced release.

**R-M2-5 — un-throttled IPC.** Every watch event emits `WATCH_STATUS_EVENT` carrying a **full clone** of `WatchStatus` — two `HashMap`s and ten last-sample snapshots (`watch.rs:386-387, 100-135`) — and orientation additionally emits `WATCH_ORIENTATION_EVENT` (`:178`). At a requested 200 Hz that is 400 IPC messages per second plus 200 full-status serializations. `graphRefreshRateHz` throttles only React notification, after the payload has already crossed the boundary (`telemetryStore.ts:269-272`).

### Stale data, cancellation and shutdown

- **Five fail-closed convergence points**, all from M1, re-confirmed: disconnect (`lib.rs:226-231`), malformed/out-of-order (`:244-250`), PPG `unavailable`/`error` (`:251-259`), channel lag (`:266-272`), and the 200 ms watchdog (`:134-146`). A sixth and seventh live inside `ingest_ppg_window`: quality-gate and ordering rejections (`inference.rs:271-281`) and fusion rejections (`:328-331`).
- **Staleness bounds, quantified.** Orientation carried into a PPG window: 500 ms, desktop clock (`fusion.rs:21, 109`). Model-driven grab with no further model event: 750 ms, detected within one 200 ms tick, so 750–950 ms worst case (`gesture_policy.rs:177, 280-291`; `inference.rs:565`). Silent watch link: 3 s (`lib.rs:25`; `watch-bridge/src/lib.rs:892-897`) against a 1 s watch heartbeat (`WatchLinkManager.kt:463`). Sony silence: 1 s on the external path (`head_pose.rs:29`), native-backend-dependent otherwise.
- **T-4 (tradeoff).** A **button**-driven grab leaves `GesturePolicy` in `Idle`, so `on_tick` returns `None` immediately (`gesture_policy.rs:281-283`). Its only releases are button-up, disconnect, invalid message, PPG unavailable and channel lag. A link that goes silent mid-hold therefore holds the overlay for up to the 3 s heartbeat timeout. Deliberate and bounded; the protocol doc states the invariant it does guarantee — "a lost connection mid-hold can never leave the overlay stuck grabbed" (`docs/…:52-56`).
- **Cancellation.** BLE uses a flag-plus-`Notify` pair precisely because `notify_waiters` only wakes futures already awaiting, closing the window where a stop lands between two `select!`s (`watch-bridge/src/lib.rs:199-225`); the session is **cancelled, not aborted**, so no future is dropped mid-GATT-operation (`:247-249`), with a 20 s stop timeout (`:70, 573`). A cancelled scan is explicitly stopped because the scan future's own cleanup never ran (`:706-711, 800`). By contrast `WatchBridgeServer::stop` **aborts** the axum task (`:591`), and `SonyUdpHeadPoseProvider::stop` aborts its receive task and then emits `Disconnected` (`head-tracking:317-329`) — acceptable for a stateless UDP read.
- **Shutdown.** The main window's close is intercepted, both transports are torn down regardless of which is selected, then `exit(0)` (`lib.rs:106-127`). The mDNS advertisement is unregistered with a 500 ms wait on a blocking task (`watch-bridge/src/lib.rs:600-610`). The watch-event consumer loop and the head-pose task are never cancelled — they end with the process. `native-head-tracking`'s `Drop` joins the native worker before freeing the callback context (per M1, `provider.rs:136`), and `run_native` keeps `provider` alive for exactly that reason (`head_pose.rs:380-381`).
- **Watch-side lifecycle.** BLE deliberately keeps advertising when backgrounded, because dropping the GATT server would make every screen-off a disconnect (`BleGattTransport.kt:123-131`); Wi-Fi releases its socket on pause and re-establishes on resume (`WatchLinkManager.kt:131-143`).

---

## Cross-language contract comparison

Four mechanical comparisons were run. Commands, exit codes and outcomes are in *Acceptance evidence*; scripts were written to this job's scratch directory only and no file was added to the repository.

### C-1 — Watch protocol v1 literals (Kotlin ↔ Rust): **agree**

29 string literals (all 22 message types, the button id and both states, the three IMU sensor ids) and 11 numeric literals (protocol version, haptic bounds, IMU rate bounds, PPG flush-rate bounds, and the five BLE framing constants) were extracted from `WatchProtocol.kt` / `MotionSensorProtocol.kt` / `PpgCollector.kt` / `BleFraming.kt` / `BleGattTransport.kt` and from `crates/protocol/src/lib.rs` / `crates/watch-bridge/src/ble.rs`, and compared pairwise. **0 mismatches** (V-M2-1).

Vocabulary lists were compared separately (V-M2-2): the 7 medical tracker ids agree as a set, and `MEDICAL_TRACKER_STATES` (7 values) and `PPG_STATES` (6 values) agree **in order**. **0 mismatches**, with one documentation inaccuracy:

**D-7 (confirmed, low severity).** `MedicalTrackerProtocol.kt:6-8` says the tracker ids match `spatial_protocol::MEDICAL_TRACKER_IDS` "exactly". `TRACKER_PPG_CONTINUOUS = "ppg_continuous"` (`:10`) is not in that Rust list; in Rust it is `SENSOR_PPG_FLUSH`, a member of `RATE_CONTROLLABLE_SENSOR_IDS` only (`protocol:160, 163-168`), and deliberately absent from both `MEDICAL_TRACKER_IDS` and `CONTROLLABLE_SENSOR_IDS` (verified programmatically). This is **currently harmless**: the id is only ever used as the subject of a rate command (`MainActivity.kt:184-189`), and `medicalCollector.state` only ever reports heart rate, skin temperature and EDA (`MainActivity.kt:224-228`). Were a `watch.medical_status` for `ppg_continuous` ever emitted, `protocol:565-567` would reject it as `UnknownMedicalTracker` → `InvalidMessage` → forced release.

**T-6 (tradeoff).** Kotlin chunks PPG and medical batches at 32 samples (`WatchLinkManager.kt:466-467`) while Rust accepts up to 512 (`protocol:220, 236`). Asymmetric by design — the Rust bound is an anti-abuse ceiling, documented as such at `protocol:233-235`.

### C-2 — BLE GATT and framing (Kotlin ↔ Rust): **agree, byte for byte**

The three GATT UUIDs match exactly (V-M2-1). For the frame layout, `watch_bridge::ble::fragment` was executed for real — a throwaway crate outside the repository, path-depending on `watch-bridge`, printed its actual output bytes — and `BleFraming.kt:41-59` was re-expressed step for step in Python and compared (V-M2-3):

| Case | Rust bytes (executed) | Kotlin-algorithm bytes | Result |
| --- | --- | --- | --- |
| `{"type":"watch.heartbeat"}`, 200-byte payload | `0100007b2274797065…227d` (1 frame) | identical | OK |
| empty message, 20-byte payload | `010000` (1 frame) | identical | OK |
| 1000 bytes, 20-byte payload (min MTU) | 59 frames; first `000000 00…10`, last `01003a e9…f6` | identical count, identical first and last frames | OK |
| 16 KiB + 1 | refused | refused (`null`) | OK |

**0 mismatches.** Caveat (G-M2-3): the Kotlin side was re-expressed in Python, not executed as Kotlin — this host has no Android SDK and no `kotlinc`, so `BleFramingTest.kt` cannot run. Note also that both test suites are same-language round trips (`BleFramingTest.kt:16-29` and the eight `ble::tests` in `ble.rs`); **neither side validates the other's bytes**, so the comparison above exists only in this review, not in the repository. Reassembly differences were checked by reading: Kotlin's `nextIndex` is an `Int` incremented plainly, Rust's a `u16` with `wrapping_add` (`BleFraming.kt:97`; `ble.rs:190`) — unreachable divergence, since 16 KiB at a 1-byte minimum chunk is 16 384 fragments, well under `u16::MAX`. Both sides clamp the usable ATT payload to a floor of 20 bytes (`BleFraming.kt:34`; `ble.rs:296-299`), so both would over-fill a sub-23-byte MTU identically.

### C-3 — 55-feature contract (Rust ↔ Python): names agree, **semantics diverge**

M1 verified the 55 names and their order are identical. This milestone compared what the two sides *compute*.

`FusedWindow` carries **one orientation snapshot per PPG batch** (`features.rs:73-95`; `fusion.rs:95-137`), so Rust derives all accel, gyro and quaternion statistics from a single value via `constant_stat_block` — mean = min = max = that value, **std = 0** (`features.rs:118-123`) — and computes `quat_delta_angle_deg` between the snapshot and *itself*, which is identically `0.0` (`features.rs:258-261`). Python computes the same statistics over every row in a 500 ms window (`features.py:103-158`), where `csv_io.py:130, 141-155` has forward-filled each channel from its own genuine samples.

Reproduced (V-M2-4): a synthetic session at the documented capture rates — PPG 25 Hz, orientation 50 Hz, single-channel-per-row exactly as `telemetryStore.ts:901-973` writes them, with a slow deliberate wrist roll — loaded through the real `load_recording`/`build_windows`/`extract_features`:

```text
window rows=39 span_ms=500.0
features Rust holds at 0.0 that are non-zero in this training window: 11/13
  accel_x_std=0.0205  accel_y_std=0.0156  accel_z_std=1.5519  accel_magnitude_std=1.5520
  gyro_x_std=0.0748   gyro_y_std=0.000316 gyro_z_std=0.0225   gyro_magnitude_std=0.0780
  quat_w_std=0.1573   quat_x_std=0.0520   quat_delta_angle_deg=180
sample_count (training) = 39 (all channels' rows); duration_ms = 500.0
```

**R-M2-1 (risk, not a confirmed defect).** 13 features (`accel_*_std`, `accel_magnitude_std`, `gyro_*_std`, `gyro_magnitude_std`, `quat_*_std`, `quat_delta_angle_deg`) are structurally `0.0` live and demonstrably non-zero in training. Two more differ in basis: `sample_count` counts every channel's rows offline (39 above) but only one batch's PPG samples live (`features.rs:264`), and `duration_ms` is the window length offline (500.0) but the batch's own span live (`features.rs:265-272`). It is classified as a risk rather than a defect because `features.rs:73-77` and `fusion.rs:1-7` both state the carry-forward design openly and assert the model "was trained against exactly this carry-forward contract" — the gap is between that claim and `windowing.py`'s 500 ms multi-sample windows, and no trained model exists in-repo against which to measure the accuracy cost. Quantifying it needs a trained bundle (G-M2-6).

**R-M2-12 (artifact).** `quat_delta_angle_deg` reads exactly 180° above, because `_carry_forward`'s documented leading-NaN fallback fills 0.0 before the first genuine orientation row (`csv_io.py:141-155`), and a zero quaternion normalizes to zero, so `2·arccos(0) = 180°` (`features.py:95-100`). Any window containing rows that precede the session's first orientation sample carries this value. Bounded to session starts.

What is **not** skewed, checked explicitly: the `ppg_*_slope` and `duration_ms` arithmetic is delta-only on both sides (`features.rs:127-139` vs `features.py:88-92`), and `translateToWatchClockDomain` preserves intra-batch deltas exactly (`telemetryStore.ts:118-122`), so the frontend's domain translation introduces no divergence in any derived feature. `stat_block` uses population variance (`ddof=0`) to match numpy's default, stated at `features.rs:97-101`.

### C-4 — classification state machine (Rust ↔ Python): **2 divergences in 10 steps**

`runtime.rs:5-7` claims the Rust port is "kept behaviorally identical to the Python reference". The real `DesktopPinchRuntime` was driven over a scripted probability sequence through a stub `PinchModel` (throwaway crate, outside the repository), and the Python reference's validation and threshold branches (`desktop_runtime.py:52-81`) were run over the same sequence (V-M2-6):

| Step | `[negative, start, release]` | Python | Rust | Verdict |
| --- | --- | --- | --- | --- |
| 0 | 0.90, 0.05, 0.05 | none | none | agree |
| 1 | 0.10, 0.85, 0.05 | started 0.8500 | started 0.8500 | agree |
| 2 | 0.30, 0.60, 0.10 | held 0.9000 | held 0.9000 | agree |
| 3 | 0.10, 0.05, 0.85 | released 0.8500 | released 0.8500 | agree |
| 4 | 0.10, 0.05, 0.85 (inactive) | none | none | agree |
| 5 | 0.10, 0.85, 0.05 | started 0.8500 | started 0.8500 | agree |
| 6 | backend failure while active | released 1.0000 | released 1.0000 | agree |
| 7 | 0.10, 0.85, 0.05 | started 0.8500 | started 0.8500 | agree |
| 8 | **2.0, 3.0, 1.0** (unnormalized, finite) | **held 0.0000** | **released 1.0000** | **diverge** |
| 9 | 0.34, 0.33, 0.33 | held 0.6700 | none | diverge — downstream of step 8 only |

**Root cause, cited.** Rust validates the output as a probability distribution: every value within tolerance of `[0, 1]` *and* summing to 1.0 within tolerance, otherwise `InvalidOutput` (`model.rs:35-59`), which `submit` treats as a failure and converts into a forced release (`runtime.rs:64-68`). Python checks only shape and finiteness (`desktop_runtime.py:66-67`), so `[2, 3, 1]` passes, `released = 1.0 < 0.80` is false, and the grab is held with confidence `max(0, 1-1.0) = 0`. Step 9 is **not** an independent divergence: it follows mechanically from Rust being inactive and Python still active after step 8.

**T-2 (tradeoff).** Rust is the safe side and is deliberately so — `runtime.rs` has a test named `unnormalized_model_output_forces_a_release`. The finding is that the "behaviorally identical" claim is inaccurate, not that Rust is wrong.

**T-3 (tradeoff).** Rust accepts a reduced-length feature slice (test `submit_accepts_a_reduced_length_feature_slice`; rationale at `model.rs:64-68`) to support custom bundles declaring a strict feature subset. Python's reference rejects anything but exactly 55 values and additionally requires `ordered_names == FEATURE_NAMES` (`desktop_runtime.py:34-35, 61`). Subset bundles are a Rust-only capability, by design.

### C-6 — recording-bundle validation (Rust ↔ Python): **asymmetric**

**D-6 (confirmed).** `validate_raw_csv_full` checks the exact header, field count and per-field numeric parseability, and records the first and last timestamps — but **never checks that timestamps are ordered** (`recording_bundle.rs:350-402`). `csv_io.load_recording` rejects any row whose timestamp decreases, as a hard `CsvFormatError` (`csv_io.py:101-106`). The desktop therefore accepts and persists a `raw.csv` that the trainer will refuse, and the resulting `recording.json` carries a `duration_ms` computed as `last - first` clamped at 0 (`recording_bundle.rs:538`), which is meaningless for unordered input. The live recorder does insert rows in chronological order (`telemetryStore.ts:650-676`), so this is reachable through `import_recording_from_raw_csv` and the legacy conversion path, not through normal capture.

**D-5 (confirmed).** `MonotonicWallClock.monotonic_ns` (`recording_bundle.rs:108-109`) holds the WebView monotonic clock for a recorded bundle (`telemetryStore.ts:746-747, 778-779`) and the watch's own source timestamps for an imported one (`recording_bundle.rs:544-550`). The same is true of `requested_start_monotonic_ns`/`requested_end_monotonic_ns` (`telemetryStore.ts:797-798` vs `recording_bundle.rs:567-568`). One field, two clock domains, distinguishable only by provenance — and `resolved_*.source_timestamp_ns` sits beside it already meaning the watch domain in both cases.

---

## Reproducible scenarios and unknowns

### Scenarios with a source-cited reproduction

**S-1 — a wrist-rotation setting with no effect (D-1).** Set `wristSmoothingAlpha` to its minimum 0.01 and then its maximum 1.0 (`settings.rs:30-31`), and `wristMaxVolumePointsPerSecond` to 1 and then 100 (`:36-37`); grab the overlay and roll the wrist identically each time. The volume trajectory is identical, because `observe` reads neither value (`interaction-engine/src/lib.rs:580-635`). Deterministic, no hardware-specific behaviour involved beyond producing orientation samples.

**S-2 — PPG wedged for the process lifetime after a watch reboot (D-2).** With a model active and inference `Monitor` or `Live`: stream PPG so the watermark advances (`inference.rs:202-204`); reboot the watch; reconnect. The watch's `elapsedRealtimeNanos` restarts near 0 (`WatchLinkManager.kt:406`), the desktop's watermark still holds the pre-reboot value because nothing clears it, and the key is identical because `deviceId` is a constant (`WatchProtocol.kt:53`). Expected: every window emits `PpgWindowOutcome::RejectedStaleOrOutOfOrder` (observable on `PPG_WINDOW_OBSERVED_EVENT`, `inference.rs:66, 268`) and each one calls `force_release_policy` (`:271-281`), for the rest of the desktop process's life. Recovery requires restarting the desktop app. Deterministic given a reboot; **not executed here** — needs a Galaxy Watch (G-M2-2).

**S-3 — C-4 divergence on an unnormalized model output.** Exactly the step-8 row above. Reproduced in full this session: `cargo run --bin smtrace` against the real `DesktopPinchRuntime`, and the Python branch logic over the same sequence (V-M2-6). No hardware needed.

**S-4 — feature skew between training and live windows (R-M2-1).** Reproduced this session (V-M2-4) on a synthetic recording at the documented capture rates. Quantifying the *accuracy* consequence additionally needs a trained bundle and the `litert` feature (G-M2-6).

**S-5 — BLE PPG starvation at the default MTU (R-M2-4).** Connect over BLE without MTU negotiation (`mtu` stays `DEFAULT_MTU = 23`, `BleGattTransport.kt:510`), enable PPG, and watch the outbound deque: a 32-sample batch produces ~150–180 fragments at a 17-byte chunk, so three batches exceed `MAX_QUEUED_FRAGMENTS = 512` and the backlog is cleared (`:147-149`). Observable as sequence gaps on the desktop without any `InvalidMessage` (gaps are tolerated, `watch-bridge/src/lib.rs:1011-1012`). **Not executed** — needs a BLE peer (G-M2-2).

**S-6 — the orientation-domain merge (D-4).** On any device where `SensorEvent.timestamp` and `SystemClock.elapsedRealtimeNanos()` do not share a base, record a dataset session and compare `raw.csv` row order against arrival order: orientation rows will be displaced relative to PPG rows by the constant offset, because `pushDatasetRowSorted` sorts on `timestampNs` across both domains (`telemetryStore.ts:650-676`). The offset is directly measurable on-watch by logging both clocks in `SensorCollector.onSensorChanged`. **Not executed** — needs a watch, and the device property itself is unverified (G-M2-5).

**S-7 — forced-release storm on channel closure (R-M2-3).** Requires `Arc<WatchBridgeServer>` to be dropped while the consumer loop lives, which the current composition root prevents (`lib.rs:164-165`). **Explicitly unverified**, and recorded as a structural risk rather than a reachable scenario; the missing evidence is any code path that drops the server early.

**S-8 — stale displayed PPG rate (R-M2-10).** `WatchStatus.ppg_rate_hz` is written only when a batch arrives (`watch.rs:196-203`) and cleared only by `Connected`/`Disconnected` (`:167-175`). Disable PPG with `desktop.set_sensor` while connected: the last computed Hz stays on screen indefinitely. Deterministic; **not executed** (needs a watch).

### Evidence gaps

**G-M2-1 — the unit and epoch of `DataPoint.getTimestamp()` are asserted nowhere.** `PpgCollector.kt:278` stores it into a field named `timestampNs`; the wire field is `timestampsNs`; `fusion.rs`, `features.rs` and `watch.rs:196-203` all divide by `1e9`/`1e6` as if it were nanoseconds. Searched for a primary assertion and found none:
- The vendored API docs are inert. All nine HTML files under `vendor/samsung-health-sensor-sdk/1.4.1/` are 239–296 bytes — JavaScript shells with no content (`wc -c`, V-M2-7); `grep -c -i timestamp` on `programming-guide.html` returns 0. `PpgCollector.kt:192-194` already records this ("its HTML docs are an empty JS shell").
- Decompiling the vendored AAR gives only the signature. `javap -p` on `com/samsung/android/service/health/tracking/data/DataPoint.class` (extracted from `libs/samsung-health-sensor-api-1.4.1.aar`) yields `public long getTimestamp();` over an obfuscated `private long a` — no unit, no doc comment (V-M2-8).
- The repository's own statement is about the domain, not the unit: "monotonic but on their own clock domain" (`docs/…:111-113`).

**Why it matters, precisely.** Both the Rust runtime and the Python trainer treat the value the same way, so there is **no train/serve skew** from this — their `slope` and `duration_ms` arithmetic is delta-only and identical. What depends on the unit is the *physical meaning* of two features and one display: if the value is milliseconds, `duration_ms` and every `ppg_*_slope` are off by 10⁶ (consistently, in both paths), and `WatchStatus.ppg_rate_hz` reads 10⁶× high. **Required validation:** connect a Galaxy Watch 4+, enable PPG, and read the displayed PPG Hz. A plausible ~25 Hz confirms nanoseconds; ~2.5×10⁷ Hz confirms milliseconds. That single observation settles it, and it is also the cheapest check that `windowing.py`'s 500 ms windows and 250 ms gap threshold mean what they say for PPG rows.

**G-M2-2 — no physical hardware.** No Galaxy Watch, no Sony headset, no BLE peer. Unexercised: the BLE trust gate and bonding (`ble.rs:15-24`), MTU negotiation, real sensor and flush cadence, the native macOS/Windows FFI link, every measured rate in the table above, and S-2/S-5/S-6/S-8. Carried from M1 unknown 4.

**G-M2-3 — Kotlin is not executable here.** No Android SDK (M1 V-11) and no `kotlinc` on this host, so `BleFramingTest.kt` and `WatchTransportKindTest.kt` did not run, and the C-2 byte comparison used a Python re-expression of `BleFraming.kt:41-59` rather than the Kotlin itself. **Required validation:** provision an Android SDK and run `:app:testDebugUnitTest`, and add a shared fixture both sides assert against (M1's G-1 notes neither CI job covers `apps/watch/`).

**G-M2-4 — `spatial-gesture-desktop` is still unbuildable here.** No `pkg-config`/GTK (M1 V-10), so `lib.rs`, `inference.rs`, `watch.rs`, `overlay.rs`, `settings.rs`, `head_pose.rs` and `recording_bundle.rs` have **no execution evidence in this review either**. Every claim about them is source-level. Their unit tests do exist (e.g. `inference.rs:978-1039`) and CI runs them (`desktop-ci.yml:48`). **Required validation:** install the Linux Tauri prerequisites, or read the CI run for `a2e7d58`.

**G-M2-5 — the relationship between `SensorEvent.timestamp` and `elapsedRealtimeNanos` is device-dependent.** D-4's severity turns on this, and it cannot be established from this repository or from this host. **Required validation:** log both clocks side by side in `SensorCollector.onSensorChanged` on the target hardware and record the offset.

**G-M2-6 — no trained model exists in-repo.** `litert` is off by default in both manifests (M1 unknown 3), so no real classification ran. The accuracy cost of R-M2-1 and the real-world frequency of C-4's step-8 case (how often a TFLite softmax output drifts outside the sum tolerance) are both unquantified. **Required validation:** a trained bundle plus a `--features litert-inference` build, replaying one recorded session through both the Python reference and the desktop runtime and diffing the transition streams.

### Unknowns

1. Whether `desktop_monotonic_now_ns`'s `OnceLock` anchor is initialised before or after the first watch sample in practice. First call wins (`inference.rs:575-576`), so the first orientation sample can read ~0 and the first PPG window shortly after; `saturating_sub` keeps it safe (`fusion.rs:108`), but the first few windows' `elapsed_ns` are measured from an arbitrary origin. Not observable without running the Tauri crate (G-M2-4).
2. Actual `broadcast` lag frequency under real load. 256 slots is a guess at adequacy until R-M2-2's chain is measured with a real model.
3. Whether any shipped Galaxy Watch lacks `TYPE_LINEAR_ACCELERATION`, which would silently switch the accel frame to include gravity (`SensorCollector.kt:26-27`). Nothing on the wire reports which sensor was used, so a recorded dataset cannot be audited for this after the fact.
4. Whether `estimated_at_ns` on `ClockOffsetEstimate` is intended for future use or is simply dead (`watch-bridge/src/lib.rs:131`; discarded at `watch.rs:185-189`).
5. The real distribution of `receive_latency_ms` and `packets_per_second` from the Sony sources — both are passed through unvalidated (`protocol:20-21, 70-71`) and displayed (`events.ts:20-21`); nothing bounds or sanity-checks them.
6. Whether the native head-pose path's missing `StationaryPoseFilter` (R-M2-8) is deliberate (the native engine may filter internally) or an omission. `head_pose.rs:352-356` explains why the function needs no `cfg` branching but says nothing about the filter.

---

## Acceptance evidence

### Checks executed

| # | Command | Exit | Outcome |
| --- | --- | --- | --- |
| V-M2-1 | `python3 $JOB_TMP/m2/compare_contracts.py` | 0 | C-1/C-2 literals: 29/29 strings, 11/11 numbers, 3/3 GATT UUIDs agree. **0 mismatches** |
| V-M2-2 | `python3 $JOB_TMP/m2/compare_vocab.py` | 0 | 7/7 tracker ids (set), 7/7 medical states (ordered), 6/6 PPG states (ordered) agree. Kotlin-only `ppg_continuous` confirmed absent from Rust's `MEDICAL_TRACKER_IDS` and `CONTROLLABLE_SENSOR_IDS`, present in `RATE_CONTROLLABLE_SENSOR_IDS` → D-7 |
| V-M2-3 | `cargo run --quiet --offline` (throwaway crate) then `python3 $JOB_TMP/m2/ble_frames_kotlin.py` | 0, 0 | Real `watch_bridge::ble::fragment` bytes captured for four cases; Kotlin algorithm matches all four byte for byte. **0 mismatches** |
| V-M2-4 | `uv run --directory tools/pinch-classifier python $JOB_TMP/m2/feature_skew.py` | 0 | 39-row / 500.0 ms window built by the real `build_windows`; **11 of 13** features that Rust pins to 0.0 are non-zero; `sample_count` 39 vs one batch's PPG count, `duration_ms` 500.0 vs one batch's span |
| V-M2-5 | `grep -rn "smoothing_alpha\|max_volume_points_per_second" crates/ apps/desktop/src-tauri/src --include=*.rs` | 0 | 16 hits: declaration, defaults, validation, settings plumbing. **No read site in `observe`** → D-1 |
| V-M2-6 | `cargo run --quiet --offline --bin smtrace && uv run --directory tools/pinch-classifier python $JOB_TMP/m2/sm_python.py` | 0 | Real Rust `DesktopPinchRuntime` traced over 10 steps against the Python reference's branches: **8/10 agree**, divergent steps exactly `[8, 9]`. The check asserts that *set*, so it also fails on a new or vanished divergence rather than merely on finding one |
| V-M2-7 | `wc -c vendor/samsung-health-sensor-sdk/1.4.1/docs/*.html .../sample-codes/*.html` | 0 | All nine files 239–296 bytes, 2445 total — inert JS shells → G-M2-1 |
| V-M2-8 | `javap -p …/DataPoint.class` (temurin-17, on the AAR extracted into the job scratch dir) | 0 | `public long getTimestamp();` only; no unit information → G-M2-1 |
| V-M2-9 | `cargo test -p watch-bridge -p pinch-inference -p head-tracking -p interaction-engine --all-targets` | 0 | **131 tests passed, 0 failed**, including the four sequence-watermark tests, eight BLE framing tests, `unnormalized_model_output_forces_a_release` and `submit_accepts_a_reduced_length_feature_slice` |
| V-M2-10 | `git status --porcelain` before and after every run | 0 | Byte-identical to the opening capture throughout; the five pre-existing dirty paths untouched |
| V-M2-11 | `git rev-parse HEAD` / `git ls-remote origin main` | 0 | Both `a2e7d58935bf3235500934969b5dd58d75e25bd2` before this report's commit |

Scratch artifacts (comparison scripts, the extracted AAR, the throwaway Rust crate and its `target/`) were created **only** under this job's temporary directory, never in the repository, and no repository file was added, modified or deleted other than this report. No system package was installed and no network fetch was required: `uv` resolved `tools/pinch-classifier`’s own (gitignored) project environment, and `cargo` ran `--offline` against the already-populated local registry.

Not attempted, with reasons: `cargo test -p spatial-gesture-desktop` (G-M2-4, and the capsule forbids installing the Linux Tauri prerequisites); `./gradlew :app:testDebugUnitTest` (G-M2-3); any `--features litert-inference` build (network-dependent native fetch, M1 "not attempted"); `npm test` / `npm run build` (re-verified green in M1 at the parent commit; nothing in this milestone changed frontend code, and re-running risks perturbing the pre-existing `package.json` state).

### Milestone 2 acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Cited sequence diagram for Watch IMU and PPG, hardware acquisition through every transformation and consumer, including raw timestamps and active-IMU behaviour | **met** | *Watch IMU and PPG flow* — one diagram with ~60 inline citations spanning `SensorCollector.kt` → `WatchProtocol.kt` → both transports → `watch-bridge` → the single consumer loop → inference, overlay, recording and UI; plus five active-IMU behaviours cited separately |
| Cited sequence diagram for Sony motion through provider selection, desktop acceptance/rate control, graphing, recording, inference | **met** | *Sony motion flow* — both provider paths, the acceptance gate at `settings.rs:413-434`, graph/CSV consumers, and the explicit finding that Sony reaches neither `raw.csv` nor inference, each cited |
| Every source and receive timestamp classified by unit, origin, clock domain, monotonicity, authority, conversion, replacement, rounding, synthesis, persistence | **met** | *Timestamp and clock domains* — 14 rows over all ten axes, plus the three rules that hold and the one that is undermined (D-4) |
| Rate-control authority explicit for Watch IMU, Samsung PPG, medical sensors, Sony acceptance, desktop UI, recording, inference; requested/physical/accepted/displayed distinguished | **met** | *Rate-control authority* — 10 streams × 6 columns, naming the owner of each; D-1 recorded |
| Source identity, sequence handling, duplicate/out-of-order, coordinate frames, reconnect replay, source switching, queue bounds, broadcast lag, stale samples, cancellation, shutdown traced | **met** | *Ordering, buffering, and backpressure* — six subsections; D-2, D-3, R-M2-2…R-M2-6, T-4 |
| Kotlin/Rust Watch protocol literals and BLE framing plus Rust/Python state-machine behaviour mechanically compared where possible; exact checks and results recorded | **met** | *Cross-language contract comparison* + V-M2-1…V-M2-6. C-1/C-2 agree (0 mismatches, byte-level for framing); C-4 diverges at 2 of 10 steps; C-3 semantics diverge in 15 features. Execution limits stated at G-M2-3 |
| Every timing or concurrency risk has a source-cited reproducible scenario or is explicitly labelled unverified with missing evidence and required validation | **met** | *Reproducible scenarios and unknowns* — S-1…S-8 (S-1, S-3, S-4 reproduced here; S-2, S-5, S-6, S-8 cited-but-not-executed with the blocking gap named; S-7 explicitly labelled unverified) and G-M2-1…G-M2-6, each with "Required validation" |
| Confirmed defects, risks, intentional tradeoffs, evidence gaps and unknowns distinguished; no product-code fixes proposed or applied | **met** | D-1…D-7 confirmed; R-M2-1…R-M2-12 risks; T-1…T-7 tradeoffs; G-M2-1…G-M2-6 gaps; 6 unknowns. No remediation is stated anywhere; "Required validation" entries are evidence requests, not fixes |
| Only the review report committed and pushed; pre-existing dirty work and product code untouched | **met** | V-M2-10, V-M2-11; one added path, `.hermes/reviews/gesture-controls-sensor-timing.md` |

### Self-review performed before delivery

- Every citation was read from the primary worktree, never from the three `.claude/worktrees/` copies (M1 R-2).
- No raw prompts, reasoning traces, credentials, secrets or unbounded logs appear here. `status-resp.json` is referenced by name only.
- Every check is reported with the exit code it actually returned. V-M2-6 asserts the recorded divergence set (`[8, 9]`) rather than the absence of divergence, so its pass means "the two implementations differ in exactly the two documented places" — it is not a claim that C-4 agrees.
- Where a claim rests on an unverified device property or on absent hardware, it says so in the same sentence rather than in a footnote — D-4's severity, G-M2-1's consequence and S-2/S-5/S-6/S-8's status in particular.
- Claims about `spatial-gesture-desktop` and `apps/watch/` are source-level only, as M1's condition 1 requires.
- Milestone 3–6 material met along the way (model-bundle metadata validation, CI consolidation, module depth) is left where M1 deferred it; nothing new was added to those milestones' scope.

---

## Milestone verdict

**Milestone 2 is complete.** Both sensor paths are traced end to end with citations, all 14 timestamp/clock-domain boundaries are classified, rate-control authority is explicit for all ten streams, and the ordering, identity, buffering and cancellation semantics are recorded. Four cross-language contracts were compared mechanically rather than read; nine checks were executed and their exit codes recorded.

**The intended timing architecture is sound and is implemented.** Raw device timestamps are preserved as the ordering and diagnostic authority and are never allowed to drive a freshness decision; a separate desktop monotonic clock owns every staleness judgement; the clock-offset estimate exists for observability and is deliberately never applied to a sample. Seven independent abnormal conditions converge on a forced release, each with a quantified bound (500 ms orientation staleness, 750–950 ms model staleness, 3 s link silence, 1 s Sony silence). BLE cancellation is handled with unusual care, and both transports solve the broadcast subscribe-before-announce race explicitly.

**The defects are concentrated in state that outlives a connection and in claims that no longer match the code.** D-2 (a watermark that no reconnect clears, in a boot-relative clock) and D-3 (a device identity that is a build constant) compound into a failure mode that disables gesture inference until the desktop app is restarted — the single highest-impact finding in this milestone. D-4, D-5, D-6 and D-7 are each a place where a comment or a sibling validator asserts something the code does not do. D-1 is two user-visible controls wired to nothing.

**The weakest area this milestone can name is the training/serving boundary.** C-1 and C-2 — the contracts with the most literals — agree exactly, and they are the ones a drift would break loudly. The two contracts that matter for *correctness of inference*, C-3's semantics and C-4's behaviour, both diverge: 13 features are structurally zero live and non-zero in training, two more are computed on different bases, and the state machines disagree on an unnormalized model output. None of this is caught by any test in the repository, and M1 already established that `tools/pinch-classifier/` runs in no CI job.

**Nothing found here blocks Milestone 3.** The model-bundle metadata validation gap M1 located (`model_registry.rs:378-402`) now has concrete company: R-M2-1's feature-basis mismatch and T-3's subset-feature divergence are exactly the "inference-critical settings cannot silently differ between training and runtime" question Milestone 3 owns, and both are cited above with reproductions.

**Conditions carried into Milestone 3:**
1. Treat G-M2-1 (the Samsung timestamp unit) as the cheapest high-value piece of missing evidence. One hardware observation of the displayed PPG Hz settles the physical meaning of `duration_ms`, every `ppg_*_slope`, and whether `windowing.py`'s 500 ms/250 ms constants mean what they say.
2. Treat R-M2-1 and T-3 as inputs to the training/runtime-divergence criterion, not as closed findings — both need a trained bundle plus a `litert` build to quantify (G-M2-6).
3. `apps/watch/` and `spatial-gesture-desktop` remain unverified by execution. Carry that forward unchanged.
4. Carry D-1…D-7 and R-M2-1…R-M2-12 into the Milestone 6 finding set for ranking alongside M1's F-1…F-6 and G-1. This milestone proposes no fixes.
5. Leave the five pre-existing dirty paths untouched; R-1 remains the repository owner's call.
