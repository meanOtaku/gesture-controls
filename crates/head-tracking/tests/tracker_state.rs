use head_tracking::TrackerMonitor;
use std::time::{Duration, Instant};

#[test]
fn tracker_disconnects_after_sample_timeout() {
    let start = Instant::now();
    let mut monitor = TrackerMonitor::new(Duration::from_millis(500));
    monitor.observe(start, 1);
    assert!(monitor.is_connected(start + Duration::from_millis(499)));
    assert!(!monitor.is_connected(start + Duration::from_millis(501)));
}

#[test]
fn tracker_reports_reset_counter_changes_after_first_sample() {
    let start = Instant::now();
    let mut monitor = TrackerMonitor::new(Duration::from_secs(1));
    assert!(!monitor.observe(start, 4));
    assert!(!monitor.observe(start + Duration::from_millis(20), 4));
    assert!(monitor.observe(start + Duration::from_millis(40), 5));
}
