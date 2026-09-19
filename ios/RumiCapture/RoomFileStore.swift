import Foundation

/// Stores Apple's JSON bytes unchanged. Files survive sheet dismissal and app relaunch.
struct RoomFileStore {
    let directory: URL

    init(directory: URL = URL.applicationSupportDirectory.appendingPathComponent("CompletedRoom", isDirectory: true)) {
        self.directory = directory
    }

    func currentFile() throws -> URL? {
        guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }.last
    }

    func save(_ data: Data, now: Date = Date()) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        let timestamp = ISO8601DateFormatter().string(from: now).replacingOccurrences(of: ":", with: "-")
        let name = "rumi-room-\(timestamp)-\(UUID().uuidString.prefix(8).lowercased()).json"
        let url = directory.appendingPathComponent(name)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        return url
    }

    /// Only called after explicit discard confirmation, with no active share sheet.
    func discard() throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.removeItem(at: directory)
    }
}
