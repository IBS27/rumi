import RoomPlan
import SwiftUI

struct CaptureScreen: View {
    @ObservedObject var model: ScanModel
    @State private var confirmsDiscard = false
    @StateObject private var connection = CaptureConnection()
    @State private var showsPairing = false
    @State private var startAfterPairing = false
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
                connectionStatus
                actions
            }
            .multilineTextAlignment(.center)
            .padding()
            .background(.bar)
        }
        .tint(Color(red: 0.16, green: 0.36, blue: 0.30))
        .confirmationDialog("Discard this scan?", isPresented: $confirmsDiscard, titleVisibility: .visible) {
            Button("Discard and start another scan", role: .destructive) {
                connection.prepareForNewScan()
                model.startOver()
            }
            Button("Keep scan", role: .cancel) {}
        } message: {
            Text("Export any completed scan you want to keep before starting over. This removes the saved result from this iPhone.")
        }
        .sheet(isPresented: $showsPairing, onDismiss: {
            // Release the QR camera before RoomPlan takes ownership of it.
            if startAfterPairing {
                startAfterPairing = false
                model.start()
            }
        }) {
            PairingScreen(connection: connection) {
                startAfterPairing = model.lifecycle.phase == .welcome
            }
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
            primary("Connect to Rumi") { showsPairing = true }
            Button("Start Scan", action: model.start)
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
            Text("\(model.photoCount) photos saved · \(model.photoGuidance)")
                .font(.footnote).foregroundStyle(.secondary)
            primary("Finish Scan", action: model.finish)
            Button("Start over") { confirmsDiscard = true }
        case .processing:
            ProgressView("Finishing the scan. Keep Rumi open.")
            Button("Start over") { confirmsDiscard = true }
        case .completed:
            if connection.isBusy {
                ProgressView("Sending room…")
                Button("Cancel transfer", action: connection.cancel)
            } else if connection.sent {
                Label("Sent to Rumi", systemImage: "checkmark.circle")
            } else if connection.isConnected {
                primary(model.hasSurfacePackage ? "Send to Rumi" : "Send layout to Rumi") {
                    connection.send(packageURL: model.packageURL, bytes: model.completedBytes)
                }
                    .disabled(model.isSharing || model.isPreparingSurface)
            } else {
                primary("Connect to Rumi") { showsPairing = true }
                    .disabled(model.isSharing || model.isPreparingSurface)
            }
            if model.isPreparingSurface {
                ProgressView("Saving surfaces and photos. Keep Rumi open.")
            } else if model.hasSurfacePackage {
                Button("Export scan", action: model.exportScan).disabled(model.isSharing || connection.isBusy)
                Button("Export layout JSON", action: model.export).disabled(model.isSharing || connection.isBusy)
            } else {
                Button("Export layout JSON", action: model.export).disabled(model.isSharing || connection.isBusy)
                if model.controller != nil {
                    Button("Retry saving detailed scan", action: model.retrySurfacePackage).disabled(model.isSharing || connection.isBusy)
                }
            }
            Button("Start another scan", action: requestStartOver).disabled(model.isSharing || connection.isBusy || model.isPreparingSurface)
        case .failed:
            primary("Start another scan", action: requestStartOver)
        }
    }

    @ViewBuilder private var connectionStatus: some View {
        if let message = connection.message {
            Text(message).font(.footnote).foregroundStyle(.secondary)
        }
        if connection.isConnected, !connection.sent {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text(connection.canSend ? "Connected to Rumi" : "Connection expired. Reconnect to send your scan.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        if !model.lifecycle.isCapturing, model.lifecycle.phase != .requestingPermission,
           model.lifecycle.phase != .welcome, model.lifecycle.phase != .completed || connection.isConnected {
            Button(connection.isConnected ? "Connect to another session" : "Connect to Rumi") { showsPairing = true }
                .disabled(model.isSharing || connection.isBusy || model.isPreparingSurface)
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.headline).frame(maxWidth: .infinity)
            .buttonStyle(.borderedProminent).controlSize(.large)
    }

    private func requestStartOver() {
        if model.needsDiscardConfirmation { confirmsDiscard = true }
        else { connection.prepareForNewScan(); model.startOver() }
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
            "Send the detailed room and photos to your paired browser, or keep a copy with Export scan. Layout JSON remains available separately."
        case .failed(let message): message
        default:
            "Open Scan with iPhone in Rumi, then scan its QR code. Move slowly around the room and show the sides of furniture. Photos are captured automatically. Send to Rumi includes the surfaces and room photos; Export scan keeps a ZIP copy.\n\nYou can also scan offline and connect or export later."
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
