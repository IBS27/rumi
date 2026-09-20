import RoomPlan
import SwiftUI

struct CaptureScreen: View {
    @ObservedObject var model: ScanModel
    @State private var confirmsDiscard = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Rumi").font(.title2.bold())
                Spacer()
                Text("ROOM CAPTURE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding()

            if let controller = model.controller {
                RoomCaptureContainer(controller: controller)
                    .id(ObjectIdentifier(controller))
                    .overlay(alignment: .top) {
                        if model.lifecycle.phase == .processing {
                            Label("Processing room…", systemImage: "hourglass")
                                .padding().background(.regularMaterial, in: Capsule()).padding()
                        }
                    }
                    .accessibilityLabel("RoomPlan scan and room preview")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Image(systemName: icon).font(.system(size: 52)).foregroundStyle(.tint)
                            .accessibilityHidden(true)
                        Text(title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                        Text(explanation).font(.body).foregroundStyle(.secondary)
                        if let room = model.room { roomSummary(room) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
                }
            }

            VStack(spacing: 12) {
                if model.controller != nil, let room = model.room {
                    Text("Room ready").font(.headline)
                    Text("\(room.walls.count) walls · \(room.doors.count) doors · \(room.windows.count) windows · \(room.openings.count) openings · \(room.objects.count) objects")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Drag and pinch to inspect the room.").font(.caption).foregroundStyle(.secondary)
                }
                if let message = model.exportMessage {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
                if let message = model.surfaceMessage {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
                actions
            }
            .multilineTextAlignment(.center)
            .padding()
            .background(.bar)
        }
        .tint(Color(red: 0.16, green: 0.36, blue: 0.30))
        .confirmationDialog("Discard this scan?", isPresented: $confirmsDiscard, titleVisibility: .visible) {
            Button("Discard and start another scan", role: .destructive) { model.startOver() }
            Button("Keep scan", role: .cancel) {}
        } message: {
            Text("Export any completed scan you want to keep before starting over. This removes the saved result from this iPhone.")
        }
        .sheet(item: $model.shareFile, onDismiss: model.shareDismissed) { file in
            RoomShareSheet(url: file.url, onCompletion: model.shareFinished)
                .ignoresSafeArea()
        }
        .alert("Could not start over", isPresented: Binding(
            get: { model.alertMessage != nil },
            set: { if !$0 { model.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.alertMessage = nil }
        } message: { Text(model.alertMessage ?? "") }
    }

    @ViewBuilder private var actions: some View {
        switch model.lifecycle.phase {
        case .welcome:
            primary("Start Scan", action: model.start)
        case .requestingPermission:
            ProgressView("Waiting for camera permission…")
        case .unsupported:
            Text("Scanning requires a physical iPhone with LiDAR.").font(.footnote)
            Button("Check again", action: model.start)
        case .cameraDenied:
            primary("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            Button("Check permission again", action: model.start)
        case .starting:
            ProgressView("Starting camera…")
            Button("Start over") { confirmsDiscard = true }
        case .scanning:
            Text("Move slowly around furniture and show its sides. Photos capture its appearance; hidden surfaces remain unknown.")
                .font(.footnote).foregroundStyle(.secondary)
            primary("Finish Scan", action: model.finish)
            Button("Start over") { confirmsDiscard = true }
        case .processing:
            ProgressView("Finishing the scan. Keep Rumi open.")
            Button("Start over") { confirmsDiscard = true }
        case .completed:
            if model.isPreparingSurface {
                ProgressView("Saving surfaces and photos. Keep Rumi open.")
            } else if model.hasSurfacePackage {
                primary("Export scan", action: model.exportScan).disabled(model.isSharing)
                Button("Export layout JSON", action: model.export).disabled(model.isSharing)
            } else {
                primary("Export JSON", action: model.export).disabled(model.isSharing)
                if model.controller != nil {
                    Button("Retry saving detailed scan", action: model.retrySurfacePackage).disabled(model.isSharing)
                }
            }
            Button("Start another scan", action: requestStartOver).disabled(model.isSharing || model.isPreparingSurface)
        case .failed:
            primary("Start another scan", action: requestStartOver)
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.headline).frame(maxWidth: .infinity)
            .buttonStyle(.borderedProminent).controlSize(.large)
    }

    private func requestStartOver() {
        if model.needsDiscardConfirmation { confirmsDiscard = true }
        else { model.startOver() }
    }

    private func roomSummary(_ room: CapturedRoom) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(room.walls.count) walls · \(room.floors.count) floors")
            Text("\(room.doors.count) doors · \(room.windows.count) windows · \(room.openings.count) openings")
            Text("\(room.objects.count) objects")
            Text("Saved on this iPhone. The interactive RoomPlan preview is available immediately after scanning.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var title: String {
        switch model.lifecycle.phase {
        case .unsupported: "Room scanning isn't available"
        case .cameraDenied: "Allow camera access"
        case .completed: "Your room is ready"
        case .failed: "Scan couldn't finish"
        default: "Bring your room into Rumi"
        }
    }

    private var explanation: String {
        switch model.lifecycle.phase {
        case .unsupported:
            "This device doesn't support Apple RoomPlan. Use a LiDAR-equipped iPhone with iOS 17 or later. The simulator cannot capture a room."
        case .cameraDenied:
            "Rumi needs the camera to scan your room. Enable Camera for Rumi Capture in Settings, then return here and check permission again. If access is restricted, check Screen Time or device-management settings."
        case .completed:
            "Share your saved scan with your Mac and import it into Rumi. Detailed scans include photos of your room."
        case .failed(let message): message
        default:
            "Scan one room with your iPhone's LiDAR camera. Move slowly around the room and show furniture from several angles, then export the scan to Rumi on your Mac.\n\nThe scan includes room photos and visible surface shapes. Scanning and saving stay on this iPhone until you share the file."
        }
    }

    private var icon: String {
        switch model.lifecycle.phase {
        case .unsupported, .failed: "exclamationmark.triangle"
        case .cameraDenied: "camera"
        case .completed: "checkmark.circle"
        default: "viewfinder"
        }
    }
}

private struct RoomCaptureContainer: UIViewControllerRepresentable {
    let controller: RoomScanViewController
    func makeUIViewController(context: Context) -> RoomScanViewController { controller }
    func updateUIViewController(_ uiViewController: RoomScanViewController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: RoomScanViewController, coordinator: ()) {
        uiViewController.invalidate()
    }
}

private struct RoomShareSheet: UIViewControllerRepresentable {
    let url: URL
    let onCompletion: (Bool, Error?) -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, error in
            DispatchQueue.main.async { onCompletion(completed, error) }
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
