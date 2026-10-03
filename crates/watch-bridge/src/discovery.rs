//! The desktop side of Wi-Fi discovery: which watches are on the network, and which of them
//! to ask (again) to connect. The watch is passive, so everything that makes a connection happen
//! is decided here. Kept free of sockets and clocks it does not own, so the timing rules can be
//! tested directly.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

struct Attempt {
    at: Instant,
    ok: bool,
}

/// What a watch's pairing server has been seen to do, so a log shows changes and not repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptChange {
    /// First answer from this watch.
    First,
    /// Answered differently from last time (it started answering, or stopped).
    Changed,
    /// Same result as last time: nothing worth saying.
    Same,
}

#[derive(Default)]
pub struct WatchRoster {
    /// mDNS service name -> the address its pairing server answers on.
    known: HashMap<String, SocketAddr>,
    attempts: HashMap<SocketAddr, Attempt>,
}

impl WatchRoster {
    /// A watch's pairing service was resolved. Returns true when it is new, or has moved to a
    /// different address (a watch that rejoined the network usually has).
    pub fn seen(&mut self, service_name: String, address: SocketAddr) -> bool {
        let previous = self.known.insert(service_name, address);
        if let Some(previous) = previous.filter(|previous| *previous != address) {
            self.attempts.remove(&previous);
        }
        previous != Some(address)
    }

    /// The service went away (the watch left the network or its app stopped). Returns where it was.
    pub fn removed(&mut self, service_name: &str) -> Option<SocketAddr> {
        let address = self.known.remove(service_name)?;
        self.attempts.remove(&address);
        Some(address)
    }

    pub fn is_empty(&self) -> bool {
        self.known.is_empty()
    }

    /// The watches that should be asked to connect now: every known one that has not been asked
    /// within `retry`. Sorted so the order is stable.
    pub fn due(&self, now: Instant, retry: Duration) -> Vec<SocketAddr> {
        let mut due: Vec<SocketAddr> = self
            .known
            .values()
            .copied()
            .filter(|address| {
                self.attempts
                    .get(address)
                    .is_none_or(|attempt| now.duration_since(attempt.at) >= retry)
            })
            .collect();
        due.sort();
        due.dedup();
        due
    }

    /// Records the outcome of asking `address` to connect.
    pub fn record(&mut self, address: SocketAddr, now: Instant, ok: bool) -> AttemptChange {
        let change = match self.attempts.get(&address) {
            None => AttemptChange::First,
            Some(previous) if previous.ok != ok => AttemptChange::Changed,
            Some(_) => AttemptChange::Same,
        };
        self.attempts.insert(address, Attempt { at: now, ok });
        change
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(last: u8) -> SocketAddr {
        SocketAddr::from(([192, 168, 1, last], 34000))
    }

    const RETRY: Duration = Duration::from_secs(10);

    #[test]
    fn a_watch_is_due_as_soon_as_it_is_seen_and_again_only_after_the_retry_interval() {
        let mut roster = WatchRoster::default();
        let start = Instant::now();
        assert!(roster.seen("watch".into(), address(5)));
        assert_eq!(roster.due(start, RETRY), vec![address(5)]);
        roster.record(address(5), start, true);
        assert!(roster.due(start + Duration::from_secs(9), RETRY).is_empty());
        assert_eq!(roster.due(start + RETRY, RETRY), vec![address(5)]);
    }

    #[test]
    fn a_known_watch_is_asked_again_even_though_it_was_discovered_long_ago() {
        // The reason this type exists: after a dropped connection nothing new is announced, and
        // the old design waited for an announcement that never came.
        let mut roster = WatchRoster::default();
        let start = Instant::now();
        roster.seen("watch".into(), address(5));
        roster.record(address(5), start, true);
        let much_later = start + Duration::from_secs(3600);
        assert_eq!(roster.due(much_later, RETRY), vec![address(5)]);
    }

    #[test]
    fn seeing_the_same_watch_again_is_not_news_but_a_move_is() {
        let mut roster = WatchRoster::default();
        assert!(roster.seen("watch".into(), address(5)));
        assert!(!roster.seen("watch".into(), address(5)));
        assert!(roster.seen("watch".into(), address(9)));
    }

    #[test]
    fn a_moved_watch_is_asked_at_once_at_its_new_address() {
        let mut roster = WatchRoster::default();
        let start = Instant::now();
        roster.seen("watch".into(), address(5));
        roster.record(address(5), start, true);
        roster.seen("watch".into(), address(9));
        assert_eq!(
            roster.due(start + Duration::from_secs(1), RETRY),
            vec![address(9)]
        );
    }

    #[test]
    fn a_watch_that_left_is_forgotten_with_its_history() {
        let mut roster = WatchRoster::default();
        let start = Instant::now();
        roster.seen("watch".into(), address(5));
        roster.record(address(5), start, false);
        assert_eq!(roster.removed("watch"), Some(address(5)));
        assert!(roster.is_empty());
        assert!(roster.due(start, RETRY).is_empty());
        assert_eq!(roster.removed("watch"), None);
        // If it comes back it is treated as new: due at once, and its first answer is "first".
        roster.seen("watch".into(), address(5));
        assert_eq!(roster.due(start, RETRY), vec![address(5)]);
        assert_eq!(roster.record(address(5), start, true), AttemptChange::First);
    }

    #[test]
    fn outcomes_are_reported_only_when_they_change() {
        let mut roster = WatchRoster::default();
        let start = Instant::now();
        roster.seen("watch".into(), address(5));
        assert_eq!(
            roster.record(address(5), start, false),
            AttemptChange::First
        );
        assert_eq!(roster.record(address(5), start, false), AttemptChange::Same);
        assert_eq!(
            roster.record(address(5), start, true),
            AttemptChange::Changed
        );
        assert_eq!(roster.record(address(5), start, true), AttemptChange::Same);
        assert_eq!(
            roster.record(address(5), start, false),
            AttemptChange::Changed
        );
    }

    #[test]
    fn two_services_at_one_address_are_asked_once() {
        let mut roster = WatchRoster::default();
        roster.seen("watch".into(), address(5));
        roster.seen("watch (2)".into(), address(5));
        assert_eq!(roster.due(Instant::now(), RETRY), vec![address(5)]);
    }
}
