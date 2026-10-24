import Cocoa
import WebKit
import PDFKit

final class NativeBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let fileManager = FileManager.default
    private let fileQueue = DispatchQueue(label: "com.marknote.files", qos: .userInitiated)
    private lazy var defaultWorkspace: URL = {
        if CommandLine.arguments.contains("--self-test") {
            return fileManager.temporaryDirectory.appendingPathComponent("marknote-storage-test-" + UUID().uuidString)
        }
        return fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Documents/MarkNote", isDirectory: true)
    }()

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
        case "revealNote":
            guard let url = safeURL(payload), fileManager.fileExists(atPath: url.path) else {
                respond(requestID, ["ok": false, "error": "笔记文件不存在"]); return
            }
            NSWorkspace.shared.activateFileViewerSelecting([url])
            respond(requestID, ["ok": true])
        case "testWorkspace", "defaultWorkspace", "listNotes", "readFile", "createNote", "writeFile", "readAsset", "writeAsset", "renameNote", "trashNote":
            fileQueue.async { [weak self] in
                self?.handleFileAction(action, requestID: requestID, payload: payload)
            }
        case "saveFile":
            saveFile(requestID, payload: payload)
        case "print":
            printPage(requestID, payload: payload)
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
            panel.canCreateDirectories = true
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
        case "testWorkspace":
            guard CommandLine.arguments.contains("--self-test") else { respond(requestID, ["ok": false, "error": "测试接口不可用"]); return }
            do {
                let folder = defaultWorkspace.appendingPathComponent("工程测试", isDirectory: true)
                try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
                respond(requestID, ["ok": true, "path": folder.path])
            } catch { respond(requestID, ["ok": false, "error": error.localizedDescription]) }
        case "defaultWorkspace":
            do {
                let previous = fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Documents/Markdown", isDirectory: true)
                if payload["migratePreviousDefault"] as? Bool == true,
                   !fileManager.fileExists(atPath: defaultWorkspace.path),
                   fileManager.fileExists(atPath: previous.path),
                   !CommandLine.arguments.contains("--self-test") {
                    try fileManager.copyItem(at: previous, to: defaultWorkspace)
                }
                try fileManager.createDirectory(at: defaultWorkspace, withIntermediateDirectories: true)
                respond(requestID, ["ok": true, "path": defaultWorkspace.path, "name": "MarkNote"])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
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
        case "createNote":
            guard let url = safeURL(payload), let text = payload["text"] as? String else {
                respond(requestID, ["ok": false, "error": "新建笔记参数无效"])
                return
            }
            do {
                try Data(text.utf8).write(to: url, options: .withoutOverwriting)
                respond(requestID, ["ok": true])
            } catch { respond(requestID, ["ok": false, "error": error.localizedDescription]) }
        case "writeFile":
            guard let url = safeURL(payload), let text = payload["text"] as? String else {
                respond(requestID, ["ok": false, "error": "写入参数无效"])
                return
            }
            do {
                try writeNoteText(text, to: url)
                respond(requestID, ["ok": true])
            } catch {
                respond(requestID, ["ok": false, "error": error.localizedDescription])
            }
        case "renameNote", "trashNote":
            guard let url = safeURL(payload), let root = rootURL(payload),
                  url.deletingLastPathComponent() == root,
                  ["md", "markdown", "txt"].contains(url.pathExtension.lowercased()),
                  !((try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])).map { $0.isSymbolicLink == true || $0.isRegularFile != true } ?? true) else {
                respond(requestID, ["ok": false, "error": "只能操作工程内的笔记文件"]); return
            }
            do {
                if action == "trashNote" {
                    try fileManager.trashItem(at: url, resultingItemURL: nil)
                } else {
                    guard let name = payload["newName"] as? String, !name.isEmpty,
                          !name.contains("/"), !name.contains(":"), !name.contains("\\"),
                          !name.hasPrefix("."), ["md", "markdown", "txt"].contains(URL(fileURLWithPath: name).pathExtension.lowercased()) else {
                        respond(requestID, ["ok": false, "error": "笔记名称无效"]); return
                    }
                    try fileManager.moveItem(at: url, to: root.appendingPathComponent(name))
                }
                respond(requestID, ["ok": true])
            } catch { respond(requestID, ["ok": false, "error": error.localizedDescription]) }
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

    private func printPage(_ requestID: String, payload: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.webView != nil else {
                self?.respond(requestID, ["ok": false, "error": "打印视图不可用"])
                return
            }
            let panel = NSSavePanel()
            panel.title = "导出 PDF"
            panel.nameFieldStringValue = payload["filename"] as? String ?? "MarkNote.pdf"
            panel.allowedFileTypes = ["pdf"]
            panel.canCreateDirectories = true
            panel.begin { response in
                guard response == .OK, let url = panel.url else {
                    self.respond(requestID, ["cancelled": true])
                    return
                }
                self.exportPDF(to: url) { result in
                    switch result {
                    case .success: self.respond(requestID, ["ok": true, "path": url.path])
                    case .failure(let error): self.respond(requestID, ["ok": false, "error": error.localizedDescription])
                    }
                }
            }
        }
    }

    func exportPDF(to url: URL, completion: @escaping (Result<Void, Error>) -> Void) {
        guard #available(macOS 11.0, *) else {
            completion(.failure(NSError(domain: "MarkNote", code: 3, userInfo: [NSLocalizedDescriptionKey: "PDF 导出需要 macOS 11 或更新版本；可先导出 HTML 后用浏览器打印"])))
            return
        }
        guard let webView = webView else { return }
        let measure = """
        (() => {
          const preview = document.getElementById('preview');
          const box = preview.getBoundingClientRect();
          const blocks = Array.from(preview.children).map(e => {
            const r = e.getBoundingClientRect();
            const next = /^H[1-6]$/.test(e.tagName) ? e.nextElementSibling?.getBoundingClientRect() : null;
            return {top: r.top - box.top, bottom: (next?.bottom ?? r.bottom) - box.top};
          });
          return {x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: Math.max(box.height, preview.scrollHeight), blocks};
        })()
        """
        webView.evaluateJavaScript(measure) { result, error in
            guard let layout = result as? [String: Any], let width = layout["width"] as? Double,
                  let height = layout["height"] as? Double, width > 0, height > 0 else {
                completion(.failure(error ?? NSError(domain: "MarkNote", code: 4)))
                return
            }
            let config = WKPDFConfiguration()
            config.rect = CGRect(x: layout["x"] as? Double ?? 0, y: layout["y"] as? Double ?? 0, width: width, height: height)
            webView.createPDF(configuration: config) { result in
                do {
                    let data = try result.get()
                    guard let provider = CGDataProvider(data: data as CFData), let source = CGPDFDocument(provider),
                          let page = source.page(at: 1), let consumer = CGDataConsumer(url: url as CFURL) else {
                        throw NSError(domain: "MarkNote", code: 5)
                    }
                    var paper = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
                    guard let context = CGContext(consumer: consumer, mediaBox: &paper, nil) else { throw NSError(domain: "MarkNote", code: 6) }
                    let bounds = page.getBoxRect(.mediaBox)
                    let scale = (paper.width - 72) / bounds.width
                    let capacity = (paper.height - 72) / scale
                    let blocks = layout["blocks"] as? [[String: Double]] ?? []
                    var start: CGFloat = 0
                    while start < bounds.height {
                        var end = min(start + capacity, bounds.height)
                        if end < bounds.height {
                            for block in blocks {
                                let top = CGFloat(block["top"] ?? 0)
                                let bottom = CGFloat(block["bottom"] ?? 0)
                                if top > start + 1 && top < end && bottom > end && bottom - top <= capacity { end = top; break }
                            }
                        }
                        context.beginPDFPage(nil)
                        context.saveGState()
                        context.clip(to: CGRect(x: 36, y: paper.height - 36 - (end - start) * scale, width: paper.width - 72, height: (end - start) * scale))
                        context.translateBy(x: 36, y: paper.height - 36 - (bounds.height - start) * scale)
                        context.scaleBy(x: scale, y: scale)
                        context.drawPDFPage(page)
                        context.restoreGState()
                        context.endPDFPage()
                        start = end
                    }
                    context.closePDF()
                    completion(.success(()))
                } catch { completion(.failure(error)) }
            }
        }
    }

    private func rootURL(_ payload: [String: Any]) -> URL? {
        guard let root = payload["root"] as? String, !root.isEmpty else { return nil }
        return URL(fileURLWithPath: root).standardizedFileURL
    }

    func writeNoteText(_ text: String, to url: URL) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private let bridge = NativeBridge()
    private let selfTest = CommandLine.arguments.contains("--self-test")
    private var workspaceTestReport: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        let configuration = WKWebViewConfiguration()
        if selfTest { configuration.websiteDataStore = .nonPersistent() }
        if selfTest { configuration.userContentController.addUserScript(WKUserScript(source: "window.__MARKNOTE_SELFTEST__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
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
        } else {
            showLoadError("应用中缺少页面文件，请重新安装 MarkNote。")
        }
        if selfTest {
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                self.finishSelfTest(["ok": false, "error": "页面启动超时"])
            }
        }
    }

    private func installMenus() {
        let menu = NSMenu()
        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        appMenu.addItem(withTitle: "关于 MarkNote", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 MarkNote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editMenu = NSMenu(title: "编辑")
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard selfTest else { return }
        waitForSelfTestStartup()
    }

    private func waitForSelfTestStartup() {
        webView?.evaluateJavaScript("window.marknoteReady === true") { result, _ in
            if result as? Bool == true { self.runWorkspacePreflight() }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForSelfTestStartup() } }
        }
    }

    private func runWorkspacePreflight() {
        let fixtures = Bundle.main.url(forResource: "compatibility-tests", withExtension: "js")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        webView?.evaluateJavaScript(fixtures + "\n; window.runMarkNoteWorkspaceTests().then(report => { window.__workspaceReport = report; }).catch(error => { window.__workspaceReport = {ok:false, error:String(error), stack:error.stack}; }); null;") { _, error in
            if let error = error { self.finishSelfTest(["ok": false, "workspaceError": error.localizedDescription]); return }
            self.pollWorkspacePreflight()
        }
    }

    private func pollWorkspacePreflight() {
        webView?.evaluateJavaScript("window.__workspaceReport || null") { result, _ in
            if let report = result as? [String: Any] {
                self.workspaceTestReport = report
                self.runSelfTest()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.pollWorkspacePreflight() }
            }
        }
    }

    private func runSelfTest() {
        guard let webView = webView else { return }
        let fixtures = Bundle.main.url(forResource: "compatibility-tests", withExtension: "js")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let script = fixtures + "\n;" + """
        (() => {
          const compatibility = window.runMarkNoteCompatibilityTests();
          const layoutChecks = {};
          const sidebar = document.getElementById('sidebar');
          const sideSplit = document.getElementById('sidebarSplitter');
          const previewSplit = document.getElementById('previewSplitter');
          const editorPanel = document.querySelector('.editor-panel');
          const previewPanel = document.getElementById('previewPanel');
          function drag(splitter, startX, endX) {
            splitter.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 91, button: 0, clientX: startX}));
            splitter.dispatchEvent(new PointerEvent('pointermove', {pointerId: 91, clientX: endX}));
            splitter.dispatchEvent(new PointerEvent('pointerup', {pointerId: 91, clientX: endX}));
          }
          sideSplit.dispatchEvent(new MouseEvent('dblclick'));
          previewSplit.dispatchEvent(new MouseEvent('dblclick'));
          const originalWidth = sidebar.getBoundingClientRect().width;
          drag(sideSplit, originalWidth, originalWidth + 60);
          layoutChecks.sidebarDrag = Math.abs(sidebar.getBoundingClientRect().width - originalWidth - 60) < 2;
          const gridBox = document.querySelector('.workspace-grid').getBoundingClientRect();
          drag(previewSplit, gridBox.left + gridBox.width * 0.45, gridBox.left + gridBox.width * 0.65);
          layoutChecks.previewDrag = editorPanel.getBoundingClientRect().width > previewPanel.getBoundingClientRect().width;
          const beforeCollapse = editorPanel.getBoundingClientRect().width;
          document.querySelector('.sidebar-collapse').click();
          document.querySelector('.preview-panel [data-action="toggle-preview"]').click();
          layoutChecks.collapse = getComputedStyle(sidebar).display === 'none' && getComputedStyle(previewPanel).display === 'none' && editorPanel.getBoundingClientRect().width > beforeCollapse;
          const savedLayout = JSON.parse(localStorage.getItem('marknote-layout-v1'));
          layoutChecks.persist = savedLayout.sidebarCollapsed && savedLayout.previewCollapsed && savedLayout.editorShare > 0.6 && savedLayout.sidebarWidth === 308;
          document.body.classList.add('printing');
          layoutChecks.exportCollapsedPreview = getComputedStyle(previewPanel).display !== 'none' && getComputedStyle(previewSplit).display === 'none';
          document.body.classList.remove('printing');
          document.querySelector('.restore-sidebar').click();
          document.querySelector('.restore-preview').click();
          layoutChecks.restore = getComputedStyle(sidebar).display !== 'none' && getComputedStyle(previewPanel).display !== 'none';
          sideSplit.dispatchEvent(new MouseEvent('dblclick'));
          previewSplit.dispatchEvent(new MouseEvent('dblclick'));
          layoutChecks.reset = Math.abs(sidebar.getBoundingClientRect().width - 248) < 2;
          const diagnosticsButton = document.getElementById('diagnosticsToggle');
          diagnosticsButton.click();
          layoutChecks.diagnosticsCollapse = getComputedStyle(document.getElementById('diagnosticsList')).display === 'none' && diagnosticsButton.getAttribute('aria-expanded') === 'false' && JSON.parse(localStorage.getItem('marknote-layout-v1')).diagnosticsCollapsed;
          diagnosticsButton.click();
          layoutChecks.diagnosticsRestore = getComputedStyle(document.getElementById('diagnosticsList')).display !== 'none' && diagnosticsButton.getAttribute('aria-expanded') === 'true';
          document.querySelector('[data-action="load-sample"]').click();
          const preview = document.getElementById('preview');
          const editor = document.getElementById('sourceInput');
          const initial = {table: !!preview?.querySelector('table'), math: !!preview?.querySelector('.katex'), code: !!preview?.querySelector('pre code')};
          const styleButton = document.getElementById('pdfStyleToggle');
          const originalSource = editor.value;
          const originalLight = document.body.classList.contains('light');
          if (styleButton.getAttribute('aria-pressed') !== 'true') styleButton.click();
          const styleChecks = {
            liveSimple: !document.body.classList.contains('printing') && document.body.classList.contains('pdf-simple'),
            mathPlain: getComputedStyle(preview.querySelector('.katex-display')).backgroundColor === 'rgba(0, 0, 0, 0)',
            codePlain: getComputedStyle(preview.querySelector('pre')).borderRadius === '0px',
            tablePlain: getComputedStyle(preview.querySelector('td')).borderLeftWidth === '0px',
            remembered: localStorage.getItem('marknote-pdf-style-v1') === 'simple'
          };
          document.body.classList.remove('light');
          styleChecks.darkReadable = getComputedStyle(preview.querySelector('.hljs')).color === 'rgb(237, 244, 252)';
          document.body.classList.add('light');
          styleChecks.lightReadable = getComputedStyle(preview.querySelector('.hljs')).color === 'rgb(32, 33, 36)';
          styleButton.click();
          styleChecks.coolRestored = document.body.classList.contains('pdf-cool') && !document.body.classList.contains('pdf-simple') && getComputedStyle(preview.querySelector('pre')).borderRadius === '8px';
          styleChecks.sourceUnchanged = originalSource === editor.value;
          document.body.classList.toggle('light', originalLight);
          editor.value = Array.from({length: 100}, (_, i) => '## 独立滚动 ' + i + '\\n\\n滚动测试正文。').join('\\n\\n');
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          const sidebarTop = sidebar.getBoundingClientRect().top;
          const main = document.querySelector('.main-content');
          editor.scrollTop = 160; preview.scrollTop = 230;
          const scrollChecks = {
            editorScrolls: editor.scrollTop === 160 && editor.scrollHeight > editor.clientHeight,
            previewScrolls: preview.scrollTop === 230 && preview.scrollHeight > preview.clientHeight,
            separatePositions: editor.scrollTop !== preview.scrollTop,
            sidebarFixed: sidebar.getBoundingClientRect().top === sidebarTop && sidebar.scrollTop === 0,
            sidebarOwnScrollbar: getComputedStyle(sidebar).overflowY === 'scroll',
            noPageScroll: document.documentElement.scrollHeight <= innerHeight + 1
          };
          main.scrollTop = 100;
          scrollChecks.mainDoesNotMoveSidebar = sidebar.getBoundingClientRect().top === sidebarTop;
          main.scrollTop = 0;
          const spacer = document.createElement('div');
          spacer.style.height = '2000px';
          sidebar.append(spacer);
          sidebar.scrollTop = sidebar.scrollHeight;
          window.scrollTo(0, 1000);
          const shell = document.querySelector('.app-shell');
          scrollChecks.sidebarBottomCannotMovePage = sidebar.scrollTop > 0 && window.scrollY === 0 && shell.getBoundingClientRect().top === 0 && Math.abs(shell.getBoundingClientRect().bottom - innerHeight) <= 1;
          spacer.remove(); sidebar.scrollTop = 0;
          scrollChecks.viewportLocked = getComputedStyle(document.body).position === 'fixed' && getComputedStyle(document.documentElement).overflowY === 'hidden';
          editor.value = Array.from({length: 30}, (_, i) => '## 跳转段落 ' + i + '\\n\\n' + '较长的中文段落用于验证自动换行后行号与箭头位置仍然一致。'.repeat(6) + '\\n\\n```js\\nconst value_' + i + ' = ' + i + ';\\nconsole.log(value_' + i + ');\\n```').join('\\n\\n');
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          const sourceLines = editor.value.split('\\n');
          const headingLine = sourceLines.indexOf('## 跳转段落 20') + 1;
          const headingOffset = sourceLines.slice(0, headingLine - 1).join('\\n').length + 1;
          editor.setSelectionRange(headingOffset, headingOffset);
          document.querySelector('[data-action="jump-preview"]').click();
          const jumpChecks = {
            toolbarLocates: preview.querySelector('.jump-highlight')?.textContent === '跳转段落 20' && preview.scrollTop > 0,
            wrapGutterMatches: Math.abs(document.getElementById('lineGutter').scrollHeight - editor.scrollHeight) <= 3,
            rootStaysFixed: window.scrollY === 0 && shell.getBoundingClientRect().top === 0
          };
          document.querySelector('.preview-panel [data-action="toggle-preview"]').click();
          document.querySelector('#lineGutter [data-line="' + headingLine + '"]').click();
          jumpChecks.gutterReopensPreview = !document.body.classList.contains('preview-collapsed') && preview.querySelector('.jump-highlight')?.textContent === '跳转段落 20';
          const insideCode = sourceLines.indexOf('console.log(value_20);') + 1;
          document.querySelector('#lineGutter [data-line="' + insideCode + '"]').click();
          jumpChecks.codeStaysInOwnBlock = preview.querySelector('.jump-highlight')?.tagName === 'PRE' && preview.querySelector('.jump-highlight')?.textContent.includes('value_20');
          const key = new KeyboardEvent('keydown', {key: 'ArrowRight', ctrlKey: true, altKey: true, bubbles: true, cancelable: true});
          editor.dispatchEvent(key);
          jumpChecks.keyboardLocates = key.defaultPrevented && preview.querySelector('.jump-highlight')?.textContent === '跳转段落 20';
          const plainRight = new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true});
          editor.dispatchEvent(plainRight);
          jumpChecks.normalArrowPreserved = !plainRight.defaultPrevented;
          preview.querySelector('.jump-highlight').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
          jumpChecks.reverseJumpPreserved = editor.selectionStart === headingOffset && editor.value.slice(editor.selectionStart, editor.selectionEnd) === '## 跳转段落 20' && editor.scrollTop > 0;
          editor.value = '# 启动测试\\n\\n编辑和预览正常。';
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          return {compatibility, layoutChecks, styleChecks, scrollChecks, jumpChecks, initial, edited: preview.querySelector('h1')?.textContent === '启动测试', bridge: !!window.webkit?.messageHandlers?.marknote, engine: document.getElementById('engineStatus')?.textContent, path: document.getElementById('workspacePath')?.textContent, note: document.getElementById('breadcrumbNote')?.textContent};
        })()
        """
        webView.evaluateJavaScript(script) { result, error in
            var report = result as? [String: Any] ?? [:]
            report["workspaceTests"] = self.workspaceTestReport
            let initial = report["initial"] as? [String: Bool] ?? [:]
            let layoutChecks = report["layoutChecks"] as? [String: Bool] ?? [:]
            let styleChecks = report["styleChecks"] as? [String: Bool] ?? [:]
            let scrollChecks = report["scrollChecks"] as? [String: Bool] ?? [:]
            let jumpChecks = report["jumpChecks"] as? [String: Bool] ?? [:]
            let compatibility = report["compatibility"] as? [[String: Any]] ?? []
            do {
                report["storageAudit"] = try StorageCompatibilityTests.run(write: self.bridge.writeNoteText)
            } catch {
                report["storageAudit"] = ["error": error.localizedDescription]
            }
            let storageChecks = (report["storageAudit"] as? [String: Any])?["checks"] as? [String: Bool] ?? [:]
            report["windowVisible"] = self.window?.isVisible == true
            report["ok"] = error == nil && self.window?.isVisible == true && initial.values.filter { $0 }.count == 3 && report["edited"] as? Bool == true && report["bridge"] as? Bool == true && layoutChecks.count == 9 && layoutChecks.values.allSatisfy { $0 } && !compatibility.isEmpty && compatibility.allSatisfy { $0["ok"] as? Bool == true } && storageChecks.count == 6 && storageChecks.values.allSatisfy { $0 }
            if let error = error { report["error"] = error.localizedDescription }
            report["ok"] = report["ok"] as? Bool == true && styleChecks.count == 9 && styleChecks.values.allSatisfy { $0 }
            report["ok"] = report["ok"] as? Bool == true && scrollChecks.count == 9 && scrollChecks.values.allSatisfy { $0 }
            report["ok"] = report["ok"] as? Bool == true && jumpChecks.count == 8 && jumpChecks.values.allSatisfy { $0 }
            report["ok"] = report["ok"] as? Bool == true && self.workspaceTestReport["ok"] as? Bool == true
            let renderReport = report
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                var finalReport = renderReport
                let path = renderReport["path"] as? String ?? ""
                let note = renderReport["note"] as? String ?? ""
                let fileName = note.hasSuffix(".md") ? note : note + ".md"
                let content = try? String(contentsOf: URL(fileURLWithPath: path).appendingPathComponent(fileName), encoding: .utf8)
                finalReport["fileAutosaved"] = content == "# 启动测试\n\n编辑和预览正常。"
                finalReport["ok"] = renderReport["ok"] as? Bool == true && finalReport["fileAutosaved"] as? Bool == true
                self.verifyPDFAndTheme(finalReport)
            }
        }
    }

    private func verifyPDFAndTheme(_ previousReport: [String: Any]) {
        let script = """
        (() => {
          document.body.classList.add('light');
          document.querySelector('[data-action="load-sample"]').click();
          const editor = document.getElementById('sourceInput');
          editor.value += '\\n\\n' + Array.from({length: 55}, (_, i) => '## PDF 分页测试 ' + (i + 1) + '\\n\\n分页后的文字也必须完整保留。公式、表格、代码块和图片都应该正常显示。').join('\\n\\n');
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          const math = getComputedStyle(document.querySelector('.katex-display > .katex')).color;
          const codeBackground = getComputedStyle(document.querySelector('pre')).backgroundColor;
          document.body.classList.add('printing', 'pdf-cool');
          return {math, codeBackground};
        })()
        """
        webView?.evaluateJavaScript(script) { result, error in
            let theme = result as? [String: String] ?? [:]
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                var report = previousReport
                report["lightTheme"] = theme
                let path = previousReport["path"] as? String ?? ""
                let url = URL(fileURLWithPath: path).appendingPathComponent("export-verification.pdf")
                self.bridge.exportPDF(to: url) { result in
                  do {
                    try result.get()
                    let pdf = PDFDocument(url: url)
                    let content = pdf?.string ?? ""
                    let valid = (pdf?.pageCount ?? 0) > 1 && content.contains("Encoder") && content.contains("encode") && content.contains("55")
                    report["pdfPages"] = pdf?.pageCount ?? 0
                    report["pdfPath"] = url.path
                    report["pdfContentVerified"] = valid
                    report["ok"] = previousReport["ok"] as? Bool == true && error == nil && valid && theme["math"] == "rgb(21, 34, 56)" && theme["codeBackground"] == "rgb(241, 243, 245)"
                  } catch {
                    report["ok"] = false
                    report["pdfError"] = error.localizedDescription
                  }
                  self.verifySimplePDF(report)
                }
            }
        }
    }

    private func verifySimplePDF(_ previous: [String: Any]) {
        let script = """
        (() => {
          const before = document.getElementById('sourceInput').value;
          const button = document.getElementById('pdfStyleToggle');
          if (button.getAttribute('aria-pressed') !== 'true') button.click();
          document.body.classList.remove('pdf-cool');
          document.body.classList.add('pdf-simple');
          return {sourceUnchanged: before === document.getElementById('sourceInput').value,
            stylePersisted: localStorage.getItem('marknote-pdf-style-v1') === 'simple',
            mathBackground: getComputedStyle(document.querySelector('.katex-display')).backgroundColor,
            codeRadius: getComputedStyle(document.querySelector('pre')).borderRadius};
        })()
        """
        webView?.evaluateJavaScript(script) { result, error in
            var report = previous
            let style = result as? [String: Any] ?? [:]
            report["simpleStyle"] = style
            let path = previous["path"] as? String ?? ""
            let url = URL(fileURLWithPath: path).appendingPathComponent("export-simple-verification.pdf")
            self.bridge.exportPDF(to: url) { result in
                do {
                    try result.get()
                    let pdf = PDFDocument(url: url)
                    let content = pdf?.string ?? ""
                    let valid = (pdf?.pageCount ?? 0) > 1 && content.contains("Encoder") && content.contains("55") && content.contains("encode")
                    report["simplePDFPath"] = url.path
                    report["simplePDFPages"] = pdf?.pageCount ?? 0
                    report["ok"] = previous["ok"] as? Bool == true && error == nil && valid && style["sourceUnchanged"] as? Bool == true && style["stylePersisted"] as? Bool == true && style["mathBackground"] as? String == "rgba(0, 0, 0, 0)" && style["codeRadius"] as? String == "0px"
                } catch {
                    report["ok"] = false
                    report["simplePDFError"] = error.localizedDescription
                }
                self.finishSelfTest(report)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }

    private func showLoadError(_ message: String) {
        if selfTest {
            finishSelfTest(["ok": false, "error": message])
            return
        }
        let alert = NSAlert()
        alert.messageText = "MarkNote 页面加载失败"
        alert.informativeText = message
        alert.runModal()
    }

    private func finishSelfTest(_ report: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            print(json)
            fflush(stdout)
        }
        exit(report["ok"] as? Bool == true ? 0 : 1)
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

@main
enum MarkNoteMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}
