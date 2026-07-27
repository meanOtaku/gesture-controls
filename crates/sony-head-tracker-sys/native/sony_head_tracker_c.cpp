#include "sony_head_tracker_c.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>

#if defined(_WIN32) || defined(__APPLE__)
#include "sony_head_tracker/hid_backend.hpp"
#include "sony_head_tracker/orientation.hpp"
#include <chrono>
#include <deque>
#include <vector>
#endif

#if defined(_WIN32)
#include "sony_head_tracker/sensor_api_backend.hpp"
#include <Windows.h>
#elif defined(__APPLE__)
#include <IOKit/hid/IOHIDLib.h>
#endif

namespace {

constexpr const char* kUnsupportedMessage =
    "Sony head tracking is supported only on Windows 11 and macOS 14 or newer";

class Engine {
public:
    Engine(void* context, sht_sample_callback sample, sht_status_callback status,
           sht_context_release_callback release)
        : context_(context), sampleCallback_(sample), statusCallback_(status),
          releaseCallback_(release) {}

    virtual ~Engine() {
        stop();
        if (ownsContext_ && releaseCallback_) releaseCallback_(context_);
    }

    void adoptContext() noexcept { ownsContext_ = true; }

    int start() {
#if !defined(_WIN32) && !defined(__APPLE__)
        emitStatus(SHT_STATUS_UNSUPPORTED, kUnsupportedMessage);
        return SHT_ERROR_UNSUPPORTED;
#else
        std::unique_lock lock(lifecycleMutex_);
        if (joining_) return SHT_ERROR_ALREADY_STARTED;
        if (supervisor_.joinable()) {
            if (running_.load(std::memory_order_acquire)) return SHT_ERROR_ALREADY_STARTED;
            supervisor_.join();
        }
        stopRequested_.store(false, std::memory_order_release);
        running_.store(true, std::memory_order_release);
        try {
            supervisor_ = std::thread([this] { superviseGuarded(); });
            supervisorId_ = supervisor_.get_id();
        } catch (...) {
            running_.store(false, std::memory_order_release);
            lock.unlock();
            emitStatus(SHT_STATUS_ERROR, "Could not create tracker supervisor thread");
            return SHT_ERROR_THREAD;
        }
        return SHT_OK;
#endif
    }

    int stop() noexcept {
#if defined(_WIN32) || defined(__APPLE__)
        stopRequested_.store(true, std::memory_order_release);
        wake_.notify_all();
        std::thread toJoin;
        {
            std::unique_lock lock(lifecycleMutex_);
            if (std::this_thread::get_id() == supervisorId_) return SHT_OK;
            lifecycleWake_.wait(lock, [this] { return !joining_; });
            if (supervisor_.joinable()) {
                joining_ = true;
                toJoin = std::move(supervisor_);
            }
        }
        // Never hold lifecycleMutex_ while callbacks finish: a callback is allowed
        // to request stop without deadlocking the external joining thread.
        if (toJoin.joinable()) toJoin.join();
        {
            std::scoped_lock lock(lifecycleMutex_);
            running_.store(false, std::memory_order_release);
            joining_ = false;
            supervisorId_ = {};
        }
        lifecycleWake_.notify_all();
#endif
        return SHT_OK;
    }

    bool destroy() noexcept {
#if defined(_WIN32) || defined(__APPLE__)
        {
            std::lock_guard lock(lifecycleMutex_);
            if (std::this_thread::get_id() == supervisorId_) {
                // A callback may release the final Rust Tracker. Deleting a
                // joinable std::thread from that callback would terminate, so
                // the supervisor owns final deletion after the callback unwinds.
                destroyOnExit_.store(true, std::memory_order_release);
                stopRequested_.store(true, std::memory_order_release);
                wake_.notify_all();
                return true;
            }
        }
#endif
        stop();
        return false;
    }

    int recenter() noexcept {
        recenterRequested_.store(true, std::memory_order_release);
        wake_.notify_all();
        return SHT_OK;
    }

private:
    void emitStatus(std::uint32_t status, const char* message) noexcept {
        if (!statusCallback_) return;
        try {
            statusCallback_(context_, status, message ? message : "");
        } catch (...) {
            // No exception may cross the callback-only C ABI.
        }
    }

#if defined(_WIN32) || defined(__APPLE__)
    struct PendingSample {
        sony::MotionSample sample;
        std::string label;
    };

    void enqueue(sony::MotionSample sample, const std::string& label) {
        {
            std::scoped_lock lock(queueMutex_);
            // Bound memory if an embedder blocks its callback for an extended period.
            if (pending_.size() >= 256) pending_.pop_front();
            pending_.push_back({std::move(sample), label});
        }
        wake_.notify_all();
    }

    void drain(sony::OrientationFilter& filter) noexcept {
        std::deque<PendingSample> local;
        {
            std::scoped_lock lock(queueMutex_);
            local.swap(pending_);
        }
        for (auto& pending : local) {
            if (recenterRequested_.exchange(false, std::memory_order_acq_rel)) filter.recenter();
            emitSample(filter.process(std::move(pending.sample)), pending.label);
        }
    }

    void emitSample(const sony::MotionSample& sample, const std::string& label) noexcept {
        if (!sampleCallback_) return;
        sht_sample output{};
        output.quaternion[0] = sample.orientation.w;
        output.quaternion[1] = sample.orientation.x;
        output.quaternion[2] = sample.orientation.y;
        output.quaternion[3] = sample.orientation.z;
        output.ypr_degrees[0] = sample.euler.yaw;
        output.ypr_degrees[1] = sample.euler.pitch;
        output.ypr_degrees[2] = sample.euler.roll;
        if (sample.angularVelocity) {
            output.has_gyro = 1;
            output.gyro[0] = sample.angularVelocity->x;
            output.gyro[1] = sample.angularVelocity->y;
            output.gyro[2] = sample.angularVelocity->z;
        }
        if (sample.acceleration) {
            output.has_acceleration = 1;
            output.acceleration[0] = sample.acceleration->x;
            output.acceleration[1] = sample.acceleration->y;
            output.acceleration[2] = sample.acceleration->z;
        }
        output.reset_counter = sample.resetCounter;
        output.packets_per_second = sample.packetsPerSecond;
        output.receive_latency_ms = sample.receiveLatencyMs;
        output.device_label = label.c_str();
        try {
            sampleCallback_(context_, &output);
        } catch (...) {
            // No exception may cross the callback-only C ABI.
        }
    }

    bool waitFor(std::chrono::milliseconds duration) {
        std::unique_lock lock(waitMutex_);
        return wake_.wait_for(lock, duration, [this] {
            return stopRequested_.load(std::memory_order_acquire);
        });
    }

    static unsigned backoff(std::size_t attempt) {
        constexpr unsigned seconds[] = {1, 2, 5, 10, 30};
        return seconds[attempt < 5 ? attempt : 4];
    }

    static std::string utf8(const std::wstring& input) {
#if defined(_WIN32)
        if (input.empty()) return {};
        const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                                              static_cast<int>(input.size()), nullptr, 0,
                                              nullptr, nullptr);
        if (size <= 0) return {};
        std::string output(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                            static_cast<int>(input.size()), output.data(), size,
                            nullptr, nullptr);
        return output;
#else
        std::string output;
        for (const auto value : input) {
            const auto code = static_cast<std::uint32_t>(value);
            if (code <= 0x7f) output.push_back(static_cast<char>(code));
            else if (code <= 0x7ff) {
                output.push_back(static_cast<char>(0xc0 | (code >> 6)));
                output.push_back(static_cast<char>(0x80 | (code & 0x3f)));
            } else if (code <= 0xffff) {
                output.push_back(static_cast<char>(0xe0 | (code >> 12)));
                output.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
                output.push_back(static_cast<char>(0x80 | (code & 0x3f)));
            } else if (code <= 0x10ffff) {
                output.push_back(static_cast<char>(0xf0 | (code >> 18)));
                output.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3f)));
                output.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
                output.push_back(static_cast<char>(0x80 | (code & 0x3f)));
            }
        }
        return output;
#endif
    }

    void superviseGuarded() noexcept {
        try {
            supervise();
        } catch (const std::exception& error) {
            emitStatus(SHT_STATUS_ERROR, error.what());
        } catch (...) {
            emitStatus(SHT_STATUS_ERROR, "Unknown native tracker error");
        }
        running_.store(false, std::memory_order_release);
        if (destroyOnExit_.exchange(false, std::memory_order_acq_rel)) {
            {
                std::lock_guard lock(lifecycleMutex_);
                if (supervisor_.joinable()) supervisor_.detach();
            }
            delete this;
        }
    }

    void supervise() {
        sony::OrientationFilter filter;
        std::size_t attempt = 0;
        while (!stopRequested_.load(std::memory_order_acquire)) {
            emitStatus(SHT_STATUS_SEARCHING, "Searching for a verified Android Head Tracker HID device");
#if defined(__APPLE__)
            const auto access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent);
            if (access == kIOHIDAccessTypeDenied ||
                (access != kIOHIDAccessTypeGranted &&
                 !IOHIDRequestAccess(kIOHIDRequestTypeListenEvent))) {
                emitStatus(SHT_STATUS_PERMISSION,
                           "macOS denied Input Monitoring access for the head tracker");
                if (waitFor(std::chrono::seconds(backoff(attempt++)))) break;
                continue;
            }
#endif
            sony::HidBackend hid;
            const auto devices = hid.enumerate(true);
            const auto selected = std::find_if(devices.begin(), devices.end(), [](const auto& device) {
                return device.androidHeadTracker && device.usagePage == 0x20 &&
                       device.usage == 0xE1 && !device.accessDenied;
            });
            if (selected != devices.end()) {
                auto label = utf8(selected->bluetoothName.empty() ? selected->product
                                                                  : selected->bluetoothName);
                if (label.empty()) label = "Sony Android Head Tracker";
                if (hid.connect(*selected, {}, [this, label](sony::MotionSample sample) {
                        enqueue(std::move(sample), label);
                    })) {
                    attempt = 0;
                    emitStatus(SHT_STATUS_CONNECTED, label.c_str());
                    while (!stopRequested_.load(std::memory_order_acquire) && hid.connected()) {
                        drain(filter);
                        // Keep embedding latency below one display frame while serializing
                        // platform callbacks through the bounded queue.
                        waitFor(std::chrono::milliseconds(10));
                    }
                    drain(filter);
                    hid.disconnect();
                    emitStatus(SHT_STATUS_DISCONNECTED,
                               stopRequested_.load(std::memory_order_acquire)
                                   ? "Head tracker stopped"
                                   : "Head tracker disconnected; reconnecting");
                    if (stopRequested_.load(std::memory_order_acquire)) break;
                    if (waitFor(std::chrono::seconds(backoff(attempt++)))) break;
                    continue;
                }
                emitStatus(SHT_STATUS_ERROR, "Verified HID device could not be opened or configured");
            }

#if defined(_WIN32)
            sony::SensorBackend sensor;
            const auto sensors = sensor.enumerate();
            const auto sensorInfo = std::find_if(sensors.begin(), sensors.end(),
                                                 [](const auto& value) { return value.androidHeadTracker; });
            if (sensorInfo != sensors.end()) {
                auto label = utf8(sensorInfo->friendlyName);
                if (label.empty()) label = "Sony Android Head Tracker (Sensor API)";
                if (sensor.connect(*sensorInfo, [this, label](sony::MotionSample sample) {
                        enqueue(std::move(sample), label);
                    })) {
                    attempt = 0;
                    emitStatus(SHT_STATUS_CONNECTED, label.c_str());
                    while (!stopRequested_.load(std::memory_order_acquire) && sensor.connected()) {
                        drain(filter);
                        // Keep embedding latency below one display frame while serializing
                        // platform callbacks through the bounded queue.
                        waitFor(std::chrono::milliseconds(10));
                    }
                    drain(filter);
                    sensor.disconnect();
                    emitStatus(SHT_STATUS_DISCONNECTED,
                               stopRequested_.load(std::memory_order_acquire)
                                   ? "Head tracker stopped"
                                   : "Sensor API tracker disconnected; reconnecting");
                    if (stopRequested_.load(std::memory_order_acquire)) break;
                    if (waitFor(std::chrono::seconds(backoff(attempt++)))) break;
                    continue;
                }
                emitStatus(SHT_STATUS_PERMISSION,
                           "Windows Sensor API tracker could not be opened; check sensor privacy permissions");
            }
#endif
            if (waitFor(std::chrono::seconds(backoff(attempt++)))) break;
        }
    }
#endif

    void* context_{};
    sht_sample_callback sampleCallback_{};
    sht_status_callback statusCallback_{};
    sht_context_release_callback releaseCallback_{};
    bool ownsContext_{};
    std::atomic_bool stopRequested_{};
    std::atomic_bool recenterRequested_{};
    std::atomic_bool running_{};
    std::atomic_bool destroyOnExit_{};
    std::mutex lifecycleMutex_;
    std::condition_variable lifecycleWake_;
    bool joining_{};
    std::thread::id supervisorId_{};
    std::mutex waitMutex_;
    std::condition_variable wake_;
#if defined(_WIN32) || defined(__APPLE__)
    std::thread supervisor_;
    std::mutex queueMutex_;
    std::deque<PendingSample> pending_;
#endif
};

} // namespace

struct sht_engine final : Engine {
    using Engine::Engine;
};

extern "C" sht_engine* sht_create(void* context, sht_sample_callback sample,
                                  sht_status_callback status,
                                  sht_context_release_callback release) {
    try {
        auto* engine = new (std::nothrow) sht_engine(context, sample, status, release);
        if (engine) engine->adoptContext();
        return engine;
    } catch (...) {
        return nullptr;
    }
}

extern "C" void sht_destroy(sht_engine* engine) {
    try {
        if (engine && engine->destroy()) return;
        delete engine;
    } catch (...) {
    }
}

extern "C" std::int32_t sht_start(sht_engine* engine) {
    if (!engine) return SHT_ERROR_NULL;
    try {
        return engine->start();
    } catch (...) {
        return SHT_ERROR_INTERNAL;
    }
}

extern "C" std::int32_t sht_stop(sht_engine* engine) {
    if (!engine) return SHT_ERROR_NULL;
    return engine->stop();
}

extern "C" std::int32_t sht_recenter(sht_engine* engine) {
    if (!engine) return SHT_ERROR_NULL;
    return engine->recenter();
}
