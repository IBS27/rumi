import SwiftUI

@main
struct RumiCaptureApp: App {
    @StateObject private var model = ScanModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            CaptureScreen(model: model)
                .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
        }
    }
}
