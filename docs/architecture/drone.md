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
| `crates/drone-link/src/vision.rs` | JPEG decoding, image motion and the reference-frame tracker |
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
| `drone_heartbeat` | The page saying it is still open, with what its Climb, Descend and steering buttons ask for |
| `drone_set_hold` | Calibrates and starts hold, or stops it |
| `drone_set_headless` | Turns headless mode on or off. It reaches the drone only while armed, and Stop turns it off |
| `drone_set_return` | Starts the one-key return, only once taken off, or cancels it. Ends hold |
| `drone_reset_drift` | Makes the current view the centre |
| `drone_frame` | Waits up to 500 ms for a frame newer than the one shown, then returns its number and the JPEG |

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
| Return sent for at most | 10 s | `PilotConfig::return_limit` |
| Correction dropped after | 300 ms | `PilotConfig::correction_stale_after` |
| Hold gains | P 0.5, I 0.08, D 0.4, in calibration pushes, gentle so the drone's IMU leads | `HoldConfig` |
| Hold after takeoff | 3 s after Up, giving up at 10 s | `AUTO_HOLD_AFTER`, `AUTO_HOLD_GIVE_UP` in `link.rs` |
| Trim | ±20 steps on aileron, elevator and rudder | `MAX_TRIM` in `drone.rs` |
| Largest correction | 12 steps | `HoldConfig::max_correction` |
| Calibration push | 12 steps for 0.6 s each way, 0.5 s settling | `HoldConfig` |
| Least response to a push | 0.8 pixels, 0.4% zoom | `HoldConfig` |
| Hold gives up without a picture | 1 s | `HoldConfig::picture_lost_after` |
| Height button | ±30 steps, at most ±40 | `HEIGHT_RATE` in `DronePage.tsx`, `MAX_HEIGHT_RATE` in `drone.rs` |
| Steering button and arrow key | ±25 steps, at most ±30 | `NUDGE` in `DronePage.tsx`, `MAX_NUDGE` in `drone.rs` |
| Steady picture before test pushes | 2 s | `HoldConfig::steady_before_pushing` |
| Break that ends test pushes | One untrusted frame, or 250 ms | `HoldConfig::probe_gap` |
| Wrist dead zone, full tilt | 8°, 35° | `SteeringConfig` |
| Ask again for a frame stuck partway | 15 ms | `REPEAT_REQUEST_AFTER` in `link.rs` |
| Give up on a video frame | 500 ms | `SKIP_FRAME_AFTER` in `link.rs` |
| Restart video after silence | 1 s | `RESTART_VIDEO_AFTER` in `link.rs` |
| Least tracking agreement | 25% | `vision::MIN_CONFIDENCE` |

The gains were tuned in simulation only, and not on the drone.

## Flight recordings

Arming starts a recording of every control frame, in `drone-flights/flight-<date>-<time>.csv` in the app's data folder. The page
shows the path. Each row has the time, sticks, flags, hold phase, picture movement, confidence, drift and correction. These files
are how hold gets tuned, and they can feed the simulator's physics with real numbers.

**Unknown packets.** Anything the drone sends that is neither video nor the firmware name, on either port, is appended to
`drone-unknown-packets.txt` in the app's data folder: one `# session` line per connection, then one line per packet with the
time, port, length and hex bytes, up to 200 a session. The page counts them. The DM002HW has sent none so far; one appearing
would be the first sign of status or sensor data. A status message is read too: the page then shows the drone's own fly
state, raw battery number, speed and headless, and the file marks its line `status`.

## Connecting

When this computer joins the drone's Wi-Fi, the app opens a session by itself within about a second. It checks by asking
the system for a route to the drone, which sends nothing. A drone that does not answer is tried again every 5 seconds.

Auto-connect only opens a session. It never arms or takes off. Disconnect holds until you choose Connect or leave the Wi-Fi,
and leaving the Wi-Fi closes the link.

The watch must use Bluetooth, because the computer's Wi-Fi is taken by the drone. Internet needs another connection.

## Camera hold

The aim is that a person only takes off. The drone's own takeoff sets the height and its altitude hold keeps it, and hold keeps
the other two axes.

**Two loops.** The drone's IMU runs the fast inner loop on board: it keeps the drone level and at height many times a second.
The app cannot read the IMU, because the drone sends no telemetry. So the camera loop is a slow, gentle outer loop that only
leans against drift, and **trim** removes any steady lean so the inner loop has less to fight.

**After takeoff**, if **Hold position after takeoff** is on and a measurement is saved, the app waits 3 seconds for the drone's
own climb to settle, then holds that spot with the saved measurement and no test pushes. It needs a steady picture, tries until
10 seconds after takeoff, and runs once per takeoff. Steering by hand ends it.

**The saved measurement** comes from the first time **Hold position** finishes its test pushes, and is kept in
`drone-hold-calibration.txt` in the app's data folder. Its sign belongs to the drone and is reliable. Its size depends on the
distance to the scene, so it is only roughly right elsewhere; in simulation, a measurement taken 1 to 4 m from the scene and
reused at 1 to 4 m held within 0.3 m. A damaged file is ignored.

**Measuring movement** works like a mouse's optical sensor, using the drone's own camera.

1. Each frame is shrunk to 160 × 90 greyscale.
2. Fifteen patches of a saved **reference frame** are searched for in each new frame, ±10 pixels around where they are
   expected, ignoring brightness changes.
3. The median of the patches that agree gives sideways and vertical movement, and their spread gives zoom.
4. The reference is replaced when the view moves more than 30 pixels or 15% zoom from it, or cannot be found. The movement
   since the last frame then comes from the frame before.

Comparing with one fixed frame matters because adding up movement between neighbouring frames adds up their errors too, so a
still drone appears to creep. Against a reference, it does not. On captured frames of a still drone, false movement over 10
seconds fell about threefold, as below.

| False movement over 10 s, on average | Adding up frames | Against a reference | At 2 m |
| --- | --- | --- | --- |
| Sideways | 1.63 px | 0.51 px | 2.9 cm to 0.9 cm |
| Zoom, for forward and back | 0.051 | 0.018 | 10 cm to 3.5 cm |

These are from a small bench sample in one dim scene, with the drone still. Flight will be worse.

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
| Grows or shrinks | Flying forward or back | Steers elevator. The faintest signal, but tilting and turning barely change it |
| Slides up or down | Climbing, or tilting | Nothing: the drone holds its own height |

**Trim** shifts aileron, elevator and rudder by a few steps for the whole flight, as the phone app's trim does. It is
remembered on the page and sent with every heartbeat.

**Height** comes from the **Climb** and **Descend** buttons, which work while holding. They move only the throttle, and are sent
with every heartbeat, so a stuck button or frozen page cannot keep the drone climbing.

**Steering by hand** uses the Left, Right, Forward and Back buttons or the arrow keys. It is sent the same way and ends hold at
once, so a person always wins over the autopilot. Which way each goes has not been checked, so the page can reverse either axis,
and remembers it.

**Hold only starts once flying**, after Take off, and only when the picture has been trusted for 2 seconds without a break.
During the test pushes, a single untrusted frame stops them. In the first flights, pushes on a poor picture moved the drone
into something.

### Simulated flights

`crates/drone-link/tests/hold_flight.rs` flies the autopilot in a simulated room with video delay, noise, a steady lean and
gusts. Across 270 combinations of scene distance, drone response, drag, lean and stick direction, hold stayed within 1 m in 182
and refused in 88. It never ran away. Refusals rise with distance, because a far wall gives a weaker signal.

The physics are estimates, not measurements of the real drone. This shows the loop is stable across a wide range and fails safely.
It does not show how well it will hold on the real drone.

### What to expect

On the bench, with the drone still, frame-to-frame movement had a median of 0.02 pixels and 99% of frames stayed under 0.26. Decoding
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
| Arming, Up, Down and Stop from the Rust link | **Yes**, in the first flights. What Stop did was not recorded | Yes |
| Auto-connect | **No** | Policy only |
| Stop (`44`) | **Never sent** | Yes |
| Gyro calibration (`c0`) | **Never sent** | Yes |
| Firmware name in the app | **No**: the reply was read by hand earlier | Yes |
| Stick movement | **Never sent** | Yes |
| Calibration and hold reaching the sticks | **Yes, once**: pushes ran on a poor picture and the drone hit something, which led to the steady-picture rule | Yes, in simulated flights |
| Video in flight | Dropouts of 1 to 8 s, about every 10 to 20 s, after the freeze was fixed | Yes |
| Manual steering | **No** | Yes |
| Height buttons | **No** | Yes |
| Flight recording | **No** | Yes |
| Which way tilt pushes the drone | **Unknown** | Calibration measures this for hold |
| What the drone does when commands stop | **Unknown** | |
| Flights with the props on | Five on 2026-11-07, one ending in a collision | |

## Next steps, in order

Each stage needs a person's go before anything is sent to the drone.

1. **Check the drone** after the collision: props, motors, frame and battery. Calibrate its gyro on a flat surface.
2. **Manual flight, hold off.** Open space, a metre or more from anything, low and short. Nudge each way gently to learn the
   directions, and reverse an axis if needed. Watch the video rate and restarts count.
3. **Phone app video in flight.** If the phone's video also drops out, the drone's Wi-Fi is the limit, and camera hold is not
   workable on this drone without another sensor.
4. **Lost-link test, props off.** With the motors running, stop sending and time what the drone does.
5. **Hold in flight**, only if video stays steady. In good light, facing a detailed scene, a metre clear all round.
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
| `cargo run --release -p drone-link --example flow_frames -- <folder>` | Measure tracking noise on saved frames, with and without a reference | Nothing |

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
| Video lags but frames a second is about 15 | Before this was fixed the page checked for frames every 60 ms; it now shows each as soon as it is decoded. If it still lags, the delay is in the drone's camera, which cannot be measured |
| Video freezes for seconds in flight | Likely radio noise from the motors losing pieces of frames. Check whether the phone app's video freezes too |
| Picture is very dark | The camera is dim indoors. The app brightens the display, not the measurement |
