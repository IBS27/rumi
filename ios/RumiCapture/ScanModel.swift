import AVFoundation
import RoomPlan
import SwiftUI

@MainActor
final class ScanModel: ObservableObject {
    @Published private(set) var lifecycle = ScanLifecycle() {
        didSet {
            // Keep the phone awake through processing; restore auto-lock on every exit.
            UIApplication.shared.isIdleTimerDisabled = lifecycle.isCapturing
        }
    }
    @Published private(set) var room: CapturedRoom?
    @Published private(set) var exportMessage: String?
    @Published var alertMessage: String?
    @Published var shareFile: ShareFile?
    @Published private(set) var isSharing = false
    @Published private(set) var isPreparingSurface = false
    @Published private(set) var surfaceMessage: String?
    @Published private(set) var hasSurfacePackage = false
    @Published private(set) var photoCount = 0
    @Published private(set) var photoGuidance = "Move slowly. Photos are captured automatically."

    private(set) var controller: RoomScanViewController?
    private let store: RoomFileStore
    private var savedURL: URL?
    private(set) var packageURL: URL?
    private var hasUnreadableSave = false
    private var processingTimeout: Task<Void, Never>?

    var needsDiscardConfirmation: Bool { room != nil || hasUnreadableSave || lifecycle.isCapturing }

    private var supportsCapture: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        RoomCaptureSession.isSupported
        #endif
    }

    init(store: RoomFileStore = RoomFileStore()) {
        self.store = store
        do {
            if let url = try store.currentFile() {
                room = try JSONDecoder().decode(CapturedRoom.self, from: Data(contentsOf: url))
                savedURL = url
                let package = url.deletingPathExtension().appendingPathExtension("zip")
                if FileManager.default.isReadableFile(atPath: package.path) {
                    packageURL = package
                    hasSurfacePackage = true
                }
                lifecycle.restoreCompleted()
            }
        } catch {
            hasUnreadableSave = true
            lifecycle.restoreFailed("The saved scan could not be opened. It has not been deleted. \(error.localizedDescription)")
        }
    }

    func start() {
        guard !isSharing, let id = lifecycle.requestStart() else { return }
        guard supportsCapture else {
            _ = lifecycle.authorize(id, supported: false, cameraAllowed: false)
            return
        }
        Task { [weak self] in
            let allowed: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
            guard let self else { return }
            // Permission sheets temporarily make the scene inactive. Wait for the answer,
            // but never start a camera session while the app is in the background.
            guard UIApplication.shared.applicationState != .background else {
                self.lifecycle.fail(id, message: "The app went into the background before scanning started. Try again.")
                return
            }
            guard self.lifecycle.authorize(id, supported: true, cameraAllowed: allowed) else { return }
            self.photoCount = 0
            self.photoGuidance = "Move slowly. Photos are captured automatically."
            let capture = RoomScanViewController()
            capture.onPhotoProgress = { [weak self] count, message in
                self?.photoCount = count
                self?.photoGuidance = message
            }
            capture.onStarted = { [weak self] in self?.lifecycle.didStart(id) }
            capture.onProcessing = { [weak self] in self?.beginProcessing(id) }
            capture.onCompleted = { [weak self] room in self?.complete(room, id: id) }
            capture.onFailure = { [weak self] message in self?.fail(id, message: message) }
            self.controller = capture
            // Notify after installing the controller as well as the phase change.
            self.objectWillChange.send()
        }
    }

    func finish() {
        guard lifecycle.phase == .scanning, let id = lifecycle.token else { return }
        beginProcessing(id)
        controller?.finish()
    }

    private func beginProcessing(_ id: UUID) {
        guard lifecycle.process(id) else { return }
        processingTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled else { return }
            self?.fail(id, message: "RoomPlan did not finish processing. Start another scan and try again.")
        }
    }

    private func complete(_ result: CapturedRoom, id: UUID) {
        guard !result.walls.isEmpty else {
            fail(id, message: "RoomPlan did not detect any walls. Scan the walls of one room and try again.")
            return
        }
        guard lifecycle.complete(id) else { return }
        processingTimeout?.cancel()
        room = result
        persistResult()
        prepareSurfacePackage()
    }

    private func prepareSurfacePackage() {
        guard let controller, let savedURL else { return }
        do {
            let json = try Data(contentsOf: savedURL)
            let destination = savedURL.deletingPathExtension().appendingPathExtension("zip")
            isPreparingSurface = true
            surfaceMessage = nil
            UIApplication.shared.isIdleTimerDisabled = true
            controller.preparePackage(roomJSON: json, destination: destination) { [weak self] result in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isPreparingSurface = false
                    UIApplication.shared.isIdleTimerDisabled = false
                    switch result {
                    case .success(let url):
                        self.packageURL = url
                        self.hasSurfacePackage = true
                        self.surfaceMessage = "Detailed surfaces and photos are saved. Send to Rumi includes them. The preview above shows the RoomPlan layout."
                    case .failure(let error):
                        self.surfaceMessage = "Detailed capture could not be prepared: \(error.localizedDescription) Your room layout is retained."
                    }
                }
            }
        } catch { surfaceMessage = "Could not prepare detailed capture: \(error.localizedDescription)" }
    }

    func retrySurfacePackage() {
        guard lifecycle.phase == .completed, !isSharing, !isPreparingSurface, !hasSurfacePackage else { return }
        persistResult()
        prepareSurfacePackage()
    }

    func exportScan() {
        guard !isPreparingSurface, !isSharing, let packageURL else { return }
        guard FileManager.default.isReadableFile(atPath: packageURL.path) else {
            hasSurfacePackage = false
            surfaceMessage = "The detailed package is missing. Export JSON to retain your room layout."
            return
        }
        presentShare(packageURL)
    }

    private func persistResult() {
        guard savedURL == nil, let room else { return }
        do {
            // Critical handoff: direct encoding of FINAL didPresent result. No envelope,
            // intermediate schema, field filtering, coordinate conversion, or units change.
            savedURL = try store.save(JSONEncoder().encode(room))
            exportMessage = nil
        } catch {
            exportMessage = "Could not save JSON: \(error.localizedDescription) Your scan is still in memory. Tap Export JSON to retry before closing the app."
        }
    }

    func completedBytes() throws -> Data {
        guard lifecycle.phase == .completed else { throw CaptureError.invalidRoom }
        persistResult()
        guard let savedURL else {
            throw NSError(domain: "RumiCapture", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Could not save the scan. Free some storage and try again. Your room is still in memory."])
        }
        return try Data(contentsOf: savedURL)
    }

    func export() {
        guard lifecycle.phase == .completed, !isSharing else { return }
        persistResult()
        guard let url = savedURL else { return }
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            savedURL = nil
            persistResult()
            guard let replacement = savedURL else { return }
            presentShare(replacement)
            return
        }
        presentShare(url)
    }

    private func presentShare(_ url: URL) {
        isSharing = true
        shareFile = ShareFile(url: url)
    }

    func shareFinished(completed: Bool, error: Error?) {
        if let error { exportMessage = "Export failed: \(error.localizedDescription) Your scan is retained. Try again." }
        else if completed { exportMessage = "Shared. Your scan is still available to export again." }
        // A canceled activity is not a successful export and never discards the room.
    }

    func shareDismissed() { isSharing = false; shareFile = nil }

    func startOver() {
        guard !isSharing, !isPreparingSurface else { return }
        do { try store.discard() }
        catch { alertMessage = "Could not discard the saved scan: \(error.localizedDescription)"; return }
        controller?.invalidate()
        controller = nil
        processingTimeout?.cancel()
        room = nil
        savedURL = nil
        packageURL = nil
        hasSurfacePackage = false
        surfaceMessage = nil
        hasUnreadableSave = false
        exportMessage = nil
        lifecycle.reset()
        start()
    }

    func sceneChanged(_ phase: ScenePhase) {
        // Losing foreground focus invalidates an active capture, including calls and lock.
        // Completed rooms and sharing are unaffected. Permission prompts are handled above.
        guard phase != .active, lifecycle.isCapturing, let id = lifecycle.token else { return }
        fail(id, message: "Scanning was interrupted. Keep Rumi open while scanning and processing, then start another scan.")
    }

    private func fail(_ id: UUID, message: String) {
        guard lifecycle.token == id else { return }
        lifecycle.fail(id, message: message)
        processingTimeout?.cancel()
        controller?.invalidate()
        controller = nil
    }
}

struct ShareFile: Identifiable {
    let id = UUID()
    let url: URL
}
