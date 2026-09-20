import Foundation
import Combine

@MainActor
final class CaptureConnection: ObservableObject {
    @Published private(set) var pairing: CapturePairing?
    @Published private(set) var grant: CaptureGrant?
    @Published private(set) var isBusy = false
    @Published private(set) var sent = false
    @Published private(set) var message: String?

    private let client: CaptureClient
    private var claimId = UUID()
    private var upload: (bytes: Data, key: UUID)?
    private var operation: Task<Void, Never>?
    private var operationId: UUID?

    init(client: CaptureClient = CaptureClient()) { self.client = client }

    var isConnected: Bool { grant != nil }
    var canSend: Bool {
        guard let grant, let expiry = captureDate(grant.expiresAt) else { return false }
        return !sent && expiry > Date()
    }

    @discardableResult
    func readCode(_ text: String) -> Bool {
        guard !isBusy else { return false }
        do {
            let candidate = try CapturePairing.parse(text)
            // Re-reading the same QR after a lost claim response must retain the claim ID.
            if pairing != candidate {
                pairing = candidate
                grant = nil
                claimId = UUID()
                upload = nil
                sent = false
            }
            message = nil
            return true
        } catch { message = error.localizedDescription; return false }
    }

    func claim(onConnected: @escaping @MainActor () -> Void) {
        guard !isBusy, let pairing else { return }
        let id = begin()
        operation = Task {
            do {
                let result = try await client.claim(pairing, claimId: claimId)
                guard operationId == id, !Task.isCancelled else { return }
                grant = result
                finish(id)
                onConnected()
            } catch { failed(error, id: id) }
        }
    }

    func send(bytes: () throws -> Data) {
        guard !isBusy, !sent, let pairing, let grant else { return }
        do {
            // Retain exactly these bytes and this key after failure or cancellation.
            if upload == nil { upload = (try bytes(), UUID()) }
        } catch { message = error.localizedDescription; return }
        guard let upload else { return }
        let id = begin()
        operation = Task {
            do {
                try await client.upload(upload.bytes, pairing: pairing, grant: grant, key: upload.key)
                guard operationId == id, !Task.isCancelled else { return }
                sent = true
                message = "Sent to Rumi. Review the room in your browser. Your scan is still saved on this iPhone."
                finish(id)
            } catch { failed(error, id: id) }
        }
    }

    func cancel() {
        operationId = nil
        operation?.cancel()
        operation = nil
        isBusy = false
        message = grant == nil
            ? "Connection stopped. Scan the same code to try again."
            : "Transfer stopped. If Rumi already received it, retrying will confirm delivery. Your scan is retained."
    }

    func disconnect() {
        cancel()
        pairing = nil
        grant = nil
        upload = nil
        sent = false
        message = nil
        claimId = UUID()
    }

    func prepareForNewScan() {
        // One room per grant. Keep a newly paired session through scan retries only
        // when no room has been sent or attempted with that grant.
        if upload != nil { disconnect() }
    }

    private func begin() -> UUID {
        let id = UUID()
        operationId = id
        isBusy = true
        message = nil
        return id
    }

    private func finish(_ id: UUID) {
        guard operationId == id else { return }
        operation = nil
        operationId = nil
        isBusy = false
    }

    private func failed(_ error: Error, id: UUID) {
        guard operationId == id else { return }
        message = error.localizedDescription
        if case CaptureError.reconnect = error { grant = nil }
        finish(id)
    }
}
