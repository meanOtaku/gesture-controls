import Foundation

@MainActor
final class TrackerViewModel: ObservableObject {
    @Published private(set) var state: TrackerConnectionState = .stopped
    @Published private(set) var pose = HeadPose()

    private let tracker: any HeadTrackerProvider

    init(tracker: any HeadTrackerProvider = MacHIDHeadTracker()) {
        self.tracker = tracker
        tracker.onStateChange = { [weak self] state in
            self?.state = state
        }
        tracker.onPose = { [weak self] pose in
            self?.pose = pose
        }
    }

    func start() {
        tracker.start()
    }

    func stop() {
        tracker.stop()
    }

    func recenter() {
        tracker.recenter()
    }
}
