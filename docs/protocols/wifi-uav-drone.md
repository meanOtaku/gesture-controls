# WIFI UAV drone protocol

How the desktop talks to a Wi-Fi toy drone that pairs with the WIFI UAV phone app, as implemented in
[`crates/drone-link`](../../crates/drone-link). Worked out on a DM002HW, firmware
`(NOFLOW)FLOW_720P_V1.4.17_20250520`, from an over-the-air capture of the phone app, the decompiled app
(`com.lcfld.fldpublic` 2026.09.17) and bench tests with the props off.

Each fact is marked **tested** (seen working on the drone), **captured** (in the phone app's traffic) or **app code**
(read from the decompiled app, not yet tried).

[reversing-wifi-uav](https://github.com/FahrulRPutra/reversing-wifi-uav) documents an older drone in the same family.
Its frame container matches, but its 20-byte control record does not work here.

## Transport

- The drone is an open Wi-Fi access point on 2.4 GHz at `192.168.169.1`. Clients get `192.168.169.2` and up. **Tested**
- Control goes to UDP port 8800, and video returns from port 1234 to the sender's port. **Tested**
- The app sends one control frame every 50 ms. **App code**, matching the capture.

## Opening a session

1. Send `ef 00 04 00` to port 8800, and from a second socket to port 8801. Wait 100 ms and send it to 8800 again.
2. Frame 1 of the video arrives, with no acknowledgement so far.
3. Send an empty 88-byte frame, the 108-byte setup frame, and an empty frame, about 27 ms apart.
4. Send the start packet to 8801 again, then a 124-byte frame with an empty control area that requests frame 2.
5. From here, send control frames.

Tested as a whole. Without step 3 onward the drone resends frame 1 and goes silent until it is power-cycled.

`ef 20 06 00 01 65` asks for the firmware name, which arrives as a `93 04` packet. **Tested**

## Control frame

Little-endian. Bytes not listed are zero.

| Offset | Value |
| --- | --- |
| 0 | `ef 02` |
| 2 | Frame length as `u16`: 88, 108 or 124 |
| 4 | `02 02 00 01` |
| 8 | Number of records after the base as `u32`: 0, 1 or 2 |
| 12 | Frame counter as `u16` |
| 16 | `08 00 66`: the control record's header |
| 19 | Aileron, elevator, throttle and rudder, one byte each, centred on `80` |
| 23 | Flags |
| 24 | Checksum: the XOR of bytes 19 to 23 |
| 25 | `99` |
| 82 | `32 4b 14 2d 00 00` |
| 88 | Video frame received as `u32`, in a 124-byte frame |
| 96 | `01 00 00 00 14 00 00 00 ff ff ff ff` |
| 108 | Next video frame wanted as `u32` |
| 116 | `03 00 00 00 10 00 00 00` |

Byte-identical to 1,292 of the 1,340 captured 124-byte frames with this control record. The rest fail these fixed-byte
checks, and those inspected were damaged in the air.

The 108-byte setup frame has `1` at offset 8 and these records at 88: `01 00 00 00`, eight zero bytes, `14 00 00 00`,
`00 00 fe ff`.

### Flags

The app holds Up and Down for about 1.1 s. Bit names are the app's.

| Bit | Name | Status |
| --- | --- | --- |
| `01` | Up | **Tested**: started the motors |
| `02` | Down | **Tested**: stopped the motors on the bench. Effect in the air unknown |
| `04` | Stop | **Captured**: presumably the emergency cut. Never sent by us |
| `08` | Roll | **App code**: presumably a flip |
| `10` | Headless | **App code** |
| `20` | Back | **App code**: off in the UAV control screen |
| `40` | Hl | **Captured**: always set in the UAV control screen. It makes throttle self-centring, which suggests altitude hold |
| `80` | GyroCheck | **App code**: gyro calibration |

### Sticks

App stick positions are scaled before sending. **App code**

- Aileron, elevator and rudder use the speed setting: 30%, 60% or 100%. The app starts at 30%, about ±38.
- Throttle always uses its full range.
- Trim adds up to ±31.

Which way each axis moves the drone is not known yet.

## Video

Parts of up to 1,080 bytes, with a 56-byte header. **Tested**

| Offset | Value |
| --- | --- |
| 0 | `93 01` |
| 2 | Packet length as `u16` |
| 16 | Frame number as `u32` |
| 32 | Part number as `u32` |
| 36 | Parts in the frame as `u32` |
| 40 | Frame size as `u32` |
| 44 | Width and height as `u16`: 640 × 360 |

The drone sends the next frame only when asked, and resends one that is asked for again. The body has no JPEG or H.264
markers. An issue on the reversing repo reports headerless JPEG, which is unconfirmed here.

Video nearly stops while the motors run, so it is not a sign of link health.

## What is not known

- **What the drone does when frames stop.** No code on the phone can answer this, so it decides how safe a lost link is.
- What Down does in the air: a landing or a motor cut.
- Stick directions, and whether Stop works as expected.
- Telemetry. The app can parse a `88 … 55` status message with fly state and battery, but none appeared in the capture.
