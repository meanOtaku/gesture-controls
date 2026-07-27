// The vendored HID reader only needs this label-resolution symbol. The full
// upstream Bluetooth probe/driver-repair module is deliberately not linked into
// the in-process library; the caller falls back to the descriptor product name.
#include "sony_head_tracker/bluetooth.hpp"

namespace sony {
std::wstring bluetoothNameForHidInstance(std::wstring_view) { return {}; }
} // namespace sony
