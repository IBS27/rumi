import XCTest
@testable import RumiCapture

final class ScanLifecycleTests: XCTestCase {
    func testOnlyFinalProcessingCanComplete() throws {
        var state = ScanLifecycle()
        let id = try XCTUnwrap(state.requestStart())
        XCTAssertNil(state.requestStart())
        XCTAssertTrue(state.authorize(id, supported: true, cameraAllowed: true))
        state.didStart(id)
        XCTAssertFalse(state.complete(id), "Live room updates must never become an exportable result")
        XCTAssertTrue(state.process(id))
        XCTAssertFalse(state.process(id), "Repeated Finish taps must not stop twice")
        XCTAssertTrue(state.complete(id))
        XCTAssertNil(state.requestStart(), "Completed rooms require explicit discard")
        XCTAssertFalse(state.complete(id))
    }

    func testLateCallbacksCannotReviveInterruptedOrNewScan() throws {
        var state = ScanLifecycle()
        let old = try XCTUnwrap(state.requestStart())
        XCTAssertTrue(state.authorize(old, supported: true, cameraAllowed: true))
        state.didStart(old)
        XCTAssertTrue(state.process(old))
        state.fail(old, message: "Interrupted")
        XCTAssertFalse(state.complete(old))
        state.reset()
        let fresh = try XCTUnwrap(state.requestStart())
        XCTAssertFalse(state.authorize(old, supported: true, cameraAllowed: true))
        state.fail(old, message: "Late error")
        XCTAssertEqual(state.token, fresh)
        XCTAssertTrue(state.authorize(fresh, supported: true, cameraAllowed: true))
        XCTAssertFalse(state.process(old))
    }

    func testUnsupportedAndDeniedNeverStartCapture() throws {
        var state = ScanLifecycle()
        let unsupported = try XCTUnwrap(state.requestStart())
        XCTAssertFalse(state.authorize(unsupported, supported: false, cameraAllowed: true))
        XCTAssertEqual(state.phase, .unsupported)
        XCTAssertNil(state.token)
        let denied = try XCTUnwrap(state.requestStart())
        XCTAssertFalse(state.authorize(denied, supported: true, cameraAllowed: false))
        XCTAssertEqual(state.phase, .cameraDenied)
        let retry = try XCTUnwrap(state.requestStart())
        XCTAssertTrue(state.authorize(retry, supported: true, cameraAllowed: true))
    }

    func testCompletedResultSurvivesLateFailuresUntilReset() throws {
        var state = ScanLifecycle()
        let id = try XCTUnwrap(state.requestStart())
        XCTAssertTrue(state.authorize(id, supported: true, cameraAllowed: true))
        XCTAssertTrue(state.process(id))
        XCTAssertTrue(state.complete(id))
        state.fail(id, message: "Late failure")
        XCTAssertEqual(state.phase, .completed)
        XCTAssertFalse(state.isCapturing)
        state.reset()
        XCTAssertNotNil(state.requestStart())
    }
}
