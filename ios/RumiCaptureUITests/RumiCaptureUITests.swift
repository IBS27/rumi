import XCTest

final class RumiCaptureUITests: XCTestCase {
    @MainActor
    func testSimulatorUnsupportedFlow() throws {
        #if targetEnvironment(simulator)
        let app = XCUIApplication()
        app.launch()
        let start = app.buttons["Start Scan"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        XCTAssertTrue(app.staticTexts["Room scanning isn't available"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Finish Scan"].exists)
        XCTAssertFalse(app.buttons["Export JSON"].exists)
        app.buttons["Check again"].tap()
        XCTAssertTrue(app.staticTexts["Room scanning isn't available"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        #else
        throw XCTSkip("This test verifies simulator rejection; real capture needs a person and a room.")
        #endif
    }
}
