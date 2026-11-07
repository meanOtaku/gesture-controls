# WIFI UAV drone protocol

Every code the desktop uses to talk to the drone. How the system around it works is in
[Drone control](../architecture/drone.md).

How the desktop talks to a Wi-Fi toy drone that pairs with the WIFI UAV phone app, as implemented in
[`crates/drone-link`](../../crates/drone-link). Worked out on a DM002HW, firmware
`(NOFLOW)FLOW_720P_V1.4.17_20250520`, from an over-the-air capture of the phone app, the decompiled app
(`com.lcfld.fldpublic` 2026.09.17) and bench tests with the props off.

Each fact is marked **tested** (seen working on the drone), **captured** (in the phone app's traffic) or **app code**
(read from the decompiled app, not yet tried).

[reversing-wifi-uav](https://github.com/FahrulRPutra/reversing-wifi-uav) documents an older drone in the same family.
Its frame container matches, but its 20-byte control record does not work here.

## Packets at a glance

| Direction | Port | Starts | Length | What |
| --- | --- | --- | --- | --- |
| To drone | 8800, 8801 | `ef 00 04 00` | 4 | Start video |
| To drone | 8800 | `ef 02 58 00` | 88 | Control |
| To drone | 8800 | `ef 02 6c 00` | 108 | Control with a setup record |
| To drone | 8800 | `ef 02 7c 00` | 124 | Control that also requests video |
| To drone | 8800 | `ef 02 80 00` | 128 | Seen in the capture, purpose unknown |
| To drone | 8800 | `ef 20 06 00 01 65` | 6 | Ask for the firmware name |
| To drone | 8800 | `ef 20 19 00 01 67` | 25 | Text command |
| From drone | 1234 | `93 01` | Up to 1,080 | Video part |
| From drone | 1234 | `93 04` | Varies | Text reply |

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

`ef 20 06 00 01 65` asks for the firmware name, which arrives as a `93 04` packet. **Tested** Bytes 12 and 13 of the reply are
`01 65`, and the name follows as text from byte 14.

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

A frame with no control has zeros from offset 12 to 81. The phone app alternates 88-byte and 124-byte frames, and the
desktop sends only 124-byte ones, which the drone accepts.

### Flags

The app holds Up and Down for about 1.1 s, and Stop for about 0.3 s. Bit names are the app's. As bytes, with `Hl` set: idle
`40`, Up `41`, Down `42`, Stop `44`, GyroCheck `c0`.

| Bit | Name | Status |
| --- | --- | --- |
| `01` | Up | **Tested**: started the motors |
| `02` | Down | **Tested**: stopped the motors on the bench. Effect in the air unknown |
| `04` | Stop | **Captured**: presumably the emergency cut. Never sent by us |
| `08` | Roll | **App code**: presumably a flip |
| `10` | Headless | **Captured**: a switch in the app, so the bit stays set in every frame while it is on (`50` for 3 s in the capture). The desktop sends it the same way |
| `20` | Back | **App code**: presumably the advertised one-key return. No control screen ever sets it, so the phone never sends it. Whether it must be held or only pressed is unknown; the desktop holds it for at most 10 s. Never yet tried on the drone |
| `40` | Hl | **Captured**: always set in the UAV control screen. It makes throttle self-centring, which suggests altitude hold |
| `80` | GyroCheck | **Captured**, held about 1.2 s. Gyro calibration by its name. Never sent by us, and the desktop refuses it while armed |

### Sticks

App stick positions are scaled before sending. **App code**

- Aileron, elevator and rudder use the speed setting: 30%, 60% or 100%. The app starts at 30%, about ±38.
- Throttle always uses its full range.
- Trim adds up to ±31.

The app's calculation, with `stick` and `trim` from 0 to 1 and centred on 0.5, and `speed` from 0.3, 0.6 or 1.0:

```text
value = (stick - 0.5) × speed × 255 + 127.5 + (trim - 0.5) × 63
```

A value within 1 of 127.5 becomes exactly `80`. Without `Hl`, throttle is `stick × 255` instead, so it no longer self-centres.

During a flip the app overwrites one axis with `00` or `ff` to pick the direction. **App code**

Which way each axis moves the drone is not known yet.

### Older control record

Some drones in this family use a 20-byte record at offset 18, as in the reversing repo, and the app picks by drone type:

```text
66 14 aileron elevator throttle rudder flags1 flags2 (ten zeros) checksum 99
```

The checksum covers the 16 bytes from aileron on. **The DM002HW ignores this record**: it has the 8-byte one.

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
| 48 | `32`, which is the JPEG quality, 50 |

The drone sends the next frame only when asked, and resends one that is asked for again. A frame is a JPEG body with
its header and end marker left off. Adding the standard quality 50 header gives the picture: 736 of the 858 complete
frames in a capture decoded this way. The rest were damaged, possibly in the capture. The app's native library holds
this header among six of different quality. **Tested** on captured frames.

Frame numbers come from the drone. A client must never count past them: a frame numbered at or below the one acknowledged
is treated as old, so running ahead freezes the picture for good. That happened on the real drone with an early version.

### How the phone app paces video

Measured from both captures: the phone's own capture in the reversing repo, and the over-the-air capture of the user's app
and drone while the motors were off. The desktop follows this.

| | Older app, other drone | User's app, DM002HW |
| --- | --- | --- |
| Control frames | Every 27 ms, alternating 88 and 124 bytes | Every 50 ms, mostly 124 bytes |
| Next frame asked for, after one finishes | About 42 ms later, on the next 124-byte frame | About 43 ms later |
| Drone's answer to a request | About 5 ms to the first part | About 6 ms |
| Whole frames a second | 15.9 | About 17 |
| A frame stuck partway | Asked for again 26 to 31 ms later | Asked for again about 14 ms later |
| Frames given up on | None: every request followed a whole frame | Not measurable over the air |

So the app asks on its regular tick, never immediately, and keeps asking for a stuck frame until it arrives whole. The drone
answers within milliseconds, so the rate is set by how often a client asks. The app's native code sets its control interval
to 50 ms (`nativeSetCtlMsgInterval(50)`). **App code** and **captured**

The desktop sends a control frame every 50 ms, asks again 15 ms after a frame stops arriving partway, and gives up only after
500 ms. After a second of silence, the start packets are sent again.

During the motor stretches of the phone capture, the drone kept sending about 16 frames a second and the phone kept requesting
them, but the Mac recording it heard only 1 or 2 whole frames a second. That may be the Mac missing packets, or real loss from
motor noise. Whether video stays usable in flight is not yet known.

The picture is very dark, averaging about 25 of 255 in a dim room, and the app brightens it for display.

## Text commands

The app sends these after the firmware query. Their meaning is unknown, and the desktop does not send them. **Captured**

```text
ef 20 19 00 01 67 <i=2^bf_ssid=cmd=2>     reply: 93 04 ... 01 67 <e=0>
ef 20 19 00 01 67 <i=2^bf_ssid=cmd=3>     reply: 93 04 ... 01 67 <e=0>
```

## Status message

**App code.** The phone's native library hands every message from the drone to Java with a source byte first: `1` for the
Wi-Fi chip, `0` for the flight controller. The firmware reply shows where that sits on the wire: in a `93 04` packet, byte 12
is the source and byte 13 the type (`01 65`). From the Wi-Fi chip the app knows `65` (firmware name), `67` (Wi-Fi renamed),
`69` (busy) and `6a` (disconnected). From the flight controller it knows only:

| Type | Meaning |
| --- | --- |
| `66` | A remote's button: byte 5 is `02` for photo, `04` for record |
| `71`, `72` | Photo, record |
| `88` | Status |

The status message is `88 00 fly battery flags … xor 55`, at least 7 bytes, where the xor covers every byte from the `00` to
just before itself. Flags: speed (bits 0 and 1), remote control `04`, camera tilt `08`, headless `10`, photo `20`, video `40`,
light `80`. The app reads it but never shows it, so the scale of battery and the meaning of fly state are unknown.

The link looks for a status message in any packet that is not video or the firmware name, wherever it sits, because where a
DM002HW would put one is not known. It shows the numbers raw on the Drone page, and still writes the packet to
`drone-unknown-packets.txt`, marked `status`, so its meaning can be worked out. **Link code.** None has come from the
DM002HW so far.

## Sensor data

**The drone sends no IMU, gyro, attitude or height data.** Three checks agree:

- **App code.** Nothing in the Java code reads sensor values. The only drone data it reads is the status message above.
- **Native code.** `libuav_lib.so` has `handle_mcu_msg_ctlmsg` and `handle_mcu_msg_frag`, so the Wi-Fi module (built for a
  Bouffalo BL618) can forward flight-controller messages, but they reach only the status reader.
- **Captures.** Of 15,579 drone packets, including flights, all were video or text replies. Every changing video-header byte
  is explained: part counts, frame size, byte 49 (part type: 01 first, 00 continuing, 04 resent) and byte 51 (resend count).

The link keeps every packet that is neither video nor the firmware name, from both the control and aux ports, in case a
drone does send status or sensor data. The desktop app appends the first 200 of each session to
`drone-unknown-packets.txt` in its data folder, and the Drone page shows the count. **Link code**

## What is not known

- **What the drone does when frames stop.** No code on the phone can answer this, so it decides how safe a lost link is.
- What Down does in the air: a landing or a motor cut.
- Stick directions, and whether Stop works as expected.
- What `ef 02 80 00` frames and the text commands do.
- Why flags briefly went to `00` with throttle at `00` in the capture.
