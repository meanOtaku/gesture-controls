# Galaxy Watch client (Wear OS)

Standalone Gradle/Kotlin Wear OS app that implements the watch side of
[`docs/watch-websocket-protocol.md`](../docs/watch-websocket-protocol.md). It streams
`TYPE_ROTATION_VECTOR` (as a quaternion) plus accelerometer and gyroscope readings to
the desktop's `ws://DESKTOP_IP:8766/ws/watch` endpoint, answers `desktop.time_sync`
immediately, and sends `watch.heartbeat` once a second. On a **Galaxy Watch 4 or
later running Samsung Wear OS**, it also streams raw green/red/IR PPG via the
[Samsung Health Sensor SDK](../1.4.1) — see [Raw PPG](#raw-ppg-galaxy-watch-4-samsung-wear-os-only) below.

This module is self-contained: it does not depend on, and is not referenced by,
`apps/desktop` or the Rust crates. The desktop only ever sees the WebSocket wire
protocol.

## Project layout

```text
android-wearos/
├── settings.gradle.kts
├── build.gradle.kts
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/gesturecontrols/wearwatch/
│       │   ├── MainActivity.kt        UI, lifecycle, wiring
│       │   ├── WatchLinkManager.kt    OkHttp WebSocket, sequencing, heartbeat, reconnect, PPG batching
│       │   ├── SensorCollector.kt     SensorManager (rotation vector, accel, gyro)
│       │   ├── PpgCollector.kt        Samsung Health Sensor SDK PPG_CONTINUOUS lifecycle
│       │   ├── WatchProtocol.kt       v1 envelope encode/decode (org.json)
│       │   └── ConnectionPrefs.kt     SharedPreferences endpoint persistence
│       └── res/                       layout, strings, theme
```

## What it implements

- **Desktop discovery**: the app uses Android `NsdManager` to browse the desktop's
  `_gesture-controls._tcp.local.` mDNS/DNS-SD advertisement, resolves its current
  host and port, persists the endpoint, and begins streaming automatically. The
  endpoint field and Connect button remain a manual fallback.
- **MainActivity**: text field for the desktop endpoint (`ws://LAN-IP:8766/ws/watch`),
  persisted in `SharedPreferences` across restarts; a Connect/Disconnect button; live
  discovery and connection status; live sensor status and last-sent sequence number.
- **SensorCollector**: registers `TYPE_ROTATION_VECTOR`, `TYPE_ACCELEROMETER`,
  `TYPE_GYROSCOPE` at `SENSOR_DELAY_GAME`. Every rotation-vector sample is converted to
  a `[w, x, y, z]` quaternion via `SensorManager.getQuaternionFromVector` and paired
  with the most recent accelerometer/gyroscope reading (`null` until the first sample
  of that sensor arrives, matching the protocol's nullable vectors).
- **WatchLinkManager**: owns the single OkHttp `WebSocket`. Maintains one
  connection-wide, strictly increasing `sequence` counter shared by every outbound
  message type (orientation, heartbeat, time sync) — the desktop bridge tracks a
  single `last_sequence` per connection, not one per message type. Sends
  `watch.heartbeat` every second (well inside the server's 3-second silence timeout),
  and replies to `desktop.time_sync` with `watch.time_sync` immediately, echoing
  `desktopTimeNs` and attaching the current `SystemClock.elapsedRealtimeNanos()` as
  `watchTimeNs`. Reconnects with capped exponential backoff (1s → 2s → 4s → … → 30s
  cap) for up to 8 attempts while the user has requested a connection; after that it
  surfaces `Failed` and waits for the user to tap Connect again.
- **Lifecycle**: `onPause` stops the sensor listeners and closes the socket without
  forgetting the user's intent to be connected; `onResume` reopens the socket and
  restarts sensors if a connection was requested; `onDestroy` cancels everything.
- **PpgCollector**: on Galaxy Watch 4+, wraps the Samsung Health Sensor SDK's
  `HealthTrackingService` to stream `HealthTrackerType.PPG_CONTINUOUS`. See
  [Raw PPG](#raw-ppg-galaxy-watch-4-samsung-wear-os-only) below.

## Requirements

- Android Studio (Koala/2024.1 or newer recommended)
- JDK 17
- A Wear OS device or emulator running **API 30+** (Wear OS 3), e.g. a Galaxy Watch 4

No API key, Play services, or companion phone app is required — the manifest declares
`com.google.android.wearable.standalone = true` and the app runs entirely on the
watch.

## Opening the project

1. Launch Android Studio → **Open** → select the `android-wearos/` directory (not the
   repo root — this is a separate Gradle project from the Tauri/Rust code).
2. Android Studio will use the committed Gradle wrapper (Gradle 8.7). Let the first
   sync download the Android Gradle Plugin and dependencies, then finish.
3. Select the `app` run configuration.

For a command-line build, run `./gradlew :app:assembleDebug` on macOS/Linux or
`gradlew.bat :app:assembleDebug` on Windows from this directory.

## Deploying to a Galaxy Watch 4

### 1. Put the watch and your desktop on the same Wi-Fi network

The watch connects to the desktop over plain LAN WebSocket (`ws://`, not `wss://`),
so both devices must be reachable on the same local network/subnet. Watch-only
cellular or a guest network that isolates clients from each other will not work.

### 2. Enable Developer Options and Wi-Fi debugging on the watch

1. On the watch: **Settings → About watch → Software** (or **About**), tap **Software
   version** repeatedly until "Developer mode" is enabled.
2. Back out to **Settings → Developer options**.
3. Turn on **ADB debugging**.
4. Turn on **Debug over Wi-Fi**. The watch shows an IP address and port
   (e.g. `192.168.1.50:5555`).

### 3. Connect adb to the watch

From a terminal with the Android platform-tools on `PATH`:

```bash
adb connect 192.168.1.50:5555
adb devices   # should list the watch as "device", not "unauthorized"
```

If it shows `unauthorized`, check the watch face for a pairing prompt and accept it.

### 4. Install and run from Android Studio

With the watch selected as the deployment target (it should now appear in Android
Studio's device dropdown), click **Run ▶**. Android Studio builds the APK, installs
it, and launches `MainActivity` on the watch.

### 5. Start the desktop app

Start the desktop app (`npm start` from the repo root). Its watch bridge listens on
`0.0.0.0:8766` and advertises itself as `_gesture-controls._tcp.local.`. With both
devices on the same Wi-Fi/LAN, the watch finds the service, resolves its current IP,
and starts streaming automatically.

### 6. Confirm automatic discovery or enter a manual fallback endpoint

In the app on the watch, enter:

```text
ws://<desktop-lan-ip>:8766/ws/watch
```

The watch normally fills this endpoint and connects automatically. If discovery is
unavailable, enter it manually (for example `ws://192.168.1.42:8766/ws/watch`) and
tap **Connect**. The status text should move from `Connecting…` to `Connected`, and
the detail line below it should start counting up a sequence number as orientation
samples stream out.

### 7. Firewall

The desktop's watch bridge binds `0.0.0.0:8766` (all interfaces), so the OS firewall
on the desktop — not the watch — is what usually blocks the connection:

- **macOS**: the first time the Tauri app binds the port, Gatekeeper/Application
  Firewall may prompt "Do you want the application … to accept incoming network
  connections?". Choose **Allow**. If you don't see the prompt (or dismissed it),
  check **System Settings → Network → Firewall → Options** and allow the app.
- **Windows**: Windows Defender Firewall will prompt on first bind; allow it for at
  least **Private networks**.
- **Linux**: if `ufw` or another firewall is active, allow the port:
  `sudo ufw allow 8766/tcp`.

If the watch app sits on `Connecting…` and then flips to `Reconnecting…` /
`Failed`, this is the first thing to check, followed by double-checking both devices
are actually on the same subnet (some routers put 2.4 GHz/5 GHz or guest SSIDs on
isolated subnets).

## Expected dashboard evidence

Once connected, the desktop's Tauri dashboard ("Watch connection" card) should show:

- Header flips from "Waiting for watch" to **"Watch connected"**, with the status
  pill going from `Disconnected` to `Streaming`.
- **Battery** metric populated with the watch's battery percentage (from
  `watch.heartbeat`).
- **Sequence** metric counting up (from `watch.orientation`).
- **Clock offset** and **round trip** metrics populated after the first
  `desktop.time_sync` / `watch.time_sync` exchange (within ~5 seconds of connecting).
- **Quaternion**, **Accelerometer**, and **Gyroscope** rows updating live as you move
  the watch. Accelerometer/gyroscope may briefly read `—` immediately after connecting
  until the first reading of each sensor type arrives.

## Raw PPG (Galaxy Watch 4+ Samsung Wear OS only)

`PpgCollector` wraps the vendored [Samsung Health Sensor SDK 1.4.1](../1.4.1)
(`1.4.1/libs/samsung-health-sensor-api-1.4.1.aar`, added as a local `files()`
dependency in `app/build.gradle.kts`, not published to any repository). This is
**wellness data, not a medical measurement**.

- Connects via `HealthTrackingService(ConnectionListener, Context)`, checks
  `HealthTrackerCapability` for `HealthTrackerType.PPG_CONTINUOUS`, then requests
  the tracker with `getHealthTracker(PPG_CONTINUOUS, EnumSet.of(PpgType.GREEN,
  PpgType.RED, PpgType.IR))`.
- Each `DataPoint` reads `ValueKey.PpgSet.PPG_GREEN` / `PPG_RED` / `PPG_IR` and
  their `*_STATUS` companions, timestamped by the SDK.
- Requires the Android runtime permission `android.permission.BODY_SENSORS`
  (`MainActivity` requests it on first Connect if not already granted) **and**
  the Samsung Health Sensor SDK's own consent prompt, surfaced asynchronously as
  `HealthTracker.TrackerError.PERMISSION_ERROR`.
- On hardware without `PPG_CONTINUOUS` support, or without the Samsung Health
  app installed, `PpgCollector` reports `PpgState.UNAVAILABLE` and the rest of
  the app (orientation streaming) keeps working normally.
- Samples are buffered in `WatchLinkManager` and flushed as `watch.ppg_batch`
  messages (see [`docs/watch-websocket-protocol.md`](../docs/watch-websocket-protocol.md#raw-ppg-galaxy-watch-4-samsung-wear-os-only));
  `PpgState` transitions are sent separately as `watch.ppg_status`.

## Limitations

- **One watch at a time**: the desktop bridge accepts a single connection; a second
  watch (or a second launch of this app pointed at the same desktop) is rejected with
  close code `4409`.
- **No companion phone pairing / Wearable Data Layer API**: the app talks directly to
  the desktop over Wi-Fi. If the watch has no Wi-Fi (Bluetooth-only companion mode),
  it cannot reach the desktop.
- **Plain `ws://`, LAN-only**: there is no TLS and no authentication. This is
  appropriate for a trusted local network only; do not expose port 8766 beyond your
  LAN.
- **mDNS is local-only**: automatic discovery requires the watch and desktop to share
  a Wi-Fi/LAN multicast domain. It does not cross guest networks, client-isolated
  SSIDs, most VLANs/subnets, or the internet. The manual endpoint field remains the
  fallback for networks that block mDNS.
- **Button grab only**: Milestone 7 maps the Wear OS `STEM_1` hardware key to a
  press-and-hold volume-overlay grab after the desktop has shown that overlay. It
  does not intercept Back, Home, or Power. Wrist-rotation volume control and
  on-device pinch inference remain later milestones.
- **Raw PPG is hardware-gated**: only Galaxy Watch 4+ on Samsung Wear OS exposes
  `PPG_CONTINUOUS`; other watches run normally with `PpgState.UNAVAILABLE` and no
  PPG data in `watch.ppg_batch`.
- **Bounded reconnect**: after 8 failed reconnect attempts (capped at 30s backoff
  each) the app stops retrying automatically and shows `Failed`; tap **Connect** again
  once the issue (Wi-Fi, firewall, desktop app) is resolved.
- **Ambient/Doze**: this app has no foreground service. If the watch enters deep
  ambient or the app is backgrounded, `onPause` stops sensors and the socket; bring
  the app back to the foreground to resume streaming.
