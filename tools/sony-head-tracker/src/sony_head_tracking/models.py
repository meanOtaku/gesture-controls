"""Validated data models for Sony Head Tracker protocol version 2."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any


class PacketError(ValueError):
    """Raised when a UDP datagram is not a valid head-pose sample."""


def _vector(
    payload: dict[str, Any],
    key: str,
    length: int,
    *,
    optional: bool = False,
) -> tuple[float, ...] | None:
    value = payload.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, list) or len(value) != length:
        raise PacketError(f"{key} must be an array of {length} numbers")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value):
        raise PacketError(f"{key} must contain only numbers")
    return tuple(float(item) for item in value)


@dataclass(frozen=True, slots=True)
class HeadPose:
    version: int
    device: str | None
    quaternion: tuple[float, float, float, float]
    yaw: float
    pitch: float
    roll: float
    gyroscope: tuple[float, float, float] | None
    accelerometer: tuple[float, float, float] | None
    reset_counter: int
    packets_per_second: float
    receive_latency_ms: float

    @classmethod
    def from_datagram(cls, datagram: bytes) -> HeadPose:
        try:
            payload = json.loads(datagram.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PacketError("datagram is not valid UTF-8 JSON") from error

        if not isinstance(payload, dict):
            raise PacketError("packet root must be a JSON object")
        if payload.get("version") != 2:
            raise PacketError(f"unsupported protocol version: {payload.get('version')!r}")

        device = payload.get("device")
        if device is not None and not isinstance(device, str):
            raise PacketError("device must be a string or null")

        quaternion = _vector(payload, "quaternion", 4)
        ypr = _vector(payload, "yprDegrees", 3)
        gyroscope = _vector(payload, "gyroscope", 3, optional=True)
        accelerometer = _vector(payload, "accelerometer", 3, optional=True)

        reset_counter = payload.get("resetCounter", 0)
        if isinstance(reset_counter, bool) or not isinstance(reset_counter, int):
            raise PacketError("resetCounter must be an integer")

        try:
            packets_per_second = float(payload.get("packetsPerSecond", 0.0))
            receive_latency_ms = float(payload.get("receiveLatencyMs", -1.0))
        except (TypeError, ValueError) as error:
            raise PacketError("rate and latency values must be numbers") from error

        assert quaternion is not None
        assert ypr is not None
        return cls(
            version=2,
            device=device,
            quaternion=quaternion,  # type: ignore[arg-type]
            yaw=ypr[0],
            pitch=ypr[1],
            roll=ypr[2],
            gyroscope=gyroscope,  # type: ignore[arg-type]
            accelerometer=accelerometer,  # type: ignore[arg-type]
            reset_counter=reset_counter,
            packets_per_second=packets_per_second,
            receive_latency_ms=receive_latency_ms,
        )
