import Foundation

enum TrackerConnectionState: Equatable, Sendable {
    case stopped
    case searching
    case permissionRequired
    case connected(device: String)
    case error(message: String)

    var title: String {
        switch self {
        case .stopped: "Stopped"
        case .searching: "Searching for a compatible headset"
        case .permissionRequired: "Input Monitoring permission required"
        case let .connected(device): "Tracking \(device)"
        case let .error(message): message
        }
    }

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}
