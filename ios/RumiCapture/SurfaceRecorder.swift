@preconcurrency import ARKit
import CoreImage
import Foundation
import ImageIO
import simd

struct SurfaceFrame: Encodable {
    let image: String
    let depth: String
    let confidence: String
    let width: Int
    let height: Int
    let depthWidth: Int
    let depthHeight: Int
    let fx: Float
    let fy: Float
    let cx: Float
    let cy: Float
    let cameraTransform: [Float]
    let timestamp: TimeInterval
}
struct SurfaceMesh: Encodable {
    let positions: String
    let indices: String
    let classifications: String
    let transform: [Float]
    let vertexCount: Int
    let faceCount: Int
}
struct SurfaceManifest: Encodable {
    let format = "rumi.capture"
    let version = 1
    let coordinates = "arkit-world-meters-y-up"
    let room = "roomplan.json"
    let meshes: [SurfaceMesh]
    let frames: [SurfaceFrame]
    let warnings: [String]
}

/// Mutable state is confined to queue. The semaphore admits at most one retained ARFrame.
/// Polling currentFrame avoids replacing RoomCaptureView's own ARSession delegate.
final class SurfaceRecorder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "rumi.surface-recorder", qos: .utility)
    private let capacity = DispatchSemaphore(value: 1)
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var frames: [SurfaceFrame] = []
    private var poses: [simd_float4x4] = []
    private var lastTimestamp: TimeInterval = -1
    private var previousPose: simd_float4x4?
    private var previousTime: TimeInterval = 0
    private var failure: String?
    private var stopped = false
    private var frameBytes = 0
    private var photoPixels = 0
    var onProgress: (@Sendable (Int, String) -> Void)?
    private var budgetReached = false

    func sample(_ frame: ARFrame, session: ARSession) {
        guard capacity.wait(timeout: .now()) == .success else { return }
        queue.async { [self] in
            guard !stopped, failure == nil, eligible(frame) else { capacity.signal(); return }
            // Keep one request in flight, without replacing RoomPlan's session delegate.
            DispatchQueue.main.async { [self] in
                session.captureHighResolutionFrame { [self] highResolution, _ in
                    queue.async { [self] in
                        defer { capacity.signal() }
                        autoreleasepool {
                            guard !stopped, failure == nil else { return }
                            // Never combine a high-resolution image with another frame's pose/depth.
                            let selected: ARFrame
                            if let highResolution, highResolution.sceneDepth?.confidenceMap != nil { selected = highResolution }
                            else { selected = frame }
                            do { try record(selected) }
                            catch {
                                failure = "Surface photos could not be saved: \(error.localizedDescription)"
                                guidance("Photos could not be saved. The room layout is still being captured.")
                            }
                        }
                    }
                }
            }
        }
    }

    private func guidance(_ text: String) { onProgress?(frames.count, text) }

    private func eligible(_ frame: ARFrame) -> Bool {
        guard case .normal = frame.camera.trackingState else {
            guidance("Move slowly while the camera finds its position."); return false
        }
        let pose = frame.camera.transform
        let timestamp = frame.timestamp
        defer { previousPose = pose; previousTime = timestamp }
        guard !budgetReached, frames.count < 160, frameBytes < 96 * 1024 * 1024, photoPixels < 800_000_000 else {
            budgetReached = true
            guidance("Photo limit reached. Finish once the room layout is complete."); return false
        }
        guard timestamp - lastTimestamp >= 1.0 else { return false }
        guard frame.sceneDepth?.confidenceMap != nil else {
            guidance("Point at a nearby wall or furniture to capture depth."); return false
        }
        if let previousPose {
            let elapsed = max(timestamp - previousTime, 0.01)
            let movement = simd_distance(pose.columns.3, previousPose.columns.3)
            let angle = acos(min(1, max(-1, simd_dot(pose.columns.2, previousPose.columns.2))))
            guard movement / Float(elapsed) < 0.35, angle / Float(elapsed) < 0.5 else {
                guidance("Slow down briefly for a sharp photo."); return false
            }
        }
        guard !poses.contains(where: {
            simd_distance($0.columns.3, pose.columns.3) < 0.15 && simd_dot($0.columns.2, pose.columns.2) > 0.99
        }) else {
            guidance("Show another side of the furniture, or scan from a lower angle."); return false
        }
        return true
    }

    private func record(_ frame: ARFrame) throws {
        guard case .normal = frame.camera.trackingState,
              let depth = frame.sceneDepth, let confidence = depth.confidenceMap else { return }
        guard sharpEnough(frame.capturedImage) else {
            guidance("Hold steady and keep the room well lit."); return
        }
        let pose = frame.camera.transform
        let timestamp = frame.timestamp
        let native = frame.camera.imageResolution
        let sourceWidth = CGFloat(CVPixelBufferGetWidth(frame.capturedImage))
        let sourceHeight = CGFloat(CVPixelBufferGetHeight(frame.capturedImage))
        let scale = min(1, 2560 / max(sourceWidth, sourceHeight))
        let width = Int((sourceWidth * scale).rounded())
        let height = Int((sourceHeight * scale).rounded())
        let image = CIImage(cvPixelBuffer: frame.capturedImage).transformed(by: CGAffineTransform(scaleX: CGFloat(width) / sourceWidth, y: CGFloat(height) / sourceHeight))
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.9]) else { return }
        let w = CVPixelBufferGetWidth(depth.depthMap), h = CVPixelBufferGetHeight(depth.depthMap)
        guard w <= 512, h <= 512, CVPixelBufferGetWidth(confidence) == w, CVPixelBufferGetHeight(confidence) == h else { return }
        let depthBytes = copyRows(depth.depthMap, rowBytes: w * 4, height: h)
        let confidenceBytes = copyRows(confidence, rowBytes: w, height: h)
        guard depthBytes.count == w * h * 4, confidenceBytes.count == w * h, jpeg.count <= 8 * 1024 * 1024 else { return }
        let payloadBytes = jpeg.count + depthBytes.count + confidenceBytes.count
        guard frameBytes + payloadBytes <= 96 * 1024 * 1024,
              photoPixels + width * height <= 800_000_000 else {
            budgetReached = true
            guidance("Photo limit reached. Finish once the room layout is complete."); return
        }
        let prefix = "frames/\(frames.count)"
        try write(jpeg, name: "\(prefix).jpg")
        try write(depthBytes, name: "\(prefix)-depth.bin")
        try write(confidenceBytes, name: "\(prefix)-confidence.bin")
        let k = frame.camera.intrinsics
        frames.append(SurfaceFrame(image: "\(prefix).jpg", depth: "\(prefix)-depth.bin", confidence: "\(prefix)-confidence.bin",
            width: width, height: height, depthWidth: w, depthHeight: h,
            fx: k.columns.0.x * Float(CGFloat(width) / native.width), fy: k.columns.1.y * Float(CGFloat(height) / native.height),
            cx: k.columns.2.x * Float(CGFloat(width) / native.width), cy: k.columns.2.y * Float(CGFloat(height) / native.height),
            cameraTransform: Self.matrix(pose), timestamp: timestamp))
        frameBytes += payloadBytes
        photoPixels += width * height
        poses.append(pose)
        lastTimestamp = timestamp
        guidance("Photo saved. Keep overlapping views and include corners and furniture sides.")
    }

    /// Called only after the AR session pauses, so final mesh buffers are no longer changing.
    func finish(roomJSON: Data, anchors: [ARMeshAnchor], destination: URL, completion: @escaping @Sendable (Result<URL, Error>) -> Void) {
        queue.async { [self] in
            stopped = true
            let result: Result<URL, Error> = Result {
                var meshes: [SurfaceMesh] = []
                var vertices = 0, faces = 0
                for anchor in anchors.sorted(by: { $0.identifier.uuidString < $1.identifier.uuidString }) {
                    let geometry = anchor.geometry
                    guard geometry.vertices.count > 0, geometry.faces.count > 0 else { continue }
                    vertices += geometry.vertices.count; faces += geometry.faces.count
                    guard vertices <= 600_000, faces <= 300_000, meshes.count < 2048 else {
                        throw RecorderError.message("The surface scan is too large. The room layout is saved; try a smaller room for detailed capture.")
                    }
                    let prefix = "meshes/\(meshes.count)"
                    var positions = Data(), indices = Data(), classifications = Data()
                    for i in 0..<geometry.vertices.count {
                        let p = geometry.vertices.buffer.contents().advanced(by: geometry.vertices.offset + i * geometry.vertices.stride)
                        for axis in 0..<3 { positions.le(p.load(fromByteOffset: axis * 4, as: Float.self).bitPattern) }
                    }
                    let faceData = geometry.faces.buffer.contents()
                    guard geometry.faces.indexCountPerPrimitive == 3 else { throw RecorderError.message("Unsupported surface geometry.") }
                    for i in 0..<(geometry.faces.count * 3) {
                        let offset = i * geometry.faces.bytesPerIndex
                        let index: UInt32
                        switch geometry.faces.bytesPerIndex {
                        case 2: index = UInt32(faceData.load(fromByteOffset: offset, as: UInt16.self))
                        case 4: index = faceData.load(fromByteOffset: offset, as: UInt32.self)
                        default: throw RecorderError.message("Unsupported surface indices.")
                        }
                        indices.le(index)
                    }
                    for i in 0..<geometry.faces.count {
                        if let source = geometry.classification {
                            let value = source.buffer.contents().load(fromByteOffset: source.offset + i * source.stride, as: UInt8.self)
                            classifications.append(value <= 7 ? value : 0)
                        } else { classifications.append(0) }
                    }
                    try write(positions, name: "\(prefix)-positions.bin")
                    try write(indices, name: "\(prefix)-indices.bin")
                    try write(classifications, name: "\(prefix)-classes.bin")
                    meshes.append(SurfaceMesh(positions: "\(prefix)-positions.bin", indices: "\(prefix)-indices.bin", classifications: "\(prefix)-classes.bin", transform: Self.matrix(anchor.transform), vertexCount: geometry.vertices.count, faceCount: geometry.faces.count))
                }
                guard !meshes.isEmpty else { throw RecorderError.message("No detailed surfaces were captured. The RoomPlan layout is still available as JSON.") }
                var warnings: [String] = []
                if let failure { warnings.append(failure) }
                if frames.isEmpty { warnings.append("No usable photos were captured. Surfaces are shown without textures.") }
                if budgetReached { warnings.append("Photo capture reached its limit. Some surfaces may have no texture.") }
                try write(roomJSON, name: "roomplan.json")
                try write(JSONEncoder().encode(SurfaceManifest(meshes: meshes, frames: frames, warnings: warnings)), name: "manifest.json")
                let names = ["roomplan.json", "manifest.json"] + meshes.flatMap { [$0.positions, $0.indices, $0.classifications] } + frames.flatMap { [$0.image, $0.depth, $0.confidence] }
                try CaptureArchive.write(files: names.map { ($0, directory.appendingPathComponent($0)) }, to: destination)
                return destination
            }
            // Keep source files for a retry until the recorder is discarded.
            completion(result)
        }
    }

    func discard() {
        queue.async { [self] in stopped = true; try? FileManager.default.removeItem(at: directory) }
    }
    private func write(_ data: Data, name: String) throws {
        let url = directory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
    }
    private static func matrix(_ m: simd_float4x4) -> [Float] {
        (0..<4).flatMap { column in (0..<4).map { row in m[column][row] } }
    }
    private func copyRows(_ buffer: CVPixelBuffer, rowBytes: Int, height: Int) -> Data {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return Data() }
        var result = Data(capacity: rowBytes * height)
        for row in 0..<height { result.append(base.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)).assumingMemoryBound(to: UInt8.self), count: rowBytes) }
        return result
    }
    private func sharpEnough(_ buffer: CVPixelBuffer) -> Bool {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return false }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let w = CVPixelBufferGetWidthOfPlane(buffer, 0), h = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let pixels = base.assumingMemoryBound(to: UInt8.self)
        var energy: Double = 0, count: Double = 0
        for y in Swift.stride(from: 2, to: h - 2, by: 8) {
            for x in Swift.stride(from: 2, to: w - 2, by: 8) {
                let i = y * stride + x
                let laplacian = 4 * Int(pixels[i]) - Int(pixels[i - 2]) - Int(pixels[i + 2]) - Int(pixels[i - 2 * stride]) - Int(pixels[i + 2 * stride])
                energy += Double(laplacian * laplacian); count += 1
            }
        }
        return count > 0 && energy / count > 30
    }
}
private enum RecorderError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
