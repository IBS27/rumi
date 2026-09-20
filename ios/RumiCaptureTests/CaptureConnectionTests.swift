import XCTest
@testable import RumiCapture

@MainActor
final class CaptureConnectionTests: XCTestCase {
    private func settle(_ connection: CaptureConnection) async throws {
        for _ in 0..<200 {
            if !connection.isBusy { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Transfer did not settle")
    }

    func testManualRetryRetainsOriginalBytesAndNewScanRequiresNewSession() async throws {
        let stub = CaptureTransportStub([.response(200, claimResponse), .networkFailure, .networkFailure,
                                         .networkFailure, .response(200, uploadResponse)])
        let connection = CaptureConnection(client: stub.client())
        XCTAssertTrue(connection.readCode(pairingText()))
        connection.claim {}
        try await settle(connection)
        XCTAssertTrue(connection.isConnected)
        connection.prepareForNewScan()
        XCTAssertTrue(connection.isConnected, "Pairing must survive starting the first scan")
        let bytes = Data("saved room bytes".utf8)
        connection.send { bytes }
        try await settle(connection)
        XCTAssertFalse(connection.sent)
        XCTAssertNotNil(connection.message)
        connection.send { XCTFail("Retry must not reread or re-encode the room"); return Data() }
        try await settle(connection)
        XCTAssertTrue(connection.sent)
        let uploads = await stub.requests.filter { $0.url?.path == "/capture/v1/room" }
        XCTAssertEqual(uploads.count, 4)
        XCTAssertTrue(uploads.allSatisfy { $0.httpBody == bytes })
        XCTAssertEqual(Set(uploads.compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }).count, 1)
        connection.prepareForNewScan()
        XCTAssertFalse(connection.isConnected)
        XCTAssertFalse(connection.sent)
    }

    func testLostClaimResponseCanRetrySameQRWithoutCompetingClaim() async throws {
        let stub = CaptureTransportStub([.networkFailure, .networkFailure, .networkFailure, .response(200, claimResponse)])
        let connection = CaptureConnection(client: stub.client())
        connection.readCode(pairingText())
        connection.claim {}
        try await settle(connection)
        XCTAssertFalse(connection.isConnected)
        connection.readCode(pairingText())
        connection.claim {}
        try await settle(connection)
        XCTAssertTrue(connection.isConnected)
        let requests = await stub.requests
        XCTAssertEqual(requests.count, 4)
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == requests.first?.httpBody })
    }

    func testCanceledClaimCannotStartRoomScan() async throws {
        let started = expectation(description: "Request started")
        let connection = CaptureConnection(client: CaptureClient(transport: { request in
            started.fulfill()
            try await Task.sleep(for: .seconds(30))
            return (Data(claimResponse.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }))
        connection.readCode(pairingText())
        connection.claim { XCTFail("Canceled pairing must not start the room camera") }
        await fulfillment(of: [started], timeout: 2)
        connection.cancel()
        await Task.yield()
        XCTAssertFalse(connection.isBusy)
        XCTAssertFalse(connection.isConnected)
    }
}
