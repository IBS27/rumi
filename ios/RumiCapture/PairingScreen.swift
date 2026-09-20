import AVFoundation
import SwiftUI
import VisionKit

struct PairingScreen: View {
    @ObservedObject var connection: CaptureConnection
    let onConnected: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var cameraAllowed = false
    @State private var checkingPermission = true
    @State private var foundCode = false
    @State private var scannerError: String?
    @State private var scannerId = UUID()

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if foundCode, let pairing = connection.pairing {
                    Image(systemName: "link").font(.largeTitle)
                    Text("Connect to this Rumi session?").font(.title2.bold())
                    Text(pairing.baseUrl).font(.footnote).textSelection(.enabled)
                    Text("Your completed room will be sent to the browser that displayed this code when you tap Send to Rumi.")
                        .foregroundStyle(.secondary)
                    if connection.isBusy {
                        ProgressView("Connecting…")
                    } else {
                        Button("Connect to Rumi") {
                            connection.claim {
                                onConnected()
                                dismiss()
                            }
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        Button("Scan another code") { foundCode = false; scannerId = UUID() }
                    }
                } else if checkingPermission {
                    ProgressView("Waiting for camera permission…")
                } else if !DataScannerViewController.isSupported {
                    Text("QR scanning needs a supported physical iPhone.").font(.headline)
                } else if !cameraAllowed {
                    Text("Allow camera access to scan the QR code.").font(.headline)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    Button("Check permission again") { Task { await checkPermission() } }
                } else if let scannerError {
                    Text(scannerError)
                    Button("Try camera again") { self.scannerError = nil; scannerId = UUID() }
                } else if scenePhase == .active {
                    Text("In the web app, choose Scan with iPhone. Point your camera at its QR code.")
                    QRScanner(onCode: { text in
                        foundCode = connection.readCode(text)
                        if !foundCode { scannerError = connection.message }
                    }, onError: { scannerError = $0 })
                    .id(scannerId)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .accessibilityLabel("Scan the Rumi QR code")
                }
                if foundCode, let message = connection.message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding().multilineTextAlignment(.center)
            .navigationTitle("Connect to Rumi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if connection.isBusy { connection.cancel() }
                        dismiss()
                    }
                }
            }
            .task { await checkPermission() }
            .onDisappear { if connection.isBusy { connection.cancel() } }
            .interactiveDismissDisabled(connection.isBusy)
        }
    }

    @MainActor private func checkPermission() async {
        guard DataScannerViewController.isSupported else {
            checkingPermission = false
            return
        }
        checkingPermission = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: cameraAllowed = true
        case .notDetermined: cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
        default: cameraAllowed = false
        }
        checkingPermission = false
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        controller.onError = onError
        return controller
    }
    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: QRScannerController, coordinator: ()) { controller.stop() }
}

private final class QRScannerController: UIViewController, DataScannerViewControllerDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private var handled = false
    private let scanner = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])],
        qualityLevel: .accurate,
        recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false,
        isPinchToZoomEnabled: true,
        isGuidanceEnabled: true,
        isHighlightingEnabled: true
    )

    override func viewDidLoad() {
        super.viewDidLoad()
        scanner.delegate = self
        addChild(scanner)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scanner.view)
        NSLayoutConstraint.activate([
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scanner.view.topAnchor.constraint(equalTo: view.topAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handled else { return }
        do { try scanner.startScanning() }
        catch { onError?("Couldn't start the QR camera. Check camera access in Settings and try again.") }
    }

    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stop() }
    func stop() { scanner.stopScanning() }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            if case .barcode(let code) = item, let text = code.payloadStringValue, !handled {
                handled = true
                stop()
                onCode?(text)
                return
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        stop()
        onError?("QR scanning was interrupted. Keep Rumi open and try again.")
    }
}
