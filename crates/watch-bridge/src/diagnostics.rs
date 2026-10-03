//! A running account of what the watch link is doing and why: its phase, how long it has been
//! up, how often and why it ended, how fast writes complete, the longest silence, and a short
//! history of events. Shared by the Bluetooth and Wi-Fi transports and surfaced in the desktop's
//! "Link health" card, so a drop is explained by the app itself instead of by reading logs.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Most recent events kept; older ones fall off the front.
const MAX_EVENTS: usize = 60;

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkEvent {
    pub at_unix_ms: u64,
    /// `info`, `warn` or `error`.
    pub level: &'static str,
    pub message: String,
}

/// Why the last session ended.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkEnd {
    pub at_unix_ms: u64,
    /// A stable machine-readable reason: `heartbeat_timeout`, `stream_closed`, `write_failed`,
    /// `cancelled`.
    pub reason: &'static str,
    /// The same, in words.
    pub detail: String,
    pub session_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkDiagnostics {
    /// `bluetooth` or `wifi`, once a transport has been started.
    pub transport: Option<&'static str>,
    /// The watch this link is about, as far as it is known: a Wi-Fi address, or a Bluetooth watch's
    /// short id and signal strength.
    pub peer: Option<String>,
    /// `idle`, `scanning`, `connecting`, `awaiting_trust`, `streaming`, `failed`.
    pub phase: &'static str,
    pub phase_detail: Option<String>,
    /// Sessions that reached streaming.
    pub sessions: u32,
    /// Sessions that ended without the desktop asking for it.
    pub drops: u32,
    pub scan_attempts: u32,
    pub connected_since_unix_ms: Option<u64>,
    pub last_message_unix_ms: Option<u64>,
    pub last_end: Option<LinkEnd>,
    pub messages_received: u64,
    pub invalid_messages: u64,
    pub out_of_order_messages: u64,
    pub writes: u64,
    pub write_failures: u64,
    pub write_last_ms: Option<u64>,
    /// Slowest write this session.
    pub write_max_ms: Option<u64>,
    /// Longest silence between two messages this session.
    pub max_gap_ms: Option<u64>,
    /// Negotiated ATT MTU (Bluetooth).
    pub mtu: Option<u32>,
    /// When the next attempt starts, while waiting to retry.
    pub retry_in_ms: Option<u64>,
    pub events: Vec<LinkEvent>,
}

#[derive(Default)]
struct Inner {
    data: LinkDiagnostics,
    events: VecDeque<LinkEvent>,
    session_started: Option<Instant>,
}

#[derive(Default)]
pub struct LinkLog {
    inner: Mutex<Inner>,
}

impl LinkLog {
    fn with<R>(&self, apply: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        self.inner.lock().ok().map(|mut guard| apply(&mut guard))
    }

    fn push(inner: &mut Inner, level: &'static str, message: String) {
        if inner.events.len() == MAX_EVENTS {
            inner.events.pop_front();
        }
        inner.events.push_back(LinkEvent {
            at_unix_ms: unix_ms(),
            level,
            message,
        });
    }

    pub fn event(&self, level: &'static str, message: impl Into<String>) {
        let message = message.into();
        self.with(|inner| Self::push(inner, level, message));
    }

    /// Records a phase change; repeating the current phase with the same detail is ignored so
    /// the history is transitions, not a heartbeat.
    pub fn phase(&self, phase: &'static str, detail: Option<String>) {
        self.with(|inner| {
            if inner.data.phase == phase && inner.data.phase_detail == detail {
                return;
            }
            let level = if phase == "failed" { "warn" } else { "info" };
            let message = match &detail {
                Some(detail) => format!("{phase}: {detail}"),
                None => phase.to_string(),
            };
            inner.data.phase = phase;
            inner.data.phase_detail = detail;
            if phase != "failed" {
                inner.data.retry_in_ms = None;
            }
            Self::push(inner, level, message);
        });
    }

    pub fn transport(&self, transport: &'static str) {
        self.with(|inner| inner.data.transport = Some(transport));
    }

    pub fn peer(&self, peer: Option<String>) {
        self.with(|inner| inner.data.peer = peer);
    }

    pub fn scan_started(&self) {
        self.with(|inner| inner.data.scan_attempts += 1);
    }

    pub fn retry_in(&self, delay: Duration) {
        self.with(|inner| inner.data.retry_in_ms = Some(delay.as_millis() as u64));
    }

    pub fn session_started(&self, mtu: Option<u32>) {
        self.with(|inner| {
            inner.data.sessions += 1;
            inner.data.connected_since_unix_ms = Some(unix_ms());
            inner.data.last_message_unix_ms = None;
            inner.data.write_max_ms = None;
            inner.data.max_gap_ms = None;
            inner.data.mtu = mtu;
            inner.session_started = Some(Instant::now());
            let message = match mtu {
                Some(mtu) => format!("session started (MTU {mtu})"),
                None => "session started".to_string(),
            };
            Self::push(inner, "info", message);
        });
    }

    /// `expected` is a session the desktop ended on purpose (a stop or a transport switch).
    pub fn session_ended(&self, reason: &'static str, detail: impl Into<String>, expected: bool) {
        let detail = detail.into();
        self.with(|inner| {
            let session_seconds = inner
                .session_started
                .take()
                .map(|started| started.elapsed().as_secs())
                .unwrap_or(0);
            if !expected {
                inner.data.drops += 1;
            }
            inner.data.connected_since_unix_ms = None;
            inner.data.last_end = Some(LinkEnd {
                at_unix_ms: unix_ms(),
                reason,
                detail: detail.clone(),
                session_seconds,
            });
            let level = if expected { "info" } else { "warn" };
            Self::push(
                inner,
                level,
                format!("session ended after {session_seconds}s: {detail}"),
            );
        });
    }

    pub fn message_received(&self, gap: Duration) {
        self.with(|inner| {
            inner.data.messages_received += 1;
            inner.data.last_message_unix_ms = Some(unix_ms());
            let gap_ms = gap.as_millis() as u64;
            if inner.data.max_gap_ms.is_none_or(|max| gap_ms > max) {
                inner.data.max_gap_ms = Some(gap_ms);
            }
        });
    }

    pub fn invalid_message(&self) {
        self.with(|inner| inner.data.invalid_messages += 1);
    }

    pub fn out_of_order_message(&self) {
        self.with(|inner| inner.data.out_of_order_messages += 1);
    }

    pub fn write_finished(&self, elapsed: Duration, ok: bool) {
        self.with(|inner| {
            let elapsed_ms = elapsed.as_millis() as u64;
            inner.data.writes += 1;
            if !ok {
                inner.data.write_failures += 1;
            }
            inner.data.write_last_ms = Some(elapsed_ms);
            if inner.data.write_max_ms.is_none_or(|max| elapsed_ms > max) {
                inner.data.write_max_ms = Some(elapsed_ms);
            }
        });
    }

    pub fn snapshot(&self) -> LinkDiagnostics {
        self.with(|inner| {
            let mut data = inner.data.clone();
            if data.phase.is_empty() {
                data.phase = "idle";
            }
            data.events = inner.events.iter().cloned().collect();
            data
        })
        .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_log_reads_as_idle_with_nothing_recorded() {
        let snapshot = LinkLog::default().snapshot();
        assert_eq!(snapshot.phase, "idle");
        assert_eq!(snapshot.sessions, 0);
        assert!(snapshot.events.is_empty());
    }

    #[test]
    fn repeating_a_phase_does_not_flood_the_history() {
        let log = LinkLog::default();
        log.phase("scanning", None);
        log.phase("scanning", None);
        log.phase("connecting", None);
        let messages: Vec<_> = log
            .snapshot()
            .events
            .into_iter()
            .map(|e| e.message)
            .collect();
        assert_eq!(messages, vec!["scanning", "connecting"]);
    }

    #[test]
    fn a_session_counts_drops_only_when_the_desktop_did_not_ask_for_the_end() {
        let log = LinkLog::default();
        log.session_started(Some(517));
        log.session_ended("heartbeat_timeout", "no message for 3 s", false);
        log.session_started(None);
        log.session_ended("cancelled", "stopped by the desktop", true);
        let snapshot = log.snapshot();
        assert_eq!(snapshot.sessions, 2);
        assert_eq!(snapshot.drops, 1);
        assert_eq!(snapshot.last_end.unwrap().reason, "cancelled");
        assert!(snapshot.connected_since_unix_ms.is_none());
    }

    #[test]
    fn a_new_session_resets_the_per_session_extremes_but_not_the_totals() {
        let log = LinkLog::default();
        log.session_started(Some(23));
        log.message_received(Duration::from_millis(2300));
        log.write_finished(Duration::from_millis(3190), true);
        assert_eq!(log.snapshot().max_gap_ms, Some(2300));
        assert_eq!(log.snapshot().write_max_ms, Some(3190));
        log.session_started(Some(517));
        let snapshot = log.snapshot();
        assert_eq!(snapshot.max_gap_ms, None);
        assert_eq!(snapshot.write_max_ms, None);
        assert_eq!(snapshot.mtu, Some(517));
        assert_eq!(snapshot.messages_received, 1);
        assert_eq!(snapshot.writes, 1);
    }

    #[test]
    fn extremes_keep_the_largest_value_and_failures_are_counted() {
        let log = LinkLog::default();
        log.message_received(Duration::from_millis(40));
        log.message_received(Duration::from_millis(900));
        log.message_received(Duration::from_millis(60));
        log.write_finished(Duration::from_millis(30), true);
        log.write_finished(Duration::from_millis(400), false);
        log.write_finished(Duration::from_millis(50), true);
        let snapshot = log.snapshot();
        assert_eq!(snapshot.max_gap_ms, Some(900));
        assert_eq!(snapshot.write_max_ms, Some(400));
        assert_eq!(snapshot.write_last_ms, Some(50));
        assert_eq!(snapshot.writes, 3);
        assert_eq!(snapshot.write_failures, 1);
    }

    #[test]
    fn the_event_history_is_bounded_and_keeps_the_newest() {
        let log = LinkLog::default();
        for index in 0..(MAX_EVENTS + 25) {
            log.event("info", format!("event {index}"));
        }
        let events = log.snapshot().events;
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(
            events.last().unwrap().message,
            format!("event {}", MAX_EVENTS + 24)
        );
        assert_eq!(events.first().unwrap().message, "event 25");
    }

    #[test]
    fn leaving_the_failed_phase_clears_the_retry_countdown() {
        let log = LinkLog::default();
        log.phase("failed", Some("watch not found".into()));
        log.retry_in(Duration::from_secs(2));
        assert_eq!(log.snapshot().retry_in_ms, Some(2000));
        log.phase("scanning", None);
        assert_eq!(log.snapshot().retry_in_ms, None);
    }
}
