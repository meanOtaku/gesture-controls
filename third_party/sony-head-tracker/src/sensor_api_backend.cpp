// sensor_api_backend.cpp
// Windows Sensor API fallback backend (COM). Produces normalized MotionSamples.
#include "sony_head_tracker/windows_prelude.hpp"

#include "sony_head_tracker/sensor_api_backend.hpp"

#include "sony_head_tracker/logger.hpp"

#include <chrono>
#include <cstdint>
#include <format>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace sony {

namespace {
std::wstring getString(ISensor* sensor, REFPROPERTYKEY key) {
    PROPVARIANT value{}; PropVariantInit(&value);
    std::wstring result;
    if (SUCCEEDED(sensor->GetProperty(key, &value)) && value.vt == VT_LPWSTR && value.pwszVal) result = value.pwszVal;
    PropVariantClear(&value); return result;
}
std::wstring guidString(REFGUID guid) { wchar_t b[40]{}; StringFromGUID2(guid, b, 40); return b; }
std::vector<double> numbers(const PROPVARIANT& v) {
    if(v.vt==VT_R4)return {v.fltVal};if(v.vt==VT_R8)return {v.dblVal};if(v.vt==VT_UI1)return {static_cast<double>(v.bVal)};if(v.vt==VT_UI4)return {static_cast<double>(v.ulVal)};
    if(v.vt==(VT_VECTOR|VT_R4))return std::vector<double>(v.caflt.pElems,v.caflt.pElems+v.caflt.cElems);
    if(v.vt==(VT_VECTOR|VT_R8))return std::vector<double>(v.cadbl.pElems,v.cadbl.pElems+v.cadbl.cElems);
    if(v.vt==(VT_VECTOR|VT_UI4)){std::vector<double> r;for(ULONG i=0;i<v.caul.cElems;++i)r.push_back(v.caul.pElems[i]);return r;}return {};
}
std::vector<double> getNumbers(ISensorDataReport* report,REFPROPERTYKEY key) { PROPVARIANT v{};PropVariantInit(&v);std::vector<double> r;if(SUCCEEDED(report->GetSensorValue(key,&v)))r=numbers(v);PropVariantClear(&v);return r; }
double reportLatencyMs(ISensorDataReport* report) {
    SYSTEMTIME stamp{};if(FAILED(report->GetTimestamp(&stamp)))return -1.0;FILETIME ft{},now{};if(!SystemTimeToFileTime(&stamp,&ft))return -1.0;GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER a{{ft.dwLowDateTime,ft.dwHighDateTime}},b{{now.dwLowDateTime,now.dwHighDateTime}};if(b.QuadPart<a.QuadPart)return -1.0;return (b.QuadPart-a.QuadPart)/10000.0;
}

class SensorEventSink final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          ISensorEvents> {
public:
    SensorEventSink(SensorBackend::SampleCallback callback, std::atomic_bool* connected)
        : callback_(std::move(callback)), connected_(connected),
          rateStart_(std::chrono::steady_clock::now()) {}

    IFACEMETHODIMP OnStateChanged(ISensor*, SensorState state) override {
        if (state != SENSOR_STATE_READY && connected_) {
            connected_->store(false, std::memory_order_release);
        }
        return S_OK;
    }

    IFACEMETHODIMP OnDataUpdated(ISensor*, ISensorDataReport* report) override {
        if (!report) return E_POINTER;
        std::scoped_lock lock(mutex_);
        auto rotation=getNumbers(report,SENSOR_DATA_TYPE_CUSTOM_VALUE1);auto velocity=getNumbers(report,SENSOR_DATA_TYPE_CUSTOM_VALUE2);auto reset=getNumbers(report,SENSOR_DATA_TYPE_CUSTOM_VALUE3);
        if(rotation.size()<3){rotation.clear();for(const auto* key:{&SENSOR_DATA_TYPE_CUSTOM_VALUE1,&SENSOR_DATA_TYPE_CUSTOM_VALUE2,&SENSOR_DATA_TYPE_CUSTOM_VALUE3}){auto v=getNumbers(report,*key);if(v.empty())break;rotation.push_back(v[0]);}velocity.clear();for(const auto* key:{&SENSOR_DATA_TYPE_CUSTOM_VALUE4,&SENSOR_DATA_TYPE_CUSTOM_VALUE5,&SENSOR_DATA_TYPE_CUSTOM_VALUE6}){auto v=getNumbers(report,*key);if(v.empty())break;velocity.push_back(v[0]);}reset=getNumbers(report,SENSOR_DATA_TYPE_CUSTOM_VALUE7);}
        if(rotation.size()>=3){MotionSample sample;sample.rotationVector={rotation[0],rotation[1],rotation[2]};if(velocity.size()>=3)sample.angularVelocity=Vec3{velocity[0],velocity[1],velocity[2]};if(!reset.empty())sample.resetCounter=static_cast<std::uint8_t>(reset[0]);sample.receivedAt=std::chrono::steady_clock::now();sample.receiveLatencyMs=reportLatencyMs(report);++count_;const auto elapsed=std::chrono::duration<double>(sample.receivedAt-rateStart_).count();if(elapsed>=1.0){rate_=count_/elapsed;count_=0;rateStart_=sample.receivedAt;}sample.packetsPerSecond=rate_;if(callback_)callback_(std::move(sample));}
        return S_OK;
    }

    IFACEMETHODIMP OnEvent(ISensor*, REFGUID, IPortableDeviceValues*) override { return S_OK; }
    IFACEMETHODIMP OnLeave(REFSENSOR_ID) override {
        if (connected_) connected_->store(false, std::memory_order_release);
        return S_OK;
    }

private:
    SensorBackend::SampleCallback callback_;
    std::atomic_bool* connected_{};
    std::mutex mutex_;
    std::chrono::steady_clock::time_point rateStart_;
    std::uint64_t count_{};
    double rate_{};
};
}

std::vector<SensorInfo> SensorBackend::enumerate() {
    std::vector<SensorInfo> result;
    const auto init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComPtr<ISensorManager> manager;
    auto hr = CoCreateInstance(CLSID_SensorManager, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&manager));
    if (FAILED(hr)) {
        Logger::instance().write(LogLevel::warning, std::format(L"Windows Sensor API unavailable (0x{:08X})", static_cast<unsigned>(hr)));
        if (SUCCEEDED(init)) CoUninitialize(); return result;
    }
    ComPtr<ISensorCollection> sensors;
    hr = manager->GetSensorsByCategory(SENSOR_CATEGORY_OTHER, &sensors);
    if (FAILED(hr)) hr = manager->GetSensorsByType(SENSOR_TYPE_CUSTOM, &sensors);
    ULONG count{}; if (sensors) sensors->GetCount(&count);
    Logger::instance().write(LogLevel::info, std::format(L"Sensor API discovered {} custom/other sensor(s)", count));
    for (ULONG i=0; i<count; ++i) {
        ComPtr<ISensor> sensor; if (FAILED(sensors->GetAt(i, &sensor))) continue;
        GUID id{}, type{}; sensor->GetID(&id); sensor->GetType(&type);
        SensorInfo info;
        info.friendlyName = getString(sensor.Get(), SENSOR_PROPERTY_FRIENDLY_NAME);
        info.description = getString(sensor.Get(), SENSOR_PROPERTY_DESCRIPTION);
        info.id = guidString(id); info.type = guidString(type);
        const auto marker = std::wstring(L"#AndroidHeadTracker#");
        info.androidHeadTracker = info.description.starts_with(marker) || info.friendlyName.find(marker) != std::wstring::npos;
        result.push_back(std::move(info));
    }
    sensors.Reset();manager.Reset();
    if (SUCCEEDED(init)) CoUninitialize();
    return result;
}

SensorBackend::~SensorBackend(){disconnect();}

bool SensorBackend::connect(const SensorInfo& info,SampleCallback callback) {
    disconnect();GUID sensorId{};if(FAILED(CLSIDFromString(info.id.c_str(),&sensorId)))return false;running_=true;
    reader_=std::jthread([this,sensorId,callback=std::move(callback)](std::stop_token stop){
        const auto init=CoInitializeEx(nullptr,COINIT_MULTITHREADED);ComPtr<ISensorManager> manager;ComPtr<ISensor> sensor;
        auto hr=CoCreateInstance(CLSID_SensorManager,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&manager));if(SUCCEEDED(hr))hr=manager->GetSensorByID(sensorId,&sensor);
        if(FAILED(hr)){Logger::instance().write(LogLevel::error,std::format(L"Sensor API open failed (0x{:08X}); check sensor privacy permissions",static_cast<unsigned>(hr)));running_=false;if(SUCCEEDED(init))CoUninitialize();return;}
        ComPtr<IPortableDeviceValues> requested,results;if(SUCCEEDED(CoCreateInstance(CLSID_PortableDeviceValues,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&requested)))){
            requested->SetUnsignedIntegerValue(SENSOR_PROPERTY_CURRENT_REPORT_INTERVAL,10);hr=sensor->SetProperties(requested.Get(),&results);
            Logger::instance().write(SUCCEEDED(hr)?LogLevel::info:LogLevel::warning,std::format(L"Sensor API requested 10 ms interval (0x{:08X})",static_cast<unsigned>(hr)));
        }
        auto sink=Microsoft::WRL::Make<SensorEventSink>(std::move(callback),&running_);
        hr=sink? sensor->SetEventSink(sink.Get()):E_OUTOFMEMORY;
        if(FAILED(hr)){Logger::instance().write(LogLevel::error,std::format(L"Sensor API event subscription failed (0x{:08X})",static_cast<unsigned>(hr)));running_=false;sensor.Reset();manager.Reset();if(SUCCEEDED(init))CoUninitialize();return;}
        while(!stop.stop_requested()&&running_)std::this_thread::sleep_for(std::chrono::milliseconds(10));
        sensor->SetEventSink(nullptr);sink.Reset();
        sensor.Reset();manager.Reset();if(SUCCEEDED(init))CoUninitialize();running_=false;
    });
    Logger::instance().write(LogLevel::info,L"Windows Sensor API event-driven fallback started");return true;
}

void SensorBackend::disconnect(){running_=false;if(reader_.joinable()){reader_.request_stop();reader_.join();}}

} // namespace sony
