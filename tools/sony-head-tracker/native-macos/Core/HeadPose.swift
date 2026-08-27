import Foundation

struct Vector3: Equatable, Sendable {
    var x: Double = 0
    var y: Double = 0
    var z: Double = 0
}

struct Quaternion: Equatable, Sendable {
    var w: Double = 1
    var x: Double = 0
    var y: Double = 0
    var z: Double = 0
}

struct HeadPose: Equatable, Sendable {
    var quaternion = Quaternion()
    var yaw: Double = 0
    var pitch: Double = 0
    var roll: Double = 0
    var gyroscope = Vector3()
    var packetsPerSecond: Double = 0
    var receivedAt = Date()
}
