use spatial_protocol::{HeadPose, SonyHeadSample, SonyPacketError};

const SAMPLE: &str = r#"{
  "version": 2,
  "device": "WH-1000XM5",
  "rotationVector": [0.012, -0.004, 0.31],
  "quaternion": [0.987, 0.006, -0.002, 0.155],
  "yprDegrees": [17.84, -0.46, 1.37],
  "gyroscope": [0.01, 0.0, -0.02],
  "accelerometer": null,
  "angularVelocity": [0.01, 0.0, -0.02],
  "resetCounter": 7,
  "packetsPerSecond": 25.0,
  "receiveLatencyMs": 3.5,
  "futureField": true
}"#;

#[test]
fn parses_version_two_packet_and_ignores_unknown_fields() {
    let sample = SonyHeadSample::from_json(SAMPLE.as_bytes()).expect("valid sample");
    assert_eq!(sample.version, 2);
    assert_eq!(sample.device.as_deref(), Some("WH-1000XM5"));
    assert_eq!(sample.ypr_degrees, [17.84, -0.46, 1.37]);
    assert_eq!(sample.reset_counter, 7);
    assert_eq!(sample.accelerometer, None);
}

#[test]
fn rejects_unsupported_schema_versions() {
    let packet = SAMPLE.replace("\"version\": 2", "\"version\": 1");
    let error = SonyHeadSample::from_json(packet.as_bytes()).unwrap_err();
    assert!(matches!(error, SonyPacketError::UnsupportedVersion(1)));
}

#[test]
fn rejects_malformed_vector_lengths() {
    let packet = SAMPLE.replace(
        "\"quaternion\": [0.987, 0.006, -0.002, 0.155]",
        "\"quaternion\": [1.0, 0.0, 0.0]",
    );
    assert!(matches!(
        SonyHeadSample::from_json(packet.as_bytes()),
        Err(SonyPacketError::InvalidJson(_))
    ));
}

#[test]
fn rejects_packets_missing_required_protocol_v2_metrics() {
    for field in ["resetCounter", "packetsPerSecond", "receiveLatencyMs"] {
        let mut packet: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        packet.as_object_mut().unwrap().remove(field);

        assert!(
            matches!(
                SonyHeadSample::from_json(packet.to_string().as_bytes()),
                Err(SonyPacketError::InvalidJson(_))
            ),
            "packet missing {field} was accepted"
        );
    }
}

#[test]
fn converts_sony_packet_into_provider_independent_head_pose() {
    let sample = SonyHeadSample::from_json(SAMPLE.as_bytes()).unwrap();
    let pose: HeadPose = sample.into_head_pose(123_456);
    assert_eq!(pose.timestamp_ns, 123_456);
    assert_eq!(pose.quaternion, [0.987, 0.006, -0.002, 0.155]);
    assert_eq!(pose.yaw_deg, 17.84);
    assert_eq!(pose.angular_velocity, Some([0.01, 0.0, -0.02]));
}
