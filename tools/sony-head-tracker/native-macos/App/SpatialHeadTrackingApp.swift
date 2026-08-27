import SwiftUI

@main
struct SpatialHeadTrackingApp: App {
    @StateObject private var model = TrackerViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onAppear { model.start() }
        }
        .windowResizability(.contentSize)
    }
}
