# Galaxy Watch WebSocket protocol

> This is the **Wi-Fi** transport. Bluetooth LE is the default since GC-037 and
> carries these exact same envelopes over GATT; see
> [`watch-ble-transport.md`](./watch-ble-transport.md). Only one transport runs
> at a time.

The desktop listens on `ws://DESKTOP_IP:8766/ws/watch` on the local network. Only one watch connection is accepted at a time. The desktop disconnects a silent client after three seconds.

## Local discovery

After the listener starts, the desktop advertises a DNS-SD service as
`_gesture-controls._tcp.local.`. Its TXT metadata is `protocol=ws`,
`path=/ws/watch`, and `version=1`; the advertised port is the listener's actual
bound port. The Wear OS app browses and resolves this service with Android's
`NsdManager`, then connects to the resolved `ws://HOST:PORT/ws/watch` endpoint.

**The desktop does the looking; the watch only listens.** While the Wi-Fi transport is selected the
watch advertises a `_gesture-watch._tcp.local.` pairing service and answers on it. The desktop
browses for that service and keeps a table of the watches it has seen. Whenever no watch is
attached it asks each one, every 4 seconds, to connect: it opens the watch's `/pair` endpoint, and
the watch uses the request's source address to open the WebSocket back to the desktop. The
retry is what makes a dropped connection recover: nothing new is announced on the network when a
link drops, so a desktop that only reacted to announcements would wait forever. A watch that
leaves the network (or whose app stops) is removed from the table when its service expires.

The watch does not browse for the desktop on its own, since a continuous multicast browse is a
steady battery cost for a job the desktop already does. Two fallbacks remain on the watch: it
reconnects to the endpoint it last used, retrying with a backoff capped at 30 s and never giving up,
and **Find desktop** runs the `_gesture-controls._tcp` search on demand. A connect request from the
desktop replaces a retry in progress (the watch may be retrying an address the desktop no longer
has) but never interrupts a live session.

Everything is local multicast and LAN TCP: the watch and desktop must share a Wi-Fi network, and
client isolation, guest networks, VLAN boundaries or multicast-blocking routers can prevent
pairing. On macOS the app that launched the desktop also needs Local Network access.
The Link health card shows which of these the desktop is doing (`no watch seen on the network yet`,
`asked the watch at ADDRESS to connect; it accepted`, or `did not answer`).

## Watch messages

All messages are UTF-8 JSON with the required envelope fields `type`, `version` (`1`), `deviceId`, `sequence`, `timestampNs`, and `payload`. `timestampNs` is the watch `SystemClock.elapsedRealtimeNanos()` timestamp (boot-relative) on **every** message, including `watch.orientation`. Orientation is built from `SensorEvent.timestamp`; Android requires that clock to share `elapsedRealtimeNanos()`'s base, and the watch verifies it on each event, rebasing orientation onto that base (and logging once) on a device where it does not hold, so the desktop can always order orientation against every other message. The per-sample `timestampsNs` inside a `watch.ppg_batch` are the exception: they are on the Samsung Health Sensor SDK's own clock (see below). Sequences must increase across a connection.

`deviceId` identifies the watch. Over **Bluetooth** the desktop assigns it from the peripheral it discovered (`ble-<platform peripheral id>`, e.g. `ble-aa-bb-cc-dd-ee-ff`) and replaces whatever the watch put in the envelope, so a watch cannot choose or spoof which device it is. Over **Wi-Fi** there is no peripheral, so the desktop uses the watch's own `deviceId`, which is a unique per-install value (`watch-<uuid>`) generated once and persisted on the watch. The `galaxy-watch-4` values in the examples below are illustrative only; the desktop's per-device state (the PPG ordering watermark, orientation/PPG fusion identity checks) is keyed on whichever id applies to the active transport.

`watch.orientation` carries a quaternion and optional accelerometer and gyroscope vectors:

```json
{"type":"watch.orientation","version":1,"deviceId":"galaxy-watch-4","sequence":1,"timestampNs":123,"payload":{"quaternion":[1,0,0,0],"accelerometer":[0,0,9.81],"gyroscope":[0,0,0]}}
```

`watch.heartbeat` carries an optional `batteryPercent` value. Send it at least once every three seconds, including while no IMU samples are available.

## Wear state (on or off the wrist)

`watch.wear_state` reports the watch's off-body detector (the standard
`low_latency_offbody_detect` sensor):

```json
{ "type": "watch.wear_state", "payload": { "worn": false } }
```

The watch sends it when the state changes, and once after each connection starts (the
sensor reports its current value on registration, and a watch with no such sensor reports
`worn: true`). Taking the watch off is confirmed for 3 seconds before it is reported; putting
it on is reported at once.

While `worn` is `false` the watch **stops its IMU, PPG and medical collection**, so no
`watch.orientation` or `watch.ppg_batch` messages are expected, and over Bluetooth it releases
its CPU wake lock and may sleep. The desktop therefore:

- releases any held interaction (fail closed: the data that drove it has stopped),
- tolerates silence for up to 10 minutes instead of the normal heartbeat timeout, **over Bluetooth
  only** (a Wi-Fi watch keeps its wake lock and its heartbeat, so nothing stretches). The allowance is
  safe because the desktop separately asks the Bluetooth stack once a second whether the watch is
  still connected, which needs no radio traffic and does not wake the watch; the notification
  stream itself does not end when a peer disappears, so without that check a watch app that was killed
  (a reinstall, a crash) while off the wrist would leave the desktop in a dead session instead of
  looking for it again, and
- stops its 5-second `desktop.time_sync` writes, which would otherwise wake the sleeping watch.

The watch has an "off-wrist streaming" toggle for testing with the watch on a desk; with it on the
watch streams regardless and still reports its wear state.

## Volume overlay grab (STEM button)

When the head tracker dwells on the calibrated top-right target, the desktop
shows its volume overlay. Holding the watch's STEM_1 hardware key (Wear OS's
customizable button, distinct from Back/Home/Power) while the overlay is shown
grabs it; releasing the key releases the grab and hides the overlay. Only this
one button is dispatched in this milestone — no pinch gesture or wrist-rotation
volume control yet.

`watch.button` reports a press or release:

```json
{"type":"watch.button","version":1,"deviceId":"galaxy-watch-4","sequence":5,"timestampNs":127,"payload":{"button":"stem_primary","state":"down"}}
```

`payload.button` is currently always `stem_primary`; `payload.state` is
`down` or `up`. The desktop ignores a `down` while the overlay isn't shown,
and always clears the grab and hides the overlay on `up` or on watch
disconnect, so a lost connection mid-hold can never leave the overlay stuck
grabbed.

## Time synchronization

The desktop sends `desktop.time_sync` every five seconds. Echo its `payload.desktopTimeNs` immediately in a `watch.time_sync` message and add the current watch monotonic time as `payload.watchTimeNs`. The desktop calculates round-trip latency and uses the median of its latest five offset samples.

```json
{"type":"watch.time_sync","version":1,"deviceId":"galaxy-watch-4","sequence":2,"timestampNs":124,"payload":{"desktopTimeNs":456,"watchTimeNs":124}}
```

The watch should also handle the initial `desktop.connected` acknowledgement, which contains the session identifier and desktop timestamp.

## Desktop runtime controls

The desktop can change active Watch inputs without reconnecting. `desktop.set_sensor`
enables or disables one of `orientation`, `acceleration`, `gyroscope`,
`heart_rate_continuous`, `skin_temperature_continuous`, or `eda_continuous`.

The desktop can request an independent Android sampling rate for each IMU input
with `desktop.set_sensor_rate`:

```json
{"type":"desktop.set_sensor_rate","version":1,"timestampNs":456,"payload":{"sensor":"gyroscope","rateHz":75}}
```

For `orientation`, `acceleration`, and `gyroscope`, `payload.rateHz` must be finite
and between 1 and 200 Hz. The Watch converts it to
`SensorManager.registerListener`'s sampling period and re-registers only that
physical sensor. Hardware and Android may deliver a different measured rate.

The same command accepts `sensor: "ppg_continuous"` with 0.1–10 Hz to change the
existing `HealthTracker.flush()` schedule at runtime. This only controls how often
the Watch asks Samsung's SDK to release buffered raw PPG callbacks; it does not
change physical PPG sampling or manufacture callback cadence.

## Raw PPG (Galaxy Watch 4+ Samsung Wear OS only)

Raw green/red/IR PPG is available only on Galaxy Watch 4 or later running Samsung
Wear OS, via the Samsung Health Sensor SDK's `PPG_CONTINUOUS` tracker. It is
**wellness data, not a medical measurement** — do not treat it as diagnostic. It
streams only while the watch also has a desktop connection requested, alongside
IMU orientation.

`watch.ppg_batch` carries a compact batch of raw samples as parallel per-channel
arrays (one entry per sample, ascending SDK-timestamp order), not one message per
sample:

```json
{"type":"watch.ppg_batch","version":1,"deviceId":"galaxy-watch-4","sequence":3,"timestampNs":125,"payload":{"sampleCount":2,"timestampsNs":[100,140],"green":[812345,812350],"greenStatus":[0,0],"red":[512345,512348],"redStatus":[0,0],"ir":[312345,312349],"irStatus":[0,0]}}
```

- `green`, `red`, `ir` are the raw ADC counts from `ValueKey.PpgSet`.
- `*Status` is the SDK's per-sample per-channel status code; `0` means valid,
  non-zero flags a degraded reading (e.g. poor skin contact).
- `timestampsNs` are the SDK's own per-sample timestamps (`DataPoint.getTimestamp()`),
  not the watch's `SystemClock.elapsedRealtimeNanos()` used elsewhere in this
  protocol — they are monotonic but on their own clock domain.
- The desktop rejects a batch whose `sampleCount` doesn't match every channel
  array's length, or whose `sampleCount` is `0` or exceeds 512 samples.

`watch.ppg_status` reports the watch's raw-PPG availability, independent of the
WebSocket connection state itself:

```json
{"type":"watch.ppg_status","version":1,"deviceId":"galaxy-watch-4","sequence":4,"timestampNs":126,"payload":{"state":"streaming"}}
```

`payload.state` is one of `idle`, `permission_required`, `connecting`,
`streaming`, `unavailable`, `error`:

- `permission_required`: the Android `BODY_SENSORS` runtime permission, or the
  Samsung Health Sensor SDK's own consent (`HealthTracker.TrackerError.PERMISSION_ERROR`),
  has not been granted yet.
- `unavailable`: the watch's `HealthTrackerCapability` does not list
  `PPG_CONTINUOUS` (non–Galaxy Watch 4+ hardware), or the Samsung Health app is
  missing/outdated (`HealthTrackerException`).
- `error`: an SDK policy error or other tracker failure after a successful connection.