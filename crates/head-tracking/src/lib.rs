//! Replaceable head-pose providers for the built-in Sony engine and compatibility UDP input.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
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
    ResetCounterChanged {
        previous: u64,
        current: u64,
    },
    RuntimeStatus {
        state: HeadTrackerRuntimeState,
        message: String,
        device: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HeadTrackerRuntimeState {
    Starting,
    Searching,
    Connected,
    Reconnecting,
    PermissionRequired,
    Unsupported,
    Error,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeadTrackerRuntimeStatus {
    pub state: HeadTrackerRuntimeState,
    pub message: String,
    pub device: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeadPoseProviderSnapshot {
    pub runtime: HeadTrackerRuntimeStatus,
    pub reset_counter: Option<u64>,
}

#[derive(Debug, Error)]
pub enum HeadPoseError {
    #[error("failed to bind Sony UDP listener: {0}")]
    SocketBindFailed(#[source] std::io::Error),
    #[error("head-pose provider is already running")]
    AlreadyRunning,
    #[error("head-pose provider state lock was poisoned")]
    StatePoisoned,
    #[error("head tracking is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("this head-pose source does not support {0}")]
    UnsupportedOperation(&'static str),
    #[error("native Sony tracker failed: {0}")]
    Native(#[from] sony_head_tracker_sys::EngineError),
    #[error("head-pose provider task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

#[async_trait]
pub trait HeadPoseProvider: Send + Sync {
    /// Starts receiving samples. A provider may be started again after `stop` completes.
    async fn start(&self) -> Result<(), HeadPoseError>;
    /// Stops receiving samples and waits for the receive task to terminate.
    async fn stop(&self) -> Result<(), HeadPoseError>;
    fn subscribe(&self) -> broadcast::Receiver<HeadPoseEvent>;
    fn is_connected(&self) -> bool;
    /// Returns persisted lifecycle/reset state so consumers can recover after event lag.
    fn snapshot(&self) -> HeadPoseProviderSnapshot;
    fn recenter(&self) -> Result<(), HeadPoseError>;
}

mod direct;
pub use direct::SonyDirectHeadPoseProvider;

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
    connected: Arc<AtomicBool>,
    runtime: Arc<Mutex<HeadTrackerRuntimeStatus>>,
    reset_counter: Arc<Mutex<Option<u64>>>,
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
            connected: Arc::new(AtomicBool::new(false)),
            runtime: Arc::new(Mutex::new(HeadTrackerRuntimeStatus {
                state: HeadTrackerRuntimeState::Stopped,
                message: "Compatibility UDP provider is stopped".to_owned(),
                device: None,
            })),
            reset_counter: Arc::new(Mutex::new(None)),
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
        let connection_state = Arc::clone(&self.connected);
        let runtime = Arc::clone(&self.runtime);
        let reset_counter = Arc::clone(&self.reset_counter);
        *runtime.lock().map_err(|_| HeadPoseError::StatePoisoned)? = HeadTrackerRuntimeStatus {
            state: HeadTrackerRuntimeState::Searching,
            message: format!("Waiting for simulator data on {}", self.local_addr),
            device: None,
        };
        *reset_counter
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)? = None;

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
                        let device = sample.device.clone();
                        let now = Instant::now();
                        let reset_changed = monitor.observe(now, sample.reset_counter);
                        if let Ok(mut current_reset) = reset_counter.lock() {
                            *current_reset = Some(sample.reset_counter);
                        }
                        if let Ok(mut current_runtime) = runtime.lock() {
                            *current_runtime = HeadTrackerRuntimeStatus {
                                state: HeadTrackerRuntimeState::Connected,
                                message: "Compatibility simulator connected".to_owned(),
                                device,
                            };
                        }
                        if !connected {
                            connected = true;
                            connection_state.store(true, Ordering::Release);
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
                            connection_state.store(false, Ordering::Release);
                            if let Ok(mut current_runtime) = runtime.lock() {
                                *current_runtime = HeadTrackerRuntimeStatus {
                                    state: HeadTrackerRuntimeState::Reconnecting,
                                    message: "Simulator data timed out; waiting for new samples"
                                        .to_owned(),
                                    device: None,
                                };
                            }
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
            self.connected.store(false, Ordering::Release);
            let _ = self.events.send(HeadPoseEvent::Disconnected);
        }
        *self
            .runtime
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)? = HeadTrackerRuntimeStatus {
            state: HeadTrackerRuntimeState::Stopped,
            message: "Compatibility UDP provider stopped".to_owned(),
            device: None,
        };
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<HeadPoseEvent> {
        self.events.subscribe()
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> HeadPoseProviderSnapshot {
        let runtime =
            self.runtime
                .lock()
                .map(|value| value.clone())
                .unwrap_or(HeadTrackerRuntimeStatus {
                    state: HeadTrackerRuntimeState::Error,
                    message: "Compatibility provider state lock was poisoned".to_owned(),
                    device: None,
                });
        let reset_counter = self
            .reset_counter
            .lock()
            .map(|value| *value)
            .unwrap_or(None);
        HeadPoseProviderSnapshot {
            runtime,
            reset_counter,
        }
    }

    fn recenter(&self) -> Result<(), HeadPoseError> {
        Err(HeadPoseError::UnsupportedOperation(
            "recenter for compatibility UDP input",
        ))
    }
}
