import Foundation

@MainActor
protocol HeadTrackerProvider: AnyObject {
    var onStateChange: ((TrackerConnectionState) -> Void)? { get set }
    var onPose: ((HeadPose) -> Void)? { get set }

    func start()
    func stop()
    func recenter()
}
