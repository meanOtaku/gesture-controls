//! Milestone 1 acceptance: a clean macOS checkout links the real vendored
//! engine and its adapter (build.rs + macos/adapter.cpp), and lifecycle
//! (create/start/stop/restart/destroy) is safe with no paired headset and no
//! Input Monitoring permission granted -- exactly the state a CI runner is
//! in. This file compiles only on macOS; other targets never see it.

#![cfg(target_os = "macos")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use native_head_tracking::ffi::{NativeSample, NativeStatus};
use native_head_tracking::provider::{MacosProvider, NativeEventSink};

#[derive(Clone, Default)]
struct RecordingSink(Arc<Mutex<Vec<String>>>);

impl NativeEventSink for RecordingSink {
    fn on_sample(&mut self, sample: NativeSample) {
        self.0
            .lock()
            .unwrap()
            .push(format!("sample reset={}", sample.reset_counter));
    }

    fn on_status(&mut self, status: NativeStatus, message: String) {
        self.0
            .lock()
            .unwrap()
            .push(format!("status={status:?} message={message}"));
    }
}

#[test]
fn create_and_destroy_without_start_is_safe() {
    let provider = MacosProvider::new().expect("native handle should always construct");
    drop(provider);
}

#[test]
fn start_stop_teardown_is_safe_without_hardware() {
    let provider = MacosProvider::new().expect("native handle should always construct");
    let sink = RecordingSink::default();

    assert!(
        provider.start(Box::new(sink.clone())),
        "sht_start must accept callbacks even with no paired hardware or Input Monitoring access"
    );

    // No external tracker process starts as a side effect of this call; the
    // engine either reports PermissionDenied (no Input Monitoring in CI) or
    // Scanning (no paired device) on its own worker thread.
    std::thread::sleep(Duration::from_millis(200));

    // Must not hang: sht_stop blocks until the worker thread has returned.
    provider.stop();

    drop(provider);
}

#[test]
fn restart_after_stop_succeeds() {
    let provider = MacosProvider::new().expect("native handle should always construct");
    let sink = RecordingSink::default();

    assert!(provider.start(Box::new(sink.clone())));
    provider.stop();

    assert!(
        provider.start(Box::new(sink.clone())),
        "a fully stopped provider must accept a second start"
    );
    provider.stop();
}

#[test]
fn double_start_without_stop_is_rejected() {
    let provider = MacosProvider::new().expect("native handle should always construct");
    let sink = RecordingSink::default();

    assert!(provider.start(Box::new(sink.clone())));
    assert!(
        !provider.start(Box::new(sink.clone())),
        "starting an already-running provider must fail rather than leak the first session"
    );

    provider.stop();
}

#[test]
fn diagnostics_snapshot_is_available_before_start() {
    let provider = MacosProvider::new().expect("native handle should always construct");
    // Content varies by host; this call must simply not panic or hang, and
    // must not require a running session.
    let snapshot = provider.diagnostics();
    assert!(!snapshot.is_empty());
}
