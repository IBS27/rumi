import RoomPlan
import ARKit
import UIKit

/// Owns exactly one RoomCaptureView/session. The same view stays mounted for review.
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
    var onStarted: (() -> Void)?
    var onProcessing: (() -> Void)?
    var onCompleted: ((CapturedRoom) -> Void)?
    var onPhotoProgress: ((Int, String) -> Void)?
    var onFailure: ((String) -> Void)?

    private var captureView: RoomCaptureView?
    private var hasStarted = false
    private var hasStopped = false
    private var acceptsResults = true
    private let surfaceRecorder = SurfaceRecorder()
    private var surfaceTimer: Timer?
    private var finalMeshAnchors: [ARMeshAnchor] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        let session = ARSession()
        let tracking = ARWorldTrackingConfiguration()
        if let format = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
            tracking.videoFormat = format
        }
        surfaceRecorder.onProgress = { [weak self] count, message in
            Task { @MainActor [weak self] in
                guard let self, self.acceptsResults, !self.hasStopped else { return }
                self.onPhotoProgress?(count, message)
            }
        }
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            tracking.sceneReconstruction = .meshWithClassification
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            tracking.frameSemantics.insert(.sceneDepth)
        }
        session.run(tracking)
        let capture = RoomCaptureView(frame: .zero, arSession: session)
        capture.delegate = self
        capture.captureSession.delegate = self
        capture.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(capture)
        NSLayoutConstraint.activate([
            capture.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            capture.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            capture.topAnchor.constraint(equalTo: view.topAnchor),
            capture.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        captureView = capture
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasStarted, acceptsResults else { return }
        hasStarted = true
        var configuration = RoomCaptureSession.Configuration()
        configuration.isCoachingEnabled = true
        captureView?.captureSession.run(configuration: configuration)
        surfaceTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.acceptsResults, !self.hasStopped,
                      let frame = self.captureView?.captureSession.arSession.currentFrame else { return }
                if let session = self.captureView?.captureSession.arSession {
                    self.surfaceRecorder.sample(frame, session: session)
                }
            }
        }
    }

    func finish() {
        guard hasStarted, !hasStopped, acceptsResults else { return }
        hasStopped = true
        captureView?.captureSession.stop()
        freezeSurfaces()
    }

    private func freezeSurfaces() {
        surfaceTimer?.invalidate()
        surfaceTimer = nil
        captureView?.captureSession.arSession.pause()
        if finalMeshAnchors.isEmpty {
            finalMeshAnchors = captureView?.captureSession.arSession.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
        }
    }

    func preparePackage(roomJSON: Data, destination: URL, completion: @escaping @Sendable (Result<URL, Error>) -> Void) {
        freezeSurfaces()
        surfaceRecorder.finish(roomJSON: roomJSON, anchors: finalMeshAnchors, destination: destination, completion: completion)
    }

    func invalidate() {
        acceptsResults = false
        surfaceTimer?.invalidate()
        surfaceTimer = nil
        surfaceRecorder.discard()
        captureView?.delegate = nil
        captureView?.captureSession.delegate = nil
        if hasStarted, !hasStopped {
            hasStopped = true
            captureView?.captureSession.stop()
        }
        captureView?.captureSession.arSession.pause()
    }

    // RoomPlan's protocol is not actor annotated. Marshal every callback to the UI queue.
    nonisolated func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error {
            reportFailure(error.localizedDescription)
            return false
        }
        return onMain {
            guard self.acceptsResults else { return false }
            self.hasStopped = true
            self.freezeSurfaces()
            self.onProcessing?()
            return true
        }
    }

    nonisolated func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error { reportFailure(error.localizedDescription); return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.acceptsResults else { return }
            self.onCompleted?(processedResult)
        }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didStartWith configuration: RoomCaptureSession.Configuration) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.acceptsResults else { return }
            self.onStarted?()
        }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        if let error { reportFailure(error.localizedDescription) }
    }

    nonisolated private func reportFailure(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.acceptsResults else { return }
            self.onFailure?(message)
        }
    }

    nonisolated private func onMain(_ action: @MainActor @Sendable () -> Bool) -> Bool {
        if Thread.isMainThread { return MainActor.assumeIsolated { action() } }
        return DispatchQueue.main.sync { action() }
    }
}
