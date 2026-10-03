# Review remediation

Status of every finding in the four engineering reviews under
[`.hermes/reviews/`](../.hermes/reviews/): the architecture baseline (M1), sensor
timing (M2), data and model lifecycle (M3) and gesture-to-action safety (M4). The
reviews themselves are historical records of the tree at the commit each one
names; they are not edited. This page is where current status lives.

**How to read the status column.** *Fixed* means the cited commit changes the code
and its tests pass. *Partial* means a real part is fixed and the remainder is
named. *Open* means untouched. **Nothing here has been verified on physical
hardware**; "fixed" always means "fixed and covered by automated tests".

Checks run for these changes: `cargo fmt --check`; `cargo clippy --workspace
--all-targets -- -D warnings`; `cargo test --workspace` (excluding the
environment-sensitive `native-head-tracking` `ffi_macos` smoke test); `npm test`
and `npm run typecheck`; the trainer's `pytest`; and the watch's
`./gradlew :app:testDebugUnitTest`. The last two are not run by CI (see
[Components and deployment §5](architecture/components-and-deployment.md#5-tests-and-ci)).

## M4 — gesture to action safety

| ID | Finding | Status | Commit |
| --- | --- | --- | --- |
| D-M4-1 | Native volume write had no rate limit | **Fixed**: wrist writes limited to 1 per 100 ms; the slew cap below also bounds the rate | `cd08095`, `188dfa6` |
| D-M4-2 | `correct_grab_executed` was not atomic | **Fixed**: bindings remap and correction run under one policy lock | `cd08095` |
| D-M4-3 | Overlay lock held across a blocking native call | **Fixed**: writes order on a separate lock; reads happen outside the state lock | `e515543` |
| D-M4-4 | Webview raised the volume capability gate | **Fixed**: `show_overlay` requires the backend's top-right target to be active | `e515543` |
| D-M4-5 | `report_pinch_transition` injected a transition | **Fixed**: command removed (it had no caller) | `e515543` |
| D-M4-6 | Duplicate transition timestamp accepted | **Fixed**: strictly increasing required | `e515543` |
| D-M4-7 | First orientation sample skipped the velocity gate | **Partial**: first sample is now checked; the reference pose still has **no freshness bound** | `cd08095` |
| R-M4-1 | Hot loop on a closed watch event channel | **Fixed**: loop ends on `Closed`, recovers on `Lagged` | `3215911` |
| R-M4-2 | Failed haptic consumed the rate-limit slot | **Fixed** (failure is still not surfaced in `OverlayState`, by design) | `3215911` |
| R-M4-3 | Overlay grab had no owner | **Fixed**: grab owner recorded; normal ends are owner-scoped, forced ends unconditional | `3b10663` |
| R-M4-4 | Teardown had no outer bound | **Fixed**: 10 s bound, then exit | `3215911` |
| R-M4-5 | Un-clearable PPG watermark | **Fixed** (see D-2) | `188dfa6` |
| R-M4-6 | Inference mode had two sources of truth | **Fixed**: apply, then persist, restore on failure; persisted `Live` capped to `Monitor` at startup | `3b10663` |
| R-M4-7 | Event name duplicated across languages | **Fixed**: declared once in `events.ts`; a Rust test fails on drift | `3215911` |
| T-M4-1…4 | Tradeoffs (no retries, no grab duration cap, no volume restore, four unexecuted intents) | Unchanged by design | — |
| G-M4-1…4 | No end-to-end actuation, haptic loop, or Windows adapter test on a real device | **Open** (needs hardware) | — |

## M3 — data and model lifecycle

| ID | Finding | Status | Commit |
| --- | --- | --- | --- |
| D-M3-1 | Timeline Capture labels could not reach training | **Partial**: a Timeline CSV export now imports (gap rows dropped, every row label checked and mapped). `annotations.json`, curation status and interval boundaries still reach nothing | `8ca0290` |
| D-M3-2 | `save_recording_bundle` trusted the webview | **Fixed**: CSV, row counts, source counts and interval bounds verified. Webview clock fields cannot be verified and are not | `288033b` |
| D-M3-3 | Corrupt registry silently erased | **Fixed**: an unreadable/corrupt `registry.json` is an error and is never overwritten | `3e658b4` |
| D-M3-4 | Curation and post-capture editing unreachable | **Open** | — |
| D-M3-5 | Replay re-roled labels | **Fixed**: replay uses the training run's `label_mapping.json`; legacy fallback rejects unknown labels | `29cc2f4` |
| D-M3-6 | Desktop validated only bundle shape | **Fixed**: dtypes, preprocessing, `window_config`, parity and training provenance are validated; shared cross-language fixture | `3e658b4` |
| R-M3-1 | Window settings never compared with runtime | **Partial**: live window duration is checked against `window_ms` (Live blocked on mismatch, Monitor allowed); `min_samples_per_window` is enforced. No sliding window exists live, so stride and max gap have no live counterpart | `428ed6c` |
| R-M3-2 | Lineage is path-based, not content-based | **Open** (no input hashes; the label mapping is not covered by the bundle digest) | — |
| R-M3-3, R-M3-4, R-M3-5, R-M3-6, R-M3-7, R-M3-8, R-M3-9, R-M3-10 | Order sensitivity, non-durable writes, stale on-disk bundle, LiteRT input signature, overlap clamp, orphaned model dirs, fabricated `0` timestamp, split `created_at` | **Open** | — |
| R-M3-11 | Mode persisted without being applied | **Fixed** (see R-M4-6) | `3b10663` |
| R-M3-12 | Label pre-flight checked the wrong label set | **Fixed**: row labels are authoritative and must agree with a single-label file's comment | `8ca0290` |
| G-M3-1…5 | No execution evidence for the Rust half, crash recovery, concurrency, a LiteRT model run | **Open** (the desktop crate now builds and tests locally; crash/concurrency/LiteRT evidence is still missing) | — |
| G-M3-6 | No cross-language fixture | **Partial**: bundle contract has one; the annotation contract does not | `3e658b4` |

## M2 — sensor timing

| ID | Finding | Status | Commit |
| --- | --- | --- | --- |
| D-1 | Two wrist settings had no effect | **Fixed**: `max_volume_points_per_second` is a real slew limit; the smoothing control was removed (old `settings.json` still loads) | `188dfa6` |
| D-2 | PPG watermark never cleared | **Fixed**: cleared on watch disconnect | `188dfa6` |
| D-3 | `deviceId` was a build constant | **Fixed**: BLE id derived from the discovered peripheral and stamped by the desktop; Wi-Fi id is a unique per-install value | `5fba672` |
| D-4 | Orientation on a different clock than every other message | **Fixed** on the watch: sensor timestamp verified per event and rebased onto `elapsedRealtimeNanos` if it differs (a sub-second base mismatch would not be detected) | `1d5b568` |
| D-5, D-6, D-7 | `monotonic_ns` means two things; unordered `raw.csv` accepted; `ppg_continuous` tracker id doc claim | **Open** | — |
| R-M2-1 | 13 features structurally zero live | **Partial**: orientation statistics now run over the samples that arrived in the window, with trainer-verified arithmetic. Window membership still approximates the offline row model | `38ac917` |
| R-M2-3 | Unbounded error loop | **Fixed** (see R-M4-1) | `3215911` |
| R-M2-2, R-M2-4, R-M2-5, R-M2-7, R-M2-9, R-M2-10, R-M2-11, R-M2-12 | Single sequential consumer lag, BLE PPG starvation at default MTU, un-throttled IPC, wall-clock time sync, epoch-scale PPG timestamp precision, stale PPG rate, accel frame ambiguity, 180° delta artifact | **Open** | — |
| C-4 | Rust and Python state machines diverge on an unnormalized output (Rust is the safe side) | **Open**; the "behaviorally identical" comment in `runtime.rs` is still inaccurate | — |
| G-M2-1…6 | Unverified device properties, no hardware, no trained model | **Open** (the watch's Gradle toolchain does run on a developer machine, so Kotlin unit tests are executable; a real watch is still required) | — |

## M1 — architecture baseline

| ID | Finding | Status | Where |
| --- | --- | --- | --- |
| F-3 | In-source references to an `ARCHITECTURE.md` that did not describe inference | **Fixed**: `apps/desktop/ARCHITECTURE.md` now documents the backend, modes and policy | this change |
| F-4 | README never mentioned the watch's default transport | **Fixed** | this change |
| F-5 | README called `volume-control` macOS-only | **Fixed** | this change |
| F-6 | Stale trees in both `ARCHITECTURE.md` files and `docs/README.md` | **Fixed** | this change |
| F-1, F-2 | Duplicate `usePendingActions` hook; dead `lib/utils.ts` | **Open** | — |
| G-1 | CI covers neither `apps/watch` nor `tools/pinch-classifier` | **Open**: documented honestly in the docs, not fixed | — |
| R-1…R-4 | Untracked build artifacts, overlapping CI workflows, hand-maintained cross-language contracts | **Open** (event-name and bundle-contract drift now have guards; the rest do not) | — |

## Suggested next work

1. **Close G-1**: add the trainer's `pytest` and the watch's `testDebugUnitTest` to CI. Both already pass locally and now guard real contracts (the shared bundle fixture, BLE framing, the orientation clock rebaser, the device id).
2. **D-M3-4**, then the rest of **D-M3-1** (curation and annotation data into training).
3. **D-M2-5 / D-M2-6**: the recorder's clock meaning and ordered `raw.csv`.
4. **Hardware validation** against the [release-readiness checklist](release-readiness.md): the first Monitor session will show the real live window duration and whether the watch ever logs a sensor-clock rebase.
