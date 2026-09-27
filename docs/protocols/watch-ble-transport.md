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
