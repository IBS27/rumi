import Foundation

/// Tokens prevent late permission and RoomPlan callbacks from reviving an old scan.
struct ScanLifecycle {
    enum Phase: Equatable {
        case welcome, requestingPermission, unsupported, cameraDenied
        case starting, scanning, processing, completed
        case failed(String)
    }

    private(set) var phase: Phase = .welcome
    private(set) var token: UUID?

    var isCapturing: Bool {
        phase == .starting || phase == .scanning || phase == .processing
    }

    mutating func requestStart() -> UUID? {
        guard token == nil, phase != .completed else { return nil }
        let id = UUID()
        token = id
        phase = .requestingPermission
        return id
    }

    mutating func authorize(_ id: UUID, supported: Bool, cameraAllowed: Bool) -> Bool {
        guard token == id, phase == .requestingPermission else { return false }
        guard supported, cameraAllowed else {
            token = nil
            phase = supported ? .cameraDenied : .unsupported
            return false
        }
        phase = .starting
        return true
    }

    mutating func didStart(_ id: UUID) {
        guard token == id, phase == .starting else { return }
        phase = .scanning
    }

    @discardableResult
    mutating func process(_ id: UUID) -> Bool {
        guard token == id, phase == .scanning || phase == .starting else { return false }
        phase = .processing
        return true
    }

    @discardableResult
    mutating func complete(_ id: UUID) -> Bool {
        guard token == id, phase == .processing else { return false }
        token = nil
        phase = .completed
        return true
    }

    mutating func fail(_ id: UUID, message: String) {
        guard token == id else { return }
        token = nil
        phase = .failed(message)
    }

    mutating func restoreCompleted() { token = nil; phase = .completed }
    mutating func restoreFailed(_ message: String) { token = nil; phase = .failed(message) }
    mutating func reset() { self = ScanLifecycle() }
}
