// Minimal Windows SDK prelude for the embedded HID and Sensor API backends.
// The upstream GUI, Bluetooth repair, Winsock, and shell headers are intentionally omitted.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <Windows.h>
#include <SetupAPI.h>
#include <cfgmgr32.h>
#include <devpkey.h>
#include <hidpi.h>
#include <hidsdi.h>
#include <Sensors.h>
#include <SensorsApi.h>
#include <PortableDeviceTypes.h>
#include <objbase.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>
