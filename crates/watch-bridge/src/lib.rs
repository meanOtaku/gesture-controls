//! Axum WebSocket server that accepts a single Galaxy Watch connection.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::StreamExt;
use spatial_protocol::{
    DESKTOP_CONNECTED_TYPE, DESKTOP_TIME_SYNC_TYPE, DesktopConnectedPayload,
    DesktopOutboundEnvelope, DesktopTimeSyncPayload, WatchEnvelope, WatchHeartbeatSample,
    WatchInboundMessage, WatchOrientationSample, WatchPpgBatchSample, WatchPpgStatusSample,
    WatchTimeSyncSample,
};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

pub const WATCH_WEBSOCKET_PATH: &str = "/ws/watch";
const TIME_SYNC_INTERVAL: Duration = Duration::from_secs(5);
const CLOCK_OFFSET_SAMPLE_COUNT: usize = 5;
const DEVICE_ALREADY_CONNECTED_CLOSE_CODE: u16 = 4409;

#[derive(Debug, Clone)]
pub enum WatchEvent {
    Connected,
    Disconnected,
    Orientation(WatchOrientationSample),
    Heartbeat(WatchHeartbeatSample),
    ClockOffsetUpdated(ClockOffsetEstimate),
    Ppg(WatchPpgBatchSample),
    PpgStatusUpdated(WatchPpgStatusSample),
    InvalidMessage { reason: String },
}

/// Round-trip clock-offset estimate, computed from one desktop/watch time-sync exchange.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockOffsetEstimate {
    pub offset_ns: i64,
    pub round_trip_ns: u64,
    pub estimated_at_ns: u64,
}

#[derive(Debug, Error)]
pub enum WatchBridgeError {
    #[error("failed to bind watch WebSocket listener: {0}")]
    SocketBindFailed(#[source] std::io::Error),
    #[error("watch bridge server is already running")]
    AlreadyRunning,
    #[error("watch bridge server state lock was poisoned")]
    StatePoisoned,
}

struct SharedState {
    events: broadcast::Sender<WatchEvent>,
    active: AtomicBool,
    heartbeat_timeout: Duration,
}

pub struct WatchBridgeServer {
    local_addr: SocketAddr,
    listener: Mutex<Option<TcpListener>>,
    task: Mutex<Option<JoinHandle<()>>>,
    shared: Arc<SharedState>,
}

impl WatchBridgeServer {
    /// Binds the TCP listener. Call `start` to begin serving `/ws/watch`.
    pub async fn bind(
        address: SocketAddr,
        heartbeat_timeout: Duration,
    ) -> Result<Self, WatchBridgeError> {
        let listener = TcpListener::bind(address)
            .await
            .map_err(WatchBridgeError::SocketBindFailed)?;
        let local_addr = listener
            .local_addr()
            .map_err(WatchBridgeError::SocketBindFailed)?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            local_addr,
            listener: Mutex::new(Some(listener)),
            task: Mutex::new(None),
            shared: Arc::new(SharedState {
                events,
                active: AtomicBool::new(false),
                heartbeat_timeout,
            }),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WatchEvent> {
        self.shared.events.subscribe()
    }

    pub async fn start(&self) -> Result<(), WatchBridgeError> {
        let mut task_guard = self
            .task
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)?;
        if task_guard.is_some() {
            return Err(WatchBridgeError::AlreadyRunning);
        }
        let listener = self
            .listener
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)?
            .take()
            .ok_or(WatchBridgeError::AlreadyRunning)?;
        let shared = Arc::clone(&self.shared);
        let app = Router::new()
            .route(WATCH_WEBSOCKET_PATH, get(ws_handler))
            .with_state(shared);

        *task_guard = Some(tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app.into_make_service()).await {
                warn!(%error, "watch WebSocket server terminated");
            }
        }));
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), WatchBridgeError> {
        let task = self
            .task
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)?
            .take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        Ok(())
    }
}

async fn ws_handler(
    State(shared): State<Arc<SharedState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, shared))
}

async fn handle_socket(mut socket: WebSocket, shared: Arc<SharedState>) {
    if shared
        .active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let close = Message::Close(Some(CloseFrame {
            code: DEVICE_ALREADY_CONNECTED_CLOSE_CODE,
            reason: "watch device already connected".into(),
        }));
        let _ = socket.send(close).await;
        return;
    }

    let connected_at_ns = now_ns();
    let ack = DesktopOutboundEnvelope::new(
        DESKTOP_CONNECTED_TYPE,
        connected_at_ns,
        DesktopConnectedPayload {
            session_id: format!("watch-session-{connected_at_ns}"),
            server_time_ns: connected_at_ns,
        },
    );
    if send_json(&mut socket, &ack).await.is_ok() {
        let _ = shared.events.send(WatchEvent::Connected);
        info!("watch device connected");
        run_connection(&mut socket, &shared).await;
    }

    shared.active.store(false, Ordering::Release);
    let _ = shared.events.send(WatchEvent::Disconnected);
    info!("watch device disconnected");
}

async fn run_connection(socket: &mut WebSocket, shared: &Arc<SharedState>) {
    let mut last_activity = Instant::now();
    let mut last_sequence: Option<u64> = None;
    let mut time_sync_ticker = tokio::time::interval(TIME_SYNC_INTERVAL);
    let mut pending_time_sync_at: Option<u64> = None;
    let mut clock_offset_samples = VecDeque::with_capacity(CLOCK_OFFSET_SAMPLE_COUNT);

    loop {
        let remaining = shared
            .heartbeat_timeout
            .saturating_sub(last_activity.elapsed());
        if remaining.is_zero() {
            debug!("watch heartbeat timed out");
            break;
        }

        tokio::select! {
            _ = time_sync_ticker.tick() => {
                let desktop_time_ns = now_ns();
                let request = DesktopOutboundEnvelope::new(
                    DESKTOP_TIME_SYNC_TYPE,
                    desktop_time_ns,
                    DesktopTimeSyncPayload { desktop_time_ns },
                );
                if send_json(socket, &request).await.is_err() {
                    break;
                }
                pending_time_sync_at = Some(desktop_time_ns);
            }
            message = tokio::time::timeout(remaining, socket.next()) => {
                match message {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        last_activity = Instant::now();
                        handle_inbound(
                            text.as_bytes(),
                            &mut last_sequence,
                            &mut pending_time_sync_at,
                            &mut clock_offset_samples,
                            shared,
                        );
                    }
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
                    Ok(Some(Ok(_))) => {}
                    Ok(Some(Err(error))) => {
                        warn!(%error, "watch WebSocket receive error");
                        break;
                    }
                    Err(_) => {
                        debug!("watch heartbeat timed out");
                        break;
                    }
                }
            }
        }
    }
}

fn handle_inbound(
    bytes: &[u8],
    last_sequence: &mut Option<u64>,
    pending_time_sync_at: &mut Option<u64>,
    clock_offset_samples: &mut VecDeque<i64>,
    shared: &Arc<SharedState>,
) {
    let envelope = match WatchEnvelope::from_json(bytes) {
        Ok(envelope) => envelope,
        Err(error) => {
            warn!(%error, "ignoring invalid watch message");
            let _ = shared.events.send(WatchEvent::InvalidMessage {
                reason: error.to_string(),
            });
            return;
        }
    };

    if let Some(previous) = *last_sequence
        && envelope.sequence <= previous
    {
        warn!(
            sequence = envelope.sequence,
            previous, "ignoring out-of-order or duplicate watch sequence"
        );
        let _ = shared.events.send(WatchEvent::InvalidMessage {
            reason: format!(
                "out-of-order or duplicate sequence {} (previous {previous})",
                envelope.sequence
            ),
        });
        return;
    }
    *last_sequence = Some(envelope.sequence);

    match envelope.decode() {
        Ok(WatchInboundMessage::Orientation(sample)) => {
            let _ = shared.events.send(WatchEvent::Orientation(sample));
        }
        Ok(WatchInboundMessage::Heartbeat(sample)) => {
            let _ = shared.events.send(WatchEvent::Heartbeat(sample));
        }
        Ok(WatchInboundMessage::TimeSync(sample)) => {
            if let Some(mut estimate) = estimate_clock_offset(sample, pending_time_sync_at.take()) {
                clock_offset_samples.push_back(estimate.offset_ns);
                if clock_offset_samples.len() > CLOCK_OFFSET_SAMPLE_COUNT {
                    clock_offset_samples.pop_front();
                }
                estimate.offset_ns = median_clock_offset(clock_offset_samples);
                let _ = shared.events.send(WatchEvent::ClockOffsetUpdated(estimate));
            }
        }
        Ok(WatchInboundMessage::PpgBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::Ppg(sample));
        }
        Ok(WatchInboundMessage::PpgStatus(sample)) => {
            let _ = shared.events.send(WatchEvent::PpgStatusUpdated(sample));
        }
        Err(error) => {
            warn!(%error, "ignoring unparseable watch message payload");
            let _ = shared.events.send(WatchEvent::InvalidMessage {
                reason: error.to_string(),
            });
        }
    }
}

fn median_clock_offset(samples: &VecDeque<i64>) -> i64 {
    let mut sorted: Vec<_> = samples.iter().copied().collect();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

fn estimate_clock_offset(
    sample: WatchTimeSyncSample,
    pending_desktop_time_ns: Option<u64>,
) -> Option<ClockOffsetEstimate> {
    let sent_at_ns = pending_desktop_time_ns.filter(|&sent| sent == sample.desktop_time_ns)?;
    let received_at_ns = now_ns();
    let round_trip_ns = received_at_ns.saturating_sub(sent_at_ns);
    let offset_ns = sample.watch_time_ns as i64 - (sent_at_ns as i64 + (round_trip_ns / 2) as i64);
    Some(ClockOffsetEstimate {
        offset_ns,
        round_trip_ns,
        estimated_at_ns: received_at_ns,
    })
}

async fn send_json<T: serde::Serialize>(
    socket: &mut WebSocket,
    value: &T,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(value).unwrap_or_default();
    socket.send(Message::Text(text.into())).await
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}
