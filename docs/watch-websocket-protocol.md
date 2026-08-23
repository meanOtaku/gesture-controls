# Galaxy Watch WebSocket protocol

The desktop listens on `ws://DESKTOP_IP:8766/ws/watch` on the local network. Only one watch connection is accepted at a time. The desktop disconnects a silent client after three seconds.

## Local discovery

After the listener starts, the desktop advertises a DNS-SD service as
`_gesture-controls._tcp.local.`. Its TXT metadata is `protocol=ws`,
`path=/ws/watch`, and `version=1`; the advertised port is the listener's actual
bound port. The Wear OS app browses and resolves this service with Android's
`NsdManager`, then connects to the resolved `ws://HOST:PORT/ws/watch` endpoint.

Discovery is bidirectional. While open, the Wear OS app also advertises a
`_gesture-watch._tcp.local.` pairing service. The desktop browses that service,
opens its local `/pair` endpoint, and the watch uses the request's source address
to connect back to the desktop WebSocket automatically. This avoids typing either
device's IP address. Both mechanisms remain local multicast only: the watch and
desktop must share a Wi-Fi/LAN and client isolation, guest networks, VLAN
boundaries, or multicast-blocking routers can prevent pairing.

## Watch messages

All messages are UTF-8 JSON with the required envelope fields `type`, `version` (`1`), `deviceId`, `sequence`, `timestampNs`, and `payload`. `timestampNs` is the watch monotonic-clock timestamp. Sequences must increase across a connection.

`watch.orientation` carries a quaternion and optional accelerometer and gyroscope vectors:

```json
{"type":"watch.orientation","version":1,"deviceId":"galaxy-watch-4","sequence":1,"timestampNs":123,"payload":{"quaternion":[1,0,0,0],"accelerometer":[0,0,9.81],"gyroscope":[0,0,0]}}
```

`watch.heartbeat` carries an optional `batteryPercent` value. Send it at least once every three seconds, including while no IMU samples are available.

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