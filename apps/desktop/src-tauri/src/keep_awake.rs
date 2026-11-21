//! Keeps the Mac from idle-sleeping while the watch is streaming.
//!
//! With the watch off the wrist and set to keep streaming (or on a wrist while nobody touches the Mac), macOS turns the
//! display off after its idle time and then puts the whole system to sleep. Sleep powers the Bluetooth radio off, so
//! the watch and the head tracker drop; the Mac then dark-wakes for Bluetooth, reconnects, and sleeps again about every
//! 47 s. The graphs lag and empty with every cycle. This holds a "prevent idle system sleep" assertion (what
//! `caffeinate -i` does) only while the watch is actually streaming, and lets it go once it stops. The
//! display still sleeps as usual, and closing the lid still sleeps the Mac.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// How often [`KeepAwake::tick`] should run.
pub const TICK_INTERVAL: Duration = Duration::from_secs(5);
/// Streaming sends hundreds of samples a tick; an off-wrist watch that has paused still sends a stray one now and then,
/// which must not keep the Mac awake.
const MIN_SAMPLES_PER_TICK: u32 = 10;
/// Without streaming for this long, the assertion goes.
pub const STREAMING_STALE_AFTER: Duration = Duration::from_secs(15);

#[derive(Default)]
struct State {
    assertion: Option<platform::Assertion>,
    last_streaming: Option<Instant>,
}

#[derive(Default)]
pub struct KeepAwake {
    /// Samples since the last tick; counted without a lock, as they arrive at up to 100 Hz.
    samples: AtomicU32,
    state: Mutex<State>,
}

impl KeepAwake {
    /// One watch sensor sample arrived.
    pub fn note_data(&self) {
        self.samples.fetch_add(1, Ordering::Relaxed);
    }

    /// Holds the assertion while the watch streams, and lets it go once it has stopped for a while.
    pub fn tick(&self) {
        let samples = self.samples.swap(0, Ordering::Relaxed);
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if samples >= MIN_SAMPLES_PER_TICK {
            state.last_streaming = Some(Instant::now());
            if state.assertion.is_none() {
                state.assertion = platform::Assertion::create("Streaming from the watch");
                if state.assertion.is_some() {
                    tracing::info!("watch is streaming; keeping the Mac from idle sleep");
                }
            }
            return;
        }
        let stale = state
            .last_streaming
            .is_none_or(|at| at.elapsed() >= STREAMING_STALE_AFTER);
        if stale && state.assertion.take().is_some() {
            tracing::info!("watch stopped streaming; the Mac may idle-sleep again");
        }
    }

    /// The watch disconnected: let the assertion go now.
    pub fn release(&self) {
        self.samples.store(0, Ordering::Relaxed);
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.last_streaming = None;
        if state.assertion.take().is_some() {
            tracing::info!("watch disconnected; the Mac may idle-sleep again");
        }
    }

    #[cfg(test)]
    fn held(&self) -> bool {
        self.state.lock().unwrap().assertion.is_some()
    }

    #[cfg(test)]
    fn age(&self, by: Duration) {
        let mut state = self.state.lock().unwrap();
        state.last_streaming = state.last_streaming.and_then(|at| at.checked_sub(by));
    }

    #[cfg(test)]
    fn stream(&self, samples: u32) {
        (0..samples).for_each(|_| self.note_data());
        self.tick();
    }
}

#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use std::ffi::c_void;

    use objc2_foundation::NSString;

    /// `kIOPMAssertionLevelOn`.
    const ASSERTION_LEVEL_ON: u32 = 255;
    /// `kIOReturnSuccess`.
    const SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// A held IOKit power assertion; released when dropped.
    pub struct Assertion(u32);

    impl Assertion {
        pub fn create(reason: &str) -> Option<Self> {
            // NSString is toll-free bridged with CFString, which is what IOKit takes.
            let kind = NSString::from_str("PreventUserIdleSystemSleep");
            let name = NSString::from_str(reason);
            let mut id = 0u32;
            // SAFETY: both strings live through the call, and `id` is a valid out-pointer.
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    (&*kind as *const NSString).cast(),
                    ASSERTION_LEVEL_ON,
                    (&*name as *const NSString).cast(),
                    &mut id,
                )
            };
            if result == SUCCESS {
                Some(Self(id))
            } else {
                tracing::warn!(result, "could not keep the Mac from idle sleep");
                None
            }
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: the id came from a successful IOPMAssertionCreateWithName and is released once.
            unsafe {
                IOPMAssertionRelease(self.0);
            }
        }
    }
}

/// Elsewhere, and in tests, nothing is asserted; the bookkeeping is the same.
#[cfg(any(not(target_os = "macos"), test))]
mod platform {
    pub struct Assertion;

    impl Assertion {
        pub fn create(_reason: &str) -> Option<Self> {
            Some(Self)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_holds_the_assertion_until_it_has_stopped_for_a_while() {
        let awake = KeepAwake::default();
        awake.tick();
        assert!(!awake.held());
        awake.stream(500);
        assert!(awake.held());
        awake.stream(0);
        assert!(awake.held(), "one quiet tick keeps it");
        awake.age(STREAMING_STALE_AFTER);
        awake.stream(0);
        assert!(!awake.held(), "a long quiet lets it go");
        awake.stream(500);
        assert!(awake.held(), "streaming again takes it again");
    }

    #[test]
    fn a_stray_sample_from_a_paused_watch_does_not_keep_the_mac_awake() {
        let awake = KeepAwake::default();
        awake.stream(1);
        assert!(!awake.held());
    }

    #[test]
    fn a_disconnect_lets_it_go_at_once() {
        let awake = KeepAwake::default();
        awake.stream(500);
        awake.note_data();
        awake.release();
        assert!(!awake.held());
        awake.tick();
        assert!(
            !awake.held(),
            "samples counted before the disconnect do not count"
        );
    }
}
