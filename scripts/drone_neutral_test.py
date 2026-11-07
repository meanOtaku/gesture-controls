#!/usr/bin/env python3
"""Prove a WIFI UAV drone reads our control frames, without any flight command.

Uses the 8-byte control record captured from a real DM002HW session, which differs from the 20-byte record in the
reversing-wifi-uav repo, and opens the session as that repo's capture shows: start packets to ports 8800 and 8801, a
short setup, then control frames that also name the video frame just received and the next one wanted. If video
advances past frame 1, the drone is acting on what we send. Sticks stay centred and the flags idle, with no option to
change either. It is still control traffic to real hardware: props off.
"""

import argparse
import select
import socket
import struct
import sys
import time
from collections import defaultdict

from drone_probe import VIDEO_START, local_address_for, report, same_network

NEUTRAL = 0x80
CENTRED = (NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL)
FLAGS_IDLE = 0x40
MAX_SECONDS = 10.0
FIRST_FRAME_TIMEOUT = 1.0
FRAME_GAP = 0.027  # Seconds between frames during the opening, from the repo's capture.
CONTROL_GAP = 0.052  # Median seconds between control frames in the DM002HW capture.
VIDEO_MAGIC = b"\x93\x01"
VIDEO_HEADER_LENGTH = 56
VERSION_QUERY = bytes([0xEF, 0x20, 0x06, 0x00, 0x01, 0x65])

COMMON_HEADER = bytes([0x02, 0x02, 0x00, 0x01])
TRAILER = bytes([0x32, 0x4B, 0x14, 0x2D, 0x00, 0x00])
BASE_LENGTH = 88
SETUP_RECORD = struct.pack("<IIII", 1, 0, 0, 0x14) + bytes([0x00, 0x00, 0xFE, 0xFF])


def header(length, records):
    return bytes([0xEF, 0x02]) + struct.pack("<H", length) + COMMON_HEADER + struct.pack("<I", records)


def control_block(sequence, sticks, flags):
    """Offsets 12 to 25: the frame counter, then the 8-byte record of four axes, flags and their checksum."""
    body = bytes(sticks) + bytes([flags])
    checksum = 0
    for byte in body:
        checksum ^= byte
    return struct.pack("<I", sequence & 0xFFFF) + bytes([0x08, 0x00, 0x66]) + body + bytes([checksum, 0x99])


def base(records, length, sequence=None, sticks=CENTRED, flags=FLAGS_IDLE):
    """The first 88 bytes of every frame. Without a sequence the control area is empty, as in the app's first frames."""
    block = b"" if sequence is None else control_block(sequence, sticks, flags)
    frame = header(length, records) + block
    return frame + bytes(BASE_LENGTH - len(frame) - len(TRAILER)) + TRAILER


def request_records(received, wanted):
    """Names the video frame just received and the next one wanted."""
    return struct.pack("<IIII", received, 0, 1, 0x14) + b"\xff\xff\xff\xff" + struct.pack("<IIII", wanted, 0, 3, 0x10)


def empty_frame():
    return base(0, 88)


def setup_frame():
    return base(1, 108) + SETUP_RECORD


def request_frame(received, sequence=None, sticks=CENTRED, flags=FLAGS_IDLE):
    return base(2, 124, sequence, sticks, flags) + request_records(received, received + 1)


class Session:
    def __init__(self, host, control_port, aux_port):
        self.host = host
        self.control_port = control_port
        self.aux_port = aux_port
        self.control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.aux = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.started = time.monotonic()
        self.packets = []
        self.parts = defaultdict(set)
        self.completed = 0
        self.completed_at = {}

    def close(self):
        self.control.close()
        self.aux.close()

    def send(self, payload):
        self.control.sendto(payload, (self.host, self.control_port))

    def send_aux(self, payload):
        self.aux.sendto(payload, (self.host, self.aux_port))

    def receive(self, sock):
        try:
            payload, source = sock.recvfrom(65535)
        except OSError as error:
            print(f"  socket error: {error}")
            return
        now = time.monotonic() - self.started
        self.packets.append((now, source, payload))
        if payload[:2] == VIDEO_MAGIC and len(payload) >= VIDEO_HEADER_LENGTH:
            number = struct.unpack_from("<I", payload, 16)[0]
            part, total = struct.unpack_from("<II", payload, 32)
            self.parts[number].add(part)
            if len(self.parts[number]) >= total and number not in self.completed_at:
                self.completed_at[number] = now
                self.completed = max(self.completed, number)

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            ready, _, _ = select.select([self.control, self.aux], [], [], left)
            for sock in ready:
                self.receive(sock)

    def exchange(self, sequence, sticks=CENTRED, flags=FLAGS_IDLE):
        """One control frame, which also requests the next video frame."""
        self.send(request_frame(self.completed, sequence, sticks, flags))
        self.pump(CONTROL_GAP)


def open_session(session):
    """Replays the app's opening. False when the drone never sends its first frame, and then no control frame is sent."""
    session.send(VIDEO_START)
    session.pump(0.007)
    session.send_aux(VIDEO_START)
    session.pump(0.094)
    session.send(VIDEO_START)
    deadline = time.monotonic() + FIRST_FRAME_TIMEOUT
    while session.completed < 1 and time.monotonic() < deadline:
        session.pump(0.01)
    if session.completed < 1:
        print("no complete first frame, so stopping before any control frame")
        return False

    session.send(empty_frame())
    session.pump(FRAME_GAP)
    session.send(setup_frame())
    session.pump(FRAME_GAP)
    session.send(empty_frame())
    session.pump(0.005)
    session.send_aux(VIDEO_START)
    session.pump(0.021)
    session.send(request_frame(session.completed))
    session.send(VERSION_QUERY)
    session.pump(FRAME_GAP)
    return True


def run(session, seconds):
    if not open_session(session):
        return 0
    sent = 4  # The opening's control-port frames.
    sequence = 1
    end = session.started + seconds
    while time.monotonic() < end:
        session.exchange(sequence)
        sent += 1
        sequence += 1
    return sent


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="192.168.169.1")
    parser.add_argument("--control-port", type=int, default=8800)
    parser.add_argument("--aux-port", type=int, default=8801)
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()

    seconds = min(args.seconds, MAX_SECONDS)
    local = local_address_for(args.host)
    if local is None or not same_network(local, args.host):
        print(f"Not on the drone's network: {args.host} would be reached from {local}. Join its Wi-Fi and retry.")
        return 2

    print(f"neutral session for {seconds:.0f} s from {local} to {args.host}")
    session = Session(args.host, args.control_port, args.aux_port)
    try:
        sent = run(session, seconds)
    finally:
        session.close()

    frames = sorted(session.completed_at)
    print(f"sent {sent} frames, then stopped")
    print(f"complete video frames: {len(frames)}, highest number {session.completed}")
    if len(frames) > 1:
        span = session.completed_at[frames[-1]] - session.completed_at[frames[0]]
        print(f"video rate {(len(frames) - 1) / span:.1f} frames/s" if span > 0 else "")
    report(session.packets, seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
