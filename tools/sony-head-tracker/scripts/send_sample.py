"""Send a single simulated Sony Head Tracker version-2 sample."""

import json
import socket

sample = {
    "version": 2,
    "device": "Simulated WH-1000XM5",
    "rotationVector": [0.0, 0.0, 0.0],
    "quaternion": [1.0, 0.0, 0.0, 0.0],
    "yprDegrees": [12.5, -4.0, 1.25],
    "gyroscope": [0.01, 0.02, 0.03],
    "accelerometer": None,
    "angularVelocity": [0.01, 0.02, 0.03],
    "resetCounter": 0,
    "packetsPerSecond": 25.0,
    "receiveLatencyMs": -1.0,
}

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_socket:
    udp_socket.sendto(json.dumps(sample).encode("utf-8"), ("127.0.0.1", 4243))

print("Sent one simulated sample to 127.0.0.1:4243")
