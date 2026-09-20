import Foundation

struct CapturePairing: Decodable, Equatable, Sendable {
    let type: String
    let version: Int
    let baseUrl: String
    let sessionId: String
    let pairingToken: String
    let expiresAt: String

    // Add reviewed deployments here, never a wildcard or an origin learned from a QR.
    static let allowedOrigins: Set<String> = ["https://utmost-cow-946.convex.site"]

    static func parse(_ text: String, now: Date = Date()) throws -> Self {
        guard text.utf8.count <= 4096,
              let value = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)),
              value.type == "rumi.capture", value.version == 1,
              !value.sessionId.isEmpty, value.sessionId.count <= 200,
              validToken(value.pairingToken),
              allowedOrigins.contains(value.baseUrl),
              let expiry = captureDate(value.expiresAt) else {
            throw CaptureError.invalidCode
        }
        guard expiry > now else { throw CaptureError.reconnect }
        return value
    }
}

func captureDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

private func validToken(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

struct CaptureGrant: Decodable, Sendable {
    let sessionId: String
    let uploadToken: String
    let expiresAt: String
    let maxBytes: Int
    let maxPackageBytes: Int?
}

enum CaptureError: LocalizedError {
    case invalidCode, invalidResponse, reconnect, tooLarge, invalidRoom, temporary, rejected, packageUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidCode: "This isn't a supported Rumi code. Open Scan with iPhone in the web app and scan its QR code."
        case .invalidResponse: "Rumi returned an unexpected response. Try again. Your scan is retained."
        case .reconnect: "This connection is no longer available. Show a new code in the web app and reconnect. Your scan is retained."
        case .tooLarge: "This scan is too large to send. Use Export scan to keep the detailed room."
        case .packageUnavailable: "This Rumi server needs an update to receive detailed scans. Use Export scan and import the ZIP in your browser."
        case .invalidRoom: "Rumi couldn't import this scan. Keep it with Export JSON, or scan the room again."
        case .temporary: "Rumi is temporarily unavailable. Try again later. Your scan is retained."
        case .rejected: "Rumi couldn't accept this request. Reconnect or use Export JSON. Your scan is retained."
        }
    }
}

/// Credentials stay in memory. Redirects are refused so bearer tokens and room bytes
/// cannot be forwarded to another destination, even by an allowed server.
private final class CaptureRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct CaptureClient: Sendable {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    typealias FileTransport = @Sendable (URLRequest, URL) async throws -> (Data, HTTPURLResponse)
    private let fileTransport: FileTransport
    private let transport: Transport
    private let sleep: @Sendable (TimeInterval) async throws -> Void

    init(transport: Transport? = nil,
         sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
             try await Task.sleep(for: .seconds(seconds))
         }) {
        if let transport {
            self.transport = transport
            self.fileTransport = { request, file in
                var request = request
                request.httpBody = try Data(contentsOf: file)
                return try await transport(request)
            }
        }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            let session = URLSession(configuration: configuration, delegate: CaptureRedirectBlocker(), delegateQueue: nil)
            self.fileTransport = { request, file in
                let (data, response) = try await session.upload(for: request, fromFile: file)
                guard let response = response as? HTTPURLResponse else { throw CaptureError.invalidResponse }
                return (data, response)
            }
            self.transport = { request in
                let (data, response) = try await session.data(for: request)
                guard let response = response as? HTTPURLResponse else { throw CaptureError.invalidResponse }
                return (data, response)
            }
        }
        self.sleep = sleep
    }

    func claim(_ pairing: CapturePairing, claimId: UUID) async throws -> CaptureGrant {
        // Revalidate at send time, including retries after the confirmation screen sat open.
        guard CapturePairing.allowedOrigins.contains(pairing.baseUrl),
              let expires = captureDate(pairing.expiresAt), expires > Date() else { throw CaptureError.reconnect }
        struct Body: Encodable { let sessionId: String; let claimId: String }
        var request = try request(baseUrl: pairing.baseUrl, path: "claim", token: pairing.pairingToken)
        request.httpBody = try JSONEncoder().encode(Body(sessionId: pairing.sessionId, claimId: claimId.uuidString))
        let data = try await send(request)
        guard let grant = try? JSONDecoder().decode(CaptureGrant.self, from: data),
              grant.sessionId == pairing.sessionId, validToken(grant.uploadToken),
              let expiry = captureDate(grant.expiresAt), expiry > Date(),
              grant.maxBytes > 0, grant.maxBytes <= 10 * 1024 * 1024,
              grant.maxPackageBytes.map({ $0 > 0 && $0 <= 128 * 1024 * 1024 }) ?? true else { throw CaptureError.invalidResponse }
        return grant
    }

    func upload(_ bytes: Data, pairing: CapturePairing, grant: CaptureGrant, key: UUID) async throws {
        guard let expiry = captureDate(grant.expiresAt), expiry > Date() else { throw CaptureError.reconnect }
        guard bytes.count <= grant.maxBytes else { throw CaptureError.tooLarge }
        var request = try request(baseUrl: pairing.baseUrl, path: "room", token: grant.uploadToken)
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CaptureError.invalidCode
        }
        components.queryItems = [URLQueryItem(name: "sessionId", value: grant.sessionId)]
        request.url = components.url
        request.setValue(key.uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = bytes
        struct Receipt: Decodable { let sessionId: String; let status: String }
        let data = try await send(request)
        guard let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
              receipt.sessionId == grant.sessionId, receipt.status == "uploaded" else { throw CaptureError.invalidResponse }
    }

    func uploadPackage(_ file: URL, pairing: CapturePairing, grant: CaptureGrant, key: UUID) async throws {
        guard let expiry = captureDate(grant.expiresAt), expiry > Date() else { throw CaptureError.reconnect }
        guard let limit = grant.maxPackageBytes else { throw CaptureError.packageUnavailable }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= limit else { throw CaptureError.tooLarge }
        struct Body: Encodable { let sessionId: String; let idempotencyKey: String; var storageId: String? }
        var body = Body(sessionId: grant.sessionId, idempotencyKey: key.uuidString)
        var begin = try request(baseUrl: pairing.baseUrl, path: "package/begin", token: grant.uploadToken)
        begin.httpBody = try JSONEncoder().encode(body)
        struct Ticket: Decodable { let uploadUrl: String?; let contentType: String; let maxBytes: Int; let uploaded: Bool }
        let ticket = try JSONDecoder().decode(Ticket.self, from: try await send(begin))
        guard ticket.maxBytes > 0, ticket.maxBytes <= limit, size <= ticket.maxBytes else { throw CaptureError.tooLarge }
        if ticket.uploaded { return }
        // Storage upload URLs are issued by our allowlisted deployment. No bearer
        // credentials are sent to storage, and redirects remain disabled.
        let expectedHost = URL(string: pairing.baseUrl)?.host?.replacingOccurrences(of: ".convex.site", with: ".convex.cloud")
        guard let raw = ticket.uploadUrl, let url = URL(string: raw),
              url.scheme == "https", url.host == expectedHost, url.port == nil,
              url.user == nil, url.password == nil, url.fragment == nil,
              url.path.hasPrefix("/api/storage/upload"),
              ticket.contentType.range(of: #"^application/vnd\.rumi\.capture\.[a-f0-9]{64}\+zip$"#, options: .regularExpression) != nil else {
            throw CaptureError.invalidResponse
        }
        var upload = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
        upload.httpMethod = "POST"
        upload.setValue(ticket.contentType, forHTTPHeaderField: "Content-Type")
        struct Stored: Decodable { let storageId: String }
        let stored = try JSONDecoder().decode(Stored.self, from: try await send(upload, file: file))
        guard !stored.storageId.isEmpty, stored.storageId.count <= 200 else { throw CaptureError.invalidResponse }
        body.storageId = stored.storageId
        var complete = try request(baseUrl: pairing.baseUrl, path: "package/complete", token: grant.uploadToken)
        complete.httpBody = try JSONEncoder().encode(body)
        struct Receipt: Decodable { let sessionId: String; let status: String }
        let receipt = try JSONDecoder().decode(Receipt.self, from: try await send(complete))
        guard receipt.sessionId == grant.sessionId, receipt.status == "uploaded" else { throw CaptureError.invalidResponse }
    }

    private func request(baseUrl: String, path: String, token: String) throws -> URLRequest {
        guard CapturePairing.allowedOrigins.contains(baseUrl),
              let url = URL(string: "\(baseUrl)/capture/v1/\(path)") else { throw CaptureError.invalidCode }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func send(_ request: URLRequest, file: URL? = nil) async throws -> Data {
        for attempt in 0..<3 {
            try Task.checkCancellation()
            let result: (Data, HTTPURLResponse)
            do {
                if let file { result = try await fileTransport(request, file) }
                else { result = try await transport(request) }
            }
            catch {
                try Task.checkCancellation()
                // Certificate, permission, malformed URL and cancellation errors aren't retriable.
                let retryable: Set<URLError.Code> = [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                                                    .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]
                guard let network = error as? URLError, retryable.contains(network.code), attempt < 2 else { throw error }
                try await sleep(pow(2, Double(attempt)))
                continue
            }
            try Task.checkCancellation()
            let (data, response) = result
            switch response.statusCode {
            case 200: return data
            case 401, 403, 409, 410: throw CaptureError.reconnect
            case 413: throw CaptureError.tooLarge
            case 422: throw CaptureError.invalidRoom
            case 429, 500...599:
                guard attempt < 2 else { throw CaptureError.temporary }
                let delay = max(pow(2, Double(attempt)), Self.retryDelay(response) ?? 0)
                // A long Retry-After ends automatic retries instead of retrying too early.
                guard delay <= 30 else { throw CaptureError.temporary }
                try await sleep(delay)
            default: throw CaptureError.rejected
            }
        }
        throw CaptureError.temporary
    }

    private static func retryDelay(_ response: HTTPURLResponse) -> TimeInterval? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        if let seconds = TimeInterval(value), seconds.isFinite { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
        return formatter.date(from: value).map { max(0, $0.timeIntervalSinceNow) }
    }
}
