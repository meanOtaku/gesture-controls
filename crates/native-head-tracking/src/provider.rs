//! Safe macOS wrapper around the linked native FFI contract (`src/ffi.rs`,
//! backed by `build.rs`/`macos/adapter.cpp` on this target only). `start`
//! copies the raw sample/status out of native memory before handing it to
//! Rust, `stop`/`Drop` guarantee the native worker thread is joined before
//! its callback context is freed, and a panic inside the sink can never
//! unwind back across the C ABI boundary.

use std::ffi::{CStr, c_void};
use std::os::raw::c_char;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use crate::ffi::{self, NativeHandle, NativeSample, NativeStatus};

/// Receives owned copies of native callback data. Called on the native
/// engine's worker thread; implementations must not block or call back into
/// `MacosProvider` (matches the ABI contract's callback contract).
pub trait NativeEventSink: Send {
    fn on_sample(&mut self, sample: NativeSample);
    fn on_status(&mut self, status: NativeStatus, message: String);
}

struct CallbackState {
    sink: Box<dyn NativeEventSink>,
}

/// Owns one native provider instance. `start`/`stop` are serialized by an
/// internal lock, and `Drop` stops (blocking until the native worker thread
/// has returned) and destroys the handle, so an early return or panic in the
/// caller never leaks the native worker thread or a dangling callback
/// context.
pub struct MacosProvider {
    handle: *mut NativeHandle,
    state: Mutex<Option<Box<CallbackState>>>,
}

// SAFETY: `handle` is only ever passed to the native functions declared in
// `ffi.rs`, which the vendored engine documents as safe to call from any
// thread; `state` guards the one piece of Rust-owned data those calls touch.
unsafe impl Send for MacosProvider {}
unsafe impl Sync for MacosProvider {}

impl MacosProvider {
    /// Creates a native handle. Returns `None` only on allocation failure;
    /// no hardware or permission is required to construct one.
    pub fn new() -> Option<Self> {
        let handle = unsafe { ffi::spatial_head_tracker_create() };
        if handle.is_null() {
            return None;
        }
        Some(Self {
            handle,
            state: Mutex::new(None),
        })
    }

    /// Starts acquisition, delivering samples/status to `sink` until
    /// `stop()`. Returns `false` and drops `sink` if already started or if
    /// the native side rejects the start request (e.g. no supported device
    /// reachable).
    pub fn start(&self, sink: Box<dyn NativeEventSink>) -> bool {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_some() {
            return false;
        }
        let context = Box::into_raw(Box::new(CallbackState { sink })) as *mut c_void;
        let started = unsafe {
            ffi::spatial_head_tracker_start(
                self.handle,
                sample_trampoline,
                status_trampoline,
                context,
            )
        };
        // SAFETY: `context` was produced by the `Box::into_raw` above and is
        // reclaimed exactly once, either here or in `stop`.
        let reclaimed = unsafe { Box::from_raw(context as *mut CallbackState) };
        if started {
            *guard = Some(reclaimed);
        }
        // else: `reclaimed` drops here, freeing the context; native never
        // stored the pointer because `spatial_head_tracker_start` returned
        // false before spawning its worker thread.
        started
    }

    /// Idempotent. Blocks until the native worker thread (and therefore any
    /// in-flight callback into `sink`) has returned, then drops `sink`.
    pub fn stop(&self) {
        unsafe { ffi::spatial_head_tracker_stop(self.handle) };
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
    }

    pub fn recenter(&self) {
        unsafe { ffi::spatial_head_tracker_recenter(self.handle) };
    }

    /// A shareable diagnostic snapshot with no personal device identifiers
    /// (guaranteed by the ABI contract; see `include/spatial_head_tracker.h`).
    pub fn diagnostics(&self) -> String {
        unsafe {
            let needed =
                ffi::spatial_head_tracker_get_diagnostics(self.handle, std::ptr::null_mut(), 0);
            if needed == 0 {
                return String::new();
            }
            let mut buffer = vec![0u8; needed];
            let written = ffi::spatial_head_tracker_get_diagnostics(
                self.handle,
                buffer.as_mut_ptr() as *mut c_char,
                buffer.len(),
            );
            let len = written.saturating_sub(1).min(buffer.len());
            String::from_utf8_lossy(&buffer[..len]).into_owned()
        }
    }
}

impl Drop for MacosProvider {
    fn drop(&mut self) {
        self.stop();
        unsafe { ffi::spatial_head_tracker_destroy(self.handle) };
    }
}

extern "C" fn sample_trampoline(sample: *const NativeSample, context: *mut c_void) {
    if sample.is_null() || context.is_null() {
        return;
    }
    // Copy out of native memory before any Rust code (which may panic) runs.
    let owned = unsafe { *sample };
    let state = unsafe { &mut *(context as *mut CallbackState) };
    let _ = catch_unwind(AssertUnwindSafe(|| state.sink.on_sample(owned)));
}

extern "C" fn status_trampoline(
    status: NativeStatus,
    message: *const c_char,
    context: *mut c_void,
) {
    if context.is_null() {
        return;
    }
    let text = if message.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    let state = unsafe { &mut *(context as *mut CallbackState) };
    let _ = catch_unwind(AssertUnwindSafe(|| state.sink.on_status(status, text)));
}
