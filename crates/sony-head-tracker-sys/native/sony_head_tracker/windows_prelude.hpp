// Minimal Windows SDK prelude for the embedded HID and Sensor API backends.
// The upstream GUI, Bluetooth repair, Winsock, and shell headers are intentionally omitted.
#pragma once

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
#ifndef _NTDEF_
typedef LONG NTSTATUS;
#endif
#include <SetupAPI.h>
#include <cfgmgr32.h>
#include <devpkey.h>
#include <hidusage.h>
#include <hidsdi.h>
#include <hidpi.h>
#include <Sensors.h>
#include <SensorsApi.h>
#include <PortableDeviceTypes.h>
#include <objbase.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>
