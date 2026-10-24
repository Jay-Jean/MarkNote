import Foundation

// Exercise the production writer only in a disposable local simulation.
// This cannot validate OneDrive's server, file provider, or another device.
enum StorageCompatibilityTests {
    static func run(write: (String, URL) throws -> Void) throws -> [String: Any] {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("marknote-sync-audit-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let workspace = root.appendingPathComponent("OneDrive-本地模拟/研究 笔记", isDirectory: true)
        let note = workspace.appendingPathComponent("多模型 合并笔记 📝.md")
        var checks: [String: Bool] = [:]
        let original = "# 合并笔记\n\n公式：$a_i^2$\n\n![图片](assets/测试 图片.png)\n"
        try write(original, note)
        checks["unicodeAndSpacePaths"] = try String(contentsOf: note, encoding: .utf8) == original
        for index in 0..<50 { try write("第 \(index) 次保存\n" + original, note) }
        checks["rapidRepeatedSaves"] = try String(contentsOf: note, encoding: .utf8) == "第 49 次保存\n" + original
        let large = String(repeating: "多模型合并测试 $a_i$\n", count: 50_000)
        try write(large, note)
        checks["largeNoteRoundTrip"] = try String(contentsOf: note, encoding: .utf8) == large
        checks["imageReferencesPreserved"] = original.contains("assets/测试 图片.png") && {
            do { try write(original, note); return try String(contentsOf: note, encoding: .utf8) == original }
            catch { return false }
        }()
        let blocker = root.appendingPathComponent("not-a-folder")
        try "existing file".write(to: blocker, atomically: true, encoding: .utf8)
        do {
            try write("must fail", blocker.appendingPathComponent("note.md"))
            checks["invalidDestinationThrows"] = false
        } catch { checks["invalidDestinationThrows"] = true }
        checks["failurePreservesExistingFiles"] = try String(contentsOf: blocker, encoding: .utf8) == "existing file" && String(contentsOf: note, encoding: .utf8) == original

        // Another editor/cloud process updates a file after it was read by MarkNote.
        let external = "另一个设备同步过来的版本"
        try external.write(to: note, atomically: true, encoding: .utf8)
        try write("本机未刷新前的编辑版本", note)
        let externalOverwrite = try String(contentsOf: note, encoding: .utf8) != external
        // A workspace is moved/unlinked while the app still remembers its old path.
        let moved = root.appendingPathComponent("moved-workspace")
        try fm.moveItem(at: workspace, to: moved)
        try write("after folder moved", note)
        let stalePathRecreated = fm.fileExists(atPath: note.path)
        return [
            "checks": checks,
            "localSimulationOnly": true,
            "cloudRoundTripTested": false,
            "knownRisksReproduced": [
                "externalUpdateCanBeOverwritten": externalOverwrite,
                "movedWorkspaceOldPathIsRecreated": stalePathRecreated
            ]
        ]
    }
}
