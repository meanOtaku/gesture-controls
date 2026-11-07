#!/usr/bin/env python3
"""Find out whether a Wi-Fi toy drone speaks the "WIFI UAV" protocol, without ever flying it.

Sends only the 4-byte video start packet and records everything the drone sends back: packet sizes, source ports,
rate and leading bytes. That answers whether the address and ports are right, and whether anything other than video
comes back (telemetry). This script has no control frame builder on purpose, so it cannot send takeoff or stick data.

Join the drone's Wi-Fi first, then:  python3 scripts/drone_probe.py
"""

import argparse
import ipaddress
import socket
import sys
import time
from collections import defaultdict

VIDEO_START = bytes([0xEF, 0x00, 0x04, 0x00])
SAMPLES_PER_SIGNATURE = 3
HEX_BYTES = 48
MAX_PACKET = 65535


def local_address_for(host):
    """The address this machine would send to `host` from, or None when there is no route."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((host, 9))  # A UDP connect only picks a route; nothing is sent.
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def same_network(local, host):
    """Loopback, or the same /24: otherwise the packet would leave through the default route, not the drone's Wi-Fi."""
    address = ipaddress.ip_address(host)
    if address.is_loopback:
        return True
    return ipaddress.ip_address(local) in ipaddress.ip_network(f"{host}/24", strict=False)


def probe(sock, host, ports, seconds, interval, send, save):
    """Returns the packets as (seconds since start, source address, payload), in arrival order."""
    packets = []
    started = time.monotonic()
    next_send = started
    while (now := time.monotonic()) - started < seconds:
        if send and now >= next_send:
            for port in ports:
                sock.sendto(VIDEO_START, (host, port))
            next_send = now + interval
        sock.settimeout(0.02)
        try:
            payload, source = sock.recvfrom(MAX_PACKET)
        except socket.timeout:
            continue
        except OSError as error:  # macOS reports an ICMP "port unreachable" here; a closed port is a finding.
            print(f"  socket error: {error}")
            continue
        packets.append((time.monotonic() - started, source, payload))
        if save:
            save.write(payload)
    return packets


def report(packets, seconds):
    if not packets:
        print("\nNothing came back. Wrong address or ports, or this drone needs a different start packet.")
        return 1
    print(f"\n{len(packets)} packets, {sum(len(p) for _, _, p in packets)} bytes in {seconds:.0f} s")
    groups = defaultdict(list)
    for arrived, source, payload in packets:
        groups[(source[0], source[1], payload[:2].hex(" "))].append((arrived, payload))
    for (address, port, lead), members in sorted(groups.items(), key=lambda item: -len(item[1])):
        sizes = sorted({len(payload) for _, payload in members})
        span = members[-1][0] - members[0][0]
        rate = f"{(len(members) - 1) / span:.1f}/s" if span > 0 else "single burst"
        shown = f"{sizes[0]}-{sizes[-1]}" if len(sizes) > 1 else f"{sizes[0]}"
        print(f"\nfrom {address}:{port}  starts {lead}  x{len(members)}  {rate}  size {shown} ({len(sizes)} distinct)")
        for arrived, payload in members[:SAMPLES_PER_SIGNATURE]:
            print(f"  t={arrived:6.2f}  {payload[:HEX_BYTES].hex(' ')}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="192.168.169.1")
    parser.add_argument("--ports", type=int, nargs="+", default=[8800, 1234])
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--interval", type=float, default=0.1, help="seconds between start packets")
    parser.add_argument("--listen-only", action="store_true", help="send nothing at all")
    parser.add_argument("--save", help="append every raw payload to this file, for video analysis")
    args = parser.parse_args()

    local = local_address_for(args.host)
    if local is None or not same_network(local, args.host):
        print(f"Not on the drone's network: {args.host} would be reached from {local}. Join its Wi-Fi and retry.")
        return 2

    print(f"from {local} to {args.host} ports {args.ports}, {args.seconds:.0f} s")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    save = open(args.save, "ab") if args.save else None
    try:
        packets = probe(sock, args.host, args.ports, args.seconds, args.interval, not args.listen_only, save)
    finally:
        sock.close()
        if save:
            save.close()
    return report(packets, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
