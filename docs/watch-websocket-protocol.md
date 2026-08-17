# Galaxy Watch WebSocket protocol

The desktop listens on `ws://DESKTOP_IP:8766/ws/watch` on the local network. Only one watch connection is accepted at a time. The desktop disconnects a silent client after three seconds.

## Watch messages

All messages are UTF-8 JSON with the required envelope fields `type`, `version` (`1`), `deviceId`, `sequence`, `timestampNs`, and `payload`. `timestampNs` is the watch monotonic-clock timestamp. Sequences must increase across a connection.

`watch.orientation` carries a quaternion and optional accelerometer and gyroscope vectors:

```json
{"type":"watch.orientation","version":1,"deviceId":"galaxy-watch-4","sequence":1,"timestampNs":123,"payload":{"quaternion":[1,0,0,0],"accelerometer":[0,0,9.81],"gyroscope":[0,0,0]}}
```

`watch.heartbeat` carries an optional `batteryPercent` value. Send it at least once every three seconds, including while no IMU samples are available.

## Time synchronization

The desktop sends `desktop.time_sync` every five seconds. Echo its `payload.desktopTimeNs` immediately in a `watch.time_sync` message and add the current watch monotonic time as `payload.watchTimeNs`. The desktop calculates round-trip latency and uses the median of its latest five offset samples.

```json
{"type":"watch.time_sync","version":1,"deviceId":"galaxy-watch-4","sequence":2,"timestampNs":124,"payload":{"desktopTimeNs":456,"watchTimeNs":124}}
```

The watch should also handle the initial `desktop.connected` acknowledgement, which contains the session identifier and desktop timestamp.