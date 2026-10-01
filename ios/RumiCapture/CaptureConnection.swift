import Foundation
import Combine
import UIKit
import Security

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

    private let resumeTransfers: Bool
    private let transferDirectory = URL.applicationSupportDirectory.appendingPathComponent("PendingTransfer", isDirectory: true)
    private struct Record: Codable {
        let pairing: CapturePairing?
        let grant: CaptureGrant?
        let claimId: UUID
        let uploadKey: UUID?
        let scanURL: URL?
        let scanKey: UUID?
        let storageId: String?
        let sent: Bool
    }
    // Injected clients used by tests do not read or overwrite a real saved connection.
    init(client: CaptureClient? = nil, resumeTransfers: Bool? = nil) {
        self.client = client ?? CaptureClient()
        self.resumeTransfers = resumeTransfers ?? (client == nil)
        if self.resumeTransfers { restore() }
    }
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "rumi.capture.transfer",
         kSecAttrAccount as String: "pending"]
    }
    private func checkpoint() throws {
        guard resumeTransfers else { return }
        if pairing == nil {
            SecItemDelete(keychainQuery as CFDictionary)
            try? FileManager.default.removeItem(at: transferDirectory)
            return
        }
        try FileManager.default.createDirectory(at: transferDirectory, withIntermediateDirectories: true)
        var directory = transferDirectory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        if let upload { try upload.bytes.write(to: transferDirectory.appendingPathComponent("room.json"), options: [.atomic, .completeFileProtectionUnlessOpen]) }
        let record = Record(pairing: pairing, grant: grant, claimId: claimId, uploadKey: upload?.key,
                            scanURL: scanUpload?.url, scanKey: scanUpload?.key, storageId: scanUpload?.storageId, sent: sent)
        let data = try JSONEncoder().encode(record)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let insert = keychainQuery.merging(attributes) { _, value in value }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw CaptureError.reconnect }
        } else if status != errSecSuccess { throw CaptureError.reconnect }
    }
    private func restore() {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let record = try? JSONDecoder().decode(Record.self, from: data),
              let savedPairing = record.pairing,
              CapturePairing.allowedOrigins.contains(savedPairing.baseUrl),
              let expiry = captureDate(record.grant?.expiresAt ?? savedPairing.expiresAt), expiry > Date() else { return }
        pairing = record.pairing
        grant = record.grant
        claimId = record.claimId
        sent = record.sent
        if let key = record.uploadKey, let bytes = try? Data(contentsOf: transferDirectory.appendingPathComponent("room.json")) { upload = (bytes, key) }
        if let url = record.scanURL, let key = record.scanKey, FileManager.default.fileExists(atPath: url.path) {
            scanUpload = (url, key, nil, record.storageId)
        }
        message = sent ? "This scan was sent to Rumi." : "Previous connection restored. Retry to continue the saved transfer."
    }

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
            try checkpoint()
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
                try checkpoint()
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
            try checkpoint()
        } catch { message = error.localizedDescription; return }
        guard let upload else { return }
        let id = begin()
        operation = Task {
            do {
                try await client.upload(upload.bytes, pairing: pairing, grant: grant, key: upload.key)
                guard operationId == id, !Task.isCancelled else { return }
                sent = true
                try checkpoint()
                message = "Sent to Rumi. Review the room in your browser. Your scan is still saved on this iPhone."
                finish(id)
            } catch { failed(error, id: id) }
        }
    }

    func sendScan(file: () throws -> URL) {
        guard !isBusy, !sent, let pairing, let grant else { return }
        do { if scanUpload == nil { scanUpload = (try file(), UUID(), nil, nil) }; try checkpoint() }
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
                try checkpoint()
                message = "Complete scan sent to Rumi. Your surfaces, photos, and layout are ready to open in the browser."
                finish(id)
            } catch { failed(error, id: id) }
        }
    }

    private func rememberStorage(_ storageId: String, key: UUID) {
        if scanUpload?.key == key { scanUpload?.storageId = storageId; try? checkpoint() }
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
        try? checkpoint()
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
