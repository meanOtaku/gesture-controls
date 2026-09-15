// Cross-platform native head-tracking C ABI, owned by Spatial Gesture
// Control (not upstream). Milestone 1 (macOS) and Milestone 4 (Windows) each
// implement this contract on top of the vendored engine sources in
// third_party/sony-head-tracker/, adapting them to it; Rust links against it
// through the target-gated extern blocks in
// crates/native-head-tracking/src/ffi.rs, which must be kept in sync with
// this header by hand.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque per-instance handle. Owned by the caller; created and destroyed
// exactly once per session by the Rust wrapper.
typedef struct SpatialHeadTrackerHandle SpatialHeadTrackerHandle;

// One normalized motion sample, equivalent to sony::MotionSample
// (third_party/sony-head-tracker/include/sony_head_tracker/types.hpp) after
// orientation filtering. Carries no device identity or Bluetooth state.
typedef struct {
    double quaternion[4];    // w, x, y, z
    double yaw_deg;
    double pitch_deg;
    double roll_deg;
    double gyroscope[3];     // radians/second; valid only if has_gyroscope
    bool has_gyroscope;
    double accelerometer[3]; // m/s^2; valid only if has_accelerometer
    bool has_accelerometer;
    uint8_t reset_counter;
    double packets_per_second;
    double receive_latency_ms;
} SpatialHeadTrackerSample;

// Status a platform backend can report. Deliberately excludes any device
// name/identifier so callers cannot retain more than necessary.
typedef enum {
    SPATIAL_HEAD_TRACKER_STATUS_STOPPED = 0,
    SPATIAL_HEAD_TRACKER_STATUS_SCANNING = 1,
    SPATIAL_HEAD_TRACKER_STATUS_CONNECTED = 2,
    SPATIAL_HEAD_TRACKER_STATUS_RECONNECTING = 3,
    SPATIAL_HEAD_TRACKER_STATUS_PERMISSION_DENIED = 4,
    SPATIAL_HEAD_TRACKER_STATUS_DEVICE_NOT_FOUND = 5,
    SPATIAL_HEAD_TRACKER_STATUS_DEVICE_NOT_VERIFIED = 6,
    SPATIAL_HEAD_TRACKER_STATUS_FEATURE_WRITE_FAILED = 7,
    SPATIAL_HEAD_TRACKER_STATUS_STREAM_TIMEOUT = 8,
    SPATIAL_HEAD_TRACKER_STATUS_ERROR = 9,
} SpatialHeadTrackerStatus;

// Invoked on an implementation-owned thread. The callee must copy any data
// it needs before returning and must not call back into the handle (stop,
// recenter, destroy) from within the callback.
typedef void (*SpatialHeadTrackerSampleCallback)(const SpatialHeadTrackerSample *sample,
                                                  void *context);
typedef void (*SpatialHeadTrackerStatusCallback)(SpatialHeadTrackerStatus status,
                                                  const char *message_utf8,
                                                  void *context);

SpatialHeadTrackerHandle *spatial_head_tracker_create(void);
void spatial_head_tracker_destroy(SpatialHeadTrackerHandle *handle);

// Starts acquisition. Returns false if a supported device could not be
// reached; callbacks fire on success until spatial_head_tracker_stop.
bool spatial_head_tracker_start(SpatialHeadTrackerHandle *handle,
                                 SpatialHeadTrackerSampleCallback sample_callback,
                                 SpatialHeadTrackerStatusCallback status_callback,
                                 void *context);

// Idempotent; blocks until in-flight callbacks have returned.
void spatial_head_tracker_stop(SpatialHeadTrackerHandle *handle);

// Requests the current pose be treated as the new zero reference.
void spatial_head_tracker_recenter(SpatialHeadTrackerHandle *handle);

// Writes a NUL-terminated UTF-8 diagnostic snapshot with no personal device
// identifiers. Returns the required buffer size including the trailing NUL;
// call once with capacity 0 to size the buffer.
size_t spatial_head_tracker_get_diagnostics(SpatialHeadTrackerHandle *handle,
                                             char *buffer,
                                             size_t capacity);

#ifdef __cplusplus
}
#endif
