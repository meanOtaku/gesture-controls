"""Command-line monitor for Sony head-pose samples."""

from __future__ import annotations

import argparse
import socket
import sys

from .models import PacketError
from .receiver import SonyUdpReceiver


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Display Sony head orientation")
    parser.add_argument("--host", default="127.0.0.1", help="UDP bind address")
    parser.add_argument("--port", default=4243, type=int, help="JSON UDP port")
    return parser.parse_args()


def main() -> int:
    arguments = _arguments()
    print(f"Listening for Sony Head Tracker on {arguments.host}:{arguments.port}...")
    print("Press Ctrl+C to stop.")

    try:
        with SonyUdpReceiver(arguments.host, arguments.port) as receiver:
            while True:
                try:
                    pose = receiver.receive()
                except socket.timeout:
                    print("\rWaiting for head-tracking data...                       ", end="", flush=True)
                    continue
                except PacketError as error:
                    print(f"\nIgnored invalid packet: {error}", file=sys.stderr)
                    continue

                device = pose.device or "Unknown device"
                latency = (
                    "n/a"
                    if pose.receive_latency_ms < 0
                    else f"{pose.receive_latency_ms:.1f} ms"
                )
                print(
                    f"\r{device:<18} "
                    f"yaw {pose.yaw:>7.2f}°  "
                    f"pitch {pose.pitch:>7.2f}°  "
                    f"roll {pose.roll:>7.2f}°  "
                    f"{pose.packets_per_second:>5.1f} Hz  "
                    f"latency {latency:<10}",
                    end="",
                    flush=True,
                )
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0
    except OSError as error:
        print(f"Could not listen on UDP port: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
