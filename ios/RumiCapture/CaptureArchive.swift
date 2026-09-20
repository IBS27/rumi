import Foundation

/// ZIP STORE writer. JPEGs are already compressed; buffers stay little-endian.
/// The same package can be opened by Files and the browser without a native dependency.
enum CaptureArchive {
    private static let crcTable: [UInt32] = (0..<256).map { value in
        var crc = UInt32(value)
        for _ in 0..<8 { crc = (crc & 1) == 0 ? crc >> 1 : (crc >> 1) ^ 0xedb88320 }
        return crc
    }

    static func write(files: [(String, URL)], to destination: URL) throws {
        let temporary = destination.appendingPathExtension("partial")
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        var directory = Data()
        var offset: UInt32 = 0
        for (name, url) in files {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard data.count < 128 * 1024 * 1024, UInt64(offset) + UInt64(data.count) < 126 * 1024 * 1024 else {
                throw CocoaError(.fileWriteOutOfSpace)
            }
            var crc = UInt32.max
            for byte in data { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8) }
            crc ^= UInt32.max
            let filename = Data(name.utf8)
            let length = UInt32(data.count)
            var local = Data()
            local.le(UInt32(0x04034b50)); local.le(UInt16(20)); local.le(UInt16(0))
            local.le(UInt16(0)); local.le(UInt16(0)); local.le(UInt16(0x21))
            local.le(crc); local.le(length); local.le(length)
            local.le(UInt16(filename.count)); local.le(UInt16(0)); local.append(filename)
            try handle.write(contentsOf: local)
            try handle.write(contentsOf: data)
            directory.le(UInt32(0x02014b50)); directory.le(UInt16(20)); directory.le(UInt16(20))
            directory.le(UInt16(0)); directory.le(UInt16(0)); directory.le(UInt16(0)); directory.le(UInt16(0x21))
            directory.le(crc); directory.le(length); directory.le(length)
            directory.le(UInt16(filename.count)); directory.le(UInt16(0)); directory.le(UInt16(0))
            directory.le(UInt16(0)); directory.le(UInt16(0)); directory.le(UInt32(0)); directory.le(offset)
            directory.append(filename)
            offset += UInt32(local.count) + length
        }
        try handle.write(contentsOf: directory)
        var end = Data()
        end.le(UInt32(0x06054b50)); end.le(UInt16(0)); end.le(UInt16(0))
        end.le(UInt16(files.count)); end.le(UInt16(files.count)); end.le(UInt32(directory.count))
        end.le(offset); end.le(UInt16(0))
        try handle.write(contentsOf: end)
        try handle.synchronize()
        try handle.close()
        try FileManager.default.moveItem(at: temporary, to: destination)
    }
}

extension Data {
    mutating func le<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}
