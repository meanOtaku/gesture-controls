//! Axum WebSocket server that accepts a single Galaxy Watch connection.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::StreamExt;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use spatial_protocol::{
    CONTROLLABLE_SENSOR_IDS, DESKTOP_CONNECTED_TYPE, DESKTOP_HAPTIC_TYPE,
    DESKTOP_SET_SENSOR_RATE_TYPE, DESKTOP_SET_SENSOR_TYPE, DESKTOP_START_MEASUREMENT_TYPE,
    DESKTOP_STOP_MEASUREMENT_TYPE, DESKTOP_TIME_SYNC_TYPE, DesktopConnectedPayload,
    DesktopHapticPayload, DesktopMeasurementCommandPayload, DesktopOutboundEnvelope,
    DesktopSensorControlPayload, DesktopSensorRateCommandPayload, DesktopTimeSyncPayload,
    MAX_HAPTIC_DURATION_MS, MAX_PPG_FLUSH_RATE_HZ, MAX_SENSOR_RATE_HZ, MIN_HAPTIC_DURATION_MS,
    MIN_PPG_FLUSH_RATE_HZ, MIN_SENSOR_RATE_HZ, ON_DEMAND_MEDICAL_TRACKER_IDS,
    RATE_CONTROLLABLE_SENSOR_IDS, SENSOR_PPG_FLUSH, WATCH_PROTOCOL_VERSION, WatchBiaResultSample,
    WatchButtonSample, WatchEcgBatchSample, WatchEdaBatchSample, WatchEnvelope,
    WatchHeartRateBatchSample, WatchHeartbeatSample, WatchInboundMessage, WatchMedicalStatusSample,
    WatchOrientationSample, WatchPpgBatchSample, WatchPpgStatusSample, WatchSensorStatusSample,
    WatchSkinTemperatureBatchSample, WatchSpo2BatchSample, WatchSweatLossBatchSample,
    WatchTimeSyncSample,
};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

pub const WATCH_WEBSOCKET_PATH: &str = "/ws/watch";
/// Stable DNS-SD service type this bridge advertises itself under on the LAN.
pub const MDNS_SERVICE_TYPE: &str = "_gesture-controls._tcp.local.";
pub const WATCH_PAIRING_SERVICE_TYPE: &str = "_gesture-watch._tcp.local.";
const MDNS_INSTANCE_NAME: &str = "galaxy-watch-bridge";
const MDNS_HOST_NAME: &str = "gesture-controls-desktop.local.";
const MDNS_UNREGISTER_TIMEOUT: Duration = Duration::from_millis(500);
const PAIRING_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const PAIRING_RETRY_INTERVAL: Duration = Duration::from_secs(10);
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
    Button(WatchButtonSample),
    HeartRate(WatchHeartRateBatchSample),
    SkinTemperature(WatchSkinTemperatureBatchSample),
    Eda(WatchEdaBatchSample),
    Spo2(WatchSpo2BatchSample),
    Ecg(WatchEcgBatchSample),
    BiaResult(WatchBiaResultSample),
    SweatLoss(WatchSweatLossBatchSample),
    MedicalStatusUpdated(WatchMedicalStatusSample),
    SensorStatusUpdated(WatchSensorStatusSample),
    InvalidMessage { reason: String },
}

/// A desktop-initiated command to start or stop a bounded on-demand medical
/// measurement session on the watch (see [`ON_DEMAND_MEDICAL_TRACKER_IDS`]).
#[derive(Debug, Clone, PartialEq)]
pub enum MeasurementCommand {
    Start(String),
    Stop(String),
}

/// A desktop-initiated command to enable or disable an always-available IMU
/// input or continuous medical tracker (see [`CONTROLLABLE_SENSOR_IDS`]),
/// unlike [`MeasurementCommand`]'s bounded on-demand sessions.
#[derive(Debug, Clone, PartialEq)]
pub enum SensorControlCommand {
    Enable(String),
    Disable(String),
}

/// A desktop-initiated per-sensor sampling-rate request for [`IMU_SENSOR_IDS`]
/// (see `desktop.set_sensor_rate`). Medical trackers are never rate-controlled.
#[derive(Debug, Clone, PartialEq)]
pub struct SensorRateCommand {
    pub sensor: String,
    pub rate_hz: f64,
}

/// A desktop-initiated short haptic pulse on the watch (see `desktop.haptic`).
/// `duration_ms` is bounded by [`MIN_HAPTIC_DURATION_MS`]..=[`MAX_HAPTIC_DURATION_MS`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HapticCommand {
    pub duration_ms: u32,
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
    #[error("failed to start mDNS daemon: {0}")]
    MdnsDaemonFailed(#[source] mdns_sd::Error),
    #[error("failed to build mDNS service info: {0}")]
    MdnsServiceInfoFailed(#[source] mdns_sd::Error),
    #[error("failed to register mDNS service: {0}")]
    MdnsRegisterFailed(#[source] mdns_sd::Error),
    #[error("failed to browse for watch pairing services: {0}")]
    MdnsBrowseFailed(#[source] mdns_sd::Error),
    #[error("no watch is currently connected")]
    NoActiveConnection,
    #[error("'{0}' is not a valid on-demand medical tracker id")]
    UnknownMeasurementTracker(String),
    #[error("'{0}' is not a valid controllable sensor id")]
    UnknownControllableSensor(String),
    #[error("'{0}' is not a rate-controllable sensor id")]
    UnknownRateControllableSensor(String),
    #[error("sensor rate {0}Hz is outside the allowed range for that control")]
    SensorRateOutOfRange(f64),
    #[error("haptic duration {0}ms is outside the allowed range")]
    HapticDurationOutOfRange(u32),
}

struct SharedState {
    events: broadcast::Sender<WatchEvent>,
    commands: broadcast::Sender<MeasurementCommand>,
    sensor_commands: broadcast::Sender<SensorControlCommand>,
    sensor_rate_commands: broadcast::Sender<SensorRateCommand>,
    haptic_commands: broadcast::Sender<HapticCommand>,
    active: AtomicBool,
    heartbeat_timeout: Duration,
}

/// A registered mDNS/DNS-SD advertisement, kept alive until unregistered.
struct MdnsAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

/// Browses for the watch's local pairing service and asks it to connect back
/// to this desktop bridge. The outgoing request lets the watch derive the
/// correct LAN address from the TCP peer, avoiding typed IP addresses.
struct WatchPairingDiscovery {
    daemon: ServiceDaemon,
    task: thread::JoinHandle<()>,
}

pub struct WatchBridgeServer {
    local_addr: SocketAddr,
    listener: Mutex<Option<TcpListener>>,
    task: Mutex<Option<JoinHandle<()>>>,
    mdns: Mutex<Option<MdnsAdvertisement>>,
    pairing_discovery: Mutex<Option<WatchPairingDiscovery>>,
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
        let (commands, _) = broadcast::channel(16);
        let (sensor_commands, _) = broadcast::channel(16);
        let (sensor_rate_commands, _) = broadcast::channel(16);
        let (haptic_commands, _) = broadcast::channel(16);
        Ok(Self {
            local_addr,
            listener: Mutex::new(Some(listener)),
            task: Mutex::new(None),
            mdns: Mutex::new(None),
            pairing_discovery: Mutex::new(None),
            shared: Arc::new(SharedState {
                events,
                commands,
                sensor_commands,
                sensor_rate_commands,
                haptic_commands,
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

    /// Sends a [`MeasurementCommand`] to the connected watch, starting or
    /// stopping a bounded on-demand medical measurement session. Errors if no
    /// watch is connected or `tracker` isn't one of
    /// [`ON_DEMAND_MEDICAL_TRACKER_IDS`] — this never applies to the
    /// continuous trackers, which start automatically alongside PPG.
    pub fn send_measurement_command(
        &self,
        command: MeasurementCommand,
    ) -> Result<(), WatchBridgeError> {
        let tracker = match &command {
            MeasurementCommand::Start(tracker) | MeasurementCommand::Stop(tracker) => tracker,
        };
        if !ON_DEMAND_MEDICAL_TRACKER_IDS.contains(&tracker.as_str()) {
            return Err(WatchBridgeError::UnknownMeasurementTracker(tracker.clone()));
        }
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(WatchBridgeError::NoActiveConnection);
        }
        let _ = self.shared.commands.send(command);
        Ok(())
    }

    /// Sends a [`SensorControlCommand`] to the connected watch, enabling or
    /// disabling an IMU input or continuous medical tracker. Errors if no
    /// watch is connected or `sensor` isn't one of [`CONTROLLABLE_SENSOR_IDS`]
    /// — on-demand trackers use [`send_measurement_command`] instead.
    ///
    /// [`send_measurement_command`]: Self::send_measurement_command
    pub fn send_sensor_control_command(
        &self,
        command: SensorControlCommand,
    ) -> Result<(), WatchBridgeError> {
        let sensor = match &command {
            SensorControlCommand::Enable(sensor) | SensorControlCommand::Disable(sensor) => sensor,
        };
        if !CONTROLLABLE_SENSOR_IDS.contains(&sensor.as_str()) {
            return Err(WatchBridgeError::UnknownControllableSensor(sensor.clone()));
        }
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(WatchBridgeError::NoActiveConnection);
        }
        let _ = self.shared.sensor_commands.send(command);
        Ok(())
    }

    /// Sends a [`SensorRateCommand`] to the connected watch, requesting a new
    /// sampling rate for one IMU sensor (see [`IMU_SENSOR_IDS`]). Errors if no
    /// watch is connected, `sensor` isn't IMU-controllable, or `rate_hz` falls
    /// outside [`MIN_SENSOR_RATE_HZ`]..=[`MAX_SENSOR_RATE_HZ`]. Medical
    /// trackers are never rate-controlled.
    pub fn send_sensor_rate_command(
        &self,
        command: SensorRateCommand,
    ) -> Result<(), WatchBridgeError> {
        if !RATE_CONTROLLABLE_SENSOR_IDS.contains(&command.sensor.as_str()) {
            return Err(WatchBridgeError::UnknownRateControllableSensor(
                command.sensor.clone(),
            ));
        }
        let range = if command.sensor == SENSOR_PPG_FLUSH {
            MIN_PPG_FLUSH_RATE_HZ..=MAX_PPG_FLUSH_RATE_HZ
        } else {
            MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ
        };
        if !command.rate_hz.is_finite() || !range.contains(&command.rate_hz) {
            return Err(WatchBridgeError::SensorRateOutOfRange(command.rate_hz));
        }
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(WatchBridgeError::NoActiveConnection);
        }
        let _ = self.shared.sensor_rate_commands.send(command);
        Ok(())
    }

    /// Sends a [`HapticCommand`] to the connected watch, triggering a short,
    /// bounded haptic pulse. Errors if no watch is connected or `duration_ms`
    /// falls outside [`MIN_HAPTIC_DURATION_MS`]..=[`MAX_HAPTIC_DURATION_MS`].
    pub fn send_haptic_command(&self, command: HapticCommand) -> Result<(), WatchBridgeError> {
        if !(MIN_HAPTIC_DURATION_MS..=MAX_HAPTIC_DURATION_MS).contains(&command.duration_ms) {
            return Err(WatchBridgeError::HapticDurationOutOfRange(
                command.duration_ms,
            ));
        }
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(WatchBridgeError::NoActiveConnection);
        }
        let _ = self.shared.haptic_commands.send(command);
        Ok(())
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
        drop(task_guard);

        // Advertisement is best-effort: a network that blocks multicast (or a
        // platform without it) shouldn't prevent the WebSocket server itself
        // from serving a manually entered endpoint.
        if let Err(error) = self.advertise() {
            warn!(%error, "failed to advertise watch bridge via mDNS");
        }
        if let Err(error) = self.start_pairing_discovery() {
            warn!(%error, "failed to browse for watch pairing services");
        }
        Ok(())
    }

    fn start_pairing_discovery(&self) -> Result<(), WatchBridgeError> {
        let daemon = ServiceDaemon::new().map_err(WatchBridgeError::MdnsDaemonFailed)?;
        let receiver = daemon
            .browse(WATCH_PAIRING_SERVICE_TYPE)
            .map_err(WatchBridgeError::MdnsBrowseFailed)?;
        let task = thread::spawn(move || {
            let mut last_attempt: HashMap<SocketAddr, Instant> = HashMap::new();
            while let Ok(event) = receiver.recv() {
                let ServiceEvent::ServiceResolved(service) = event else {
                    continue;
                };
                let Some(address) = service.get_addresses_v4().into_iter().min() else {
                    continue;
                };
                let watch = SocketAddr::from((address, service.get_port()));
                let now = Instant::now();
                if last_attempt
                    .get(&watch)
                    .is_some_and(|previous| now.duration_since(*previous) < PAIRING_RETRY_INTERVAL)
                {
                    continue;
                }
                last_attempt.insert(watch, now);
                match request_watch_pairing(watch) {
                    Ok(()) => info!(%watch, "requested watch pairing via mDNS discovery"),
                    Err(error) => warn!(%watch, %error, "watch pairing request failed"),
                }
            }
        });
        *self
            .pairing_discovery
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)? =
            Some(WatchPairingDiscovery { daemon, task });
        Ok(())
    }

    /// Publishes this server under [`MDNS_SERVICE_TYPE`] so LAN clients can discover it
    /// automatically. Only call once the listener is confirmed bound and serving.
    fn advertise(&self) -> Result<(), WatchBridgeError> {
        let daemon = ServiceDaemon::new().map_err(WatchBridgeError::MdnsDaemonFailed)?;
        let version = WATCH_PROTOCOL_VERSION.to_string();
        let txt = [
            ("protocol", "ws"),
            ("path", WATCH_WEBSOCKET_PATH),
            ("version", version.as_str()),
        ];
        let service = ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            MDNS_INSTANCE_NAME,
            MDNS_HOST_NAME,
            "",
            self.local_addr.port(),
            &txt[..],
        )
        .map_err(WatchBridgeError::MdnsServiceInfoFailed)?
        .enable_addr_auto();
        let fullname = service.get_fullname().to_string();

        daemon
            .register(service)
            .map_err(WatchBridgeError::MdnsRegisterFailed)?;
        info!(
            service_type = MDNS_SERVICE_TYPE,
            port = self.local_addr.port(),
            "advertising watch bridge via mDNS"
        );

        *self
            .mdns
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)? =
            Some(MdnsAdvertisement { daemon, fullname });
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

        let advertisement = self
            .mdns
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)?
            .take();
        if let Some(MdnsAdvertisement { daemon, fullname }) = advertisement {
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(receiver) = daemon.unregister(&fullname) {
                    let _ = receiver.recv_timeout(MDNS_UNREGISTER_TIMEOUT);
                }
                if let Ok(receiver) = daemon.shutdown() {
                    let _ = receiver.recv_timeout(MDNS_UNREGISTER_TIMEOUT);
                }
            })
            .await;
        }

        let pairing_discovery = self
            .pairing_discovery
            .lock()
            .map_err(|_| WatchBridgeError::StatePoisoned)?
            .take();
        if let Some(WatchPairingDiscovery { daemon, task }) = pairing_discovery {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = daemon.shutdown();
                let _ = task.join();
            })
            .await;
        }
        Ok(())
    }
}

fn request_watch_pairing(watch: SocketAddr) -> std::io::Result<()> {
    let mut stream = TcpStream::connect_timeout(&watch, PAIRING_CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(PAIRING_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(PAIRING_CONNECT_TIMEOUT))?;
    stream.write_all(
        b"GET /pair HTTP/1.1\r\nHost: gesture-watch.local\r\nConnection: close\r\n\r\n",
    )?;
    let mut response = [0_u8; 128];
    let bytes_read = stream.read(&mut response)?;
    if response[..bytes_read].starts_with(b"HTTP/1.1 2") {
        Ok(())
    } else {
        Err(std::io::Error::other("watch rejected pairing request"))
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
    let mut commands = shared.commands.subscribe();
    let mut sensor_commands = shared.sensor_commands.subscribe();
    let mut sensor_rate_commands = shared.sensor_rate_commands.subscribe();
    let mut haptic_commands = shared.haptic_commands.subscribe();

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
            command = commands.recv() => {
                let (message_type, tracker) = match command {
                    Ok(MeasurementCommand::Start(tracker)) => (DESKTOP_START_MEASUREMENT_TYPE, tracker),
                    Ok(MeasurementCommand::Stop(tracker)) => (DESKTOP_STOP_MEASUREMENT_TYPE, tracker),
                    Err(_) => continue,
                };
                let request = DesktopOutboundEnvelope::new(
                    message_type,
                    now_ns(),
                    DesktopMeasurementCommandPayload { tracker },
                );
                if send_json(socket, &request).await.is_err() {
                    break;
                }
            }
            command = sensor_commands.recv() => {
                let (sensor, enabled) = match command {
                    Ok(SensorControlCommand::Enable(sensor)) => (sensor, true),
                    Ok(SensorControlCommand::Disable(sensor)) => (sensor, false),
                    Err(_) => continue,
                };
                let request = DesktopOutboundEnvelope::new(
                    DESKTOP_SET_SENSOR_TYPE,
                    now_ns(),
                    DesktopSensorControlPayload { sensor, enabled },
                );
                if send_json(socket, &request).await.is_err() {
                    break;
                }
            }
            command = sensor_rate_commands.recv() => {
                let SensorRateCommand { sensor, rate_hz } = match command {
                    Ok(command) => command,
                    Err(_) => continue,
                };
                let request = DesktopOutboundEnvelope::new(
                    DESKTOP_SET_SENSOR_RATE_TYPE,
                    now_ns(),
                    DesktopSensorRateCommandPayload { sensor, rate_hz },
                );
                if send_json(socket, &request).await.is_err() {
                    break;
                }
            }
            command = haptic_commands.recv() => {
                let HapticCommand { duration_ms } = match command {
                    Ok(command) => command,
                    Err(_) => continue,
                };
                let request = DesktopOutboundEnvelope::new(
                    DESKTOP_HAPTIC_TYPE,
                    now_ns(),
                    DesktopHapticPayload { duration_ms },
                );
                if send_json(socket, &request).await.is_err() {
                    break;
                }
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
        Ok(WatchInboundMessage::Button(sample)) => {
            let _ = shared.events.send(WatchEvent::Button(sample));
        }
        Ok(WatchInboundMessage::HeartRateBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::HeartRate(sample));
        }
        Ok(WatchInboundMessage::SkinTemperatureBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::SkinTemperature(sample));
        }
        Ok(WatchInboundMessage::EdaBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::Eda(sample));
        }
        Ok(WatchInboundMessage::Spo2Batch(sample)) => {
            let _ = shared.events.send(WatchEvent::Spo2(sample));
        }
        Ok(WatchInboundMessage::EcgBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::Ecg(sample));
        }
        Ok(WatchInboundMessage::BiaResult(sample)) => {
            let _ = shared.events.send(WatchEvent::BiaResult(sample));
        }
        Ok(WatchInboundMessage::SweatLossBatch(sample)) => {
            let _ = shared.events.send(WatchEvent::SweatLoss(sample));
        }
        Ok(WatchInboundMessage::MedicalStatus(sample)) => {
            let _ = shared.events.send(WatchEvent::MedicalStatusUpdated(sample));
        }
        Ok(WatchInboundMessage::SensorStatus(sample)) => {
            let _ = shared.events.send(WatchEvent::SensorStatusUpdated(sample));
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
