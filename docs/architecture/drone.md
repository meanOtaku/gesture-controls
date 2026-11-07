# Drone control

How the desktop flies a Wi-Fi toy drone: what exists, how it fits together, what has been tested, and what to do next.
The goal is a demonstration: a person moves a hovering drone from one point to another with a watch gesture.

- The bytes on the wire: [WIFI UAV drone protocol](../protocols/wifi-uav-drone.md)
- The rules that keep it safe: [Safety §7](safety-and-fail-closed-behavior.md#7-the-drone)
- How to use it: [Using the application](../using-the-application.md)

## The drone

A DM002HW, a small toy quadcopter with brushed motors that pairs with the WIFI UAV phone app.

| Fact | Value |
| --- | --- |
| Firmware | `(NOFLOW)FLOW_720P_V1.4.17_20250520`, shown on the Drone page. `NOFLOW`, against `FLOW` on a related drone, suggests no optical flow |
| Wi-Fi | Open access point, 2.4 GHz, channel 4 when last checked, at `192.168.169.1` |
| Camera | Front-facing, 640 × 360, about 15 frames a second, JPEG |
| Reports back | Video and a firmware name. No battery, height, attitude or acknowledgement seen |
| Height | Probably held by the drone: the app's throttle self-centres. Unconfirmed in flight |
| Position | Not held. It drifts, and that is what camera hold is for |

## How it fits together

```text
 watch ──orientation, button──┐
                              ▼
 Drone page ──commands,   desktop drone.rs ──sticks──► Pilot ──► Link thread ──20 Hz UDP──► drone
             heartbeat──►  (DroneRuntime)                ▲                                    │
                              ▲                          │ corrections                        │ video
                              │ network check         Hold                                    │
                     drone-network thread                ▲                                    ▼
                                                      Vision thread ◄── JPEG frames ◄── Link thread
```

- **`Pilot`** decides what may be sent. Nothing reaches the drone except through it.
- **`Autopilot`** measures the drone, then works out corrections. It only ever suggests: the `Pilot` decides whether they are used.
- **Link thread** sends one frame every 50 ms, and asks for video in each.
- **Vision thread** decodes frames and measures movement. It drops frames rather than queueing them, and it can never
  delay a command.
- **`drone-network` thread** checks each second whether this computer is on the drone's Wi-Fi.

## Code map

| Where | What |
| --- | --- |
| `crates/drone-link/src/frame.rs` | The wire format: control frames, opening frames, video reassembly |
| `crates/drone-link/src/pilot.rs` | Arming, button presses, stick limits, the failsafe |
| `crates/drone-link/src/link.rs` | The session, the 20 Hz sender, the vision thread, detecting the drone's network |
| `crates/drone-link/src/vision.rs` | JPEG decoding and image motion |
| `crates/drone-link/src/hold.rs` | The autopilot: calibration and the PID loops |
| `crates/drone-link/src/flight_log.rs` | The flight recorder |
| `crates/drone-link/src/steering.rs` | Turning wrist tilt into sticks |
| `crates/drone-link/src/jpeg_header.bin` | The quality 50 JPEG header the drone's video leaves off |
| `apps/desktop/src-tauri/src/drone.rs` | `DroneRuntime`, auto-connect, and the Tauri commands |
| `apps/desktop/src/features/drone/DronePage.tsx` | The Drone page, live view and heartbeat |
| `apps/desktop/src/features/drone/droneStatus.ts` | Shared status for the top and bottom bars and the telemetry panel |

### Commands

| Command | Does |
| --- | --- |
| `get_drone_state` | The current `DroneState` |
| `drone_connect`, `drone_disconnect` | Opens or closes the link. Disconnect also stops auto-connect until the network changes |
| `drone_arm` | Allows flight, if video is moving and the watch or page is checking in |
| `drone_take_off`, `drone_land`, `drone_stop` | Presses Up, Down or Stop |
| `drone_calibrate_gyro` | Presses GyroCheck. Refused while armed |
| `drone_heartbeat` | The page saying it is still open, with how hard Climb or Descend is held |
| `drone_set_hold` | Calibrates and starts hold, or stops it |
| `drone_reset_drift` | Makes the current view the centre |
| `drone_frame` | The newest video frame, as its number and then a JPEG |

### Settings in the code

There is no settings screen yet. These are the values to change while tuning.

| Value | Default | In |
| --- | --- | --- |
| Tilt and yaw stick limit | ±38 | `PilotConfig::stick_limit` |
| Throttle limit | ±64 | `PilotConfig::throttle_limit` |
| Sticks centre after silence | 200 ms | `PilotConfig::stale_after` |
| Land after silence | 1 s | `PilotConfig::land_after` |
| Up and Down held for | 1.1 s | `PilotConfig::press_hold` |
| Stop held for | 0.5 s | `PilotConfig::stop_hold` |
| Correction dropped after | 300 ms | `PilotConfig::correction_stale_after` |
| Hold gains | P 0.8, I 0.15, D 0.5, in calibration pushes | `HoldConfig` |
| Largest correction | 12 steps | `HoldConfig::max_correction` |
| Calibration push | 12 steps for 0.6 s each way, 0.5 s settling | `HoldConfig` |
| Least response to a push | 0.8 pixels, 0.4% zoom | `HoldConfig` |
| Hold gives up without a picture | 1 s | `HoldConfig::picture_lost_after` |
| Height button | ±30 steps, at most ±40 | `HEIGHT_RATE` in `DronePage.tsx`, `MAX_HEIGHT_RATE` in `drone.rs` |
| Wrist dead zone, full tilt | 8°, 35° | `SteeringConfig` |
| Give up on a video frame | 200 ms | `SKIP_FRAME_AFTER` in `link.rs` |
| Least tracking agreement | 25% | `vision::MIN_CONFIDENCE` |

The gains were tuned in simulation only, and not on the drone.

## Flight recordings

Arming starts a recording of every control frame, in `drone-flights/flight-<date>-<time>.csv` in the app's data folder. The page
shows the path. Each row has the time, sticks, flags, hold phase, picture movement, confidence, drift and correction. These files
are how hold gets tuned, and they can feed the simulator's physics with real numbers.

## Connecting

When this computer joins the drone's Wi-Fi, the app opens a session by itself within about a second. It checks by asking
the system for a route to the drone, which sends nothing. A drone that does not answer is tried again every 5 seconds.

Auto-connect only opens a session. It never arms or takes off. Disconnect holds until you choose Connect or leave the Wi-Fi,
and leaving the Wi-Fi closes the link.

The watch must use Bluetooth, because the computer's Wi-Fi is taken by the drone. Internet needs another connection.

## Camera hold

The aim is that a person only sets the height. The drone keeps its own height, and hold keeps the other two axes.

**Measuring movement** works like a mouse's optical sensor, using the drone's own camera.

1. Each frame is shrunk to 160 × 90 greyscale.
2. Fifteen patches are searched for in the next frame, ±10 pixels, ignoring brightness changes.
3. The median of the patches that agree gives sideways and vertical movement, and their spread gives zoom.

**Calibrating** happens every time hold starts, and takes about nine seconds. Which way a stick moves the picture, and how far,
depends on the drone and on how far away the scene is, so neither is assumed. For each axis the autopilot pushes one way, stops,
then pushes the other way, and takes the difference. Steady drift is the same in both, so it cancels. Measuring one push alone
was tried first: in simulation, a drifting drone read as the wrong direction and hold flew it 44 m away.

If a push shows no clear change, or drift swamps it, hold refuses and centres the sticks. So calibration also proves the drone
is flying and can see something, and a drone sitting on a table cannot pass.

**Holding** is a PID loop on each axis, scaled by what calibration measured, so it behaves the same near a wall or far from one.

| Picture does | Could mean | Hold does |
| --- | --- | --- |
| Slides sideways | Drifting sideways, or turning | Steers aileron |
| Grows or shrinks | Flying forward or back | Steers elevator |
| Slides up or down | Climbing, or tilting | Nothing: the drone holds its own height |

**Height** comes from the **Climb** and **Descend** buttons, which work while holding. They move only the throttle, and are sent
with every heartbeat, so a stuck button or frozen page cannot keep the drone climbing.

### Simulated flights

`crates/drone-link/tests/hold_flight.rs` flies the autopilot in a simulated room with video delay, noise, a steady lean and
gusts. Across 270 combinations of scene distance, drone response, drag, lean and stick direction, hold stayed within 1 m in 184
and refused in 86. It never ran away. Refusals rise with distance, because a far wall gives a weaker signal.

The physics are estimates, not measurements of the real drone. This shows the loop is stable across a wide range and fails safely.
It does not show how well it will hold on the real drone.

### What to expect

On the bench, with the drone still, measured movement had a median of 0.02 pixels and 99% of frames stayed under 0.26. Decoding
takes about 1 ms and measuring about 2 ms. Vibration in flight will make the noise worse, by an unknown amount.

A forward camera cannot lock a position the way a downward sensor can, and calibration does not change that:

- It cannot tell a drift from a turn, or a climb from a tilt, and the drone reports no attitude to separate them.
- It does not know how far away the scene is, so the same picture shift means different real distances.
- It needs light and detail. A plain wall gives nothing to follow, and people walking past look like movement.

Holding within about a metre is an estimate, not a measurement. If that is not enough, a cheap downward optical-flow sensor or
a fixed external camera would do better.

## What has been tested

| What | Real drone | Stand-in or unit tests |
| --- | --- | --- |
| Session and idle frames, in Rust | Yes | Yes |
| Live video and tracking in the app | Yes: about 16 frames a second, 0 damaged, 3% skipped, 53% agreement | Yes |
| Carrying the drone moves the marker, and it returns | Yes, seen by eye | |
| Up starts the motors | Python script only, props off | Yes |
| Down stops the motors | Python script only, props off, on the bench | Yes |
| Arming, Up and Down from the Rust link | **No** | Yes |
| Auto-connect | **No** | Policy only |
| Stop (`44`) | **Never sent** | Yes |
| Gyro calibration (`c0`) | **Never sent** | Yes |
| Firmware name in the app | **No**: the reply was read by hand earlier | Yes |
| Stick movement | **Never sent** | Yes |
| Calibration and hold reaching the sticks | **No** | Yes, in simulated flights |
| Height buttons | **No** | Yes |
| Flight recording | **No** | Yes |
| Which way tilt pushes the drone | **Unknown** | Calibration measures this for hold |
| What the drone does when commands stop | **Unknown** | |
| Any flight with the props on | **None** | |

## Next steps, in order

Each stage needs a person's go before anything is sent to the drone.

1. **Motors from the app, props off.** Secure the drone, then Arm, Take off and Land, with the battery switch in reach. Check
   a recording appears. **Hold position** should refuse with "no clear change", which proves that safety on real hardware.
2. **Lost-link test, props off.** With the motors running, stop sending and time what the drone does. This decides how much a
   dropped link matters, and nothing else can answer it.
3. **First flight, props on.** Open space, low and short. Take off, try Climb and Descend, then Land. Learn what Down does in the air.
4. **Hold in flight.** In good light, facing a detailed scene, take off and choose **Hold position**. Be ready to land while it
   makes its test pushes.
5. **Tune from recordings.** Put real numbers into the simulator, then adjust the gains.
6. **One-button hover.** Start hold by itself after takeoff, once it has proven reliable.
7. **Watch control.** Let the watch move the point being held.

## Tools

| Tool | Use | Sends |
| --- | --- | --- |
| `scripts/drone_probe.py` | Check a drone answers | Start packets only |
| `scripts/drone_neutral_test.py` | Check the drone reads our frames | Idle frames |
| `scripts/drone_motor_test.py --props-off` | Start and stop the motors | Up, Down, Stop |
| `scripts/drone_stick_test.py --props-off` | Move each axis in turn | Up, sticks, Down |
| `cargo run -p drone-link --example drone_check` | Check the Rust link | Idle frames, never arms |
| `cargo run --release -p drone-link --example flow_frames -- <folder>` | Measure tracking noise on saved frames | Nothing |

Those that talk to the drone refuse to run unless the computer is on its network, and the Python motor and stick tools send
Down then Stop on Ctrl-C. Press Ctrl-C once only: a second press cuts that sequence short.

## Finding out more about the drone

**Capture the phone app.** The drone's Wi-Fi is open, so a Mac can record the phone's traffic over the air. In Wireless
Diagnostics, open Window → Sniffer, set the drone's channel and 20 MHz, and start before opening the app. Do one action at a
time, 5 seconds apart, and note the order. PCAPdroid on Android stopped the app from working, probably through its VPN.

The capture also holds the phone's unrelated traffic, so keep it out of the repository.

**Read the app.** The app is `com.lcfld.fldpublic`. `jadx` decompiles it well. The control frame is built in `defpackage.qx`,
its fields are set in `ActCtrlN`, and native code in `libuav_lib.so` handles sending and video. These names belong to version
2026.09.17 and can change.

**Run the tests without a drone.** `crates/drone-link/tests/link.rs` has a stand-in drone that behaves as the real one did.

## Troubleshooting

| You see | Likely cause |
| --- | --- |
| "Waiting for the drone's Wi-Fi" | This computer is not on it, or the drone is off |
| "No answer from the drone" | The drone stopped responding. Power-cycle it. Early tools found it could need that after a bad session |
| Connected, but no video | The phone may still be connected to the drone. Disconnect it |
| Arm is disabled | Video has not reached frame 5, or the page is not open |
| Drone told to land by itself | Nothing checked in for a second, usually from leaving the Drone page |
| Hold says "no clear change" | The drone is not flying, or the scene is too plain or far away |
| Hold says it is drifting too much | The drone is too unsteady to measure. Land, choose **Calibrate gyro** on a flat surface, and try again |
| Marker is red | The view is too dark or plain to follow. Add light, or face something with detail |
| Video lags but frames a second is about 15 | The link is fine, and the delay is in the display |
| Picture is very dark | The camera is dim indoors. The app brightens the display, not the measurement |
