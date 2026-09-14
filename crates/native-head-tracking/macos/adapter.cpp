// Repo-owned (not vendored) adapter mapping the ABI contract this repo owns
// (../include/spatial_head_tracker.h) onto the vendored upstream bridge
// (third_party/sony-head-tracker/macos/Bridge/sony_head_tracker_c.h). Keeping
// this translation here means src/ffi.rs and the rest of the crate never
// need to know upstream's own struct/enum names or its UDP base-port
// parameter.
#include "spatial_head_tracker.h"
#include "sony_head_tracker_c.h"

#include <new>

struct SpatialHeadTrackerHandle {
    SHTHandle *inner{};
    SpatialHeadTrackerSampleCallback sampleCallback{};
    SpatialHeadTrackerStatusCallback statusCallback{};
    void *context{};
};

namespace {

// The vendored engine also mirrors samples to a loopback OpenTrack-style UDP
// socket; this repo's data path never reads that socket; it only depends on
// the sample/status callbacks below. Any fixed, valid port satisfies
// sht_start's precondition.
constexpr std::uint16_t kUnusedLoopbackPort = 47990;

SpatialHeadTrackerStatus mapStatus(SHTStatus status) {
    switch (status) {
        case SHT_STATUS_STOPPED:
            return SPATIAL_HEAD_TRACKER_STATUS_STOPPED;
        case SHT_STATUS_SCANNING:
            return SPATIAL_HEAD_TRACKER_STATUS_SCANNING;
        case SHT_STATUS_CONNECTED:
            return SPATIAL_HEAD_TRACKER_STATUS_CONNECTED;
        case SHT_STATUS_RECONNECTING:
            return SPATIAL_HEAD_TRACKER_STATUS_RECONNECTING;
        case SHT_STATUS_PERMISSION_DENIED:
            return SPATIAL_HEAD_TRACKER_STATUS_PERMISSION_DENIED;
        case SHT_STATUS_NOT_VISIBLE:
            return SPATIAL_HEAD_TRACKER_STATUS_DEVICE_NOT_FOUND;
        case SHT_STATUS_NOT_VERIFIED:
            return SPATIAL_HEAD_TRACKER_STATUS_DEVICE_NOT_VERIFIED;
        case SHT_STATUS_FEATURE_WRITE_FAILED:
            return SPATIAL_HEAD_TRACKER_STATUS_FEATURE_WRITE_FAILED;
        case SHT_STATUS_STREAM_TIMEOUT:
            return SPATIAL_HEAD_TRACKER_STATUS_STREAM_TIMEOUT;
        case SHT_STATUS_UDP_ERROR:
        case SHT_STATUS_ERROR:
        default:
            return SPATIAL_HEAD_TRACKER_STATUS_ERROR;
    }
}

void onSample(const SHTSample *sample, void *context) {
    auto *handle = static_cast<SpatialHeadTrackerHandle *>(context);
    if (!handle || !handle->sampleCallback || !sample) return;
    SpatialHeadTrackerSample converted{};
    converted.quaternion[0] = sample->quaternion[0];
    converted.quaternion[1] = sample->quaternion[1];
    converted.quaternion[2] = sample->quaternion[2];
    converted.quaternion[3] = sample->quaternion[3];
    converted.yaw_deg = sample->ypr_degrees[0];
    converted.pitch_deg = sample->ypr_degrees[1];
    converted.roll_deg = sample->ypr_degrees[2];
    converted.gyroscope[0] = sample->gyroscope[0];
    converted.gyroscope[1] = sample->gyroscope[1];
    converted.gyroscope[2] = sample->gyroscope[2];
    converted.has_gyroscope = sample->has_gyroscope;
    converted.accelerometer[0] = sample->accelerometer[0];
    converted.accelerometer[1] = sample->accelerometer[1];
    converted.accelerometer[2] = sample->accelerometer[2];
    converted.has_accelerometer = sample->has_accelerometer;
    converted.reset_counter = sample->reset_counter;
    converted.packets_per_second = sample->packets_per_second;
    converted.receive_latency_ms = sample->receive_latency_ms;
    handle->sampleCallback(&converted, handle->context);
}

void onStatus(SHTStatus status, const char *message, void *context) {
    auto *handle = static_cast<SpatialHeadTrackerHandle *>(context);
    if (!handle || !handle->statusCallback) return;
    handle->statusCallback(mapStatus(status), message, handle->context);
}

} // namespace

extern "C" SpatialHeadTrackerHandle *spatial_head_tracker_create(void) {
    auto *handle = new (std::nothrow) SpatialHeadTrackerHandle;
    if (!handle) return nullptr;
    handle->inner = sht_create();
    if (!handle->inner) {
        delete handle;
        return nullptr;
    }
    return handle;
}

extern "C" void spatial_head_tracker_destroy(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    sht_destroy(handle->inner);
    delete handle;
}

extern "C" bool spatial_head_tracker_start(SpatialHeadTrackerHandle *handle,
                                            SpatialHeadTrackerSampleCallback sample_callback,
                                            SpatialHeadTrackerStatusCallback status_callback,
                                            void *context) {
    if (!handle) return false;
    handle->sampleCallback = sample_callback;
    handle->statusCallback = status_callback;
    handle->context = context;
    return sht_start(handle->inner, kUnusedLoopbackPort, &onSample, &onStatus, handle);
}

extern "C" void spatial_head_tracker_stop(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    sht_stop(handle->inner);
}

extern "C" void spatial_head_tracker_recenter(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    sht_recenter(handle->inner);
}

extern "C" size_t spatial_head_tracker_get_diagnostics(SpatialHeadTrackerHandle *handle,
                                                        char *buffer,
                                                        size_t capacity) {
    if (!handle) return 0;
    return sht_get_diagnostics(handle->inner, buffer, capacity);
}
