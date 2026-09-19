import XCTest
@testable import RumiCapture

final class RoomFileStoreTests: XCTestCase {
    private var folder: URL!
    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    func testBytesAndFileSurviveStoreRecreationUntilExplicitDiscard() throws {
        let store = RoomFileStore(directory: folder)
        // Arbitrary bytes test file storage only. This is not a CapturedRoom or scan fixture.
        let bytes = Data("{\"unknownFutureAppleField\": [1, 2, 3]}\n".utf8)
        let url = try store.save(bytes)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertEqual(try RoomFileStore(directory: folder).currentFile(), url)
        XCTAssertTrue(url.lastPathComponent.hasPrefix("rumi-room-"))
        XCTAssertEqual(url.pathExtension, "json")
        XCTAssertTrue(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try store.discard()
        XCTAssertNil(try store.currentFile())
    }

    func testFilenamesAreUniqueEvenAtSameTimestamp() throws {
        let store = RoomFileStore(directory: folder)
        let date = Date(timeIntervalSince1970: 0)
        let first = try store.save(Data([1]), now: date)
        let second = try store.save(Data([2]), now: date)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: first), Data([1]), "A later export must not overwrite a shared file")
    }

    func testWriteFailureDoesNotPretendToExport() throws {
        try Data([1]).write(to: folder)
        XCTAssertThrowsError(try RoomFileStore(directory: folder).save(Data([2])))
        XCTAssertEqual(try Data(contentsOf: folder), Data([1]))
    }
}
