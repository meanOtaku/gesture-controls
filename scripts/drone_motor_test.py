#!/usr/bin/env python3
"""Start and stop a DM002HW's motors from the Mac. PROPS OFF ONLY.

The schedule below is fixed and runs for under 10 seconds, pressing the app's Up, Down and Stop buttons, each held
about as long as the app holds it. Bit names come from the decompiled WIFI UAV app: Up then Down started and stopped
the motors on the bench. The motors will spin: remove the props and keep the battery switch within reach. Up goes out
only once video is advancing, and any early exit after that, including Ctrl-C, sends Down then Stop.
"""

import argparse
import sys
import time

from drone_neutral_test import CENTRED, FLAGS_IDLE, Session, open_session
from drone_probe import local_address_for, same_network

FLAGS_UP = FLAGS_IDLE | 0x01
FLAGS_DOWN = FLAGS_IDLE | 0x02
FLAGS_STOP = FLAGS_IDLE | 0x04

SETTLE = ("idle", CENTRED, FLAGS_IDLE, 1.0)
UP = ("up", CENTRED, FLAGS_UP, 1.1)
DOWN = ("down", CENTRED, FLAGS_DOWN, 1.1)
STOP = ("stop", CENTRED, FLAGS_STOP, 0.5)
SCHEDULE = (
    UP,
    ("watch", CENTRED, FLAGS_IDLE, 3.0),
    DOWN,
    ("idle", CENTRED, FLAGS_IDLE, 0.5),
    STOP,
    ("idle", CENTRED, FLAGS_IDLE, 0.5),
)
ABORT = (DOWN, STOP)
MIN_VIDEO_FRAMES = 5


class Flight:
    def __init__(self, session):
        self.session = session
        self.sequence = 1

    def hold(self, step):
        name, sticks, flags, seconds = step
        started = time.monotonic() - self.session.started
        print(f"{started:6.2f} s  {name}: flags {flags:#04x} throttle {sticks[2]:#04x} for {seconds} s, video frame {self.session.completed}")
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.session.exchange(self.sequence, sticks, flags)
            self.sequence += 1


def fly(session):
    """Returns True when the whole schedule ran. A flag may be out as soon as `hold` starts, so abort from there."""
    if not open_session(session):
        return False
    flight = Flight(session)
    flight.hold(SETTLE)
    if session.completed < MIN_VIDEO_FRAMES:
        print(f"video only reached frame {session.completed}, so the link is not proven: no takeoff sent")
        return False

    finished = False
    try:
        for step in SCHEDULE:
            flight.hold(step)
        finished = True
    finally:
        if not finished:
            print("schedule interrupted: sending down, then stop")
            for step in ABORT:
                flight.hold(step)
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
    print("schedule finished, sending nothing further" if flown else "no flight flag was sent")
    return 0 if flown else 1


if __name__ == "__main__":
    sys.exit(main())
