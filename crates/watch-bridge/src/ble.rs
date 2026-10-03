//! BLE central transport to the watch's GATT server.
//!
//! The watch is the GATT **peripheral**: it advertises
//! [`WATCH_BLE_SERVICE_UUID`], notifies protocol envelopes on
//! [`WATCH_BLE_TELEMETRY_UUID`], and accepts desktop commands as
//! write-with-response on [`WATCH_BLE_COMMAND_UUID`]. The desktop is the
//! **central** — the only role btleplug supports on macOS/Windows/Linux alike,
//! which is why the roles are this way round.
//!
//! The payloads are byte-for-byte the same JSON envelopes the WebSocket
//! transport carries (`docs/protocols/watch-websocket-protocol.md`), so
//! `handle_inbound` and the desktop command encoders are shared verbatim; only
//! the framing below is BLE-specific.
//!
//! ## Trust model
//!
//! Both characteristics are declared on the watch with encrypted ATT
//! permissions, so the OS refuses reads/writes/subscriptions until the two
//! devices are bonded (Bluetooth pairing). On top of that the watch holds an
//! explicit per-central trust gate: until the user approves this desktop's
//! address on the watch, the watch sends no notifications and rejects command
//! writes with an ATT authorization error. The desktop therefore only reports
//! [`BleStatus::Streaming`] once a first valid envelope has actually arrived —
//! being connected and subscribed is *not* treated as connected.

use std::collections::BTreeSet;
use std::time::Duration;

use btleplug::api::{
    Central, CentralEvent, CharPropFlags, Characteristic, Manager as _, Peripheral as _,
    ScanFilter, ValueNotification, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use std::pin::Pin;
use thiserror::Error;
use tracing::{debug, warn};
use uuid::{Uuid, uuid};

/// Stable custom service the watch advertises. Never reuse or renumber these:
/// a desktop build filters scans on the service UUID alone.
pub const WATCH_BLE_SERVICE_UUID: Uuid = uuid!("6b1d0001-9f2a-4c7e-9a1b-2f5a7c3e8d41");
/// Watch → desktop protocol envelopes, delivered as GATT notifications.
pub const WATCH_BLE_TELEMETRY_UUID: Uuid = uuid!("6b1d0002-9f2a-4c7e-9a1b-2f5a7c3e8d41");
/// Desktop → watch commands, delivered as write-with-response.
pub const WATCH_BLE_COMMAND_UUID: Uuid = uuid!("6b1d0003-9f2a-4c7e-9a1b-2f5a7c3e8d41");

/// `[flags][fragment index: u16 big-endian]` prefixed to every ATT payload.
pub const BLE_FRAME_HEADER_LEN: usize = 3;
/// Bit 0 of the flags byte: this fragment completes the message.
const BLE_FRAME_FLAG_FINAL: u8 = 0x01;
/// Hard ceiling on one reassembled envelope. The largest real message is a
/// 32-sample PPG/medical batch (a few KB); anything past this is a desynced or
/// hostile peer, and the reassembler drops the whole message rather than grow.
pub const MAX_BLE_MESSAGE_BYTES: usize = 16 * 1024;
/// Usable ATT payload with the default 23-byte MTU, before framing overhead.
const MIN_ATT_PAYLOAD: usize = 20;
/// Bytes ATT spends on the notification/write opcode + handle.
const ATT_OVERHEAD: usize = 3;

const SCAN_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub const BLE_SCAN_TIMEOUT: Duration = Duration::from_secs(20);
pub const BLE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// What the desktop is currently doing on the BLE path, for the settings UI.
/// `Streaming` is only reached after the watch's trust gate lets real telemetry
/// through — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "camelCase")]
pub enum BleStatus {
    Idle,
    Scanning,
    Connecting,
    /// Connected and subscribed, but the watch has not sent anything yet:
    /// approve this desktop on the watch to start streaming.
    AwaitingWatchTrust,
    Streaming,
    Failed(String),
}

#[derive(Debug, Error)]
pub enum BleError {
    #[error(
        "no Bluetooth adapter available — turn Bluetooth on and grant this app Bluetooth permission"
    )]
    NoAdapter,
    #[error("Bluetooth adapter unavailable or permission denied: {0}")]
    Adapter(#[source] btleplug::Error),
    #[error(
        "no watch advertising the gesture-controls BLE service was found — open the watch app and select the Bluetooth transport"
    )]
    WatchNotFound,
    #[error("failed to connect to the watch over BLE (is it still in range and advertising?): {0}")]
    Connect(#[source] btleplug::Error),
    #[error("failed to discover the watch's GATT services: {0}")]
    Discover(#[source] btleplug::Error),
    #[error(
        "the watch is advertising the service but has no usable {0} characteristic — update the watch app"
    )]
    MissingCharacteristic(&'static str),
    #[error(
        "failed to subscribe to watch telemetry — the watch may need to be paired/bonded with this computer first: {0}"
    )]
    Subscribe(#[source] btleplug::Error),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FramingError {
    #[error("message of {0} bytes exceeds the {MAX_BLE_MESSAGE_BYTES}-byte BLE frame limit")]
    MessageTooLarge(usize),
    #[error("BLE fragment of {0} bytes is shorter than the {BLE_FRAME_HEADER_LEN}-byte header")]
    FragmentTooShort(usize),
    #[error("BLE fragment index {got} arrived while expecting {expected}")]
    OutOfOrderFragment { got: u16, expected: u16 },
}

/// Splits one protocol envelope into ATT-sized fragments. `max_att_payload` is
/// the usable payload of a single notification/write, i.e. `MTU - 3`.
pub fn fragment(message: &[u8], max_att_payload: usize) -> Result<Vec<Vec<u8>>, FramingError> {
    if message.len() > MAX_BLE_MESSAGE_BYTES {
        return Err(FramingError::MessageTooLarge(message.len()));
    }
    let chunk_len = max_att_payload.saturating_sub(BLE_FRAME_HEADER_LEN).max(1);
    let mut fragments = Vec::new();
    // `chunks` yields nothing for an empty message, but an empty envelope is
    // still a message the peer must see terminated, so seed one final fragment.
    let chunks: Vec<&[u8]> = if message.is_empty() {
        vec![&[][..]]
    } else {
        message.chunks(chunk_len).collect()
    };
    let last = chunks.len() - 1;
    for (index, chunk) in chunks.into_iter().enumerate() {
        let mut frame = Vec::with_capacity(BLE_FRAME_HEADER_LEN + chunk.len());
        frame.push(if index == last {
            BLE_FRAME_FLAG_FINAL
        } else {
            0
        });
        frame.extend_from_slice(&(index as u16).to_be_bytes());
        frame.extend_from_slice(chunk);
        fragments.push(frame);
    }
    Ok(fragments)
}

/// Rebuilds envelopes from [`fragment`]'s output. Any gap, reorder, or
/// oversized message drops the partial buffer and reports an error — a
/// half-message is never handed on as if it were complete.
#[derive(Debug, Default)]
pub struct Reassembler {
    buffer: Vec<u8>,
    next_index: u16,
}

impl Reassembler {
    /// Feeds one received ATT payload. `Ok(Some(_))` is a complete envelope.
    pub fn push(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, FramingError> {
        if frame.len() < BLE_FRAME_HEADER_LEN {
            self.reset();
            return Err(FramingError::FragmentTooShort(frame.len()));
        }
        let flags = frame[0];
        let index = u16::from_be_bytes([frame[1], frame[2]]);
        if index != self.next_index {
            let expected = self.next_index;
            self.reset();
            // A fresh message starting at 0 right after a desync is normal
            // (the peer gave up mid-message); take it rather than stalling.
            if index != 0 {
                return Err(FramingError::OutOfOrderFragment {
                    got: index,
                    expected,
                });
            }
        }
        if self.buffer.len() + frame.len() - BLE_FRAME_HEADER_LEN > MAX_BLE_MESSAGE_BYTES {
            let total = self.buffer.len() + frame.len() - BLE_FRAME_HEADER_LEN;
            self.reset();
            return Err(FramingError::MessageTooLarge(total));
        }
        self.buffer
            .extend_from_slice(&frame[BLE_FRAME_HEADER_LEN..]);
        if flags & BLE_FRAME_FLAG_FINAL != 0 {
            let message = std::mem::take(&mut self.buffer);
            self.next_index = 0;
            return Ok(Some(message));
        }
        self.next_index = self.next_index.wrapping_add(1);
        Ok(None)
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.next_index = 0;
    }
}

/// A connected, subscribed BLE link to the watch.
pub struct BleLink {
    peripheral: Peripheral,
    command: Characteristic,
    notifications: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
    reassembler: Reassembler,
    /// First envelope received while waiting on the watch's trust gate, held
    /// so [`BleLink::recv`] still delivers it to the protocol layer.
    pending: Option<Vec<u8>>,
}

/// The device id the desktop assigns a watch it discovered over BLE: derived
/// from the peripheral's own platform identifier (a CoreBluetooth UUID on
/// macOS, the Bluetooth address on Windows, the BlueZ object path on Linux),
/// which is stable for that physical watch on that desktop. Normalized to a
/// short, log- and filename-safe token.
pub fn ble_device_id(peripheral_id: &impl std::fmt::Display) -> String {
    let normalized: String = peripheral_id
        .to_string()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = normalized.trim_matches('-');
    // Collapse the separator runs that path-like ids leave behind.
    let mut out = String::from("ble-");
    let mut previous_dash = true;
    for c in trimmed.chars() {
        if c == '-' {
            if !previous_dash {
                out.push('-');
            }
            previous_dash = true;
        } else {
            out.push(c);
            previous_dash = false;
        }
    }
    out
}

/// Opens the host's first Bluetooth adapter. Held for the whole session so a
/// reconnect doesn't rebuild it, and so a cancelled scan can still be stopped
/// (see [`stop_scan`]).
pub async fn open_adapter() -> Result<Adapter, BleError> {
    let manager = Manager::new().await.map_err(BleError::Adapter)?;
    manager
        .adapters()
        .await
        .map_err(BleError::Adapter)?
        .into_iter()
        .next()
        .ok_or(BleError::NoAdapter)
}

/// Stops any scan left running, e.g. because [`BleLink::connect`] was cancelled
/// partway through and its own cleanup never ran. A leaked scan keeps the radio
/// busy and drains battery on laptops.
pub async fn stop_scan(adapter: &Adapter) {
    if let Err(error) = adapter.stop_scan().await {
        debug!(%error, "stopping the watch BLE scan reported an error");
    }
}

impl BleLink {
    /// The negotiated ATT MTU, or 0 when the backend does not report one.
    pub fn mtu(&self) -> u32 {
        u32::from(self.peripheral.mtu())
    }

    /// This watch's desktop-assigned device id; see [`ble_device_id`].
    pub fn device_id(&self) -> String {
        ble_device_id(&self.peripheral.id())
    }

    /// Scans for, connects to, and subscribes to a watch advertising
    /// [`WATCH_BLE_SERVICE_UUID`]. Every failure carries an actionable message.
    pub async fn connect(adapter: &Adapter, scan_timeout: Duration) -> Result<Self, BleError> {
        let peripheral = scan_for_watch(adapter, scan_timeout).await?;
        peripheral
            .connect_with_timeout(BLE_CONNECT_TIMEOUT)
            .await
            .map_err(BleError::Connect)?;

        // From here on any early return must not leave a half-open GATT
        // connection behind for the OS to keep alive.
        match Self::negotiate(peripheral.clone()).await {
            Ok(link) => Ok(link),
            Err(error) => {
                let _ = peripheral.disconnect().await;
                Err(error)
            }
        }
    }

    async fn negotiate(peripheral: Peripheral) -> Result<Self, BleError> {
        peripheral
            .discover_services_with_timeout(BLE_CONNECT_TIMEOUT)
            .await
            .map_err(BleError::Discover)?;
        let characteristics = peripheral.characteristics();
        let telemetry = find_characteristic(
            &characteristics,
            WATCH_BLE_TELEMETRY_UUID,
            CharPropFlags::NOTIFY,
        )
        .ok_or(BleError::MissingCharacteristic("telemetry (notify)"))?;
        let command = find_characteristic(
            &characteristics,
            WATCH_BLE_COMMAND_UUID,
            CharPropFlags::WRITE,
        )
        .ok_or(BleError::MissingCharacteristic("command (write)"))?;

        // Writes the CCCD on the watch's telemetry characteristic; the watch
        // rejects this until the devices are bonded.
        peripheral
            .subscribe(&telemetry)
            .await
            .map_err(BleError::Subscribe)?;
        let notifications = peripheral
            .notifications()
            .await
            .map_err(BleError::Subscribe)?;

        debug!(
            mtu = peripheral.mtu(),
            "watch BLE link negotiated; command writes use {} byte fragments",
            (peripheral.mtu() as usize)
                .saturating_sub(ATT_OVERHEAD)
                .max(MIN_ATT_PAYLOAD)
        );
        Ok(Self {
            peripheral,
            command,
            notifications,
            reassembler: Reassembler::default(),
            pending: None,
        })
    }

    /// Usable ATT payload for one write, from the negotiated MTU. Backends that
    /// report nothing useful fall back to the 23-byte-MTU guarantee.
    fn att_payload(&self) -> usize {
        (self.peripheral.mtu() as usize)
            .saturating_sub(ATT_OVERHEAD)
            .max(MIN_ATT_PAYLOAD)
    }

    /// Writes one protocol envelope as write-with-response fragments. Using
    /// write-*with*-response is the backpressure mechanism on this direction:
    /// each fragment is acknowledged before the next is sent.
    pub async fn send_text(&mut self, text: &str) -> Result<(), BleError> {
        let fragments = fragment(text.as_bytes(), self.att_payload())
            .map_err(|error| BleError::Connect(btleplug::Error::Other(Box::new(error))))?;
        for frame in fragments {
            self.peripheral
                .write(&self.command, &frame, WriteType::WithResponse)
                .await
                .map_err(BleError::Connect)?;
        }
        Ok(())
    }

    /// Waits up to `timeout` for the watch's trust gate to release a first
    /// envelope. `Some(true)` means trusted (the envelope is buffered for
    /// [`recv`]), `Some(false)` means still waiting, `None` means the link
    /// died.
    ///
    /// [`recv`]: Self::recv
    pub async fn await_first_message(&mut self, timeout: Duration) -> Option<bool> {
        if self.pending.is_some() {
            return Some(true);
        }
        match tokio::time::timeout(timeout, self.recv()).await {
            Ok(Some(message)) => {
                self.pending = Some(message);
                Some(true)
            }
            Ok(None) => None,
            Err(_) => Some(false),
        }
    }

    /// Next complete envelope, or `None` once the link is gone. Malformed
    /// framing is dropped and reported, not surfaced as a message.
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        if let Some(message) = self.pending.take() {
            return Some(message);
        }
        loop {
            let notification = self.notifications.next().await?;
            if notification.uuid != WATCH_BLE_TELEMETRY_UUID {
                continue;
            }
            match self.reassembler.push(&notification.value) {
                Ok(Some(message)) => return Some(message),
                Ok(None) => continue,
                Err(error) => {
                    warn!(%error, "dropping malformed watch BLE fragment");
                    continue;
                }
            }
        }
    }

    /// Tears the GATT connection down, including the notification subscription,
    /// so a later reconnect starts from a clean CCCD/descriptor state.
    pub async fn close(self) {
        let Self {
            peripheral,
            command,
            notifications,
            ..
        } = self;
        drop(notifications);
        drop(command);
        if let Err(error) = peripheral.disconnect().await {
            debug!(%error, "watch BLE disconnect reported an error");
        }
    }
}

fn find_characteristic(
    characteristics: &BTreeSet<Characteristic>,
    uuid: Uuid,
    required: CharPropFlags,
) -> Option<Characteristic> {
    characteristics
        .iter()
        .find(|characteristic| {
            characteristic.uuid == uuid && characteristic.properties.contains(required)
        })
        .cloned()
}

/// Scans until a peripheral advertising [`WATCH_BLE_SERVICE_UUID`] appears.
/// The filter is passed to the backend *and* re-checked here, because backends
/// are allowed to surface devices outside the filter.
async fn scan_for_watch(adapter: &Adapter, timeout: Duration) -> Result<Peripheral, BleError> {
    adapter
        .start_scan(ScanFilter {
            services: vec![WATCH_BLE_SERVICE_UUID],
        })
        .await
        .map_err(BleError::Adapter)?;

    let found = tokio::time::timeout(timeout, async {
        let mut events = adapter.events().await.map_err(BleError::Adapter)?;
        loop {
            // Poll the already-known set first: a watch discovered before this
            // scan started emits no fresh event.
            if let Some(peripheral) = first_matching(adapter).await? {
                return Ok(peripheral);
            }
            match tokio::time::timeout(SCAN_POLL_INTERVAL, events.next()).await {
                Ok(Some(CentralEvent::DeviceDiscovered(_) | CentralEvent::DeviceUpdated(_))) => {}
                Ok(Some(_)) => {}
                Ok(None) => return Err(BleError::WatchNotFound),
                Err(_) => {}
            }
        }
    })
    .await;

    // Stop the radio scanning regardless of the outcome; a leaked scan keeps
    // the adapter busy and drains battery on laptops.
    let _ = adapter.stop_scan().await;
    match found {
        Ok(result) => result,
        Err(_) => Err(BleError::WatchNotFound),
    }
}

async fn first_matching(adapter: &Adapter) -> Result<Option<Peripheral>, BleError> {
    for peripheral in adapter.peripherals().await.map_err(BleError::Adapter)? {
        let advertises = peripheral
            .properties()
            .await
            .ok()
            .flatten()
            .is_some_and(|properties| properties.services.contains(&WATCH_BLE_SERVICE_UUID));
        if advertises {
            return Ok(Some(peripheral));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    #[test]
    fn ble_device_id_is_derived_from_the_peripheral_identifier() {
        // macOS: CoreBluetooth UUID; Windows: Bluetooth address; Linux: BlueZ path.
        assert_eq!(
            ble_device_id(&"5D3F2B1A-9C4E-4F10-8A6B-1234567890AB"),
            "ble-5d3f2b1a-9c4e-4f10-8a6b-1234567890ab"
        );
        assert_eq!(ble_device_id(&"AA:BB:CC:DD:EE:FF"), "ble-aa-bb-cc-dd-ee-ff");
        assert_eq!(
            ble_device_id(&"/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"),
            "ble-org-bluez-hci0-dev-aa-bb-cc-dd-ee-ff"
        );
    }

    #[test]
    fn ble_device_id_tells_two_watches_apart_and_is_stable_for_one() {
        let a = ble_device_id(&"AA:BB:CC:DD:EE:01");
        let b = ble_device_id(&"AA:BB:CC:DD:EE:02");
        assert_ne!(a, b);
        assert_eq!(a, ble_device_id(&"aa:bb:cc:dd:ee:01"));
    }

    #[test]
    fn ble_device_id_is_safe_to_log_and_use_as_a_key() {
        let id = ble_device_id(&"  ../weird id\n");
        assert!(id.starts_with("ble-"));
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert!(!id.ends_with('-'));
    }

    use super::*;

    fn roundtrip(message: &[u8], att_payload: usize) -> Vec<u8> {
        let mut reassembler = Reassembler::default();
        let mut out = None;
        for frame in fragment(message, att_payload).expect("fragmentable") {
            assert!(frame.len() <= att_payload.max(BLE_FRAME_HEADER_LEN + 1));
            if let Some(message) = reassembler.push(&frame).expect("valid fragment") {
                assert!(out.is_none(), "only the final fragment completes a message");
                out = Some(message);
            }
        }
        out.expect("final fragment must complete the message")
    }

    #[test]
    fn single_fragment_message_round_trips() {
        let message = br#"{"type":"watch.heartbeat"}"#;
        assert_eq!(roundtrip(message, 200), message);
    }

    #[test]
    fn multi_fragment_message_round_trips_at_the_minimum_mtu() {
        // 20-byte ATT payload is the default-MTU guarantee: 17 bytes of
        // envelope per fragment, so a real PPG batch spans many fragments.
        let message: Vec<u8> = (0..1000).map(|index| (index % 251) as u8).collect();
        assert_eq!(roundtrip(&message, MIN_ATT_PAYLOAD), message);
    }

    #[test]
    fn empty_message_round_trips() {
        assert_eq!(roundtrip(b"", 20), b"");
    }

    #[test]
    fn oversized_message_is_refused_rather_than_fragmented() {
        let message = vec![0_u8; MAX_BLE_MESSAGE_BYTES + 1];
        assert_eq!(
            fragment(&message, 200),
            Err(FramingError::MessageTooLarge(MAX_BLE_MESSAGE_BYTES + 1))
        );
    }

    #[test]
    fn dropped_middle_fragment_is_reported_and_does_not_yield_a_partial_message() {
        let message: Vec<u8> = (0..200).map(|index| index as u8).collect();
        let fragments = fragment(&message, 20).expect("fragmentable");
        assert!(fragments.len() > 3);
        let mut reassembler = Reassembler::default();
        assert_eq!(reassembler.push(&fragments[0]), Ok(None));
        // Skip fragments[1].
        assert_eq!(
            reassembler.push(&fragments[2]),
            Err(FramingError::OutOfOrderFragment {
                got: 2,
                expected: 1
            })
        );
        // Everything buffered so far is discarded, so replaying the tail can
        // never produce a truncated "complete" message.
        for frame in &fragments[3..] {
            assert!(matches!(reassembler.push(frame), Err(_) | Ok(None)));
        }
    }

    #[test]
    fn reassembler_recovers_on_the_next_message_after_a_desync() {
        let mut reassembler = Reassembler::default();
        let truncated = fragment(&[7_u8; 100], 20).expect("fragmentable");
        assert_eq!(reassembler.push(&truncated[0]), Ok(None));
        // Peer gave up and started a fresh message at index 0.
        let fresh = fragment(b"{\"type\":\"watch.button\"}", 200).expect("fragmentable");
        assert_eq!(
            reassembler.push(&fresh[0]),
            Ok(Some(b"{\"type\":\"watch.button\"}".to_vec()))
        );
    }

    #[test]
    fn runt_fragment_shorter_than_the_header_is_refused() {
        let mut reassembler = Reassembler::default();
        assert_eq!(
            reassembler.push(&[0x01, 0x00]),
            Err(FramingError::FragmentTooShort(2))
        );
    }

    #[test]
    fn a_peer_claiming_an_endless_message_is_cut_off_at_the_bound() {
        let mut reassembler = Reassembler::default();
        let mut index: u16 = 0;
        loop {
            let mut frame = vec![0_u8];
            frame.extend_from_slice(&index.to_be_bytes());
            frame.extend_from_slice(&[0_u8; 200]);
            match reassembler.push(&frame) {
                Ok(None) => index = index.wrapping_add(1),
                Err(FramingError::MessageTooLarge(_)) => break,
                other => panic!("unexpected {other:?}"),
            }
            assert!(index < 1000, "bound must trip long before this");
        }
    }
}
