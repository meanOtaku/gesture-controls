import Foundation

enum HeadTrackerHID {
    static let sensorPage = 0x20
    static let otherCustom = 0xE1
    static let sensorDescription = 0x0308
    static let reportInterval = 0x030E
    static let reportingAllEvents = 0x0841
    static let powerFull = 0x0851
    static let rotationVector = 0x0544
    static let angularVelocity = 0x0545
    static let resetCounter = 0x0546
    static let marker = "#AndroidHeadTracker#"
}
