# Performance review

A measured review of where the system spends time, what was changed because of it, and
what was deliberately left alone. Every number below was taken on one developer machine
(Apple M3, macOS 26.6, Rust 1.97 `--release`, Node 21, Python 3.14), not on a watch or in
the packaged app. Treat them as relative evidence, not as a specification.

## Method

Nothing was optimized on a hunch. Each candidate hot path was found by reading the code that
runs per sensor sample or per user action, then **measured before any change**. Paths that
turned out to cost almost nothing were left untouched and are listed below as such, because
knowing they are cheap is as useful as the fixes. Every optimization that could change a result
is guarded by a test that compares it with the original implementation (see
[How the changes are verified](#how-the-changes-are-verified)).

## Changes made

| Area | Before | After | Where |
| --- | --- | --- | --- |
| **Dataset buffer append at capacity** | 452 µs per row; also *corrupted row order* (see below) | 0.1 µs | `store/ringBuffer.ts` |
| **Copying the dataset buffer on every render** | 1.3 ms and a 1.6 MB allocation per render, at the ~15 Hz publish rate | not done unless Export is pressed | `DatasetCaptureCard`, `LiveTelemetry` |
| **Idle tabs re-rendering on every telemetry publish** | Model Lab (a large tree) re-rendered once per publish, ~15 times a second | rendered once | `app/App.tsx` (`memo`) |
| **Raw-CSV viewer: parsing** (15 MB, 200,000 rows) | 52 ms per request | 16-32 ms per request (column dependent) | `recording_bundle.rs` |
| **Raw-CSV viewer: repeated requests** | full read and parse on *every* scrub step | first request ~24 ms, then **1.3 µs** from a bounded cache | `RawColumnCache` |
| **Full-document validation** (import) | 70 ms | 54 ms | `validate_raw_csv_full` |
| **Wrist volume writes on the watch event loop** | each write blocked the loop for the whole native call (macOS `osascript`: **130-190 ms**) | the loop only hands the target over; a writer thread applies the latest one | `overlay.rs`, `latest_write.rs` |
| **Status events at orientation rate** | up to 200/s, each a full status clone plus serialization | at most ~10/s for orientation-only changes; no clone | `watch.rs` |
| **Python: loading a recording** (100k rows) | 0.80 s | 0.32 s | `csv_io.py` |
| **Python: building a dataset** (100k rows, 13,320 windows) | 2.67 s | 1.01 s | `csv_io.py`, `features.py`, `windowing.py` |
| **Python: one long single-label recording** (200k rows, 26,664 windows) | 7.26 s | 2.23 s | `windowing.py` (was quadratic), `features.py` |
| **Release binary size** | 17.5 MB | 12.0 MB (-31%) | `[profile.release] strip` |

### Why each one

- **`RingBuffer.insertAt` was a bug as well as a slowdown.** Once the dataset buffer was full
  (200,000 rows), every in-order append went through a shifting loop, and that loop was wrong:
  inserting `99` at the end of `[10,20,30,40,50]` produced `[30,40,50,99,20]`. A recording that
  passed 200,000 rows came out of order. An in-order append is now exactly `push`, and an
  out-of-order insert moves only the elements after it. A randomized comparison against a
  reference model (capacities 1-16, including wraparound) pins the behavior.
- **Timeline intervals pointed at the wrong rows after eviction.** When a full buffer drops its
  oldest row, every row index moves one earlier, but the intervals' row bounds did not.
  `reindexIntervalsAfterInsert` now moves them with the rows, clamps an interval that lost its
  first row, and removes one that was entirely evicted.
- **The viewer commands each re-read and re-parsed the whole `raw.csv` to serve one small
  window.** The parse is now allocation-free per row (a comma count first, so a short row is
  still reported as a short row, then one pass over the fields) and its result is cached per
  recording and column, keyed on the file's size and modification time so it can never serve
  stale data. The cache is bounded (4 entries, about 5 MB each at 200,000 rows) and dropped when
  a recording is deleted. The signal-processing transforms behind the derivative and spike views
  cost only 4-7 ms per call at 100,000 samples, so they were not rewritten.
- **Wrist volume writes no longer block the watch event loop.** On macOS every volume read or
  write spawns `osascript` (130-190 ms measured). That ran inline on the loop that also carries
  PPG inference, the button release, haptics and disconnect handling, and orientation events
  queued behind it. The wrist mapper still sees **every** sample on the loop (so its
  monotonicity and velocity-outlier rejection are unchanged); only the native call moved to a
  writer thread, through a mailbox where the newest absolute target replaces older ones. Each
  target carries an *interaction epoch*, so a write that was waiting when the grab ended, or
  when a new one began, is dropped instead of landing on the wrong interaction. See
  [Safety and fail-closed behavior](architecture/safety-and-fail-closed-behavior.md).
- **Orientation-driven status events were redundant.** The frontend already receives each
  orientation on its own event and de-duplicates the copy inside the status event by sequence,
  so the status event at 50-200 Hz carried nothing new and could only be rendered at ~15 Hz. It
  is now coalesced to at most one per 100 ms for orientation-only changes (any other change is
  sent immediately), and serialized in place instead of cloned first.
- **Python.** Feature extraction was 70% of dataset-building time (about 15 separate numpy
  reductions per window) and `_carry_forward` was a Python loop over every row. Window
  selection re-scanned the *whole segment* with two masks for every window, which is quadratic
  in the segment length. All three are vectorized with **bit-identical** output; one detail is
  worth recording: `block.mean(axis=1)` is *not* a substitute for per-channel `np.mean`, because
  it sums in a different order and moved 27 of the 55 features by up to thousands of ulps, so
  the per-row mean and standard deviation replay numpy's own 1-D operations exactly.
- **Release profile.** Stripping symbols is free in compile time and saves 5.5 MB. Thin LTO with
  one codegen unit measured -28% on its own (and -42% combined with stripping) but adds about
  1.5 minutes per OS to every CI package build with no demonstrated runtime gain, so it is not
  enabled. `panic = "abort"` was not applied because it would change crash behavior.

## The watch app: battery and CPU

The watch app was reviewed by reading what runs while no desktop is receiving, then fixed.
**None of this has been measured on a watch's battery**; the only numbers below are a JVM
microbenchmark and counts of avoidable work. A real before/after needs a full-charge drain
test on hardware (see "How to measure it" at the end of this section).

| Cost | Before | After |
| --- | --- | --- |
| Sensors, PPG and the CPU wake lock while **waiting for the desktop** (BLE advertising, awaiting trust, retrying) | Left running: three IMU sensors at the configured rate, the PPG tracker and a partial wake lock, producing readings that were dropped unsent | Run only while `CONNECTED`; the foreground service stays so the process is not frozen, but the wake lock and every sensor are released |
| "Monitor mode" listener when the app is backgrounded and disconnected | Rotation-vector sensor registered with no consumer | Removed |
| `watch.ppg_status` messages | One per PPG diagnostic text change: three per flush, so 30+ BLE messages a second at the 10 Hz flush rate, plus a screen redraw each | One per actual state change; the diagnostic text is published at most once a second |
| PPG delivery | A 40 ms polling timer (25 wake-ups a second, almost always finding an empty buffer) | Sent when the SDK delivers samples (same batches, one wake-up per delivery) |
| Medical-tracker flush | A permanent 100 ms timer (10 a second) even with no medical tracker running | A one-shot, 100 ms after the first sample arrives |
| BLE advertising | Low-latency mode, and it kept running while a desktop was connected | Balanced mode, stopped while a desktop is connected, resumed on disconnect |
| Orientation message encoding (up to 50 a second) | A `JSONObject`, two `JSONArray`s and a boxed `Double` per component: 3.2 us per message (JVM) | One `StringBuilder`: 0.4 us per message (JVM, 8x), output checked against the old encoder on 2,000 random readings |
| Status text redraw | Orientation sequence redrawn at the sensor rate | At most twice a second |
| **Off the wrist** | Sensors, PPG, the wake lock and the desktop's 5-second time-sync writes all continued | The standard off-body sensor pauses IMU, PPG and medical collection; over Bluetooth the CPU wake lock is released and the desktop stops time-sync writes (see [the protocol](protocols/watch-websocket-protocol.md#wear-state-on-or-off-the-wrist)). Not yet measured on a battery |

Two behaviours changed on purpose: a reading with a non-finite component is now dropped (the old
encoder threw inside the sensor callback), and streaming control no longer depends on the screen
being on, so a reconnect that lands with the display off now starts the sensors.

**What was not changed, and why**

- **Sensor rates.** `watchOrientationRateHz`, the acceleration and gyroscope rates and
  `watchPpgFlushRateHz` are desktop settings that decide what the model sees. The largest single
  lever is `watchPpgFlushRateHz`: it is **10** in the settings file reviewed (the maximum; the default is 1),
  which makes the Samsung sensor service flush ten times a second. Lowering it would save more than
  everything above, but it also changes the live window length the model is validated against.
- **Batching the companion sensors** (acceleration, gyroscope) would cut CPU wake-ups, but it makes the
  attached readings up to 40 ms staler than the training data assumed.
- **Dim theme.** The watch uses the darkest navy as its background; an OLED panel pays for every lit
  pixel, so a mid-blue field would cost far more than this.

**How to measure it.** Charge to 100%, reset `adb shell dumpsys batterystats --reset`, run a Bluetooth
session for a fixed time (and, separately, leave the app advertising with no desktop for the same time),
then compare `adb shell dumpsys batterystats` (CPU, wake lock, sensor and Bluetooth time) and the battery
percentage between builds `719c4f3` and later.

## Measured and left alone

These were each measured and found cheap enough that changing them would add risk for no
benefit.

| Path | Cost | Verdict |
| --- | --- | --- |
| Decoding a watch message (`WatchEnvelope`) | 0.8 µs orientation, 4.1 µs for a 25-sample PPG batch | The double parse through `serde_json::Value` is irrelevant at 50 Hz |
| `TelemetryFusion::observe_orientation` | 61 ns per sample | Negligible even at 200 Hz |
| Fusing and extracting features for a live PPG window | 1.4 µs + 5 µs (with ~190 in-window orientation samples) | Negligible at 1-25 windows a second |
| Cloning and serializing the watch status | 0.7 µs + 1.0 µs | Small in CPU terms; the saving from coalescing is mostly IPC and WebView work |
| Signal-processing transforms (rolling median, top-hat, Butterworth, Savitzky-Golay, Haar) | 4-7 ms per call at 100,000 samples | Fine once the parse is cached |
| Time chart geometry | well under a millisecond per render | Left as is |
| Watch app flush timers (40 ms PPG, 100 ms medical) | not measurable here | The streaming foreground service already holds a wake lock; changing battery-sensitive timing without a device to measure on would be a guess |

## Not done, with the evidence

- **Replace the macOS `osascript` calls with CoreAudio.** Each volume read costs 130-190 ms
  even with the writer thread: the wrist control can still apply only about six writes a second,
  and `begin_volume_interaction` (a button press or a model grab) reads the current volume
  synchronously on the event loop before the grab becomes active. `show()` reads it too. A direct
  `AudioObjectGetPropertyData` call would take microseconds. It needs unsafe FFI and validation against real output devices (HDMI,
  aggregate and virtual devices behave differently), so it is the largest remaining win but
  should be done and checked on hardware.
- **Measure the WebView side of the event traffic.** The Rust cost of an event is a couple of
  microseconds; what each `emit` costs the WebView (JSON parse, listener, scheduling) was not
  measurable without running the packaged app against a streaming watch.
- **Profile the packaged app** with a real watch to confirm the writer thread improves
  perceived wrist-control latency on macOS.

## How the changes are verified

- **Bit-identity where results feed training.** `tests/reference_impl.py` keeps the original
  Python loops verbatim; `tests/test_optimized_equivalence.py` requires the vectorized loader,
  windowing, carry-forward and feature extraction to match them byte for byte over randomized
  recordings (random blanks, mixed labels, duplicate timestamps, gaps, several window sizes),
  and requires malformed files to fail with the same error message.
- **Same results, same errors** for the Rust CSV parsers: the original implementations are kept
  in the test module as references and compared over valid and malformed documents (wrong
  field counts, bad timestamps and values in every column, blank lines, CRLF), floats compared
  by bit pattern.
- **Behavior tests** for the ring buffer (randomized against a reference model), interval
  re-indexing (including a simulated long run at capacity), the column cache (hit, change,
  eviction, delete, errors), the latest-wins mailbox (newest wins, clear, wake-up, epoch), status
  coalescing, and a render-count test showing idle tabs are no longer re-rendered by publishes.
- **What is not covered:** the writer thread's interaction with a real Tauri app (it needs an
  `AppHandle`), and any of this on a watch or in the packaged binary.

## Reproducing the measurements

```bash
# Raw-CSV parse and cache (200,000-row synthetic recording)
cargo test --release -p spatial-gesture-desktop --lib perf_probes -- --ignored --nocapture

# Python dataset build (100,000 rows)
cd tools/pinch-classifier && uv run python - <<'PY'
import sys, time, tempfile, pathlib
sys.path.insert(0, "tests")
from tests.conftest import make_dataset_csv
from pinch_classifier.dataset import build_dataset
from pinch_classifier.windowing import WindowConfig
from pinch_classifier.labels import legacy_compatibility_mapping
tmp = pathlib.Path(tempfile.mkdtemp())
paths = [make_dataset_csv(tmp, f"s{i}.csv", l, 25_000, start_ns=i * 10**12)
         for i, l in enumerate(["idle", "pinch_start", "pinch_release", "idle"])]
t = time.perf_counter()
build_dataset(paths, WindowConfig(), "exclude", label_mapping=legacy_compatibility_mapping("exclude"))
print(f"{time.perf_counter() - t:.2f}s")
PY

# Release binary size
cargo build --release -p spatial-gesture-desktop && ls -l target/release/spatial-gesture-desktop

# macOS osascript spawn cost (read-only)
time osascript -e 'output volume of (get volume settings)'
```
