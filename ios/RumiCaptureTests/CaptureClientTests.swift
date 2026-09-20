import XCTest
@testable import RumiCapture

// Scripted transport exercises the real request encoder and retry policy without a deployment.
actor CaptureTransportStub {
    enum Result: Sendable {
        case response(Int, String, [String: String] = [:])
        case networkFailure
    }
    private var results: [Result]
    private(set) var requests: [URLRequest] = []
    private(set) var delays: [TimeInterval] = []

    init(_ results: [Result]) { self.results = results }
    func send(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !results.isEmpty else { throw CaptureError.rejected }
        switch results.removeFirst() {
        case .networkFailure: throw URLError(.networkConnectionLost)
        case .response(let status, let body, let headers):
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
        }
    }
    func sleep(_ seconds: TimeInterval) { delays.append(seconds) }
    nonisolated func client() -> CaptureClient {
        CaptureClient(transport: { try await self.send($0) }, sleep: { await self.sleep($0) })
    }
}

func pairingText(baseUrl: String = "https://utmost-cow-946.convex.site", version: Int = 1,
                 expiresAt: String = "2099-01-01T00:00:00.000Z") -> String {
    """
    {"type":"rumi.capture","version":\(version),"baseUrl":"\(baseUrl)","sessionId":"test-session","pairingToken":"\(String(repeating: "a", count: 64))","expiresAt":"\(expiresAt)"}
    """
}
let claimResponse = """
{"sessionId":"test-session","uploadToken":"\(String(repeating: "b", count: 64))","expiresAt":"2099-01-01T01:00:00.000Z","maxBytes":10485760}
"""
let uploadResponse = """
{"sessionId":"test-session","status":"uploaded"}
"""

final class CaptureClientTests: XCTestCase {
    func testQRCodeValidationRejectsUntrustedDestinationsAndExpiredCodes() throws {
        XCTAssertNoThrow(try CapturePairing.parse(pairingText()))
        for origin in ["http://utmost-cow-946.convex.site", "https://evil.example",
                       "https://utmost-cow-946.convex.site.evil.example",
                       "https://utmost-cow-946.convex.site@evil.example",
                       "https://utmost-cow-946.convex.site/path", "https://utmost-cow-946.convex.site?redirect=evil"] {
            XCTAssertThrowsError(try CapturePairing.parse(pairingText(baseUrl: origin)))
        }
        XCTAssertThrowsError(try CapturePairing.parse(pairingText(version: 2)))
        XCTAssertThrowsError(try CapturePairing.parse(pairingText(expiresAt: "2000-01-01T00:00:00Z")))
        XCTAssertThrowsError(try CapturePairing.parse(pairingText().replacingOccurrences(of: String(repeating: "a", count: 64), with: "bad-token")))
        XCTAssertThrowsError(try CapturePairing.parse("https://example.com"))
    }

    func testClaimRetriesReuseIdentityAndHonorRetryAfter() async throws {
        let stub = CaptureTransportStub([.networkFailure, .response(429, "{}", ["Retry-After": "3"]), .response(200, claimResponse)])
        let id = UUID()
        let grant = try await stub.client().claim(CapturePairing.parse(pairingText()), claimId: id)
        XCTAssertEqual(grant.sessionId, "test-session")
        let requests = await stub.requests
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == requests.first?.httpBody })
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(requests.first?.httpBody)) as? [String: String])
        XCTAssertEqual(body["claimId"], id.uuidString)
        XCTAssertEqual(requests[0].url?.path, "/capture/v1/claim")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "a", count: 64))")
        let delays = await stub.delays
        XCTAssertEqual(delays, [1, 3])
    }

    func testUploadRetriesUseUnchangedRawBytesAndKey() async throws {
        let stub = CaptureTransportStub([.response(503, "{}"), .response(200, uploadResponse)])
        let grant = try JSONDecoder().decode(CaptureGrant.self, from: Data(claimResponse.utf8))
        let raw = Data("{ \"walls\": [], \"unrecognizedAppleField\": true }\n".utf8)
        let key = UUID()
        try await stub.client().upload(raw, pairing: CapturePairing.parse(pairingText()), grant: grant, key: key)
        let requests = await stub.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == raw && $0.value(forHTTPHeaderField: "Idempotency-Key") == key.uuidString })
        XCTAssertEqual(requests[0].url?.path, "/capture/v1/room")
        XCTAssertEqual(URLComponents(url: requests[0].url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "test-session")
    }

    func testPermanentFailuresAndLongBackoffDoNotRetry() async throws {
        for status in [302, 400, 401, 403, 409, 410, 413, 422, 429] {
            let stub = CaptureTransportStub([.response(status, "{}", ["Retry-After": "600"])])
            do {
                _ = try await stub.client().claim(CapturePairing.parse(pairingText()), claimId: UUID())
                XCTFail("Unexpected success for \(status)")
            } catch {}
            let count = await stub.requests.count
            XCTAssertEqual(count, 1)
            let delays = await stub.delays
            XCTAssertTrue(delays.isEmpty)
        }
    }

    func testRetryBudgetAndCancellation() async throws {
        let stub = CaptureTransportStub([.networkFailure, .networkFailure, .networkFailure, .response(200, claimResponse)])
        do {
            _ = try await stub.client().claim(CapturePairing.parse(pairingText()), claimId: UUID())
            XCTFail("Retry budget should be exhausted")
        } catch {}
        let count = await stub.requests.count
        XCTAssertEqual(count, 3)

        let cancelled = CaptureTransportStub([.networkFailure, .response(200, claimResponse)])
        let client = CaptureClient(transport: { try await cancelled.send($0) }, sleep: { _ in throw CancellationError() })
        do {
            _ = try await client.claim(CapturePairing.parse(pairingText()), claimId: UUID())
            XCTFail("Cancellation should stop retries")
        } catch is CancellationError {} catch { XCTFail("Expected cancellation") }
        let cancelledCount = await cancelled.requests.count
        XCTAssertEqual(cancelledCount, 1)
    }

    func testInvalidResponsesAndUploadSizeLimit() async throws {
        for body in ["{}", claimResponse.replacingOccurrences(of: "test-session", with: "another-session"),
                     claimResponse.replacingOccurrences(of: "10485760", with: "0")] {
            let stub = CaptureTransportStub([.response(200, body)])
            do {
                _ = try await stub.client().claim(CapturePairing.parse(pairingText()), claimId: UUID())
                XCTFail("Invalid grant should be rejected")
            } catch {}
        }
        let stub = CaptureTransportStub([])
        let grant = CaptureGrant(sessionId: "test-session", uploadToken: String(repeating: "b", count: 64),
                                 expiresAt: "2099-01-01T01:00:00Z", maxBytes: 1)
        do {
            try await stub.client().upload(Data([1, 2]), pairing: CapturePairing.parse(pairingText()), grant: grant, key: UUID())
            XCTFail("Oversize body should not be sent")
        } catch {}
        let requests = await stub.requests
        XCTAssertTrue(requests.isEmpty)
    }
}
