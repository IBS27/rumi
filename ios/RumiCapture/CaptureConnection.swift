import Foundation
import Combine
import UIKit

@MainActor
final class CaptureConnection: ObservableObject {
    @Published private(set) var pairing: CapturePairing?
    @Published private(set) var grant: CaptureGrant?
    @Published private(set) var isBusy = false {
        didSet { UIApplication.shared.isIdleTimerDisabled = isBusy }
    }
    @Published private(set) var sent = false
    @Published private(set) var message: String?

    private let client: CaptureClient
    private var claimId = UUID()
    private var upload: (bytes: Data, key: UUID)?
    private var scanUpload: (url: URL, key: UUID, scan: ScanTransfer?, storageId: String?)?
    @Published private(set) var uploadProgress: Double?
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
                scanUpload = nil
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

    func sendScan(file: () throws -> URL) {
        guard !isBusy, !sent, let pairing, let grant else { return }
        do { if scanUpload == nil { scanUpload = (try file(), UUID(), nil, nil) } }
        catch { message = error.localizedDescription; return }
        guard let pending = scanUpload else { return }
        let id = begin()
        message = "Preparing complete scan…"
        operation = Task {
            do {
                let scan: ScanTransfer
                if let existing = pending.scan { scan = existing }
                else {
                    let hashing = Task.detached(priority: .utility) { try ScanTransfer.read(pending.url) }
                    scan = try await withTaskCancellationHandler(operation: { try await hashing.value }, onCancel: { hashing.cancel() })
                }
                guard operationId == id, !Task.isCancelled else { return }
                scanUpload?.scan = scan
                message = "Sending complete scan…"
                uploadProgress = 0
                try await client.uploadScan(scan, pairing: pairing, grant: grant, key: pending.key, storageId: pending.storageId,
                    onStored: { [weak self] storageId in
                        await self?.rememberStorage(storageId, key: pending.key)
                    }, progress: { [weak self] value in
                        Task { @MainActor [weak self] in
                            guard let self, self.operationId == id else { return }
                            self.uploadProgress = value
                            self.message = value == nil ? "Checking the complete scan in Rumi…" : "Sending complete scan…"
                        }
                    })
                guard operationId == id, !Task.isCancelled else { return }
                sent = true
                message = "Complete scan sent to Rumi. Your surfaces, photos, and layout are ready to open in the browser."
                finish(id)
            } catch { failed(error, id: id) }
        }
    }

    private func rememberStorage(_ storageId: String, key: UUID) {
        if scanUpload?.key == key { scanUpload?.storageId = storageId }
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
        scanUpload = nil
        sent = false
        message = nil
        claimId = UUID()
    }

    func prepareForNewScan() {
        // One room per grant. Keep a newly paired session through scan retries only
        // when no room has been sent or attempted with that grant.
        if upload != nil || scanUpload != nil { disconnect() }
    }

    private func begin() -> UUID {
        let id = UUID()
        operationId = id
        isBusy = true
        uploadProgress = nil
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
