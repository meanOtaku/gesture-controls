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
                        let now = Instant::now();
                        let reset_changed = monitor.observe(now, sample.reset_counter);
                        if !connected {
                            connected = true;
                            let _ = events.send(HeadPoseEvent::Connected);
                        }
                        if reset_changed && let Some(previous) = previous_reset {
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
                        let _ =
                            events.send(HeadPoseEvent::Pose(sample.into_head_pose(timestamp_ns)));
                    }
                    Ok(Err(error)) => {
                        warn!(%error, "Sony UDP receive failed");
                    }
                    Err(_) => {
                        if connected {
                            connected = false;
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
