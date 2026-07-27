use std::net::SocketAddr;
use std::time::Duration;

use head_tracking::{HeadPoseEvent, HeadPoseProvider, SonyUdpHeadPoseProvider};
use tokio::net::UdpSocket;

const SAMPLE: &[u8] = br#"{
  "version": 2,
  "device": "WH-1000XM5",
  "rotationVector": [0.0, 0.0, 0.0],
  "quaternion": [1.0, 0.0, 0.0, 0.0],
  "yprDegrees": [12.0, -3.0, 1.0],
  "gyroscope": [0.0, 0.1, 0.0],
  "accelerometer": null,
  "resetCounter": 2,
  "packetsPerSecond": 25.0,
  "receiveLatencyMs": 2.0
}"#;

#[tokio::test]
async fn invalid_datagram_flood_does_not_keep_provider_connected() {
    let disconnect_timeout = Duration::from_millis(80);
    let provider = SonyUdpHeadPoseProvider::bind(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        disconnect_timeout,
    )
    .await
    .unwrap();
    let destination = provider.local_addr();
    let mut events = provider.subscribe();
    provider.start().await.unwrap();

    let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sender.send_to(SAMPLE, destination).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if matches!(events.recv().await.unwrap(), HeadPoseEvent::Connected) {
                break;
            }
        }
    })
    .await
    .expect("connected event within timeout");

    let unsupported = SAMPLE
        .windows(b"\"version\": 2".len())
        .position(|window| window == b"\"version\": 2")
        .map(|position| {
            let mut packet = SAMPLE.to_vec();
            packet[position + b"\"version\": ".len()] = b'1';
            packet
        })
        .unwrap();
    let flood = tokio::spawn(async move {
        for _ in 0..20 {
            sender.send_to(b"not json", destination).await.unwrap();
            sender.send_to(&unsupported, destination).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });

    tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            if matches!(events.recv().await.unwrap(), HeadPoseEvent::Disconnected) {
                break;
            }
        }
    })
    .await
    .expect("invalid traffic must not postpone disconnection");

    flood.abort();
    provider.stop().await.unwrap();
}

#[tokio::test]
async fn udp_provider_publishes_reset_counter_changes() {
    let provider = SonyUdpHeadPoseProvider::bind(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        Duration::from_millis(500),
    )
    .await
    .unwrap();
    let destination = provider.local_addr();
    let mut events = provider.subscribe();
    provider.start().await.unwrap();

    let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sender.send_to(SAMPLE, destination).await.unwrap();
    let changed_sample = String::from_utf8(SAMPLE.to_vec())
        .unwrap()
        .replace("\"resetCounter\": 2", "\"resetCounter\": 3");
    sender
        .send_to(changed_sample.as_bytes(), destination)
        .await
        .unwrap();

    let (previous, current) = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let HeadPoseEvent::ResetCounterChanged { previous, current } =
                events.recv().await.unwrap()
            {
                break (previous, current);
            }
        }
    })
    .await
    .expect("reset event within timeout");

    assert_eq!((previous, current), (2, 3));
    provider.stop().await.unwrap();
}

#[tokio::test]
async fn provider_can_restart_after_stop() {
    let provider = SonyUdpHeadPoseProvider::bind(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        Duration::from_millis(500),
    )
    .await
    .unwrap();
    let destination = provider.local_addr();

    provider.start().await.unwrap();
    provider.stop().await.unwrap();
    provider.start().await.expect("provider should restart");

    let mut events = provider.subscribe();
    let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sender.send_to(SAMPLE, destination).await.unwrap();

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if matches!(events.recv().await.unwrap(), HeadPoseEvent::Pose(_)) {
                break;
            }
        }
    })
    .await
    .expect("restarted provider should receive packets");

    provider.stop().await.unwrap();
}

#[tokio::test]
async fn udp_provider_publishes_valid_head_pose_packets() {
    let provider = SonyUdpHeadPoseProvider::bind(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        Duration::from_millis(500),
    )
    .await
    .unwrap();
    let destination = provider.local_addr();
    let mut events = provider.subscribe();
    provider.start().await.unwrap();

    let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sender.send_to(SAMPLE, destination).await.unwrap();

    let pose = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let HeadPoseEvent::Pose(pose) = events.recv().await.unwrap() {
                break pose;
            }
        }
    })
    .await
    .expect("pose event within timeout");

    assert_eq!(pose.device.as_deref(), Some("WH-1000XM5"));
    assert_eq!(pose.yaw_deg, 12.0);
    provider.stop().await.unwrap();
}
