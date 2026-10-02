# Gesture Controls Architecture Review — Milestone 1 Baseline

**Scope:** Milestone 1 of `.hermes/plans/2026-10-02_133139-gesture-controls-architecture-review.md`.
**Date:** 2026-10-02
**Nature:** Read-only factual baseline. No product code, test, dependency, configuration, plan, generated output, or existing documentation was modified. No design judgment or remediation is proposed here; Milestones 2–6 own that.

---

## Executive baseline

The repository is a four-runtime system with a single shared wire contract crate and a strict, documented rule that all inference lives on the laptop.

- **Sensor producers:** a standalone Wear OS app (`apps/watch/`, Kotlin, 19 production files, 4183 lines incl. tests) and a Sony headphone head-tracker reached either in-process via FFI (`crates/native-head-tracking/`) or over loopback UDP from an external CLI.
- **Transport:** `crates/watch-bridge/` with two interchangeable transports (BLE GATT central — the default — and a Wi-Fi WebSocket server) behind one seam.
- **Desktop host:** a Tauri 2 application (`apps/desktop/src-tauri/`, 13 Rust modules, 11 790 lines) that owns every piece of runtime state and exposes 45 `invoke` commands plus ~20 typed events to a React 19 frontend (`apps/desktop/src/`, ~130 TS/TSX files).
- **Desktop-only intelligence:** `crates/pinch-inference/` (fusion, 55-feature extraction, fail-closed classification state machine) and `crates/interaction-engine/` (calibration, gesture policy, wrist rotation), both pure and synchronous.
- **Offline tooling:** `tools/pinch-classifier/` (Python training/replay, the reference implementation the Rust runtime is ported from) and `tools/sony-head-tracker/` (UDP receiver and reference work).

The architecture's central stated invariant — Watch and headphones are sensor-only, inference is desktop-owned — is **represented in code**, not only in prose: `crates/pinch-inference/src/lib.rs:1-12` states it, the crate's `Cargo.toml` depends on neither `watch-bridge` nor Tauri, and the Watch's Kotlin tree contains no classifier, model, or policy code.

Baseline health is **green where this host can execute it, and unverifiable in two places**. Rust formatting, Clippy (`-D warnings`), and 171 tests pass across seven crates; the desktop frontend's 326 tests, typecheck, and production build pass; 61 Python tests pass. Two checks could not run here: the `spatial-gesture-desktop` Tauri crate (no `pkg-config`/GTK on this host) and the Watch Gradle unit tests (no Android SDK). Both are recorded as environment gaps, not as passes and not as failures.

Six confirmed defects (F-1…F-6), one confirmed gap (G-1), and four risks (R-1…R-4) are recorded below: a duplicated React hook, a dead module, three concrete documentation-drift items (including a default transport the README never mentions), two unsupported in-source documentation references, a CI coverage gap over two whole source roots, and a set of hand-maintained cross-language contracts with no automated guard.

---

## Git and repository state

Captured before any command was run, and re-verified after every validation run.

| Fact | Value |
| --- | --- |
| Branch | `main` |
| Local HEAD | `deef84f55d4fb4ed45ae6c2d5f909c549c998b7a` |
| `origin/main` (via `git ls-remote origin main`) | `deef84f55d4fb4ed45ae6c2d5f909c549c998b7a` |
| Local/remote equality | Equal — baseline is not ahead of or behind origin |
| Submodules (`git submodule status`) | None. No `.gitmodules` exists; `third_party/` and `vendor/` are committed directly into the tree |
| Tracked files | 394 |

### Pre-existing dirty paths — preserved exactly, never staged

| Path | State | Notes |
| --- | --- | --- |
| `package.json` | Modified | Adds a `dependencies` block with `pptxgenjs ^4.0.1` and `sharp ^0.35.4`, and reformats the `workspaces` array. See risk R-1 below. |
| `package-lock.json` | Modified | 769 added lines resolving the two dependencies above. |
| `.hermes/` | Untracked | 16 plan files, 3 queue files, plus a `tasks/` directory. Contains the plan governing this review. |
| `.presentation-build/` | Untracked | 5.3 MB of seminar presentation assets (`.pptx`, PNG figures, paper text, a generator script). |
| `status-resp.json` | Untracked | A workflow-API task-status response holding internal workflow/project/goal identifiers. Not product data. Contents are not reproduced here. |

This review added exactly one path: `.hermes/reviews/gesture-controls-architecture-baseline.md`.

### Generated and ignored artifact risks

Ignore rules are spread across **three layers, only one of which is committed**:

1. `.gitignore` (committed) — covers `node_modules/`, `dist/`, `**/target/`, `.venv/`, `__pycache__/`, `apps/desktop/src-tauri/gen/`, `apps/desktop/src-tauri/resources/litert/`, `apps/watch/.gradle/`, `apps/watch/app/build/`, `apps/watch/local.properties`, and `graphify-out/` (`.gitignore:1-28`).
2. `.git/info/exclude` (local only, not portable) — covers `**/.claude/worktrees/`, `**/.claude/scheduled_tasks.lock`, and seven other `.claude/` paths (`.git/info/exclude:8-17`).
3. `~/.config/git/ignore` (user-global, not portable) — covers `**/.claude/settings.local.json`.

**Risk R-1 (medium, pre-existing, untouched):** `.presentation-build/` (5.3 MB) and `status-resp.json` are untracked and matched by **no** ignore rule at any layer. The uncommitted `package.json` change installs `pptxgenjs` and `sharp` as *runtime* `dependencies` of the product root manifest to serve that presentation tooling. A `git add -A` from this working tree would commit presentation assets, internal workflow identifiers, and two non-product runtime dependencies into the product repository. This review staged only its own report path.

**Risk R-4 (low):** `tools/pinch-classifier/.gitignore:1-6` ignores `.venv/`, `*.egg-info/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, and `artifacts/`. `tools/sony-head-tracker/` has **no `.gitignore` at all**, and the root `.gitignore` covers `.venv/` and `__pycache__/` but not `*.egg-info/`. Consequently the CI command at `ci.yml:25` generates an untracked `tools/sony-head-tracker/src/sony_head_tracking.egg-info/` directory (setuptools build metadata: `PKG-INFO`, `SOURCES.txt`, `entry_points.txt`, `top_level.txt`, `dependency_links.txt`) that nothing ignores. This was observed directly: running V-9 below created that directory. It was removed afterwards so this baseline leaves the working tree exactly as found — it was generated by this review, not pre-existing work, and `git status --porcelain` was confirmed byte-identical to the opening capture after removal. By contrast, the root `.pytest_cache/` is not reported by `git status` because pytest writes its own `.pytest_cache/.gitignore` containing `*` — it self-ignores, and `git check-ignore -v .pytest_cache` matches no repository rule (exit 1). Only `*.egg-info/` lacks any such self-protection, which is why it surfaces.

**Risk R-2 (low):** three stale `git worktree` checkouts exist on disk under `.claude/worktrees/` — `gc-003-variable-feature-bundles` (`2773fd6`), `m1a-label-registry` (`dbf1fbe`), `m1b-label-mapping` (`4db0781`). `git rev-list --left-right --count main...<branch>` reports `99/0`, `95/0`, and `95/0` respectively: **all three are fully merged and hold no unmerged work**. They are nonetheless complete duplicate source trees, and they poison naive repository-wide `grep`: a search for `apps/desktop/ARCHITECTURE.md` returns six hits from these copies before the two real ones. Every citation in this report was taken from the primary worktree only. They are excluded solely by the local-only `.git/info/exclude`, so a committed-config-only clone would not ignore them. Left untouched.

**Graph freshness:** `graphify-out/graph.json` reports `built_at_commit = e91f79dca4f507787e3c56190cdc28cc05e760b2` — two commits behind HEAD (`deef84f`). Graph-derived statements below are labelled as such and were each confirmed against source.

---

## Production source roots

Twenty-one production source roots. "Runtime owner" names the process that executes the code; "state ownership" names what mutable state the root holds.

### Shared contract

| Root | Purpose | Runtime owner | Main interface | Entry point | Callers / dependents | State ownership |
| --- | --- | --- | --- | --- | --- | --- |
| `crates/protocol/` (`spatial-protocol`, 1124 lines) | Sony wire types and the entire versioned Watch v1 message vocabulary | Linked into desktop | `SonyHeadSample`, `HeadPose`, `WatchEnvelope`, ~60 `pub const` message-type/sensor/tracker ids | `crates/protocol/src/lib.rs:1` | `head-tracking`, `native-head-tracking`, `pinch-inference`, `watch-bridge`, `spatial-gesture-desktop` | **Stateless.** Pure types + parse/validate functions (`WatchEnvelope::from_json` `:292`, `decode` `:306`) |

### Rust crates

| Root | Purpose | Runtime owner | Main interface | Entry point | Callers / dependents | State ownership |
| --- | --- | --- | --- | --- | --- | --- |
| `crates/head-tracking/` (330) | Replaceable head-pose provider seam + strict Sony JSON UDP listener | Desktop process | `HeadPoseProvider` trait (`src/lib.rs:34`), `SonyUdpHeadPoseProvider` (`:189`) | `SonyUdpHeadPoseProvider::bind` (`:198`) | `native-head-tracking`, `spatial-gesture-desktop` | `TrackerMonitor` (`:42`) connection/reset state; `StationaryPoseFilter` (`:80`); a `broadcast` channel of `HeadPoseEvent` |
| `crates/native-head-tracking/` (372 Rust + 2 C++ adapters) | Repo-owned C ABI for in-process Sony providers on macOS/Windows | Desktop process (FFI) | C ABI `include/spatial_head_tracker.h`; `NativeProvider` (`src/provider.rs:34`), `NativeEventSink` (`:20`) | `NativeProvider::start` (`src/provider.rs:53`) | `spatial-gesture-desktop` only | Owns a native worker thread + callback context; `Drop` (`src/provider.rs:136`) joins before free. Linux declares no extern block (`src/lib.rs:26-27`) |
| `crates/interaction-engine/` (1358) | Quaternion calibration, dwell targets, overlay geometry, wrist rotation, **and the fail-closed gesture policy** | Desktop process | `HeadCalibration` (`src/lib.rs:85`), `WristRotation` (`:439`), `GesturePolicy` (`src/gesture_policy.rs:185`), `PolicyMode`/`GestureIntent`/`ForceReleaseReason` | Library; no main | `pinch-inference`, `spatial-gesture-desktop` | **Pure and synchronous.** Holds `PolicyState` (`gesture_policy.rs:160`) and calibration state, but no locks, clocks, or I/O — the caller supplies time |
| `crates/pinch-inference/` (1462) | Desktop-only telemetry fusion, 55-feature extraction, fail-closed classification state machine | Desktop process | `TelemetryFusion` (`src/fusion.rs:48`), `extract_features` (`src/features.rs:175`), `PinchModel` trait (`src/model.rs:70`), `DesktopPinchRuntime` (`src/runtime.rs:16`) | Library; no main | `spatial-gesture-desktop` only | `TelemetryFusion` carries the last-known orientation forward; **never reads a clock itself** (`src/fusion.rs:9-12`) |
| `crates/volume-control/` (1154) | Normalized OS volume control across three platforms | Desktop process | `VolumeController` trait (`src/lib.rs:69`); `platform_volume_controller()` (`:794`) | `adjust_system_volume` (`:813`), `set_system_volume` (`:839`) | `spatial-gesture-desktop` | `ChildGuard` (`:122`) owns spawned helper lifetimes with a `Drop` (`:249`). Platform impls: macOS `:485`, Windows `:547`, Linux `:639`, unsupported fallback `:774` |
| `crates/watch-bridge/` (1834) | Both watch transports behind one seam; sequencing, time sync, heartbeat, command encoding, telemetry decoding shared | Desktop process | `WatchBridgeServer` (`src/lib.rs:241`), `WatchLinkTransport` seam, `WatchEvent` (`:73`), `WatchTransport` (`:171`) | `WatchBridgeServer::bind` (`src/lib.rs:256`) | `spatial-gesture-desktop` | `SharedState` (`src/lib.rs:180-189`): five `broadcast` senders, `AtomicBool active`, `Mutex<BleStatus>`. BLE reassembly state in `ble::Reassembler` (`src/ble.rs:152`) |

### Desktop Tauri host — `apps/desktop/src-tauri/src/` (11 790 lines, 13 modules)

Process entry point is `main.rs:1-3`, which delegates to `lib.rs:29` (`run()`). `lib.rs:36-48` registers eleven managed runtimes; `lib.rs:49-105` registers **45** `invoke` handlers; `lib.rs:149-275` is the single watch-event consumption loop.

| Module | Purpose | Main interface | State ownership |
| --- | --- | --- | --- |
| `lib.rs` (280) | Composition root; builder, handler registry, watch-event loop, teardown | `run()` `:29` | Constants only: WS address `0.0.0.0:8766` `:23-24`, heartbeat timeout 3 s `:25` |
| `inference.rs` (1226) | Desktop-owned fail-closed policy runtime; single entry for a raw fused PPG window | `ingest_ppg_window`, `apply_decision`, `force_release_and_hide` | `PpgIngestRuntime.last_timestamp_ns: Mutex<HashMap<String,u64>>` `:187`; `PinchInferenceRuntime{fusion, loaded}` `:418-420`; `GesturePolicyRuntime.policy: Mutex<GesturePolicy>` `:589` |
| `recording_bundle.rs` (3920) | Persistence boundary for the immutable recording-bundle contract | 10 `invoke` commands (`lib.rs:78-87`) | Filesystem-owned; `raw.csv` is write-once and never rewritten (`:4-10`) |
| `model_registry.rs` (1558) | Persisted model lifecycle (Draft→Evaluated→Approved→Active→Archived), thresholds, quality gate, single-active + rollback, global Off/Monitor/Live mode | 8 `invoke` commands (`lib.rs:91-99`) | `ModelRegistryRuntime.lock: Mutex<()>` `:306-307` serializing persisted-file mutation |
| `model_lab.rs` (1101) | Dataset import, training-job orchestration, replay; **legacy single-label CSV pipeline** | 8 `invoke` commands (`lib.rs:70-77`) | `ModelLabRuntime{lock, status, active_job}` `:177-180` |
| `overlay.rs` (737) | Volume overlay window, wrist-rotation application, haptic debounce | 5 `invoke` commands (`lib.rs:53-57`) | `OverlayRuntime` `:85-91`: `Mutex<OverlayState>`, `Mutex<WristRotation>`, `AtomicU64` generation, two `Mutex<Option<Instant>>` debounce clocks. `VolumeRuntime(Box<dyn VolumeController>)` `:102` |
| `settings.rs` (737) | Validated, atomically persisted `settings.json`; replays watch controls on reconnect | `get/update/reset_settings`; `apply_watch_transport`, `apply_watch_settings` | `SettingsRuntime{state: RwLock<AppSettings>, last_headphones_emit: Mutex<Option<Instant>>}` `:359-361` |
| `head_pose.rs` (591) | Provider selection and the shared native/external event pipeline | `select_provider()` `:62`, `spawn(handle)` `:205` | Spawned task state only. Sony UDP address `127.0.0.1:4243` `:28`; override env `SONY_HEAD_TRACKER_PROVIDER` `:30` |
| `watch.rs` (519) | Watch status projection and the seven sensor/measurement commands | 8 `invoke` commands (`lib.rs:58-64`, `102-104`) | `WatchRuntime.state: Mutex<WatchStatus>` `:149-150` |
| `calibration.rs` (397) | Head calibration capture and target dwell | 3 `invoke` commands (`lib.rs:50-52`) | `CalibrationRuntime` `:16-19`: operations lock, `Mutex<HeadCalibration>`, latest quaternion |
| `label_registry.rs` (301) | Persistent label catalogue; archive never deletes, so historical recordings stay interpretable (`:3-4`) | 3 `invoke` commands (`lib.rs:88-90`) | `LabelRegistryRuntime.lock: Mutex<()>` `:91-92` |
| `training_label_mapping.rs` (254) | Explicit per-run label→training-target mapping; mirrors `pinch_classifier.labels.LabelMapping` | `validate_mapping_covers`, `legacy_compatibility_mapping` | **Stateless.** Owned by a training selection |
| `environment.rs` (164) | Environment/diagnostics probe | `get_environment_diagnostics` (`lib.rs:68`) | Stateless |

### Desktop frontend — `apps/desktop/src/` (~130 TS/TSX files)

| Root | Purpose | Runtime owner | Main interface | Entry point | State ownership |
| --- | --- | --- | --- | --- | --- |
| `src/main.tsx` | React bootstrap only | WebView | — | `src/main.tsx:8` | None |
| `src/app/` | Composition root; owns all application-wide Tauri `listen` subscriptions | WebView | `App` (default export) | `src/app/App.tsx` | Local `useState` for overlay/calibration/settings projections |
| `src/shared/protocol/events.ts` (273) | **The single typed Tauri event contract** for the frontend | WebView | 16 event-name consts + payload interfaces; `quaternionToEulerDegrees` `:5` | — | Stateless |
| `src/features/telemetry/` | Bounded external store, charts, raw-image viewer, CSV export, quality summaries | WebView | `telemetryStore` (`store/telemetryStore.ts:1164`), `rawImageViewerStore` | — | **The frontend's primary mutable state.** Bounded by `MAX_VISIBLE_SAMPLES = 600` `:135` and `MAX_CSV_ROWS = 200_000` `:136` |
| `src/features/{dashboard,model-lab,overlay,settings}/` | Per-feature UI | WebView | React components | lazy-loaded (`App.tsx:57-60`) | Local component state + `usePendingActions` |
| `src/components/{ui,app}/` | shadcn-derived primitives and app-level shared controls | WebView | ~30 components | — | Stateless |
| `src/shared/{hooks,tauri}/` | Shared hooks and Tauri IO helpers | WebView | `usePendingActions`, `exportCsv`, `recordingBundle` | — | Per-hook in-flight key set |

`VolumeKnob` (`src/features/overlay/components/VolumeKnob.tsx`) is deliberately excluded from the route code-split and stays eagerly bundled as the always-visible safety surface (`App.tsx:51-55`).

### Watch, tooling, launcher, vendored

| Root | Purpose | Runtime owner | Main interface | Entry point | State ownership |
| --- | --- | --- | --- | --- | --- |
| `apps/watch/` (19 Kotlin files, 4183 lines) | Standalone Wear OS sensor producer; **no inference** | Wear OS (own Gradle build, `settings.gradle.kts`) | `WatchProtocol` object (`data/connection/WatchProtocol.kt:14`), `WatchTransportLink` seam | `app/MainActivity.kt` (`AndroidManifest.xml:60-68`) + `StreamingForegroundService` (`:69-72`) | `ConnectionPrefs` (persisted trusted endpoint); per-collector sensor subscriptions; `BleGattTransport` GATT server state |
| `tools/pinch-classifier/` (15 modules, 10 test files) | **Reference implementation**: offline training, TFLite/LiteRT export, replay, bundle validation | CPython ≥3.11 (`uv`) | 4 console scripts (`pyproject.toml:21-25`) | `train:main`, `train_tflite:main`, `replay:main`, `experiment:main` | Filesystem artifacts only |
| `tools/sony-head-tracker/` | Sony UDP receiver, sample sender, compatibility tests, committed upstream v2.2.0 prebuilds | CPython; prebuilt binaries | `sony_head_tracking.cli` | `src/sony_head_tracking/__main__.py` | Stateless receiver |
| `scripts/` (5 `.mjs`) | `npm start` launcher, LiteRT packaging, Tauri icon/config checks | Node 22 | `run-system.mjs` | `scripts/run-system.mjs:232` | Spawned child process handles |
| `third_party/sony-head-tracker/` | **Vendored upstream C++ engine**, compiled by `crates/native-head-tracking/build.rs` on macOS/Windows | Compiled into desktop | Upstream headers under `include/sony_head_tracker/` | — | Upstream-owned |
| `vendor/samsung-health-sensor-sdk/1.4.1/` | Vendored Samsung AAR, referenced once from the watch module | Wear OS | `samsung-health-sensor-api-1.4.1.aar` | `apps/watch/app/build.gradle.kts:51` | Vendor-owned |

---

## Entry points and dependency directions

### Process entry points

| Process | Entry point | Notes |
| --- | --- | --- |
| Desktop (Tauri) | `apps/desktop/src-tauri/src/main.rs:1-3` → `lib.rs:29` | Single composition root |
| Desktop (WebView) | `apps/desktop/src/main.tsx:8` | React 19 `createRoot` |
| Launcher | `scripts/run-system.mjs:232` | `npm start`; spawns the external tracker only when needed (`:203-224`) |
| Watch | `MainActivity` (`AndroidManifest.xml:60-68`) + `StreamingForegroundService` (`:69-72`) | Standalone — no companion phone app (`:56-59`) |
| Python training | `pinch_classifier.train:main` and three siblings (`pyproject.toml:21-25`) | |
| Python Sony receiver | `tools/sony-head-tracker/src/sony_head_tracking/__main__.py` | |

### Workspace dependency direction (acyclic, verified from manifests)

```text
spatial-protocol  (leaf; depends only on serde/serde_json/thiserror)
    ├── head-tracking ─────────────┐
    │       └── native-head-tracking
    ├── watch-bridge               │
    └── pinch-inference ── interaction-engine (leaf: nalgebra/serde/thiserror only)
                                   │
apps/desktop/src-tauri (spatial-gesture-desktop) ── depends on all seven
```

Confirmed from `Cargo.toml:2-10` (members) and the seven crate manifests. **No crate depends on `spatial-gesture-desktop`; nothing depends on Tauri except it.** `interaction-engine/Cargo.toml` does not list `spatial-protocol`, so the policy layer is independent of the wire format. `pinch-inference/Cargo.toml` depends on `interaction-engine` and `spatial-protocol` but **not** `watch-bridge` — the sensor-only/desktop-inference rule is enforced by the dependency graph, not only by comments.

### Runtime data direction

```text
Watch sensors (IMU, PPG, button)                 Sony headphones
   │ WatchProtocol.kt:14 JSON envelope              │
   ├─ BLE GATT notify (default)                     ├─ macOS/Windows: native FFI
   │   BleGattTransport.kt:496-502                  │   native-head-tracking/src/provider.rs:53
   └─ Wi-Fi ws://0.0.0.0:8766/ws/watch              └─ Linux / external: UDP 127.0.0.1:4243
       │                                                head_pose.rs:28
       ▼                                                │
  watch-bridge (seq, time sync, heartbeat, decode)      ▼
  crates/watch-bridge/src/lib.rs:256                head_pose.rs:205 spawn
       │ broadcast<WatchEvent>                          │
       ▼                                                ▼
  lib.rs:182-274 single consumer loop             Tauri events (head_pose.rs:23-26)
       ├─ Orientation → overlay.apply_wrist_rotation (lib.rs:234)
       │              → PinchInferenceRuntime.observe_orientation (lib.rs:237-239)
       ├─ Ppg         → inference::ingest_ppg_window (lib.rs:242)
       │                   └─ TelemetryFusion → extract_features (55) → PinchModel
       │                        └─ DesktopPinchRuntime → PinchTransition
       │                             └─ GesturePolicy (Off/Monitor/Live) → GestureIntent
       │                                  └─ volume-control → OS   +   haptic → watch
       ├─ Button down/up → overlay.begin_volume_interaction / release (lib.rs:204, 222)
       └─ Disconnected / InvalidMessage / PPG unavailable
              → inference::force_release_and_hide (lib.rs:227, 246, 255, 268)
```

**Fail-closed direction is explicit.** Four distinct abnormal conditions in the consumption loop — watch disconnect (`lib.rs:226-231`), malformed/out-of-order message (`lib.rs:244-250`), PPG sensor `unavailable`/`error` (`lib.rs:251-259`), and a lagged/closed broadcast receiver (`lib.rs:266-272`) — all converge on `force_release_and_hide`. A fifth path, a staleness watchdog, runs on its own interval task (`lib.rs:134-146`). `gesture_policy.rs:12-18` documents why releasing is unconditionally safe to execute while initiating is gated on `PolicyMode::Live`.

### Frontend dependency direction

`src/main.tsx` → `src/app/App.tsx` → lazy feature chunks. `App.tsx:1-38` is the sole owner of application-wide `listen` subscriptions and imports all event names/types from `src/shared/protocol/events.ts`. `apps/desktop/ARCHITECTURE.md:20-21` states the rule ("features may depend on `shared`, but not on another feature's implementation"); spot checks found no feature-to-feature import, with the duplication caveat in F-1 below.

### Graph-derived hubs (from `graphify-out/graph.json`, built at `e91f79d`, 4734 nodes / 9925 links)

Highest-degree production nodes: `recording_bundle.rs` (156), `model_registry.rs` (96), `telemetryStore.ts` (80), `shared/protocol/events.ts` (66), `shared/tauri/recordingBundle.ts` (65), `inference.rs` (59), `model_lab.rs` (59). These coincide with the largest files by line count (`recording_bundle.rs` 3920, `model_registry.rs` 1558) — recording/model lifecycle is the system's densest coupling region. Recorded as a fact for Milestones 3 and 5; no judgment offered here.

---

## Cross-platform contracts

Five contracts cross a language boundary. Each is listed with how it is kept in agreement today.

### C-1: Watch message protocol v1 — Kotlin ↔ Rust

- **Rust:** `crates/protocol/src/lib.rs:78-251` — `WATCH_PROTOCOL_VERSION = 1` (`:78`), 20 message-type consts (`:80-104`), sensor ids (`:157-183`), medical tracker ids (`:140-207`), rate bounds `MIN_SENSOR_RATE_HZ`/`MAX_SENSOR_RATE_HZ` (`:133-134`), haptic bounds (`:109-110`), batch caps `MAX_PPG_BATCH_SAMPLES`/`MAX_MEDICAL_BATCH_SAMPLES = 512` (`:220`, `:236`).
- **Kotlin:** `apps/watch/.../WatchProtocol.kt:14-51` — `VERSION = 1` (`:15`) and the same type strings restated as independent literals. `:48-50` explicitly notes the haptic bounds "mirror `MIN_HAPTIC_DURATION_MS`/`MAX_HAPTIC_DURATION_MS` in spatial_protocol".
- **Specification:** `docs/protocols/watch-websocket-protocol.md`.
- **How agreement is kept:** by hand. `WatchProtocol.kt:9-12` states the design intent — keep it dependency-free "so the desktop protocol crate has no Kotlin counterpart to drift out of sync with" — but the practical effect is two independent literal sets with **no generated source, no shared fixture, and no cross-language test**.

### C-2: BLE GATT service and framing — Kotlin ↔ Rust

| Constant | Rust | Kotlin |
| --- | --- | --- |
| Service UUID `6b1d0001-…` | `crates/watch-bridge/src/ble.rs:43` | `BleGattTransport.kt:496` |
| Telemetry UUID `6b1d0002-…` | `ble.rs:45` | `BleGattTransport.kt:499` |
| Command UUID `6b1d0003-…` | `ble.rs:47` | `BleGattTransport.kt:502` |
| Frame header length `3` | `ble.rs:50` (`BLE_FRAME_HEADER_LEN`) | `BleFraming.kt:17` (`HEADER_LENGTH`) |
| Max message `16 * 1024` | `ble.rs:56` (`MAX_BLE_MESSAGE_BYTES`) | `BleFraming.kt:25` (`MAX_MESSAGE_BYTES`) |

The fragmentation/reassembly **algorithm** is also implemented twice: Rust `fragment` (`ble.rs:120`) and `Reassembler` (`ble.rs:152`) against Kotlin `BleFraming` (`BleFraming.kt:42-89`). Payloads are byte-identical JSON envelopes to C-1 (`ble.rs:10-13`). Role assignment is documented and deliberate: the watch is GATT peripheral, the desktop central, because that is the only role `btleplug` supports across all three desktop OSes (`ble.rs:3-8`). The trust model is two-layer — encrypted ATT permissions plus an explicit per-central approval gate on the watch — and `BleStatus::Streaming` is only reported after a first valid envelope actually arrives (`ble.rs:15-24`). Specification: `docs/protocols/watch-ble-transport.md`. **Each side has unit tests (`BleFramingTest.kt`; Rust `ble` tests) but no shared vector set, and the Kotlin tests do not run in CI** (see G-1).

### C-3: 55-value pinch feature contract — Rust ↔ Python

- **Rust:** `crates/pinch-inference/src/features.rs:10` (`FEATURE_COUNT = 55`), `:15` (`FEATURE_NAMES`), `:175` (`extract_features`).
- **Python:** `tools/pinch-classifier/src/pinch_classifier/features.py:22` (`FEATURE_NAMES`, built from column templates), asserted at `:161`.
- **Verified in this review:** both lists were loaded programmatically and compared element-by-element — **55 names each, identical content and identical order**. The contract holds today.
- **How agreement is kept:** by hand, documented in prose (`features.rs:1-6` says it mirrors the Python "exactly (same order, same 55 values)"). Subset selection is order-preserving and rejects reordering and unknown names on the Python side (`features.py:51-79`), and `select_features` (`features.rs:284`) is the Rust counterpart. **No automated cross-language check exists in either test suite or in CI** (searched: no Rust test reads `features.py`, no Python test reads `features.rs`).

### C-4: Classification state machine — Rust ↔ Python

`crates/pinch-inference/src/runtime.rs:1-7` states it is a port of `tools/pinch-classifier/src/pinch_classifier/desktop_runtime.py`'s `DesktopPinchRuntime`, "kept behaviorally identical to the Python reference so offline training/evaluation and live desktop inference agree on when a pinch starts, holds, and releases." Both sides are unit-tested independently (`test_desktop_runtime.py` passes here; Rust `runtime` tests pass). Equivalence is a documented intent maintained by hand, with no shared golden fixture located.

### C-5: Label mapping — Rust ↔ Python

`apps/desktop/src-tauri/src/training_label_mapping.rs:1-12` mirrors `pinch_classifier.labels.LabelMapping`, which is "the mapping's actual consumer during training". A label with no entry is rejected by `validate_mapping_covers` rather than silently folded into "negative" (`:6-8`). `legacy_compatibility_mapping` (`:11-12`) is the single sanctioned exception reproducing the pre-M1-B fixed vocabulary.

### C-6: Network endpoints

Ports are consistent across every language and document checked.

| Endpoint | Definition | Other restatements |
| --- | --- | --- |
| Watch WS `0.0.0.0:8766` | `apps/desktop/src-tauri/src/lib.rs:23-24` | `WatchPairingServer.kt:119` (`DESKTOP_PORT`), `README.md:132`, `apps/watch/README.md:137,187`, `docs/protocols/watch-websocket-protocol.md:8`, `docs/decisions/2026-09-24-wifi-vs-ble-transport.md:9` |
| WS path `/ws/watch` | `crates/watch-bridge/src/lib.rs:49` (`WATCH_WEBSOCKET_PATH`) | as above |
| Sony UDP `127.0.0.1:4243` | `apps/desktop/src-tauri/src/head_pose.rs:28` | `README.md:47,75,97`, `tools/sony-head-tracker/ARCHITECTURE.md:10`, `.../receiver.py:15`, `.../cli.py:16`, `send_sample.py:21` |
| mDNS `_gesture-controls._tcp.local.` | `crates/watch-bridge/src/lib.rs:51` | `apps/watch/README.md:137` |

**Risk R-3 (low):** port `8766` is **not** a `spatial-protocol` constant — `crates/protocol/src/lib.rs` contains no port definition. It is independently hardcoded in `lib.rs:24` (Rust) and `WatchPairingServer.kt:119` (Kotlin). The shared-contract crate holds the message vocabulary but not the endpoint, so the endpoint is outside the one place designed to prevent drift.

---

## Baseline validation

All commands were run from the repository root at `deef84f` with the pre-existing dirty state untouched. `git status --porcelain` was re-captured after the Node and Rust runs and was byte-identical to the pre-run capture.

### Executed and passing

| # | Command | Result |
| --- | --- | --- |
| V-1 | `cargo fmt --all -- --check` | **passed** (exit 0, no diff) |
| V-2 | `cargo test -p spatial-protocol -p head-tracking -p native-head-tracking -p interaction-engine -p volume-control -p pinch-inference -p watch-bridge --all-targets` | **passed** — exit 0; 19 test binaries, **171 tests passed, 0 failed, 0 ignored** |
| V-3 | `cargo clippy -p spatial-protocol -p head-tracking -p native-head-tracking -p interaction-engine -p volume-control -p pinch-inference -p watch-bridge --all-targets -- -D warnings` | **passed** (exit 0, zero warnings) |
| V-4 | `npm run typecheck` (→ `tsc -b --pretty false`) | **passed** (exit 0) |
| V-5 | `npm test` | **passed** — Vitest **34 files / 305 tests**; `node --test scripts/run-system.test.mjs` **16/16**; `node --test scripts/tauri-config.test.mjs` **5/5**; total **326** |
| V-6 | `npm run build` (→ `tsc -b && vite build`) | **passed** (exit 0, built in 6.77 s; 7 chunks emitted) |
| V-7 | `npm run check:tauri-icons` | **passed** — "validated 5 configured Tauri desktop icons" |
| V-8 | `uv run --directory tools/pinch-classifier --with pytest pytest -q` | **passed** — **57 passed**, 46 warnings (third-party deprecations: `gast`, and `tf.lite.Interpreter` scheduled for deletion in TF 2.20) |
| V-9 | `uv run --directory tools/sony-head-tracker --with pytest pytest -q` | **passed** — **4 passed** |

Toolchain actually used: `cargo`/`rustc` 1.98.1, `node` v22.23.2 (matches `.nvmrc` = 22), `npm` 12.2.0, `uv` 0.11.32, `java` OpenJDK 17.0.20. The pinch-classifier `uv` venv resolves to Python 3.13, satisfying `requires-python = ">=3.11"`.

### Attempted and blocked by this host's environment — not passes, not code failures

| # | Command | Outcome |
| --- | --- | --- |
| V-10 | `cargo test -p … -p spatial-gesture-desktop --all-targets` (the full `desktop-ci.yml:48` set) | **blocked.** Exit 101. `glib-sys` build script: "Could not run `pkg-config --libs --cflags glib-2.0 'glib-2.0 >= 2.70'` … The pkg-config command could not be found." The Tauri crate's Linux dependencies (`pkg-config`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`) are absent. CI installs them (`desktop-ci.yml:32-41`); the capsule forbids installs, so this was not worked around. **`spatial-gesture-desktop` — 11 790 lines including the entire inference wiring — has no local test evidence in this baseline.** |
| V-11 | `./gradlew --offline :app:testDebugUnitTest` (in `apps/watch/`) | **blocked.** Exit 1. "SDK location not found… `sdk.dir` property in local.properties file. Problem: Directory does not exist." `local.properties` points at `/home/vaibhav/.android-sdk`, which does not exist; `ANDROID_HOME` and `ANDROID_SDK_ROOT` are both unset. Gradle 9.5.0 itself **is** cached, so only the Android SDK is missing. **`BleFramingTest.kt` and `WatchTransportKindTest.kt` have no execution evidence in this baseline.** The Gradle daemon started for this attempt was stopped afterwards. |

### Not attempted, with reasons

- `npm run tauri -- build` (`desktop-ci.yml:92`) — same missing Linux Tauri prerequisites as V-10.
- `cargo test -p pinch-inference --features litert --locked` (`desktop-ci.yml:64`) — the `litert` feature fetches a prebuilt native shared library at build time (`crates/pinch-inference/Cargo.toml` feature comment; `desktop-ci.yml:60-63`). That is a network-dependent toolchain fetch; the capsule forbids installs.
- `npm ci` — would rewrite `node_modules` and risk perturbing the pre-existing `package.json`/`package-lock.json` modifications. The existing install was used instead; V-4 through V-7 all succeeded against it.
- `cargo clippy --workspace --all-targets -- -D warnings` (`desktop-ci.yml:47`) — includes `spatial-gesture-desktop`, blocked as in V-10. The seven-crate subset (V-3) was run instead.
- macOS/Windows legs of `native-head-tracking` (`ci.yml:30-60`) — this is a Linux host; Linux declares no extern block at all (`crates/native-head-tracking/src/lib.rs:26-27`), so the real macOS/Windows FFI link is structurally unverifiable here.

### Repository-specific checks discovered

`npm test` is a composite: the workspace Vitest run plus `test:launcher`, `test:tauri-config`, and `check:tauri-icons` (`package.json:10-14`). `npm run package:litert` (`scripts/package-litert-runtime.mjs`) is a release-packaging entry point, not a check, and is documented as rejecting a missing or cross-target native runtime rather than shipping the build host's LiteRT cache (`apps/desktop/src-tauri/Cargo.toml` feature comment).

---

## Documentation drift and dead paths

### Confirmed defects

**F-1 — Duplicate implementation: two live copies of `usePendingActions`.**
`apps/desktop/src/shared/hooks/usePendingActions.ts` and `apps/desktop/src/features/model-lab/hooks/usePendingActions.ts` are both 27 lines and **differ only in their doc comment** (`diff` reports lines 4–6 only: the example key is `capture:center` in `shared/` versus `activate:model-a` in `features/model-lab/`). Both are imported: `App.tsx:9` uses the `shared/` copy; `ModelLab.tsx:11` and `ModelLifecycleControls.test.tsx:4` use the feature-local copy. Only the feature-local copy has a test (`features/model-lab/hooks/usePendingActions.test.ts`), so the copy used by the composition root is the untested one. This is the single clearest violation of the "do not duplicate" intent in `apps/desktop/ARCHITECTURE.md:20-21`.

**F-2 — Dead module: `apps/desktop/src/lib/utils.ts`.**
The file is one line — `export { cn } from "cn"` (`:1`) — and has **zero importers**: a repository-wide search for `lib/utils` across `apps/desktop/src` returns nothing. Every consumer imports `cn` directly from the `cn` package instead (e.g. `components/ui/card.tsx:2`, `input.tsx:3`, `label.tsx:2`). The file is a shadcn scaffolding remnant.

**F-3 — Unsupported documentation references in source.**
`apps/desktop/src-tauri/src/inference.rs:8` and `apps/desktop/src-tauri/src/model_registry.rs:6` both direct the reader to `apps/desktop/ARCHITECTURE.md` for the Off/Monitor/Live inference-mode design and the desktop-owned-inference rule. That document is 29 lines and contains **no** occurrence of "inference", "policy", "registry", "Monitor", "Live", "pinch", or even "src-tauri" — it describes only the React `src/` tree. The cited authority does not document what it is cited for. (`docs/architecture/project-brief.md`, cited alongside it, does cover Milestone 11.)

**F-4 — `README.md` never mentions the watch's default transport.**
`WatchTransport::Bluetooth` is the `#[default]` and has been "the default since GC-037" (`crates/watch-bridge/src/lib.rs:171-174`); `lib.rs:167-170` confirms a fresh install selects Bluetooth. `README.md:131-139` presents the watch link solely as `ws://DESKTOP_IP:8766/ws/watch` with mDNS discovery, and points only at `docs/protocols/watch-websocket-protocol.md`. No line in `README.md` mentions the watch BLE transport, `docs/protocols/watch-ble-transport.md`, or `docs/decisions/2026-09-24-wifi-vs-ble-transport.md` (the `README.md` hits for "bluetooth" at `:41`, `:112`, `:127` are all about Sony/IOKit head tracking, not the watch). A reader following the README would configure the non-default transport.

**F-5 — `README.md:125` understates `volume-control` as macOS-only.**
The layout block reads "`crates/volume-control/      Normalized controller trait and macOS adapter`". The crate ships three real adapters plus a fallback: `MacOsVolumeController` (`src/lib.rs:485`), `WindowsVolumeController` (`:547`), `LinuxVolumeController` (`:639`), `UnsupportedVolumeController` (`:774`), selected by `platform_volume_controller()` (`:794`). `README.md:5` in the same file states all three platforms exist, so the README contradicts itself.

**F-6 — Stale directory trees in both `ARCHITECTURE.md` files and `docs/README.md`.**
- `apps/desktop/ARCHITECTURE.md:5-17` omits `src/components/` (~30 files across `ui/` and `app/`), `src/hooks/`, `src/lib/`, `src/shared/hooks/`, `src/shared/tauri/`, and `src/test/`. It lists `shared/protocol/` only. It also never mentions `src-tauri/` — the 11 790-line Rust half of the same application.
- `apps/watch/ARCHITECTURE.md:8` describes `data/connection/` as "WebSocket transport and wire serialization". That package now also contains `BleGattTransport.kt` (525 lines), `BleFraming.kt` (133), and the `WatchTransportLink.kt` seam — i.e. the default transport is undescribed.
- `README.md:119-130` omits `tools/pinch-classifier/` (15 production modules and 10 test files — the Python reference implementation for C-3/C-4), `apps/watch/` (mentioned in prose at `:139` but absent from the tree), `third_party/sony-head-tracker/`, and `vendor/samsung-health-sensor-sdk/`.
- `docs/README.md:1-8` indexes 6 documents; the `docs/` tree holds 11. Unindexed: `docs/protocols/watch-ble-transport.md`, all three ADRs under `docs/decisions/`, and `docs/optimization-2026-09-gc-036.md`.

### Confirmed gap

**G-1 — Neither CI workflow covers two whole source roots.**
`grep` across `.github/workflows/*.yml` for `gradlew`, `gradle`, `pinch-classifier`, and `apps/watch` returns **no matches**. Consequently:
- `apps/watch/` (4183 lines of Kotlin, including the BLE framing that must stay byte-compatible with the desktop per C-2) is never built or tested in CI. Its two unit-test files are described in `apps/watch/app/build.gradle.kts:38-40` as existing precisely to protect that compatibility — and they run nowhere automatically. Locally they are also blocked (V-11).
- `tools/pinch-classifier/` — the reference implementation for C-3 and C-4 — is never tested in CI. `ci.yml:25` runs pytest for `tools/sony-head-tracker` only. Its 57 tests pass locally (V-8), so this is a coverage gap rather than a defect.

Combined with the absence of any cross-language check for C-1, C-2, C-3, and C-4, **every cross-platform contract in this system is currently guarded only by same-language unit tests and hand-maintained parallel literals.**

### Overlapping CI definitions (tradeoff, not a defect)

`ci.yml:9-28` (`quality`, ubuntu only) and `desktop-ci.yml:16-48` (`quality`, three-OS matrix) both run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, and `cargo fmt --all -- --check`, with differing Rust scopes: `ci.yml:27-28` covers five crates and includes `native-head-tracking`; `desktop-ci.yml:47-48` runs `cargo clippy --workspace` and a seven-crate test set including `spatial-gesture-desktop` but **excluding** `native-head-tracking`. Both workflows trigger on the same events (`push` to `main` and `pull_request`), so the Node and build steps execute at least twice per push. Recorded as a fact; Milestone 5 owns the judgment.

### Documented legacy and dead-code paths — verified intentional, not findings

- **Legacy dataset CSV pipeline.** `recording_bundle.rs:11-17` documents that `model_lab.rs`'s `import_model_dataset`/`DATASET_CSV_HEADER` (`model_lab.rs:42`, `:342`) remains "the compatibility path for existing exports and training", that `import_recording_from_raw_csv` *accepts* that legacy shape as input via `convert_legacy_dataset_csv`, and that it "never writes back to the legacy pipeline". This is a deliberate, documented, one-directional compatibility path — two pipelines by design, not accidental duplication.
- **`#[allow(dead_code)]` sites.** All five are documented and intentional: `recording_bundle.rs:91,94` (`DEFAULT_RAW_GRID_SIZE`, `RAW_WINDOW_MAX_VALUES` — exercised only by invariant assertions in `mod tests`, per `:89-90`); `model_registry.rs:382,397,400` (`feature_contract.version`, `preprocessing`, `window_semantics` — "accepted for forward-compatible parsing of the bundle schema but not yet read by any validation").
- **No `TODO`, `FIXME`, `HACK`, or `XXX` markers** exist anywhere in `crates/`, `apps/`, or `tools/pinch-classifier/`.

### Identified contract gap, deferred by scope

`model_registry.rs:378-402` parses a model bundle's `feature_contract.version`, `preprocessing`, and `window_semantics` but validates only `count` and `ordered_names` (`:385-386`, and the validator beginning at `:405`). A bundle declaring preprocessing or window semantics that differ from the desktop runtime's would therefore be accepted on those axes. This is the entry point for the Milestone 3 criterion "inference-critical settings cannot silently differ between training and runtime". **Recorded as a located entry point with an evidence citation only — Milestone 3 owns whether this is a defect, and no judgment is offered here.**

---

## Unknowns and evidence gaps

Each item is something this milestone could not establish. None is guessed at.

1. **`spatial-gesture-desktop` has no execution evidence.** Blocked by V-10 (no `pkg-config`/GTK). The crate holds all 45 command handlers, all eleven managed runtimes, and the entire inference wiring. CI does cover it (`desktop-ci.yml:48`, `ci.yml:91`), but this baseline cannot confirm the current HEAD's result. **Resolution:** install the Linux Tauri prerequisites, or read the CI run for `deef84f`.
2. **Watch Kotlin has no execution evidence.** Blocked by V-11 (no Android SDK) *and* by G-1 (no CI coverage). This is the only source root with neither local nor CI evidence. **Resolution:** provision an Android SDK and point `apps/watch/local.properties` at it.
3. **LiteRT-backed inference is unverified.** `litert` is off by default in both `crates/pinch-inference/Cargo.toml` and `apps/desktop/src-tauri/Cargo.toml`. With the feature off, `PinchInferenceRuntime` still fuses telemetry and runs the fail-closed threshold machine, but "every window fails classification (no model backend compiled in)" (Cargo.toml feature comment). **No real model execution path was exercised anywhere in this baseline.** CI covers it in one pinned job (`desktop-ci.yml:50-64`).
4. **No physical-hardware evidence.** No Galaxy Watch, no Sony headset, no BLE peer was present. C-2's bonding and per-central trust gate (`ble.rs:15-24`), the native macOS/Windows FFI link, and real sensor timing are all unexercised. `README.md:178` independently records that no physical Windows hardware was available to validate that provider; `ci.yml:31-36,47-52` records the same for the CI runners. Milestone 2 inherits this gap.
5. **Cross-language equivalence beyond C-3 is unverified.** C-3 was proved identical by direct comparison in this review. C-1 (20 message types + sensor/tracker ids + bounds), C-2 (UUIDs, framing algorithm), and C-4 (state-machine behavior) were **not** mechanically diffed — only spot-checked and read. A systematic diff is a Milestone 2 deliverable.
6. **Graph evidence is two commits stale.** `graphify-out/graph.json` was built at `e91f79d`, HEAD is `deef84f`. Every graph-derived statement here was confirmed against source; graph-only claims should be re-derived after `graphify update .`. Note also: the repository has **no `.mcp.json`**, so the Graphify MCP server is unavailable — this review used the `graphify query` CLI plus direct inspection of `graph.json`, and reports that fallback explicitly as required.
7. **Timing, ordering, and clock-domain semantics are out of scope here.** M1 located the entry points only: `fusion.rs:9-12` (freshness judged against the desktop's own monotonic receive clock, "never against the watch's own envelope timestamps"), `ORIENTATION_STALENESS_TIMEOUT_NS = 500_000_000` (`fusion.rs:21`), `PpgIngestRuntime.last_timestamp_ns` per-device ordering (`inference.rs:187`), `WatchEnvelope.sequence`/`timestamp_ns` (`protocol/src/lib.rs:256-261`), `ClockOffsetEstimate` (`watch-bridge/src/lib.rs:128`), `TrackerMonitor` (`head-tracking/src/lib.rs:42`), and `STALENESS_WATCHDOG_INTERVAL` (`lib.rs:136`). **Whether raw source timestamps stay authoritative end to end is explicitly not answered by this milestone.**
8. **Rate-control authority is asserted but unverified.** `apps/desktop/ARCHITECTURE.md:25-28` claims the Samsung PPG rate controls the watch's `HealthTracker.flush()` schedule while heart-rate, skin-temperature, and EDA rates are desktop *acceptance* limits, with Samsung authoritative for physical sampling. Not traced to code in this milestone — Milestone 2 owns it.
9. **Backpressure bounds are only partly located.** Frontend bounds are explicit (`MAX_VISIBLE_SAMPLES = 600`, `MAX_CSV_ROWS = 200_000` — `telemetryStore.ts:135-136`), as are wire caps (`MAX_PPG_BATCH_SAMPLES`/`MAX_MEDICAL_BATCH_SAMPLES = 512`, `MAX_BLE_MESSAGE_BYTES = 16 KiB`). The `broadcast` channel capacities in `watch-bridge`'s `SharedState` (`src/lib.rs:180-189`) were not measured. The lag path is handled fail-closed (`lib.rs:266-272`), but the bound itself is unrecorded.
10. **Whether the `.hermes/` plan set reflects current reality is unassessed.** 16 plan files, several from early September. `crates/native-head-tracking/src/lib.rs:2` and four `ci.yml` comments cite `.hermes/plans/2026-09-14_065556-native-sony-head-tracking-cross-platform.md` as normative — that file **does exist**, but it is untracked, so those citations resolve only on a machine holding this working tree. Not classified as drift; recorded as an unknown.
11. **`CHECKPOINT.md` (588 lines) and `TASKS.md` (967 lines) were not audited** against delivered code. Both were last modified 2026-09-29, before HEAD. Verifying their claims is a Milestone 5/6 task.

---

## Acceptance evidence

Milestone 1 acceptance criteria, mapped to the evidence above.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every production source root has an identified purpose, runtime owner, main interface, entry point, callers/dependents, and state ownership | **met** | *Production source roots* — 21 roots in four tables, each row complete and cited |
| Entry points and major dependency directions documented with exact citations | **met** | *Entry points and dependency directions* — 6 process entry points; acyclic crate graph from `Cargo.toml:2-10` + 7 manifests; runtime data-flow diagram cited to `lib.rs:182-274` and siblings |
| Cross-platform contracts documented with file and line citations | **met** | *Cross-platform contracts* — C-1…C-6, each with both sides cited; C-3 additionally proved identical by direct comparison |
| Baseline branch, local/remote SHAs, dirty paths, submodules, ignored-artifact risks recorded without alteration | **met** | *Git and repository state* — `deef84f` local = remote, no submodules, 5 dirty paths preserved, 3-layer ignore analysis, R-1/R-2/R-4; working tree returned to the opening `git status` exactly |
| Exact baseline commands and honest outcomes for Rust, desktop TS/UI/Tauri, Watch Android, Python, repo-specific checks | **met** | *Baseline validation* — V-1…V-9 passed with counts; V-10/V-11 recorded as blocked with verbatim cause; 5 commands not attempted with reasons |
| Stale docs, duplicate implementations, dead paths, unsupported claims identified | **met** | *Documentation drift and dead paths* — F-1…F-6, G-1; plus three verified-intentional paths explicitly cleared |
| All unresolved unknowns listed rather than guessed | **met** | *Unknowns and evidence gaps* — 11 items, each with why it is unresolved and how to resolve it |
| Confirmed defects distinguished from risks, tradeoffs, gaps, and unknowns | **met** | Labelled throughout: F-* confirmed defects; R-* risks; G-1 gap; "overlapping CI definitions" tradeoff; 11 numbered unknowns; 1 deferred contract gap |
| Only the review report changed; product code and pre-existing work untouched | **met** | `git status --porcelain` identical before and after all runs except the one added report path; `git diff --check` clean |

### Self-review performed before delivery

- No raw prompts, reasoning traces, credentials, secrets, or unbounded logs are included. `status-resp.json`'s internal identifiers are described by shape only, never reproduced.
- Every line citation in this report was read from the primary worktree, never from the `.claude/worktrees/` copies (see R-2).
- Validation outcomes are reported as run: two blocked checks are labelled blocked, with the tool's own reason, and are not presented as passing.
- Milestone 2–6 material encountered during inspection (timing semantics, the bundle-metadata validation gap, CI consolidation, module depth) is recorded as a located entry point with citation and an explicit deferral, not as analysis or a recommendation.

---

## Milestone verdict

**Milestone 1 is complete.** The factual system map, dependency directions, cross-platform contracts, repository state, and baseline command results are established and cited. Nine validation commands passed; two are honestly recorded as blocked by this host's environment rather than converted into passes.

**Baseline health: green where executable, with two unverified runtimes.** 171 Rust tests, 326 frontend/launcher tests, and 61 Python tests pass; `cargo fmt` and Clippy `-D warnings` are clean across seven crates. The two unverified runtimes are the Tauri host crate (CI covers it; this host cannot) and the Wear OS app (**neither** this host nor CI covers it).

**The system's central architectural claim holds structurally.** "Watch and headphones are sensor-only; AI and pinch inference belong on the laptop" is enforced by the dependency graph — `pinch-inference` depends on neither `watch-bridge` nor Tauri, `interaction-engine` depends on neither the wire format nor Tauri, and the Watch's Kotlin tree contains no classifier, model, or policy code. Fail-closed behavior is not merely asserted: five independent abnormal conditions converge on `force_release_and_hide`.

**The weakest area the baseline can already name is cross-platform contract enforcement.** Four of the five language-crossing contracts are maintained by hand-written parallel literals with no generated source and no cross-language test, and the two source roots that hold half of those literals — `apps/watch/` and `tools/pinch-classifier/` — are tested by **no** CI job. The 55-feature contract (C-3) was verified identical *in this review*; nothing in the repository would catch it diverging tomorrow.

**Nothing found in Milestone 1 blocks Milestone 2.** The sensor and timing entry points, clock-domain boundaries, ordering state, and staleness bounds that Milestone 2 must trace are all located and cited in *Unknowns* item 7.

**Conditions carried into Milestone 2:**
1. Treat `apps/watch/` and `spatial-gesture-desktop` as **unverified** until an Android SDK and the Linux Tauri prerequisites are available, or until the CI run for `deef84f` is read.
2. Mechanically diff C-1, C-2, and C-4 across languages, as was done for C-3 — reading alone is insufficient for a drift verdict.
3. Re-run `graphify update .` before relying on any graph-only claim; the graph is two commits stale, and there is no `.mcp.json`, so the CLI remains the access path.
4. Carry F-1 through F-6 and G-1 into the Milestone 6 finding set for ranking; this milestone proposes no fixes.
5. Leave the five pre-existing dirty paths untouched, and do not resolve R-1 (unignored presentation artifacts, non-product root dependencies) inside this review — it is the repository owner's call.
