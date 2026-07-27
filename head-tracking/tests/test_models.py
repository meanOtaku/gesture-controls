import json
import unittest

from sony_head_tracking.models import HeadPose, PacketError


VALID_SAMPLE = {
    "version": 2,
    "device": "WH-1000XM5",
    "quaternion": [1, 0, 0, 0],
    "yprDegrees": [12.5, -4, 1.25],
    "gyroscope": [0.1, 0.2, 0.3],
    "accelerometer": None,
    "resetCounter": 3,
    "packetsPerSecond": 25,
    "receiveLatencyMs": -1,
}


class HeadPoseTests(unittest.TestCase):
    def test_parses_version_two_sample(self) -> None:
        pose = HeadPose.from_datagram(json.dumps(VALID_SAMPLE).encode())

        self.assertEqual(pose.device, "WH-1000XM5")
        self.assertEqual((pose.yaw, pose.pitch, pose.roll), (12.5, -4.0, 1.25))
        self.assertEqual(pose.quaternion, (1.0, 0.0, 0.0, 0.0))
        self.assertIsNone(pose.accelerometer)
        self.assertEqual(pose.reset_counter, 3)

    def test_rejects_invalid_json(self) -> None:
        with self.assertRaises(PacketError):
            HeadPose.from_datagram(b"not json")

    def test_rejects_unknown_version(self) -> None:
        sample = {**VALID_SAMPLE, "version": 1}
        with self.assertRaisesRegex(PacketError, "unsupported protocol version"):
            HeadPose.from_datagram(json.dumps(sample).encode())

    def test_rejects_invalid_vector(self) -> None:
        sample = {**VALID_SAMPLE, "yprDegrees": [1, 2]}
        with self.assertRaisesRegex(PacketError, "yprDegrees"):
            HeadPose.from_datagram(json.dumps(sample).encode())


if __name__ == "__main__":
    unittest.main()
