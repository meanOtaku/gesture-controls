//! In-process Sony Android Head Tracker native bindings.
//!
//! Native callbacks are copied into owned Rust values before user code runs.
//! Panics from user callbacks are caught at the FFI boundary and never unwind
//! into C++. Dropping [`Tracker`] synchronously joins native work unless the
//! drop occurs inside a callback; that path defers native deletion. Native final
//! teardown releases the callback context only after no further callback can begin.

use std::ffi::{CStr, c_char, c_void};
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;
use std::sync::Arc;

pub mod raw {
    use super::{c_char, c_void};

    pub const SHT_OK: i32 = 0;
    pub const SHT_ERROR_NULL: i32 = 1;
    pub const SHT_ERROR_ALREADY_STARTED: i32 = 2;
    pub const SHT_ERROR_THREAD: i32 = 3;
    pub const SHT_ERROR_UNSUPPORTED: i32 = 4;
    pub const SHT_ERROR_INTERNAL: i32 = 5;

    pub const SHT_STATUS_SEARCHING: u32 = 0;
    pub const SHT_STATUS_CONNECTED: u32 = 1;
    pub const SHT_STATUS_DISCONNECTED: u32 = 2;
    pub const SHT_STATUS_PERMISSION: u32 = 3;
    pub const SHT_STATUS_UNSUPPORTED: u32 = 4;
    pub const SHT_STATUS_ERROR: u32 = 5;

    #[repr(C)]
    pub struct ShtSample {
        pub quaternion: [f64; 4],
        pub ypr_degrees: [f64; 3],
        pub gyro: [f64; 3],
        pub acceleration: [f64; 3],
        pub has_gyro: u8,
        pub has_acceleration: u8,
        pub reset_counter: u8,
        pub _reserved: u8,
        pub packets_per_second: f64,
        pub receive_latency_ms: f64,
        pub device_label: *const c_char,
    }

    pub enum ShtEngine {}

    pub type SampleCallback =
        Option<unsafe extern "C" fn(context: *mut c_void, sample: *const ShtSample)>;
    pub type StatusCallback =
        Option<unsafe extern "C" fn(context: *mut c_void, status: u32, message: *const c_char)>;
    pub type ContextReleaseCallback = Option<unsafe extern "C" fn(context: *mut c_void)>;

    unsafe extern "C" {
        pub fn sht_create(
            context: *mut c_void,
            sample_callback: SampleCallback,
            status_callback: StatusCallback,
            release_callback: ContextReleaseCallback,
        ) -> *mut ShtEngine;
        pub fn sht_destroy(engine: *mut ShtEngine);
        pub fn sht_start(engine: *mut ShtEngine) -> i32;
        pub fn sht_stop(engine: *mut ShtEngine) -> i32;
        pub fn sht_recenter(engine: *mut ShtEngine) -> i32;
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub quaternion: [f64; 4],
    pub ypr_degrees: [f64; 3],
    pub gyro: Option<[f64; 3]>,
    pub acceleration: Option<[f64; 3]>,
    pub reset_counter: u8,
    pub packets_per_second: f64,
    pub receive_latency_ms: f64,
    pub device_label: String,
}

impl Sample {
    /// Copies a borrowed ABI sample into an owned Rust value.
    ///
    /// # Safety
    ///
    /// `raw` and its `device_label`, when non-null, must remain readable for the
    /// duration of this call. The label must point to a NUL-terminated byte string.
    pub unsafe fn from_raw(raw: &raw::ShtSample) -> Self {
        let device_label = if raw.device_label.is_null() {
            String::new()
        } else {
            // SAFETY: guaranteed by this function's caller contract.
            unsafe { CStr::from_ptr(raw.device_label) }
                .to_string_lossy()
                .into_owned()
        };
        Self {
            quaternion: raw.quaternion,
            ypr_degrees: raw.ypr_degrees,
            gyro: (raw.has_gyro != 0).then_some(raw.gyro),
            acceleration: (raw.has_acceleration != 0).then_some(raw.acceleration),
            reset_counter: raw.reset_counter,
            packets_per_second: raw.packets_per_second,
            receive_latency_ms: raw.receive_latency_ms,
            device_label,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Searching,
    Connected,
    Disconnected,
    Permission,
    Unsupported,
    Error,
}

impl Status {
    pub fn from_code(code: u32) -> Self {
        match code {
            raw::SHT_STATUS_SEARCHING => Self::Searching,
            raw::SHT_STATUS_CONNECTED => Self::Connected,
            raw::SHT_STATUS_DISCONNECTED => Self::Disconnected,
            raw::SHT_STATUS_PERMISSION => Self::Permission,
            raw::SHT_STATUS_UNSUPPORTED => Self::Unsupported,
            raw::SHT_STATUS_ERROR => Self::Error,
            _ => Self::Error,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineError {
    Null,
    AlreadyStarted,
    Thread,
    Unsupported,
    Internal,
    Unknown(i32),
}

impl EngineError {
    fn from_result(code: i32) -> Result<(), Self> {
        match code {
            raw::SHT_OK => Ok(()),
            raw::SHT_ERROR_NULL => Err(Self::Null),
            raw::SHT_ERROR_ALREADY_STARTED => Err(Self::AlreadyStarted),
            raw::SHT_ERROR_THREAD => Err(Self::Thread),
            raw::SHT_ERROR_UNSUPPORTED => Err(Self::Unsupported),
            raw::SHT_ERROR_INTERNAL => Err(Self::Internal),
            value => Err(Self::Unknown(value)),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Sony head tracker native error: {self:?}")
    }
}

impl std::error::Error for EngineError {}

type SampleHandler = dyn Fn(Sample) + Send + Sync + 'static;
type StatusHandler = dyn Fn(Status, String) + Send + Sync + 'static;

struct CallbackState {
    sample: Arc<SampleHandler>,
    status: Arc<StatusHandler>,
}

unsafe extern "C" fn sample_trampoline(context: *mut c_void, sample: *const raw::ShtSample) {
    if context.is_null() || sample.is_null() {
        return;
    }
    let context = context.cast::<CallbackState>();
    // SAFETY: native starts a callback only while it owns the raw Arc reference.
    // Taking a callback-local strong reference also keeps state alive if the
    // callback itself releases the final Tracker owner.
    unsafe { Arc::increment_strong_count(context) };
    // SAFETY: paired with the increment above; this guard decrements on return.
    let state = unsafe { Arc::from_raw(context) };
    // SAFETY: native code guarantees the sample and label live through this callback.
    let owned = unsafe { Sample::from_raw(&*sample) };
    let handler = Arc::clone(&state.sample);
    let _ = catch_unwind(AssertUnwindSafe(|| handler(owned)));
}

unsafe extern "C" fn status_trampoline(context: *mut c_void, status: u32, message: *const c_char) {
    if context.is_null() {
        return;
    }
    let context = context.cast::<CallbackState>();
    // SAFETY: see sample_trampoline; each active callback owns a temporary Arc.
    unsafe { Arc::increment_strong_count(context) };
    // SAFETY: paired with the increment above.
    let state = unsafe { Arc::from_raw(context) };
    let owned_message = if message.is_null() {
        String::new()
    } else {
        // SAFETY: native status messages are NUL-terminated and callback-scoped.
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    let handler = Arc::clone(&state.status);
    let mapped = Status::from_code(status);
    let _ = catch_unwind(AssertUnwindSafe(|| handler(mapped, owned_message)));
}

unsafe extern "C" fn context_release_trampoline(context: *mut c_void) {
    let Some(context) = NonNull::new(context.cast::<CallbackState>()) else {
        return;
    };
    // SAFETY: native calls this exactly once during final engine teardown for
    // the Arc owner transferred after sht_create returned successfully.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        drop(unsafe { Arc::from_raw(context.as_ptr()) });
    }));
}

pub struct Tracker {
    native: NonNull<raw::ShtEngine>,
}

impl Tracker {
    pub fn new<S, T>(sample: S, status: T) -> Result<Self, EngineError>
    where
        S: Fn(Sample) + Send + Sync + 'static,
        T: Fn(Status, String) + Send + Sync + 'static,
    {
        let callbacks = Arc::new(CallbackState {
            sample: Arc::new(sample),
            status: Arc::new(status),
        });
        let context = Arc::into_raw(callbacks).cast_mut();
        // SAFETY: on successful creation native adopts the raw Arc owner and
        // releases it during final teardown through context_release_trampoline.
        let native = unsafe {
            raw::sht_create(
                context.cast(),
                Some(sample_trampoline),
                Some(status_trampoline),
                Some(context_release_trampoline),
            )
        };
        let Some(native) = NonNull::new(native) else {
            // SAFETY: create failed, so native never retained or used this context.
            drop(unsafe { Arc::from_raw(context) });
            return Err(EngineError::Internal);
        };
        Ok(Self { native })
    }

    pub fn start(&self) -> Result<(), EngineError> {
        // SAFETY: native is owned and valid until Drop.
        EngineError::from_result(unsafe { raw::sht_start(self.native.as_ptr()) })
    }

    pub fn stop(&self) -> Result<(), EngineError> {
        // SAFETY: native is owned and stop is synchronized/idempotent.
        EngineError::from_result(unsafe { raw::sht_stop(self.native.as_ptr()) })
    }

    pub fn recenter(&self) -> Result<(), EngineError> {
        // SAFETY: native is owned and recenter is an atomic request.
        EngineError::from_result(unsafe { raw::sht_recenter(self.native.as_ptr()) })
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        // SAFETY: destroy either joins native work and releases callback context,
        // or transfers both final deletion and context release to the supervisor.
        unsafe { raw::sht_destroy(self.native.as_ptr()) };
    }
}

// SAFETY: all native mutable lifecycle state is synchronized, recenter/stop flags are atomic,
// and callbacks require Send + Sync. In-flight callbacks own their callback storage.
unsafe impl Send for Tracker {}
// SAFETY: start/stop are mutex-protected and recenter is atomic; concurrent shared calls are valid.
unsafe impl Sync for Tracker {}

#[cfg(test)]
mod tests {
    use super::{
        CallbackState, EngineError, Sample, Status, Tracker, context_release_trampoline, raw,
        status_trampoline,
    };
    use std::ffi::CString;
    use std::sync::{Arc, Mutex};

    #[test]
    fn abi_sample_conversion_owns_the_device_label_and_preserves_flags() {
        let label = CString::new("WH-1000XM5").unwrap();
        let raw = raw::ShtSample {
            quaternion: [1.0, 0.1, 0.2, 0.3],
            ypr_degrees: [10.0, 20.0, 30.0],
            gyro: [0.4, 0.5, 0.6],
            acceleration: [7.0, 8.0, 9.0],
            has_gyro: 1,
            has_acceleration: 0,
            reset_counter: 7,
            _reserved: 0,
            packets_per_second: 99.5,
            receive_latency_ms: 2.25,
            device_label: label.as_ptr(),
        };

        let converted = unsafe { Sample::from_raw(&raw) };
        drop(label);

        assert_eq!(converted.device_label, "WH-1000XM5");
        assert_eq!(converted.quaternion, [1.0, 0.1, 0.2, 0.3]);
        assert_eq!(converted.ypr_degrees, [10.0, 20.0, 30.0]);
        assert_eq!(converted.gyro, Some([0.4, 0.5, 0.6]));
        assert_eq!(converted.acceleration, None);
        assert_eq!(converted.reset_counter, 7);
        assert_eq!(converted.packets_per_second, 99.5);
        assert_eq!(converted.receive_latency_ms, 2.25);
    }

    #[test]
    fn status_mapping_is_total_for_native_and_unknown_codes() {
        assert_eq!(
            Status::from_code(raw::SHT_STATUS_SEARCHING),
            Status::Searching
        );
        assert_eq!(
            Status::from_code(raw::SHT_STATUS_CONNECTED),
            Status::Connected
        );
        assert_eq!(
            Status::from_code(raw::SHT_STATUS_DISCONNECTED),
            Status::Disconnected
        );
        assert_eq!(
            Status::from_code(raw::SHT_STATUS_PERMISSION),
            Status::Permission
        );
        assert_eq!(
            Status::from_code(raw::SHT_STATUS_UNSUPPORTED),
            Status::Unsupported
        );
        assert_eq!(Status::from_code(raw::SHT_STATUS_ERROR), Status::Error);
        assert_eq!(Status::from_code(999), Status::Error);
    }

    #[test]
    fn callback_context_remains_valid_until_native_final_release() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&calls);
        let callbacks = Arc::new(CallbackState {
            sample: Arc::new(|_| {}),
            status: Arc::new(move |status, _| captured.lock().unwrap().push(status)),
        });
        let weak = Arc::downgrade(&callbacks);
        let context = Arc::into_raw(callbacks);
        let message = CString::new("connected").unwrap();

        // SAFETY: native still owns the raw Arc across both callbacks.
        unsafe {
            status_trampoline(
                context.cast_mut().cast(),
                raw::SHT_STATUS_CONNECTED,
                message.as_ptr(),
            );
            status_trampoline(
                context.cast_mut().cast(),
                raw::SHT_STATUS_DISCONNECTED,
                message.as_ptr(),
            );
        };
        assert_eq!(
            *calls.lock().unwrap(),
            vec![Status::Connected, Status::Disconnected]
        );
        assert!(weak.upgrade().is_some());

        // SAFETY: this is the single final release for the native-owned raw Arc.
        unsafe { context_release_trampoline(context.cast_mut().cast()) };
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn callback_context_release_contains_panicking_destructors() {
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("intentional destructor panic");
            }
        }

        let dropper = PanicOnDrop;
        let callbacks = Arc::new(CallbackState {
            sample: Arc::new(|_| {}),
            status: Arc::new(move |_, _| {
                std::hint::black_box(&dropper);
            }),
        });
        let context = Arc::into_raw(callbacks);

        // SAFETY: this is the single final release for the native-owned raw Arc.
        unsafe { context_release_trampoline(context.cast_mut().cast()) };
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn tracker_drop_releases_native_owned_callback_context() {
        let lifetime = Arc::new(());
        let weak = Arc::downgrade(&lifetime);
        let tracker = Tracker::new(
            |_| {},
            move |_, _| {
                let _keep_alive = &lifetime;
            },
        )
        .unwrap();

        assert!(weak.upgrade().is_some());
        drop(tracker);
        assert!(weak.upgrade().is_none());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn callback_panics_do_not_unwind_across_the_c_abi() {
        let tracker = Tracker::new(|_| {}, |_, _| panic!("intentional callback panic")).unwrap();
        assert_eq!(tracker.start(), Err(EngineError::Unsupported));
        tracker.stop().unwrap();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn unsupported_platform_lifecycle_is_explicit_and_safe() {
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&statuses);
        let tracker = Tracker::new(
            |_| panic!("unsupported backend must not emit samples"),
            move |status, message| captured.lock().unwrap().push((status, message)),
        )
        .unwrap();

        assert_eq!(tracker.start(), Err(EngineError::Unsupported));
        tracker.recenter().unwrap();
        tracker.stop().unwrap();
        tracker.stop().unwrap();
        drop(tracker);

        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].0, Status::Unsupported);
        assert!(statuses[0].1.contains("Windows 11 and macOS 14"));
    }
}
