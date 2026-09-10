import Cocoa
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let fileManager = FileManager.default

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let requestID = body["id"] as? String,
              let action = body["action"] as? String else {
            return
        }

        let payload = body["payload"] as? [String: Any] ?? [:]
        switch action {
        case "chooseWorkspace":
            chooseWorkspace(requestID)
        case "listNotes", "readFile", "writeFile", "readAsset", "writeAsset":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleFileAction(action, requestID: requestID, payload: payload)
            }
        case "saveFile":
            saveFile(requestID, payload: payload)
        case "print":
            printPage(requestID)
        default:
            respond(requestID, ["ok": false, "error": "未知的原生操作"])
        }
    }

    private func chooseWorkspace(_ requestID: String) {
        DispatchQueue.main.async { [weak self] in
            let panel = NSOpenPanel()
            panel.title = "选择 MarkNote 工作区"
            panel.prompt = "选择文件夹"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.begin { response in
                guard response == .OK, let url = panel.url else {
                    self?.respond(requestID, ["cancelled": true])
                    return
                }
                self?.respond(requestID, [
                    "ok": true,
                    "path": url.standardizedFileURL.path,
                    "name": url.lastPathComponent
                ])
            }
        }
    }

    private func handleFileAction(_ action: String, requestID: String, payload: [String: Any]) {
        switch action {
        case "listNotes":
            guard let root = rootURL(payload) else {
                respond(requestID, ["ok": false, "error": "工作区路径无效"])
                return
            }
            do {
                let names = try fileManager.contentsOfDirectory(atPath: root.path)
                    .filter { name in
                        let ext = URL(fileURLWithPath: name).pathExtension.lowercased()
                        return ["md", "markdown", "txt"].contains(ext)
                    }
                    .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
                respond(requestID, ["ok": true, "names": names])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        case "readFile":
            guard let url = safeURL(payload) else {
                respond(requestID, ["ok": false, "error": "文件路径无效"])
                return
            }
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                respond(requestID, ["ok": true, "text": text])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        case "writeFile":
            guard let url = safeURL(payload), let text = payload["text"] as? String else {
                respond(requestID, ["ok": false, "error": "写入参数无效"])
                return
            }
            do {
                try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try text.write(to: url, atomically: true, encoding: .utf8)
                respond(requestID, ["ok": true])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        case "readAsset":
            guard let url = safeURL(payload) else {
                respond(requestID, ["ok": false, "error": "资源路径无效"])
                return
            }
            do {
                let data = try Data(contentsOf: url)
                let mime = mimeType(for: url.pathExtension)
                respond(requestID, ["ok": true, "dataUrl": "data:\(mime);base64,\(data.base64EncodedString())"])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        case "writeAsset":
            guard let url = safeURL(payload), let dataURL = payload["dataUrl"] as? String,
                  let data = decodeDataURL(dataURL) else {
                respond(requestID, ["ok": false, "error": "图片数据无效"])
                return
            }
            do {
                try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
                respond(requestID, ["ok": true])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        default:
            respond(requestID, ["ok": false, "error": "不支持的文件操作"])
        }
    }

    private func saveFile(_ requestID: String, payload: [String: Any]) {
        guard let filename = payload["filename"] as? String,
              let content = payload["content"] as? String else {
            respond(requestID, ["ok": false, "error": "保存参数无效"])
            return
        }
        DispatchQueue.main.async { [weak self] in
            let panel = NSSavePanel()
            panel.title = "保存 MarkNote 文件"
            panel.nameFieldStringValue = filename
            panel.canCreateDirectories = true
            panel.begin { response in
                guard response == .OK, let url = panel.url else {
                    self?.respond(requestID, ["cancelled": true])
                    return
                }
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    self?.respond(requestID, ["ok": true])
                } catch {
                    self?.respond(requestID, ["ok": false, "error": error.localizedDescription])
                }
            }
        }
    }

    private func printPage(_ requestID: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else {
                self?.respond(requestID, ["ok": false, "error": "打印视图不可用"])
                return
            }
            let operation = NSPrintOperation(view: webView)
            operation.showsPrintPanel = true
            operation.showsProgressPanel = true
            let success = operation.run()
            self?.respond(requestID, ["ok": success])
        }
    }

    private func rootURL(_ payload: [String: Any]) -> URL? {
        guard let root = payload["root"] as? String, !root.isEmpty else { return nil }
        return URL(fileURLWithPath: root).standardizedFileURL
    }

    private func safeURL(_ payload: [String: Any]) -> URL? {
        guard let root = rootURL(payload), let relative = payload["relativePath"] as? String else { return nil }
        let target = root.appendingPathComponent(relative).standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { return nil }
        return target
    }

    private func mimeType(for extensionName: String) -> String {
        switch extensionName.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        default: return "image/png"
        }
    }

    private func decodeDataURL(_ dataURL: String) -> Data? {
        guard let comma = dataURL.firstIndex(of: ",") else { return nil }
        let metadata = String(dataURL[..<comma])
        let payload = String(dataURL[dataURL.index(after: comma)...])
        if metadata.lowercased().contains(";base64") {
            return Data(base64Encoded: payload)
        }
        return payload.removingPercentEncoding?.data(using: .utf8)
    }

    private func respond(_ requestID: String, _ result: [String: Any]) {
        guard let resultData = try? JSONSerialization.data(withJSONObject: result, options: []),
              let resultJSON = String(data: resultData, encoding: .utf8),
              let idData = try? JSONEncoder().encode(requestID),
              let idJSON = String(data: idData, encoding: .utf8) else {
            return
        }
        let script = "window.marknoteNativeResolve(\(idJSON),\(resultJSON));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private let bridge = NativeBridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.userContentController.add(bridge, name: "marknote")

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        bridge.webView = view
        webView = view

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 960),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MarkNote"
        window.contentView = view
        window.center()
        window.setFrameAutosaveName("MarkNoteMainWindow")
        window.makeKeyAndOrderFront(nil)
        self.window = window

        if let iconURL = Bundle.main.url(forResource: "MarkNote-icon", withExtension: "png") {
            NSApp.applicationIconImage = NSImage(contentsOf: iconURL)
        }
        NSApp.activate(ignoringOtherApps: true)

        if let htmlURL = Bundle.main.url(forResource: "index", withExtension: "html") {
            let resourceRoot = htmlURL.deletingLastPathComponent()
            view.loadFileURL(htmlURL, allowingReadAccessTo: resourceRoot)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if ["http", "https"].contains(url.scheme?.lowercased() ?? ""), navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}
