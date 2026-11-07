#!/usr/bin/env python3
"""Find out what each axis of a DM002HW does, by ear and eye. PROPS OFF ONLY.

Spins the motors with Up, then moves one axis at a time, partway in each direction, and finishes with Down, which
stopped the motors in the motor test. Axis names come from the decompiled WIFI UAV app. Each step prints as it starts,
so the person watching can match motor changes to axes. Up goes out only once video is advancing, and any early exit
sends Down then Stop.
"""

import argparse
import sys

from drone_motor_test import DOWN, MIN_VIDEO_FRAMES, STOP, UP, Flight
from drone_neutral_test import CENTRED, FLAGS_IDLE, NEUTRAL, Session, open_session
from drone_probe import local_address_for, same_network

SWING = 0x40  # Partway: well inside the range the app used, and enough to hear.
HOLD = 1.5
REST = 1.0
AXES = (("aileron", 0), ("elevator", 1), ("throttle", 2), ("rudder", 3))


def moved(axis, value):
    sticks = list(CENTRED)
    sticks[axis] = value
    return tuple(sticks)


def schedule():
    steps = [UP, ("baseline, listen", CENTRED, FLAGS_IDLE, 2.0)]
    for name, axis in AXES:
        steps.append((f"{name} HIGH", moved(axis, NEUTRAL + SWING), FLAGS_IDLE, HOLD))
        steps.append(("centre", CENTRED, FLAGS_IDLE, REST))
        steps.append((f"{name} LOW", moved(axis, NEUTRAL - SWING), FLAGS_IDLE, HOLD))
        steps.append(("centre", CENTRED, FLAGS_IDLE, REST))
    steps.append(DOWN)
    return steps


def fly(session):
    if not open_session(session):
        return False
    flight = Flight(session)
    flight.hold(("idle", CENTRED, FLAGS_IDLE, 1.0))
    if session.completed < MIN_VIDEO_FRAMES:
        print(f"video only reached frame {session.completed}, so the link is not proven: no motors started")
        return False

    finished = False
    try:
        for step in schedule():
            flight.hold(step)
        finished = True
    finally:
        if not finished:
            print("schedule interrupted: sending down, then stop")
            flight.hold(DOWN)
            flight.hold(STOP)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="192.168.169.1")
    parser.add_argument("--control-port", type=int, default=8800)
    parser.add_argument("--aux-port", type=int, default=8801)
    parser.add_argument("--props-off", action="store_true", help="confirm the propellers are removed")
    args = parser.parse_args()

    if not args.props_off:
        print("Refusing to run: remove the props, then pass --props-off.")
        return 2
    local = local_address_for(args.host)
    if local is None or not same_network(local, args.host):
        print(f"Not on the drone's network: {args.host} would be reached from {local}. Join its Wi-Fi and retry.")
        return 2

    session = Session(args.host, args.control_port, args.aux_port)
    try:
        flown = fly(session)
    except KeyboardInterrupt:
        print("interrupted")
        return 130
    finally:
        session.close()
    print("schedule finished, sending nothing further" if flown else "motors were not started")
    return 0 if flown else 1


if __name__ == "__main__":
    sys.exit(main())
