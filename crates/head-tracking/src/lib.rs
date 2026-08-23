//! Replaceable head-pose providers and the Sony JSON UDP implementation.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use spatial_protocol::{HeadPose, SonyHeadSample};
use thiserror::Error;
use tokio::net::UdpSocket;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub enum HeadPoseEvent {
    Connected,
    Disconnected,
    Pose(HeadPose),
    ResetCounterChanged { previous: u64, current: u64 },
}

#[derive(Debug, Error)]
pub enum HeadPoseError {
    #[error("failed to bind Sony UDP listener: {0}")]
    SocketBindFailed(#[source] std::io::Error),
    #[error("head-pose provider is already running")]
    AlreadyRunning,
    #[error("head-pose provider state lock was poisoned")]
    StatePoisoned,
}

#[async_trait]
pub trait HeadPoseProvider: Send + Sync {
    /// Starts receiving samples. A provider may be started again after `stop` completes.
    async fn start(&self) -> Result<(), HeadPoseError>;
    /// Stops receiving samples and waits for the receive task to terminate.
    async fn stop(&self) -> Result<(), HeadPoseError>;
}

#[derive(Debug)]
pub struct TrackerMonitor {
    disconnect_timeout: Duration,
    last_sample: Option<Instant>,
    reset_counter: Option<u64>,
}

impl TrackerMonitor {
    pub fn new(disconnect_timeout: Duration) -> Self {
        Self {
            disconnect_timeout,
            last_sample: None,
            reset_counter: None,
        }
    }

    /// Records a sample and returns true only when an established reset counter changes.
    pub fn observe(&mut self, received_at: Instant, reset_counter: u64) -> bool {
        self.last_sample = Some(received_at);
        self.reset_counter
            .replace(reset_counter)
            .is_some_and(|previous| previous != reset_counter)
    }

    pub fn is_connected(&self, now: Instant) -> bool {
        self.last_sample
            .is_some_and(|last| now.saturating_duration_since(last) <= self.disconnect_timeout)
    }
}

/// Filters normal IMU drift while preserving deliberate head movement. The Sony
/// bridge reports Euler angles and quaternions; filtering the quaternion avoids
/// calibration reacting to a single noisy packet, while circular angle filtering
/// keeps displayed yaw continuous across ±180°.
#[derive(Debug, Default)]
struct StationaryPoseFilter {
    previous: Option<HeadPose>,
}

impl StationaryPoseFilter {
    fn reset(&mut self) {
        self.previous = None;
    }

    fn apply(&mut self, sample: HeadPose) -> HeadPose {
        let Some(previous) = self.previous.as_ref() else {
            self.previous = Some(sample.clone());
            return sample;
        };

        let yaw_delta = circular_delta_degrees(sample.yaw_deg, previous.yaw_deg);
        let pitch_delta = circular_delta_degrees(sample.pitch_deg, previous.pitch_deg);
        let roll_delta = circular_delta_degrees(sample.roll_deg, previous.roll_deg);
        let largest_delta = yaw_delta.abs().max(pitch_delta.abs()).max(roll_delta.abs());
        let angular_speed = sample
            .angular_velocity
            .or(sample.gyroscope)
            .map(vector_magnitude)
            .unwrap_or(f64::INFINITY);

        if largest_delta >= STATIONARY_OUTLIER_DEGREES
            && angular_speed <= STATIONARY_ANGULAR_SPEED_THRESHOLD
        {
            let mut held = previous.clone();
            held.timestamp_ns = sample.timestamp_ns;
            held.device = sample.device;
            held.reset_counter = sample.reset_counter;
            held.packets_per_second = sample.packets_per_second;
            held.receive_latency_ms = sample.receive_latency_ms;
            self.previous = Some(held.clone());
            return held;
        }

        let alpha = if largest_delta <= STATIONARY_DEADBAND_DEGREES {
            STATIONARY_SMOOTHING_ALPHA
        } else {
            MOTION_SMOOTHING_ALPHA
        };
        let mut filtered = sample;
        filtered.yaw_deg = circular_blend(previous.yaw_deg, yaw_delta, alpha);
        filtered.pitch_deg = circular_blend(previous.pitch_deg, pitch_delta, alpha);
        filtered.roll_deg = circular_blend(previous.roll_deg, roll_delta, alpha);
        filtered.quaternion =
            normalized_quaternion_blend(previous.quaternion, filtered.quaternion, alpha);
        filtered.gyroscope = filtered
            .gyroscope
            .map(|value| smooth_vector(previous.gyroscope, value, alpha));
        filtered.angular_velocity = filtered
            .angular_velocity
            .map(|value| smooth_vector(previous.angular_velocity, value, alpha));
        self.previous = Some(filtered.clone());
        filtered
    }
}

const STATIONARY_DEADBAND_DEGREES: f64 = 1.0;
const STATIONARY_OUTLIER_DEGREES: f64 = 20.0;
const STATIONARY_ANGULAR_SPEED_THRESHOLD: f64 = 0.2;
const STATIONARY_SMOOTHING_ALPHA: f64 = 0.12;
const MOTION_SMOOTHING_ALPHA: f64 = 0.65;

fn circular_delta_degrees(current: f64, previous: f64) -> f64 {
    (current - previous + 180.0).rem_euclid(360.0) - 180.0
}

fn circular_blend(previous: f64, delta: f64, alpha: f64) -> f64 {
    previous + delta * alpha
}

fn vector_magnitude(vector: [f64; 3]) -> f64 {
    vector
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

fn smooth_vector(previous: Option<[f64; 3]>, current: [f64; 3], alpha: f64) -> [f64; 3] {
    previous.map_or(current, |previous| {
        std::array::from_fn(|index| previous[index] + (current[index] - previous[index]) * alpha)
    })
}

fn normalized_quaternion_blend(previous: [f64; 4], current: [f64; 4], alpha: f64) -> [f64; 4] {
    let dot = previous
        .iter()
        .zip(current)
        .map(|(left, right)| left * right)
        .sum::<f64>();
    let current = if dot < 0.0 {
        current.map(|component| -component)
    } else {
        current
    };
    let blended =
        std::array::from_fn(|index| previous[index] + (current[index] - previous[index]) * alpha);
    let norm = blended
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if norm > f64::EPSILON {
        blended.map(|component| component / norm)
    } else {
        previous
    }
}

pub struct SonyUdpHeadPoseProvider {
    local_addr: SocketAddr,
    socket: Arc<UdpSocket>,
    task: Mutex<Option<JoinHandle<()>>>,
    events: broadcast::Sender<HeadPoseEvent>,
    disconnect_timeout: Duration,
}

impl SonyUdpHeadPoseProvider {
    pub async fn bind(
        address: SocketAddr,
        disconnect_timeout: Duration,
    ) -> Result<Self, HeadPoseError> {
        let socket = UdpSocket::bind(address)
            .await
            .map_err(HeadPoseError::SocketBindFailed)?;
        let local_addr = socket
            .local_addr()
            .map_err(HeadPoseError::SocketBindFailed)?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            local_addr,
            socket: Arc::new(socket),
            task: Mutex::new(None),
            events,
            disconnect_timeout,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HeadPoseEvent> {
        self.events.subscribe()
    }
}

#[async_trait]
impl HeadPoseProvider for SonyUdpHeadPoseProvider {
    async fn start(&self) -> Result<(), HeadPoseError> {
        let mut task_guard = self.task.lock().map_err(|_| HeadPoseError::StatePoisoned)?;
        if task_guard.is_some() {
            return Err(HeadPoseError::AlreadyRunning);
        }
        let socket = Arc::clone(&self.socket);
        let events = self.events.clone();
        let disconnect_timeout = self.disconnect_timeout;

        *task_guard = Some(tokio::spawn(async move {
            let mut buffer = vec![0_u8; 65_536];
            let mut monitor = TrackerMonitor::new(disconnect_timeout);
            let mut connected = false;
            let mut previous_reset = None;
            let mut pose_filter = StationaryPoseFilter::default();
            // A loopback UDP port can receive packets from more than one
            // tracker process. Latch the first sender for this connection so
            // interleaved streams cannot make the displayed pose jump between
            // two independent reference frames.
            let mut accepted_source: Option<SocketAddr> = None;

            loop {
                let receive_timeout = if connected {
                    monitor
                        .last_sample
                        .map(|last| disconnect_timeout.saturating_sub(last.elapsed()))
                        .unwrap_or(disconnect_timeout)
                } else {
                    disconnect_timeout
                };
                match tokio::time::timeout(receive_timeout, socket.recv_from(&mut buffer)).await {
                    Ok(Ok((length, source))) => {
                        let sample = match SonyHeadSample::from_json(&buffer[..length]) {
                            Ok(sample) => sample,
                            Err(error) => {
                                warn!(%source, %error, "ignoring invalid Sony head-tracker datagram");
                                continue;
                            }
                        };
                        match accepted_source {
                            Some(accepted) if accepted != source => {
                                debug!(%source, %accepted, "ignoring head-tracker datagram from a second sender");
                                continue;
                            }
                            None => accepted_source = Some(source),
                            _ => {}
                        }
                        let now = Instant::now();
                        let reset_changed = monitor.observe(now, sample.reset_counter);
                        if !connected {
                            connected = true;
                            let _ = events.send(HeadPoseEvent::Connected);
                        }
                        if reset_changed && let Some(previous) = previous_reset {
                            pose_filter.reset();
                            let _ = events.send(HeadPoseEvent::ResetCounterChanged {
                                previous,
                                current: sample.reset_counter,
                            });
                        }
                        previous_reset = Some(sample.reset_counter);
                        let timestamp_ns = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos()
                            .min(u64::MAX as u128)
                            as u64;
                        let pose = pose_filter.apply(sample.into_head_pose(timestamp_ns));
                        let _ = events.send(HeadPoseEvent::Pose(pose));
                    }
                    Ok(Err(error)) => {
                        warn!(%error, "Sony UDP receive failed");
                    }
                    Err(_) => {
                        if connected {
                            connected = false;
                            accepted_source = None;
                            pose_filter.reset();
                            let _ = events.send(HeadPoseEvent::Disconnected);
                            debug!("Sony head tracker timed out");
                        }
                    }
                }
            }
        }));
        Ok(())
    }

    async fn stop(&self) -> Result<(), HeadPoseError> {
        let task = self
            .task
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)?
            .take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
            let _ = self.events.send(HeadPoseEvent::Disconnected);
        }
        Ok(())
    }
}
