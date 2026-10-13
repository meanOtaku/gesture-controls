# Watch data path: how samples reach the desktop, what broke, what was measured (October 2026)

**Scope.** Work of 2026-10-12 and 10-13 on getting the watch's motion and pulse samples to the desktop on time, over
Bluetooth. It began with PPG missing over Bluetooth, continued with the live graph lagging (worst on sudden arm
movements), and ended with motion and pulse being sent as separate streams. Each problem below has its symptom, the
evidence that pinned it, the cause, the fix and the commit.

Companion to [ppg-step-findings-2026-10.md](ppg-step-findings-2026-10.md), which used the data this path delivers. For
the link's day-to-day diagnosis see [../troubleshooting-watch-link.md](../troubleshooting-watch-link.md).

## The data path now

On `feat/ppg-step-features`, from commit `60f5d2f` on:

| Stream | Message | When it is sent | Size |
|---|---|---|---|
| Motion (rotation vector, linear acceleration, gyroscope; 50 Hz each) | `watch.sensor_batch`, motion only | 100 ms after the batch's first reading | ~5 readings, at most 16; about 2 Bluetooth packets |
| PPG (green, red, infrared; 25 Hz) | `watch.ppg_batch` | At each PPG flush (default 10 Hz) | ~2–3 samples, at most 32; 1 packet |
| Heart rate, skin temperature, EDA | their own batch messages | Gathered for up to 100 ms | small |
| Heartbeat, wear state, PPG status | their own messages | 1 s; every 5 s; on change | small |
| Time sync (desktop → watch) | `desktop.time_sync` | Every 5 s while the watch streams | small |

That is about **30 Bluetooth packets a second**.

**Over Bluetooth:**
- Each message is cut into fragments of at most 512 bytes. At most one notification is in flight at a time.
- The watch's send queue keeps whole messages and holds about half a second of data (12 fragments). Past that it drops
  its *oldest unsent* messages and never cuts a message in half (`OutboundQueue`). Drops are written to the watch's link
  log at most every 5 s.

**On the desktop:**
- Every batch is unpacked into individual samples, each with its own sensor timestamp.
- Recordings keep one row per sample, sorted by time; PPG and motion are separate rows (`ppg.csv`, `imu.csv`).
- Messages in the older formats are still accepted: one motion reading per `watch.orientation`, and the combined motion
  and pulse message of the builds from 2026-10-11 and 10-12.

## Findings

### 1. PPG over Bluetooth was refused at the 517-byte MTU

- **Symptom:** PPG showed on Wi-Fi but never over Bluetooth. Motion was fine.
- **Evidence:**
  - The desktop received heartbeats, wear state, PPG status and motion, but no `watch.ppg_batch` at all; a temporary log
    of every message type showed this.
  - The watch's sensor service delivered PPG (443 flushes, 527 deliveries), and the app tried to send it.
  - A temporary log on the watch showed the first fragment of every PPG message refused:
    `notify frame=514B index=0 final=0 mtu=517 sent=false`.
- **Cause:**
  - Fragments were sized `MTU − 3` = 514 bytes, but a Bluetooth attribute value is at most 512 bytes, so Android refused
    the notification.
  - The watch then emptied its whole queue without a log line.
  - A PPG batch (~1.6 KB at a 1 Hz flush) always needed a full-size first fragment; a motion message (~263 bytes) never
    did.
- **Fix:** payload per fragment capped at 512 on both sides, and refused or failed notifications written to the link log
  (`f63d629`).

### 2. The graph lagged on sudden movements: the queue grew for seconds, then was thrown away

- **Symptom:** the live graph fell behind on sudden arm movements, then jumped.
- **Evidence:**
  - The watch logged `dropped 512 queued fragments (#1, MTU 517): the desktop is not keeping up` three times in a minute.
  - The watch's Bluetooth service ran at 41% CPU and the app at 21%.
  - The desktop app used 10–13% CPU, so it was not the bottleneck.
- **Cause:**
  - The watch sent about 61 notifications a second: each motion reading alone (50), PPG at 10 Hz, and housekeeping.
    With one notification in flight that is close to what the link carries.
  - A sudden arm movement changes the radio path between watch and computer. The link then carries less, the queue grows
    to 512 fragments (seconds of delay), and the whole queue is dropped.
  - All sensors are continuous at a fixed rate (`dumpsys sensorservice`: 49.8 Hz each), so a movement does not add
    messages; it lowers what the link can carry.
- **Fix, in two steps:**
  - The watch's queue keeps about half a second of data and drops its oldest unsent whole messages past that
    (`OutboundQueue`, 12 fragments), instead of growing to 512 and dropping everything.
  - Fewer messages: first the motion samples rode along with each PPG flush (the combined message, 2026-10-12), then
    motion and pulse became separate batched streams (finding 6).

### 3. The desktop went silent to an off-wrist watch that was still streaming

- **Symptom:** the watch logged `no message from the desktop for 25 s while streaming; dropping the connection` every
  25 s.
- **Cause:**
  - The desktop skipped its 5 s time sync while the watch reported being off the wrist, to let a sleeping watch rest.
  - A watch set to stream off the wrist keeps streaming, though, and drops a link that stays silent.
- **Fix:** the desktop skips the sync only when no motion or pulse data has arrived recently.

### 4. The graph drew bursts as stalls, then froze after a late start

- **First cause:** samples were drawn at their *arrival* time. Bluetooth delivers in bursts, so a burst piled up at one
  moment and left a gap. That is invisible while the hand is still and looks like stalling on a sudden movement.
- **First fix:** draw samples at their own timestamps, mapped onto the desktop clock using the quickest delivery seen so
  far. This made the start of a session freeze:
  - At start-up the first samples often arrive late, so the estimate began too late.
  - When it improved, new points mapped before ones already drawn and were held in place until real time caught up.
- **Final fix:** the motion charts are drawn on the watch's own clock, which has the exact spacing and needs no estimate.
  A watch clock that restarts starts the charts afresh.

### 5. Samples of a combined message were dropped by the graph

- **Cause:** all the motion samples unpacked from one combined message carry that message's sequence number. The store
  skipped a sample whose sequence matched the previous one, a check meant only to stop the status poll adding the latest
  sample twice, so it kept the first sample of each message.
- **Fix:** a repeat is now recognised by sequence *and* timestamp.

### 6. Motion and pulse travel as separate streams

- **Why change from the combined message:**
  - Motion and pulse have different rates and are stored in separate files.
  - With the combined message, motion waited for the next PPG flush, up to 250 ms at a 1 Hz flush.
- **Change:**
  - Motion goes in its own batch, sent 100 ms after the batch's first reading, whatever the PPG rate.
  - PPG goes on its own at each flush.
  - The "combined watch message" setting was removed (`60f5d2f`).
- **Measured** with the watch's link log over 15 minutes (06:57–07:12 on 2026-10-13):
  - **20 messages dropped in total**, about 2 s of data, in groups of 2–6. Almost all came in the seconds right after a
    (re)connect, when the burst queued during connection setup is trimmed.
  - From 07:06 to 07:12 nothing was dropped.
  - Every disconnect in the window had an outside cause: the watch app was reinstalled by Android Studio (07:03:22), and
    the desktop restarted while its sources changed (07:05:59, plus three re-subscriptions at 07:09–07:11).
  - One pause is unexplained: at 07:03:39 the desktop turned notifications off and back on 10 s later.

### 7. The PPG chart covered 24 s, the others a few seconds

- **Cause:** every live series kept its last 600 samples, which is 24 s of PPG at 25 Hz.
- **Fix:** the headphone, watch motion, acceleration and PPG charts show the last 6 s by time. Heart rate, IBI and
  temperature (about one value a second) keep their last 600 values (`5d9a6bb`).

## Measurements worth keeping

| Quantity | Value | How |
|---|---|---|
| Motion sensor rates | 49.8 Hz each (rotation vector, linear acceleration, gyroscope) | `adb shell dumpsys sensorservice` (last events) |
| PPG rate | 25.0 Hz in every session | sample timestamps in the recordings |
| PPG timestamp jitter | 6–10% of gaps over 60 ms; 0.1–6.7% under 5 ms | same; a late sample is often followed closely by the next |
| Bluetooth MTU with the Mac | 517 (512 bytes per notification after the fix) | watch link log |
| Notifications per second | ~61 (each motion reading alone), ~30 now | from the message rates |
| Watch CPU at ~61 notifications/s | app 21%, Bluetooth service 41% | `adb shell top` |
| Desktop CPU while streaming | app 10%, web view 13% | `top` on the Mac |
| Live inference cost | ~0.2 ms per window in a debug build, ~10× less in release | timed with a trained model's test |

## Ruled out along the way

- **The desktop's CPU:** it had capacity to spare.
- **Model inference:** fast even in the debug build.
- **Unfiltered motion samples:** they did not raise the message rate. One row per accelerometer event is the same 50 a
  second as before.
- **The watch's screen updates:** already limited to two a second.
- **Gesture actions:** they run on their own worker thread, so they cannot block the event loop that feeds the graph.
- **The combined message as the cause of missing PPG:** the watch build running at the time did not contain it. Finding 1
  was the cause.

## Still open

- **The sample delay in practice.** Link health now shows **Sample delay** (median and 95th percentile of how late motion
  samples arrive), and the desktop log prints `watch motion samples arrive this late` every 30 s. No numbers from a real
  session have been recorded yet; they are the next thing to note.
- **The Bluetooth connection interval** was never measured. The watch could also ask for a faster one
  (`requestConnectionPriority`), which was not tried.
- **Drops right after a connect** (2–6 messages) are expected but could be avoided by not queueing before the desktop
  subscribes.
- **The 10 s notifications-off pause** at 07:03:39 is unexplained.

## Diagnosing the link

- **On the desktop:** the Link health card (Watch tab). **Sample delay** is how late motion arrives. **Longest silence**
  and **Drops / sessions** show interruptions.
- **On the watch:** `adb logcat -s LinkLog` gives the link's own events:

  | Line | Meaning |
  |---|---|
  | `MTU 517 (512 bytes per notification)` | The packet size agreed with the desktop. |
  | `the link fell behind: dropped N old messages to keep the stream live` | The send queue went past half a second; this many old messages gave way. |
  | `the stack refused a N-byte notification` | Android refused a packet; it should never appear now. |
  | `no message from the desktop for 25 s while streaming` | The desktop went silent; see finding 3. |
  | `desktop … turned notifications off` | The desktop unsubscribed (it restarted, or changed transport). |

- **Which build is on the watch:** `adb shell dumpsys package com.gesturecontrols.wearwatch | grep lastUpdateTime`. To
  compare with a local build, pull the APK (`adb shell pm path …`, then `adb pull`) and compare SHA-256 hashes. Android
  Studio's own builds differ byte for byte from a command-line build of the same source. A build with the combined message
  contains the string `combined_sensor_batch`; the separate-streams build does not.
- **What the watch's sensors deliver:** `adb shell dumpsys sensorservice`. It lists each registration with its requested
  period and the last events with their timestamps.
- **Avoid a single-sample derivative on PPG.** The timestamp jitter makes slopes between consecutive samples explode;
  resample to an even 25 Hz grid first. See finding 8 of the PPG study.

## Commits

On `main`:

| Commit | What it contains |
|---|---|
| `f63d629` | The 512-byte cap and refusal logging. |
| `a269f59` | The data-collection fixes (PPG timestamps in nanoseconds, unfiltered motion, per-sample clocks) and the 10 Hz PPG flush. |
| `71d708c` | The fresh-first queue, the time-sync fix, the graph clock fixes, the sample-delay readout and the combined message with its graph fix. |

On `feat/ppg-step-features`:

| Commit | What it contains |
|---|---|
| `60f5d2f` | Separate streams. |
| `5d9a6bb` | 6-second live charts. |
| `955d2c6` | The merge of the above. |
