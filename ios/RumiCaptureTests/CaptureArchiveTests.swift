import XCTest
@testable import RumiCapture

final class CaptureArchiveTests: XCTestCase {
    func testZIPStoresBytesCRCAndCentralDirectoryOffsets() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("input")
        let bytes = Data("123456789".utf8)
        try bytes.write(to: source)
        let output = folder.appendingPathComponent("scan.zip")
        try CaptureArchive.write(files: [("roomplan.json", source), ("frames/0.bin", source)], to: output)
        let zip = try Data(contentsOf: output)
        func u16(_ at: Int) -> Int { Int(zip[at]) | Int(zip[at + 1]) << 8 }
        func u32(_ at: Int) -> UInt32 { (0..<4).reduce(0) { $0 | UInt32(zip[at + $1]) << ($1 * 8) } }
        XCTAssertEqual(u32(0), 0x04034b50)
        XCTAssertEqual(u16(8), 0, "Stored, not deflated")
        XCTAssertEqual(u32(14), 0xcbf43926, "Known IEEE CRC32 vector")
        XCTAssertEqual(u32(18), UInt32(bytes.count))
        let payload = 30 + u16(26)
        XCTAssertEqual(zip.subdata(in: payload..<(payload + bytes.count)), bytes)
        let end = zip.count - 22
        XCTAssertEqual(u32(end), 0x06054b50)
        XCTAssertEqual(u16(end + 10), 2)
        let central = Int(u32(end + 16))
        XCTAssertEqual(u32(central), 0x02014b50)
        XCTAssertEqual(u32(central + 42), 0)
        let secondCentral = central + 46 + u16(central + 28)
        let secondLocal = Int(u32(secondCentral + 42))
        XCTAssertEqual(u32(secondLocal), 0x04034b50)
        XCTAssertEqual(secondLocal, payload + bytes.count)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathExtension("partial").path))
    }

    func testFailedArchiveLeavesSourceAndExistingExportIntact() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("room.json")
        let output = folder.appendingPathComponent("scan.zip")
        try Data([1, 2, 3]).write(to: source)
        try Data([9]).write(to: output)
        XCTAssertThrowsError(try CaptureArchive.write(files: [("roomplan.json", source)], to: output))
        XCTAssertEqual(try Data(contentsOf: output), Data([9]))
        XCTAssertEqual(try Data(contentsOf: source), Data([1, 2, 3]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathExtension("partial").path))
    }
}
