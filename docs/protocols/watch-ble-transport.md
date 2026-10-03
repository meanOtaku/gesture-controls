# Galaxy Watch Bluetooth LE transport

The Watch reaches the desktop over one of two transports, selected on the Watch
and mirrored in desktop Settings → Transport. **Bluetooth is the default** — on
a fresh install, and for any install or `settings.json` written before this
transport existed. Wi-Fi remains fully supported and selectable; see
[`watch-websocket-protocol.md`](./watch-websocket-protocol.md).

Exactly one transport is live at a time. Selecting Bluetooth stops the Wi-Fi
WebSocket, its mDNS advertisement and the pairing browser on both sides;
selecting Wi-Fi stops BLE advertising, the GATT server, the scan, and the
notification subscription. Neither is retained in the background, and a failing
Bluetooth transport never silently falls back to Wi-Fi — it reports why.

## Roles

| | Role | Implementation |
|---|---|---|
| Watch | GATT **peripheral** — advertises and runs the GATT server | `apps/watch/.../data/connection/BleGattTransport.kt` |
| Desktop | GATT **central** — scans, connects, subscribes, writes | `crates/watch-bridge/src/ble.rs` (btleplug) |

The roles are this way round because btleplug supports only the central role,
and the central role is what macOS (CoreBluetooth), Windows (WinRT) and Linux
(BlueZ) all expose identically.

## Service and characteristics

| UUID | Purpose |
|---|---|
| `6b1d0001-9f2a-4c7e-9a1b-2f5a7c3e8d41` | Service; the desktop filters its scan on this alone, so it is in the advertisement itself, not the scan response |
| `6b1d0002-9f2a-4c7e-9a1b-2f5a7c3e8d41` | Telemetry, Watch → desktop, `NOTIFY` (+ standard CCCD `2902`) |
| `6b1d0003-9f2a-4c7e-9a1b-2f5a7c3e8d41` | Commands, desktop → Watch, `WRITE` **with response** |

These UUIDs are stable and must never be renumbered or reused.

## Payloads

The bytes carried are the **same UTF-8 JSON envelopes** the WebSocket transport
defines — same `type`, `version`, `deviceId`, `sequence`, `timestampNs`,
`payload` fields, same sequence rules, same desktop commands. Nothing about the
message layer is BLE-specific, so both transports share one decoder
(`handle_inbound`) and one command encoder on the desktop, and one
`WatchLinkManager` on the Watch.

## Device identity

Over BLE the **desktop** decides which device it is talking to. When the scan
finds the watch, the desktop derives a device id from the discovered
peripheral's platform identifier and stamps it onto every inbound envelope,
**replacing** whatever `deviceId` the watch put there. Because of that, the watch
sends the one-character placeholder `w` over BLE instead of its 42-character
install id, and writes orientation floats in their shortest exact form (about
40% fewer bytes per orientation envelope than the previous 17-digit widening);
the watch logs the negotiated MTU and every dropped backlog (`BleGattTransport`):

| Desktop OS | Peripheral identifier | Resulting id (example) |
|---|---|---|
| macOS | CoreBluetooth UUID | `ble-5d3f2b1a-9c4e-4f10-8a6b-1234567890ab` |
| Windows | Bluetooth address | `ble-aa-bb-cc-dd-ee-ff` |
| Linux | BlueZ object path | `ble-org-bluez-hci0-dev-aa-bb-cc-dd-ee-ff` |

The id is lowercased and reduced to `[a-z0-9-]`. It is stable for one physical
watch on one desktop, differs between watches, and is what the desktop's
per-device state (the PPG ordering watermark and the orientation/PPG fusion
identity check) is keyed on. A watch therefore cannot choose or spoof its
identity over BLE. The id is **not** portable across desktops: macOS in
particular assigns each Mac its own identifier for the same watch.

(Over the Wi-Fi transport there is no peripheral, so the desktop uses the
watch's own `deviceId`, a unique per-install value; see the
[WebSocket protocol](./watch-websocket-protocol.md).)

## Time

Every envelope's `timestampNs` is on the watch's
`SystemClock.elapsedRealtimeNanos()` base. Orientation is built from
`SensorEvent.timestamp`, which Android requires to share that base; the watch
verifies this on each orientation event and rebases it if a device's sensor
clock differs. The desktop still never judges freshness against a watch
timestamp (it uses its own receive time), and a clock offset estimate from
`watch.time_sync` is displayed but never applied to samples.

## Framing

A GATT notification or write carries at most `MTU - 3` bytes — 20 with the
default 23-byte MTU — far less than a PPG batch, so every envelope is
fragmented:

```
[flags: u8][fragment index: u16 big-endian][chunk…]
```

* `flags` bit 0 set marks the **final** fragment of an envelope.
* Fragment indexes start at 0 and increase by one. A gap or reorder discards the
  partial buffer: a truncated envelope is never delivered as if complete. An
  index of 0 after a desync starts a fresh envelope, so a peer that abandoned a
  message mid-way resynchronizes on its next one.
* A reassembled envelope is bounded at **16 KiB**; anything larger is dropped.
  The largest real message (a 32-sample batch) is a few KB.

Both sides size fragments from the negotiated MTU (`onMtuChanged` on the Watch,
`Peripheral::mtu()` on the desktop), never dropping below the 20-byte guarantee.

### Backpressure

* **Watch → desktop:** BLE allows one outstanding notification per connection.
  Fragments queue and drain on `onNotificationSent`. The queue is bounded
  (512 fragments, ~2 s of 50 Hz orientation at the default MTU); past that the
  oldest frames are dropped, because stale motion is worthless. A notification
  the stack refuses discards the rest of that envelope rather than sending a
  hole.
* **Desktop → Watch:** commands use write-*with-response*, so each fragment is
  acknowledged before the next is written.

## Trust model

Two gates, both required before a single telemetry byte leaves the Watch:

1. **OS bonding / link encryption.** Both characteristics and the telemetry CCCD
   are declared with `PERMISSION_*_ENCRYPTED`, so Android's stack refuses
   subscription and command writes until the devices are bonded and the link is
   encrypted.
2. **Explicit app-level trust.** BLE "Just Works" bonding authenticates nothing,
   so bonding alone would let any nearby machine drive the Watch. The first
   central to connect is held pending until the user taps **Trust this
   computer** on the Watch, which shows the central's address. The approved
   address is persisted, so later reconnects are silent; **Forget trusted
   computer** revokes it and drops the connection.

Until approval the Watch sends nothing and answers command writes with ATT
`GATT_INSUFFICIENT_AUTHORIZATION` (0x08) — the command is never parsed. The
desktop therefore reports `awaitingWatchTrust`, not "connected", until a first
valid envelope actually arrives: being connected and subscribed is not treated
as a working link.

### Known limitations

* Just Works bonding has no MITM protection. The app-level gate binds a session
  to one approved address; it does not defeat an attacker who can spoof that
  address at bonding time. Bond the two devices in a trusted place.
* Only one central is served at a time; a second connecting device is dropped.
* Address privacy: a desktop with BLE random resolvable addresses may present a
  different address after re-pairing, which requires re-approval on the Watch.

## Discovery

The watch is passive: it advertises the watch service UUID and waits. The advertisement's scan
response also carries a short, stable label under that UUID: the first 4 bytes of a SHA-256 of the
install's device id, as 8 lowercase hex characters (`a1b2c3d4`). The desktop reads it when it
finds the watch and says which one it found, with its signal strength, in the Link health card
and event history (`found watch a1b2c3d4 (signal -52 dBm)`). It is a label for people and logs only;
the id is hashed so it is never broadcast, and nothing is trusted because of it. The trust
gate on the watch is what decides who may stream.

The desktop does all of the connecting: it scans for the service UUID, connects, and waits for the
watch's approval. After a session ends it rescans after 0.5 s (2 s after a failed attempt), and it
keeps looking for a Bluetooth adapter if Bluetooth is off.

## Service Changed and the 30-second disconnect

A bonded macOS central sends the watch a GATT **Service Changed indication** as soon
as it connects, and drops the link 30 s later (`Timed out waiting for indication
response - disconnecting!` in `bluetoothd`) if the watch does not confirm it. A watch
whose only role on the link is GATT *server* had nothing registered to confirm it, so
every session ended after exactly 30 s, about 8 s of rescanning followed, and the
stream was lost each time. The watch now opens a GATT *client* connection back to the
central (`BleGattTransport.openConfirmationClient`) and rediscovers its services when
told they changed, which gives the stack a client to confirm with.

Observed on a Galaxy Watch 4 and a Mac: the first connection after installing the
build still ended at 30 s, the next one received `onServiceChanged` and stayed up for
the whole observation (over 90 s). That is an observation, not a guarantee; the
watch logs `confirmation client state=...` and `central reported Service Changed` so a
recurrence is visible. If it recurs, remove the Mac from the watch's Bluetooth
settings so the pairing is rebuilt.

The watch's `sequence` counter is no longer restarted when the link reports connected
again, because the desktop rejects any sequence at or below the last one it accepted
on the same connection.

## Failure states

The Watch surfaces, without falling back to Wi-Fi: no adapter, Bluetooth off, no
BLE support, no peripheral/advertising support, missing `BLUETOOTH_ADVERTISE` /
`BLUETOOTH_CONNECT` runtime permission (API 31+; API 30 uses the install-time
`BLUETOOTH`/`BLUETOOTH_ADMIN` pair), advertising refused, and awaiting approval.
`BLUETOOTH_SCAN` is deliberately not declared — the Watch only advertises.

The desktop surfaces: no adapter / Bluetooth off / permission denied, no Watch
advertising the service found, connect failure, missing characteristic (Watch
app too old), subscribe failure (usually "not bonded yet"), and awaiting Watch
approval. It retries every 5 s while Bluetooth stays selected.

## Platform support

| Platform | Backend | Status |
|---|---|---|
| macOS | CoreBluetooth | Supported; no extra system packages |
| Windows | WinRT | Supported; no extra system packages |
| Linux | BlueZ over D-Bus | Supported; `libdbus` is vendored by the desktop build, so no system `pkg-config`/`libdbus-1-dev` is needed |

## Hardware validation still required

None of the below can be exercised without a real Galaxy Watch and a desktop
with a BLE adapter:

1. Fresh install shows Bluetooth selected; the Watch advertises and the desktop
   finds it by service UUID.
2. Bonding prompt appears; subscription is refused until bonded.
3. The Watch shows the pending central's address; the desktop stays on
   "awaiting approval" and streams only after **Trust this computer**.
4. Orientation/PPG/medical batches reassemble correctly at the negotiated MTU;
   desktop commands (`set_sensor`, `set_sensor_rate`, haptic, measurement
   start/stop) reach the Watch.
5. Switching to Wi-Fi stops advertising and the GATT server; switching back
   stops mDNS, the pairing listener and the WebSocket. Both survive a restart.
6. Reconnect after range loss, Bluetooth toggled off/on, and Watch app restart.
7. The desktop's device id for the watch has the expected `ble-…` shape on each
   desktop OS, is the same after a reconnect and a Watch app restart, and differs
   for a second watch.
8. On a Watch whose sensor clock is not on the `elapsedRealtimeNanos` base, the
   one-time `SensorCollector` "rebasing orientation timestamps" log line appears;
   on one that is, it never does. (Either outcome is evidence; it is currently
   unknown which applies to the target hardware.)
9. Default-settings Live session: the live PPG window duration shown in Model Lab
   diagnostics (expected roughly 960 ms at the default 1 Hz flush) against the
   model's trained window.
