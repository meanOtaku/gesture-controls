// Repo-owned (not vendored) adapter mapping the ABI contract this repo owns
// (../include/spatial_head_tracker.h) onto the vendored upstream Windows HID
// engine (third_party/sony-head-tracker). Unlike macOS, upstream has no
// reusable C ABI bridge object for Windows -- its own Windows entry points are
// the CLI/GUI in src/main.cpp / src/gui.cpp, which this repo deliberately does
// not vendor (see third_party/sony-head-tracker/THIRD_PARTY_NOTICES.md). This
// file plays the integration role main.cpp's "bridge" command and
// macos/Bridge/sony_head_tracker_c.mm each play on their own platforms: it
// owns discovery/connect/reconnect lifecycle directly against
// sony::HidBackend and sony::OrientationFilter, translated into this repo's
// callbacks. It never touches sony::UdpOutput -- production samples must not
// loop through localhost UDP.
#include "spatial_head_tracker.h"

#include "sony_head_tracker/device.hpp"
#include "sony_head_tracker/hid_backend.hpp"
#include "sony_head_tracker/orientation.hpp"
#include "sony_head_tracker/types.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <new>
#include <string>
#include <thread>

namespace {

// How often the worker re-enumerates HID devices while no supported tracker
// is reachable, and how often it polls HidBackend::connected() while one is.
// Neither value is part of the ABI contract; both are safe to retune without
// affecting callers.
constexpr auto kScanInterval = std::chrono::milliseconds(1500);
constexpr auto kConnectionPollInterval = std::chrono::milliseconds(200);

} // namespace

struct SpatialHeadTrackerHandle {
    std::mutex lifecycleMutex;
    sony::HidBackend hid;
    sony::OrientationFilter filter;

    std::thread worker;
    std::mutex wakeMutex;
    std::condition_variable wake;
    std::atomic_bool stopRequested{};
    std::atomic_bool running{};

    SpatialHeadTrackerSampleCallback sampleCallback{};
    SpatialHeadTrackerStatusCallback statusCallback{};
    void *context{};

    std::mutex diagnosticsMutex;
    std::string diagnostics{"stopped"};
};

namespace {

void reportStatus(SpatialHeadTrackerHandle *handle, SpatialHeadTrackerStatus status, const char *message) {
    {
        std::lock_guard<std::mutex> lock(handle->diagnosticsMutex);
        handle->diagnostics = message ? message : "";
    }
    if (handle->statusCallback) handle->statusCallback(status, message, handle->context);
}

void emitSample(SpatialHeadTrackerHandle *handle, const sony::MotionSample &filtered) {
    if (!handle->sampleCallback) return;
    SpatialHeadTrackerSample converted{};
    converted.quaternion[0] = filtered.orientation.w;
    converted.quaternion[1] = filtered.orientation.x;
    converted.quaternion[2] = filtered.orientation.y;
    converted.quaternion[3] = filtered.orientation.z;
    converted.yaw_deg = filtered.euler.yaw;
    converted.pitch_deg = filtered.euler.pitch;
    converted.roll_deg = filtered.euler.roll;
    if (filtered.angularVelocity) {
        converted.has_gyroscope = true;
        converted.gyroscope[0] = filtered.angularVelocity->x;
        converted.gyroscope[1] = filtered.angularVelocity->y;
        converted.gyroscope[2] = filtered.angularVelocity->z;
    }
    if (filtered.acceleration) {
        converted.has_accelerometer = true;
        converted.accelerometer[0] = filtered.acceleration->x;
        converted.accelerometer[1] = filtered.acceleration->y;
        converted.accelerometer[2] = filtered.acceleration->z;
    }
    converted.reset_counter = filtered.resetCounter;
    converted.packets_per_second = filtered.packetsPerSecond;
    converted.receive_latency_ms = filtered.receiveLatencyMs;
    handle->sampleCallback(&converted, handle->context);
}

// Runs on its own thread for the lifetime of one start()/stop() session:
// enumerate -> find the verified Android Head Tracker HID collection ->
// connect (HidBackend spawns its own reader thread and calls back into
// onSample below until disconnect()) -> on disconnect, rescan. Never touches
// hardware before start() and always returns once stopRequested is set, so
// stop() can block on join() without risking a hang.
void runWorker(SpatialHeadTrackerHandle *handle) {
    reportStatus(handle, SPATIAL_HEAD_TRACKER_STATUS_SCANNING,
                 "scanning for a paired Android Head Tracker HID device");
    while (!handle->stopRequested.load(std::memory_order_acquire)) {
        auto devices = handle->hid.enumerate();
        auto selected = std::find_if(devices.begin(), devices.end(),
                                      [](const sony::DeviceInfo &d) { return d.androidHeadTracker; });
        if (selected == devices.end()) {
            const bool anyDenied = std::any_of(devices.begin(), devices.end(),
                                                [](const sony::DeviceInfo &d) { return d.accessDenied; });
            reportStatus(handle,
                         anyDenied ? SPATIAL_HEAD_TRACKER_STATUS_PERMISSION_DENIED
                                   : SPATIAL_HEAD_TRACKER_STATUS_DEVICE_NOT_FOUND,
                         anyDenied ? "a candidate HID device could not be opened (access denied)"
                                   : "no Android Head Tracker HID device is currently reachable");
        } else {
            const bool connected = handle->hid.connect(
                *selected, {}, [handle](sony::MotionSample sample) {
                    emitSample(handle, handle->filter.process(std::move(sample)));
                });
            if (!connected) {
                reportStatus(handle, SPATIAL_HEAD_TRACKER_STATUS_FEATURE_WRITE_FAILED,
                             "the device was found but its sensor feature reports could not be configured");
            } else {
                reportStatus(handle, SPATIAL_HEAD_TRACKER_STATUS_CONNECTED, "connected");
                while (!handle->stopRequested.load(std::memory_order_acquire) && handle->hid.connected()) {
                    std::unique_lock<std::mutex> lock(handle->wakeMutex);
                    handle->wake.wait_for(lock, kConnectionPollInterval);
                }
                // Single-owner: only this worker thread ever calls connect()/
                // disconnect() on `hid`, so this is never concurrent with the
                // HidBackend destructor's own disconnect() from stop().
                handle->hid.disconnect();
                if (handle->stopRequested.load(std::memory_order_acquire)) break;
                reportStatus(handle, SPATIAL_HEAD_TRACKER_STATUS_RECONNECTING,
                             "device connection was lost; rescanning");
            }
        }
        std::unique_lock<std::mutex> lock(handle->wakeMutex);
        handle->wake.wait_for(lock, kScanInterval);
    }
    reportStatus(handle, SPATIAL_HEAD_TRACKER_STATUS_STOPPED, "stopped");
    handle->running.store(false, std::memory_order_release);
}

} // namespace

extern "C" SpatialHeadTrackerHandle *spatial_head_tracker_create(void) {
    return new (std::nothrow) SpatialHeadTrackerHandle;
}

extern "C" void spatial_head_tracker_destroy(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    spatial_head_tracker_stop(handle);
    delete handle;
}

extern "C" bool spatial_head_tracker_start(SpatialHeadTrackerHandle *handle,
                                            SpatialHeadTrackerSampleCallback sample_callback,
                                            SpatialHeadTrackerStatusCallback status_callback,
                                            void *context) {
    if (!handle) return false;
    std::lock_guard<std::mutex> lock(handle->lifecycleMutex);
    if (handle->running.load(std::memory_order_acquire)) return false;
    handle->sampleCallback = sample_callback;
    handle->statusCallback = status_callback;
    handle->context = context;
    handle->stopRequested.store(false, std::memory_order_release);
    handle->running.store(true, std::memory_order_release);
    handle->worker = std::thread(runWorker, handle);
    return true;
}

extern "C" void spatial_head_tracker_stop(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    std::lock_guard<std::mutex> lock(handle->lifecycleMutex);
    handle->stopRequested.store(true, std::memory_order_release);
    handle->wake.notify_all();
    if (handle->worker.joinable()) handle->worker.join();
    handle->sampleCallback = nullptr;
    handle->statusCallback = nullptr;
    handle->context = nullptr;
}

extern "C" void spatial_head_tracker_recenter(SpatialHeadTrackerHandle *handle) {
    if (!handle) return;
    handle->filter.recenter();
}

extern "C" size_t spatial_head_tracker_get_diagnostics(SpatialHeadTrackerHandle *handle,
                                                        char *buffer,
                                                        size_t capacity) {
    if (!handle) return 0;
    std::lock_guard<std::mutex> lock(handle->diagnosticsMutex);
    const size_t needed = handle->diagnostics.size() + 1;
    if (buffer && capacity) {
        const size_t toCopy = std::min(capacity - 1, handle->diagnostics.size());
        std::memcpy(buffer, handle->diagnostics.data(), toCopy);
        buffer[toCopy] = '\0';
    }
    return needed;
}
