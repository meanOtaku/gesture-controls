"""UDP transport for the local Sony Head Tracker JSON stream."""

from __future__ import annotations

from collections.abc import Iterator
import socket

from .models import HeadPose


class SonyUdpReceiver:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 4243,
        *,
        timeout: float = 1.0,
        buffer_size: int = 65_535,
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.buffer_size = buffer_size
        self._socket: socket.socket | None = None

    def __enter__(self) -> SonyUdpReceiver:
        udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_socket.settimeout(self.timeout)
        udp_socket.bind((self.host, self.port))
        self._socket = udp_socket
        return self

    def __exit__(self, *_: object) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def receive(self) -> HeadPose:
        if self._socket is None:
            raise RuntimeError("receiver must be used as a context manager")
        datagram, _address = self._socket.recvfrom(self.buffer_size)
        return HeadPose.from_datagram(datagram)

    def samples(self) -> Iterator[HeadPose]:
        while True:
            yield self.receive()
