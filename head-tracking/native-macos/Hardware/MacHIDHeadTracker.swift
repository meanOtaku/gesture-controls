import Foundation
import IOKit.hid

/// Owns direct IOHID discovery and capture. Descriptor-driven decoding and
/// feature-report configuration are the next implementation slice.
@MainActor
final class MacHIDHeadTracker: HeadTrackerProvider {
    var onStateChange: ((TrackerConnectionState) -> Void)?
    var onPose: ((HeadPose) -> Void)?

    private var manager: IOHIDManager?

    func start() {
        guard manager == nil else { return }
        onStateChange?(.searching)

        let hidManager = IOHIDManagerCreate(
            kCFAllocatorDefault,
            IOOptionBits(kIOHIDOptionsTypeNone)
        )
        let matching: [String: Any] = [
            kIOHIDDeviceUsagePageKey as String: HeadTrackerHID.sensorPage,
            kIOHIDDeviceUsageKey as String: HeadTrackerHID.otherCustom
        ]
        IOHIDManagerSetDeviceMatching(hidManager, matching as CFDictionary)

        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(
            hidManager,
            macDeviceMatched,
            context
        )
        IOHIDManagerRegisterDeviceRemovalCallback(
            hidManager,
            macDeviceRemoved,
            context
        )
        IOHIDManagerScheduleWithRunLoop(
            hidManager,
            CFRunLoopGetMain(),
            CFRunLoopMode.defaultMode.rawValue
        )

        let result = IOHIDManagerOpen(hidManager, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else {
            IOHIDManagerUnscheduleFromRunLoop(
                hidManager,
                CFRunLoopGetMain(),
                CFRunLoopMode.defaultMode.rawValue
            )
            onStateChange?(.permissionRequired)
            return
        }
        manager = hidManager
    }

    func stop() {
        guard let manager else { return }
        IOHIDManagerUnscheduleFromRunLoop(
            manager,
            CFRunLoopGetMain(),
            CFRunLoopMode.defaultMode.rawValue
        )
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = nil
        onStateChange?(.stopped)
    }

    func recenter() {
        // Recenter will store inverse(currentQuaternion) once decoded pose
        // samples are wired into the orientation engine.
    }

    fileprivate func didMatch(device: IOHIDDevice) {
        let product = IOHIDDeviceGetProperty(
            device,
            kIOHIDProductKey as CFString
        ) as? String ?? "Compatible Head Tracker"
        onStateChange?(.connected(device: product))
    }

    fileprivate func didRemove(device: IOHIDDevice) {
        onStateChange?(.searching)
    }

    deinit {
        if let manager {
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        }
    }
}

private func macDeviceMatched(
    context: UnsafeMutableRawPointer?,
    result: IOReturn,
    sender: UnsafeMutableRawPointer?,
    device: IOHIDDevice
) {
    guard result == kIOReturnSuccess, let context else { return }
    let tracker = Unmanaged<MacHIDHeadTracker>
        .fromOpaque(context)
        .takeUnretainedValue()
    Task { @MainActor in tracker.didMatch(device: device) }
}

private func macDeviceRemoved(
    context: UnsafeMutableRawPointer?,
    result: IOReturn,
    sender: UnsafeMutableRawPointer?,
    device: IOHIDDevice
) {
    guard let context else { return }
    let tracker = Unmanaged<MacHIDHeadTracker>
        .fromOpaque(context)
        .takeUnretainedValue()
    Task { @MainActor in tracker.didRemove(device: device) }
}
