(() => {
  "use strict";

  const STORAGE_KEY = "marknote-current-draft-v1";
  const THEME_KEY = "marknote-theme-v1";
  const WORKSPACE_DB = "marknote-workspaces-v1";
  const WORKSPACE_STORE = "workspaces";
  const ATTACHMENT_STORE = "attachments";
  const SELECTED_WORKSPACE_KEY = "marknote-selected-workspace-v1";
  const SELECTED_NOTE_KEY = "marknote-selected-note-v1";
  const nativeRequests = new Map();
  let nativeRequestSerial = 0;

  function hasNativeBridge() {
    return Boolean(window.webkit?.messageHandlers?.marknote);
  }

  function nativeRequest(action, payload = {}) {
    if (!hasNativeBridge()) return Promise.reject(new Error("原生桥接不可用"));
    const id = `marknote-${Date.now()}-${nativeRequestSerial += 1}`;
    return new Promise((resolve, reject) => {
      nativeRequests.set(id, { resolve, reject });
      window.webkit.messageHandlers.marknote.postMessage({ id, action, payload });
    });
  }

  window.marknoteNativeResolve = (id, response) => {
    const request = nativeRequests.get(id);
    if (!request) return;
    nativeRequests.delete(id);
    if (response?.ok === false && response.error) request.reject(new Error(response.error));
    else request.resolve(response || {});
  };

  const DEFAULT_MARKDOWN = [
    "# AI Markdown 渲染测试",
    "",
    "把 GPT、Claude 或其他模型返回的内容直接粘贴到左侧。MarkNote 会同时处理 GFM 表格、LaTeX 公式、代码块和链接。",
    "",
    "## 1. 数学公式",
    "",
    "行内公式：$P_{ij}=1$，矩阵公式会保持为独立块：",
    "",
    "$$",
    "P_{ij} =",
    "\\begin{cases}",
    "1, & i \\sim j\\\\",
    "0, & \\text{otherwise}",
    "\\end{cases}",
    "$$",
    "",
    "## 2. GFM 表格",
    "",
    "| 模块 | 输入 | 输出 |",
    "| --- | --- | --- |",
    "| Encoder | RSRP | Embedding |",
    "| GNN | Graph | Feature |",
    "",
    "## 3. 代码块",
    "",
    "```python",
    "def encode(graph):",
    "    return gnn(graph)",
    "```",
    "",
    "> 试试把模型输出的原文粘贴进来，再观察“渲染诊断”给出的提示。"
  ].join("\n");

  const sourceInput = document.getElementById("sourceInput");
  const preview = document.getElementById("preview");
  const lineGutter = document.getElementById("lineGutter");
  const sourceStats = document.getElementById("sourceStats");
  const saveState = document.getElementById("saveState");
  const compatToggle = document.getElementById("compatToggle");
  const diagnosticsList = document.getElementById("diagnosticsList");
  const renderState = document.getElementById("renderState");
  const engineStatus = document.getElementById("engineStatus");
  const fileInput = document.getElementById("fileInput");
  const toast = document.getElementById("toast");
  const workspaceSelect = document.getElementById("workspaceSelect");
  const workspacePath = document.getElementById("workspacePath");
  const workspaceStatusDot = document.getElementById("workspaceStatusDot");
  const notesList = document.getElementById("notesList");
  const breadcrumbWorkspace = document.getElementById("breadcrumbWorkspace");
  const breadcrumbNote = document.getElementById("breadcrumbNote");

  let saveTimer = null;
  let toastTimer = null;
  let workspaceDb = null;
  let workspaceRecords = [];
  let currentWorkspace = null;
  let currentNoteName = "当前草稿";
  let currentNoteHandle = null;
  let activeObjectUrls = [];

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getWorkspaceDb() {
    if (workspaceDb) return Promise.resolve(workspaceDb);
    if (!window.indexedDB) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = window.indexedDB.open(WORKSPACE_DB, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(WORKSPACE_STORE)) {
          request.result.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE)) {
          request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        workspaceDb = request.result;
        resolve(workspaceDb);
      };
      request.onerror = () => resolve(null);
    });
  }

  async function getWorkspaceRecords() {
    const db = await getWorkspaceDb();
    if (!db) return [];
    return new Promise((resolve) => {
      const request = db.transaction(WORKSPACE_STORE, "readonly").objectStore(WORKSPACE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  }

  async function putWorkspaceRecord(record) {
    const db = await getWorkspaceDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const request = db.transaction(WORKSPACE_STORE, "readwrite").objectStore(WORKSPACE_STORE).put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    });
  }

  async function putAttachment(record) {
    const db = await getWorkspaceDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const request = db.transaction(ATTACHMENT_STORE, "readwrite").objectStore(ATTACHMENT_STORE).put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    });
  }

  async function getAttachment(id) {
    const db = await getWorkspaceDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const request = db.transaction(ATTACHMENT_STORE, "readonly").objectStore(ATTACHMENT_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  function hasDirectoryPicker() {
    return hasNativeBridge() || typeof window.showDirectoryPicker === "function";
  }

  async function workspacePermission(record, write = false, ask = false) {
    if (record?.nativePath) return true;
    if (!record?.handle) return false;
    const options = { mode: write ? "readwrite" : "read" };
    try {
      let state = await record.handle.queryPermission(options);
      if (state !== "granted" && ask && typeof record.handle.requestPermission === "function") {
        state = await record.handle.requestPermission(options);
      }
      return state === "granted";
    } catch (error) {
      return false;
    }
  }

  function workspaceLabel(record) {
    return record?.name || record?.handle?.name || "本地工作区";
  }

  function updateWorkspaceIdentity() {
    const workspaceName = currentWorkspace ? workspaceLabel(currentWorkspace) : "我的笔记";
    breadcrumbWorkspace.textContent = workspaceName;
    breadcrumbNote.textContent = currentNoteName || "当前草稿";
    workspaceStatusDot.classList.toggle("connected", Boolean(currentWorkspace));
    if (currentWorkspace) {
      workspacePath.textContent = `文件夹：${workspaceLabel(currentWorkspace)} · Markdown 文件保存在其中`;
    } else {
      workspacePath.textContent = "笔记只保存在浏览器中";
    }
  }

  function renderWorkspaceOptions() {
    const selected = currentWorkspace?.id || "";
    workspaceSelect.innerHTML = "";
    const localOption = document.createElement("option");
    localOption.value = "";
    localOption.textContent = "本地草稿（未选择文件夹）";
    workspaceSelect.appendChild(localOption);
    workspaceRecords.forEach((record) => {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = workspaceLabel(record);
      workspaceSelect.appendChild(option);
    });
    workspaceSelect.value = selected;
  }

  function renderNotes(noteNames = []) {
    notesList.innerHTML = "";
    if (!currentWorkspace) {
      notesList.innerHTML = '<div class="note-list-empty">选择本地文件夹后，这里会显示其中的 Markdown 笔记。</div>';
      return;
    }
    if (!noteNames.length) {
      notesList.innerHTML = '<div class="note-list-empty">这个工作区还没有 Markdown 笔记。</div>';
      return;
    }
    noteNames.forEach((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `note-list-item${name === currentNoteName ? " active" : ""}`;
      button.dataset.noteName = name;
      button.textContent = name;
      button.title = `打开 ${name}`;
      notesList.appendChild(button);
    });
  }

  async function listWorkspaceNotes() {
    if (currentWorkspace?.nativePath) {
      try {
        const response = await nativeRequest("listNotes", { root: currentWorkspace.nativePath });
        const names = Array.isArray(response.names) ? response.names : [];
        renderNotes(names);
        return names;
      } catch (error) {
        renderNotes([]);
        return [];
      }
    }
    if (!currentWorkspace?.handle) {
      renderNotes([]);
      return [];
    }
    const allowed = await workspacePermission(currentWorkspace, false, false);
    if (!allowed) {
      workspacePath.textContent = "文件夹权限已失效，请重新选择该文件夹";
      renderNotes([]);
      return [];
    }
    const names = [];
    try {
      for await (const [name, handle] of currentWorkspace.handle.entries()) {
        if (handle.kind === "file" && /\.(?:md|markdown|txt)$/i.test(name)) names.push(name);
      }
    } catch (error) {
      renderNotes([]);
      return [];
    }
    names.sort((left, right) => left.localeCompare(right, "zh-CN"));
    renderNotes(names);
    return names;
  }

  async function openWorkspaceNote(name) {
    if ((!currentWorkspace?.handle && !currentWorkspace?.nativePath) || !name) return;
    if (!await workspacePermission(currentWorkspace, true, true)) {
      showToast("还没有获得该工作区的读写权限，请重新选择文件夹");
      return;
    }
    try {
      let text;
      if (currentWorkspace.nativePath) {
        const response = await nativeRequest("readFile", { root: currentWorkspace.nativePath, relativePath: name });
        text = response.text || "";
        currentNoteHandle = null;
      } else {
        const handle = await currentWorkspace.handle.getFileHandle(name);
        const file = await handle.getFile();
        text = await file.text();
        currentNoteHandle = handle;
      }
      currentNoteName = name;
      sourceInput.value = text;
      localStorage.setItem(STORAGE_KEY, sourceInput.value);
      localStorage.setItem(SELECTED_NOTE_KEY, name);
      updateWorkspaceIdentity();
      renderNotes(await listWorkspaceNotes());
      update({ persist: false });
      void compactInlineImagesInSource();
      showToast(`已打开 ${name}`);
    } catch (error) {
      showToast("无法打开这篇笔记");
    }
  }

  async function activateWorkspace(record, askPermission = false) {
    currentWorkspace = record || null;
    currentNoteHandle = null;
    currentNoteName = record ? (localStorage.getItem(SELECTED_NOTE_KEY) || "当前草稿") : "当前草稿";
    renderWorkspaceOptions();
    updateWorkspaceIdentity();
    if (!record) {
      sourceInput.value = localStorage.getItem(STORAGE_KEY) || DEFAULT_MARKDOWN;
      renderNotes([]);
      update({ persist: false });
      return;
    }
    const allowed = await workspacePermission(record, true, askPermission);
    if (!allowed) {
      workspacePath.textContent = "请重新选择该文件夹以恢复读写权限";
      renderNotes([]);
      update({ persist: false });
      return;
    }
    const names = await listWorkspaceNotes();
    const preferred = names.includes(currentNoteName) ? currentNoteName : names[0];
    if (preferred) await openWorkspaceNote(preferred);
    else {
      sourceInput.value = "";
      currentNoteName = "新笔记";
      updateWorkspaceIdentity();
      update({ persist: false });
    }
  }

  async function selectWorkspace() {
    if (!hasDirectoryPicker()) {
      showToast("当前浏览器不支持本地文件夹工作区，请使用 Chrome 或 Edge");
      return;
    }
    try {
      if (hasNativeBridge()) {
        const selected = await nativeRequest("chooseWorkspace");
        if (selected.cancelled || !selected.path) return;
        const suggestedName = selected.name || "本地工作区";
        const name = window.prompt("给这个工作区起个名字", suggestedName) || suggestedName;
        const existing = workspaceRecords.find((record) => record.nativePath === selected.path);
        const record = existing || { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name, nativePath: selected.path };
        record.name = name;
        record.nativePath = selected.path;
        delete record.handle;
        await putWorkspaceRecord(record);
        workspaceRecords = await getWorkspaceRecords();
        localStorage.setItem(SELECTED_WORKSPACE_KEY, record.id);
        await activateWorkspace(record, true);
        showToast(`工作区“${name}”已连接`);
        return;
      }
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const suggestedName = handle.name || "本地工作区";
      const name = window.prompt("给这个工作区起个名字", suggestedName) || suggestedName;
      let existing = null;
      for (const record of workspaceRecords) {
        try {
          if (record.handle && await record.handle.isSameEntry(handle)) {
            existing = record;
            break;
          }
        } catch (error) {
          // A stale handle is simply replaced by the newly selected folder.
        }
      }
      const record = existing || { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name, handle };
      record.name = name;
      record.handle = handle;
      await putWorkspaceRecord(record);
      workspaceRecords = await getWorkspaceRecords();
      localStorage.setItem(SELECTED_WORKSPACE_KEY, record.id);
      await activateWorkspace(record, true);
      showToast(`工作区“${name}”已连接`);
    } catch (error) {
      if (error?.name !== "AbortError") showToast("没有成功连接本地文件夹");
    }
  }

  async function initializeWorkspaces() {
    workspaceRecords = await getWorkspaceRecords();
    renderWorkspaceOptions();
    const selectedId = localStorage.getItem(SELECTED_WORKSPACE_KEY);
    const selected = workspaceRecords.find((record) => record.id === selectedId);
    if (selected) await activateWorkspace(selected, false);
    else {
      updateWorkspaceIdentity();
      renderNotes([]);
    }
  }

  async function writeBlobToWorkspace(relativePath, blob) {
    if (!currentWorkspace?.handle) return false;
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    let directory = currentWorkspace.handle;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function imageExtension(type) {
    const match = String(type || "image/png").split("/")[1] || "png";
    return match.replace(/[^a-z0-9]/gi, "") || "png";
  }

  async function savePastedImage(blob) {
    const extension = imageExtension(blob.type);
    const base = `pasted-image-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 7)}`;
    const fileName = `${base}.${extension}`;
    if (currentWorkspace && await workspacePermission(currentWorkspace, true, false)) {
      try {
        if (currentWorkspace.nativePath) {
          const response = await nativeRequest("writeAsset", {
            root: currentWorkspace.nativePath,
            relativePath: `assets/${fileName}`,
            dataUrl: await blobToDataUrl(blob)
          });
          if (!response.ok) throw new Error("图片写入失败");
        } else {
          await writeBlobToWorkspace(`assets/${fileName}`, blob);
        }
        return { source: `assets/${fileName}`, persistent: true, kind: "workspace" };
      } catch (error) {
        // Fall back to an embedded image if the folder cannot be written.
      }
    }
    const attachmentId = `${base}-${extension}`;
    const stored = await putAttachment({ id: attachmentId, name: fileName, type: blob.type, blob, createdAt: Date.now() });
    if (stored) return { source: `attachment://${attachmentId}`, persistent: true, kind: "attachment" };
    return { source: await blobToDataUrl(blob), persistent: false, kind: "data" };
  }

  function dataUrlToBlob(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;,]+)?(?:;base64)?,(.*)$/is);
    if (!match) return null;
    const type = match[1] || "image/png";
    const payload = match[2];
    try {
      if (/;base64,/i.test(dataUrl)) {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new Blob([bytes], { type });
      }
      return new Blob([decodeURIComponent(payload)], { type });
    } catch (error) {
      return null;
    }
  }

  async function compactInlineImagesInSource() {
    const imagePattern = /!\[([^\]]*)\]\((data:image\/[^)]+)\)/gi;
    const matches = Array.from(sourceInput.value.matchAll(imagePattern));
    if (!matches.length) return;
    let compacted = sourceInput.value;
    let changed = false;
    for (const match of matches) {
      const blob = dataUrlToBlob(match[2]);
      if (!blob) continue;
      const saved = await savePastedImage(blob);
      if (saved.kind === "data") continue;
      compacted = compacted.replace(match[0], `![${match[1]}](${saved.source})`);
      changed = true;
    }
    if (changed && compacted !== sourceInput.value) {
      sourceInput.value = compacted;
      update();
      showToast("已把长图片数据改为简洁的本地附件引用");
    }
  }

  function insertAtCursor(value) {
    const start = sourceInput.selectionStart ?? sourceInput.value.length;
    const end = sourceInput.selectionEnd ?? start;
    const before = sourceInput.value.slice(0, start);
    const after = sourceInput.value.slice(end);
    const prefix = before && !/[\n\r]$/.test(before) ? "\n\n" : "";
    sourceInput.value = `${before}${prefix}${value}${after}`;
    const cursor = before.length + prefix.length + value.length;
    sourceInput.focus();
    sourceInput.setSelectionRange(cursor, cursor);
  }

  async function handleImagePaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const blob = imageItem.getAsFile();
    if (!blob) return;
    event.preventDefault();
    const image = await savePastedImage(blob);
    const alt = currentWorkspace ? "粘贴图片" : "内嵌图片";
    insertAtCursor(`![${alt}](${image.source})`);
    update();
    if (image.kind === "workspace") showToast("图片已保存到工作区的 assets 文件夹");
    else if (image.kind === "attachment") showToast("图片已保存为本地附件，原文只保留简短引用");
    else showToast("图片已以内嵌方式插入；选择工作区可长期保存");
  }

  async function getWorkspaceFile(relativePath) {
    if (!currentWorkspace?.handle) return null;
    const parts = decodeURIComponent(relativePath).replace(/^\.\//, "").split("/").filter(Boolean);
    let directory = currentWorkspace.handle;
    try {
      for (let index = 0; index < parts.length - 1; index += 1) {
        directory = await directory.getDirectoryHandle(parts[index]);
      }
      return await directory.getFileHandle(parts[parts.length - 1]);
    } catch (error) {
      return null;
    }
  }

  function clearObjectUrls() {
    activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeObjectUrls = [];
  }

  async function hydrateWorkspaceImages() {
    clearObjectUrls();
    const images = Array.from(preview.querySelectorAll("img"));
    for (const image of images) {
      const source = image.getAttribute("src") || "";
      if (!source || /^(?:https?:|data:|blob:|#)/i.test(source)) continue;
      let blob = null;
      if (/^attachment:\/\//i.test(source)) {
        const attachment = await getAttachment(source.slice("attachment://".length));
        blob = attachment?.blob || null;
      } else if (currentWorkspace?.nativePath) {
        try {
          const response = await nativeRequest("readAsset", { root: currentWorkspace.nativePath, relativePath: source });
          blob = response.dataUrl ? dataUrlToBlob(response.dataUrl) : null;
        } catch (error) {
          blob = null;
        }
      } else if (currentWorkspace) {
        const handle = await getWorkspaceFile(source);
        if (handle) {
          try {
            blob = await handle.getFile();
          } catch (error) {
            blob = null;
          }
        }
      }
      if (!blob) continue;
      try {
        const objectUrl = URL.createObjectURL(blob);
        activeObjectUrls.push(objectUrl);
        image.src = objectUrl;
      } catch (error) {
        // Leave the original relative path in place so the broken asset is visible.
      }
    }
  }

  function looksLikeMath(value) {
    return /\\(?:begin|end|frac|sqrt|sum|prod|int|lim|left|right|mathrm|mathbf|text|cdot|times|sim|infty)\b|[_^]\s*\{|\\[a-zA-Z]+/.test(value);
  }

  function repairMathBody(value) {
    return value
      .replace(/\\_/g, "_")
      .replace(/(&\s*)otherwise\b/g, "$1\\text{otherwise}")
      .replace(/\\\\\s*$/gm, "\\\\");
  }

  function protectCodeFences(source) {
    const blocks = [];
    const protectedSource = source.replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g, (whole) => {
      const token = `\u0000MARKNOTE_CODE_${blocks.length}\u0000`;
      blocks.push(whole);
      return token;
    });
    return {
      source: protectedSource,
      restore(value) {
        return value.replace(/\u0000MARKNOTE_CODE_(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
      }
    };
  }

  function normalizeAiMarkdown(source, enabled) {
    if (!enabled) return source.replace(/\r\n?/g, "\n");

    const protectedSource = protectCodeFences(source.replace(/\r\n?/g, "\n"));
    const lines = protectedSource.source.split("\n");
    const result = [];
    let insideDisplayMath = false;

    for (let index = 0; index < lines.length; index += 1) {
      const current = lines[index].trim();

      // Do not reinterpret an equation environment that is already inside
      // an explicit $$...$$ or \\[...\\] block.
      if (insideDisplayMath) {
        result.push(lines[index]);
        if (current === "$$" || current === "\\]") insideDisplayMath = false;
        continue;
      }
      if (current === "$$" || current === "\\[") {
        insideDisplayMath = true;
        result.push(lines[index]);
        continue;
      }

      // Some model responses use a line containing only `[` and `]` around a LaTeX block.
      // That is visually suggestive, but it is not a Markdown/KaTeX delimiter.
      if (current === "[") {
        let end = index + 1;
        while (end < lines.length && lines[end].trim() !== "]") end += 1;
        if (end < lines.length) {
          const body = lines.slice(index + 1, end).join("\n");
          if (looksLikeMath(body)) {
            result.push("$$", repairMathBody(body), "$$");
            index = end;
            continue;
          }
        }
      }

      // Also accept a bare equation environment as a display formula.
      if (/^\\begin\{(?:equation|align|aligned|gather|matrix|pmatrix|cases)\}/.test(current)) {
        let end = index + 1;
        while (end < lines.length && !/^\\end\{/.test(lines[end].trim())) end += 1;
        if (end < lines.length) {
          result.push("$$", repairMathBody(lines.slice(index, end + 1).join("\n")), "$$");
          index = end;
          continue;
        }
      }

      result.push(lines[index]);
    }

    return protectedSource.restore(result.join("\n"));
  }

  function splitTableRow(row) {
    let value = row.trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    const cells = [];
    let current = "";
    let escaped = false;
    for (const character of value) {
      if (character === "\\" && !escaped) {
        escaped = true;
        current += character;
      } else if (character === "|" && !escaped) {
        cells.push(current.trim());
        current = "";
      } else {
        current += character;
        escaped = false;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableSeparator(row) {
    const cells = splitTableRow(row);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function analyzeSource(source) {
    const notices = [];
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const fenceCount = lines.filter((line) => /^\s{0,3}(```|~~~)/.test(line)).length;

    if (fenceCount % 2 !== 0) {
      notices.push({ type: "warn", title: "代码围栏未闭合", body: "检测到奇数个 ``` 或 ~~~，后面的内容可能都会被当成代码。" });
    }

    const bracketMath = lines.some((line, index) => {
      if (line.trim() !== "[") return false;
      const end = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.trim() === "]");
      return end > index && looksLikeMath(lines.slice(index + 1, end).join("\n"));
    });
    if (bracketMath) {
      notices.push({ type: "info", title: "已识别裸方括号公式", body: "这不是标准公式定界符，兼容模式已自动转换为 $$…$$。" });
    }

    const hasEquationWithoutDelimiter = lines.some((line) => /\\begin\{(?:cases|equation|align|matrix)/.test(line)) && !/(\$\$|\\\[)/.test(source) && !bracketMath;
    if (hasEquationWithoutDelimiter) {
      notices.push({ type: "info", title: "LaTeX 环境需要定界符", body: "KaTeX 只会渲染公式区域，单独的 \\begin{…} 需要放进 $$…$$ 或 \\[…\\]。" });
    }

    const tableCandidate = lines.findIndex((line, index) => line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]));
    if (tableCandidate >= 0) {
      const headerCells = splitTableRow(lines[tableCandidate]).length;
      const separatorCells = splitTableRow(lines[tableCandidate + 1]).length;
      if (headerCells !== separatorCells) {
        notices.push({ type: "warn", title: "表格列数不一致", body: `表头有 ${headerCells} 列，分隔行有 ${separatorCells} 列，请检查竖线是否遗漏。` });
      } else if (splitTableRow(lines[tableCandidate][0] === "|" ? lines[tableCandidate] : lines[tableCandidate]).some((cell) => cell.length > 42)) {
        notices.push({ type: "warn", title: "表头可能被粘成一格", body: "如果多个标题挤在同一个单元格，请在标题之间补上 |。" });
      }
    }

    const formulaLike = lines.some((line) => /(?:\\frac|\\begin\{|[_^]\{)/.test(line));
    const hasAnyMathDelimiter = /\$\$|\$[^\n$]+\$|\\\(|\\\[/.test(source);
    if (formulaLike && !hasAnyMathDelimiter && !bracketMath) {
      notices.push({ type: "warn", title: "发现未包裹的公式片段", body: "请让模型使用 $…$ 或 $$…$$ 包住 LaTeX，否则普通 Markdown 不知道哪里开始渲染公式。" });
    }

    if (!notices.length) {
      notices.push({ type: "ok", title: "没有发现明显问题", body: "当前内容已经具备标准 Markdown 的基本结构。" });
    }
    return notices;
  }

  function inlineFallback(value) {
    const tokens = [];
    let html = escapeHtml(value);
    const stash = (content) => {
      const token = `\u0000INLINE_${tokens.length}\u0000`;
      tokens.push(content);
      return token;
    };

    html = html.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`));
    html = html.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)/g, (_, alt, url, title) => {
      const safeUrl = /^(?:https?:|data:image\/|blob:)/i.test(url) ? url : "#";
      return stash(`<img src="${escapeHtml(safeUrl)}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy">`);
    });
    html = html.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
      const safeUrl = /^(?:https?:|mailto:|#)/i.test(url) ? url : "#";
      return stash(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${label}</a>`);
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    return html.replace(/\u0000INLINE_(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  }

  function fallbackMarkdown(source) {
    const lines = source.split("\n");
    const html = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      const fence = line.match(/^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/);
      if (fence) {
        const marker = fence[1];
        const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}`).test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        html.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${inlineFallback(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        html.push("<hr>");
        index += 1;
        continue;
      }

      if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        const header = splitTableRow(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        html.push(`<table><thead><tr>${header.map((cell) => `<th>${inlineFallback(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${inlineFallback(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
          index += 1;
        }
        html.push(`<blockquote><p>${quote.map(inlineFallback).join("<br>")}</p></blockquote>`);
        continue;
      }

      if (/^\s{0,3}(?:[-+*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s{0,3}\d+\./.test(line);
        const items = [];
        while (index < lines.length && new RegExp(`^\\s{0,3}${ordered ? "\\d+\\." : "[-+*]"}\\s+`).test(lines[index])) {
          items.push(lines[index].replace(new RegExp(`^\\s{0,3}${ordered ? "\\d+\\." : "[-+*]"}\\s+`), ""));
          index += 1;
        }
        html.push(`<${ordered ? "ol" : "ul"}>${items.map((item) => `<li>${inlineFallback(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !/^(?:\s{0,3}#{1,6}\s|\s{0,3}(?:```|~~~)|\s{0,3}>|\s{0,3}(?:[-+*]|\d+\.)\s+)/.test(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      html.push(`<p>${paragraph.map(inlineFallback).join("\n")}</p>`);
    }

    return html.join("\n");
  }

  function renderMath(root) {
    if (typeof window.renderMathInElement !== "function") return;
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false,
      strict: "ignore",
      trust: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"]
    });
  }

  function enhanceLinks(root) {
    root.querySelectorAll("a").forEach((link) => {
      if (/^https?:/i.test(link.getAttribute("href") || "")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    });
  }

  function protectDisplayMath(source) {
    const protectedCode = protectCodeFences(source);
    const blocks = [];
    const displayPattern = /(^|\n)([ \t]*)(\$\$|\\\[)[ \t]*\n([\s\S]*?)\n\2(\$\$|\\\])[ \t]*(?=\n|$)/g;
    const replaced = protectedCode.source.replace(displayPattern, (whole, prefix, indent, open, body) => {
      const token = `MARKNOTE-DISPLAY-${blocks.length}`;
      blocks.push(repairMathBody(body));
      return `${prefix}${token}`;
    });
    return { source: protectedCode.restore(replaced), blocks };
  }

  function restoreDisplayMath(root, blocks) {
    if (!blocks.length) return;
    const paragraphs = Array.from(root.querySelectorAll("p"));
    paragraphs.forEach((paragraph) => {
      const match = paragraph.textContent.trim().match(/^MARKNOTE-DISPLAY-(\d+)$/);
      if (!match) return;
      const body = blocks[Number(match[1])];
      const container = document.createElement("div");
      container.className = "math-block-container";
      if (typeof window.katex === "object" && typeof window.katex.render === "function") {
        window.katex.render(body, container, {
          displayMode: true,
          throwOnError: false,
          strict: "ignore",
          trust: false,
          output: "htmlAndMathml"
        });
      } else {
        container.className += " math-raw";
        container.textContent = `$$\n${body}\n$$`;
      }
      paragraph.replaceWith(container);
    });
  }

  function simplifySourceText(value) {
    return String(value)
      .replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, "$1")
      .replace(/[\s`*_>#|()[\]{}\\$]/g, "")
      .toLowerCase();
  }

  function findSourceLine(element, sourceLines, startLine) {
    const rawText = element.tagName === "TABLE"
      ? Array.from(element.querySelectorAll("th")).map((cell) => cell.textContent).join(" ")
      : element.textContent;
    const target = simplifySourceText(rawText);
    const firstWord = target.slice(0, 22);
    if (!target && startLine < sourceLines.length) return startLine;
    for (let index = Math.max(0, startLine); index < sourceLines.length; index += 1) {
      const candidate = simplifySourceText(sourceLines[index]);
      if ((target.length >= 2 && candidate.includes(target.slice(0, Math.min(42, target.length)))) || (firstWord.length >= 2 && candidate.includes(firstWord))) {
        return index;
      }
    }
    for (let index = 0; index < Math.min(startLine, sourceLines.length); index += 1) {
      const candidate = simplifySourceText(sourceLines[index]);
      if (firstWord.length >= 2 && candidate.includes(firstWord)) return index;
    }
    return Math.min(startLine, Math.max(0, sourceLines.length - 1));
  }

  function attachSourceLinks(root, source) {
    const sourceLines = source.replace(/\r\n?/g, "\n").split("\n");
    const blocks = Array.from(root.children).filter((element) => !element.classList.contains("diagnostic-empty"));
    let searchLine = 0;
    blocks.forEach((element) => {
      let line;
      if (element.classList.contains("math-block-container")) {
        line = sourceLines.findIndex((sourceLine, index) => index >= searchLine && /^(?:\s*(?:\$\$|\\\[|\[)\s*)$/.test(sourceLine));
        if (line < 0) line = findSourceLine(element, sourceLines, searchLine);
      } else {
        line = findSourceLine(element, sourceLines, searchLine);
      }
      element.dataset.sourceLine = String(line + 1);
      element.title = "双击返回原文位置";
      searchLine = Math.min(sourceLines.length - 1, line + 1);
    });
  }

  function jumpToSource(lineNumber) {
    const line = Math.max(1, Number(lineNumber) || 1);
    const lines = sourceInput.value.split("\n");
    const start = lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    const end = start + (lines[line - 1] || "").length;
    sourceInput.focus();
    sourceInput.setSelectionRange(start, end);
    sourceInput.scrollTop = Math.max(0, (line - 1) * 22 - sourceInput.clientHeight * 0.35);
    const gutterButton = lineGutter.querySelector(`[data-line="${line}"]`);
    if (gutterButton) gutterButton.classList.add("jump-highlight");
    window.setTimeout(() => gutterButton?.classList.remove("jump-highlight"), 900);
  }

  function jumpToPreview(lineNumber) {
    const targetLine = Math.max(1, Number(lineNumber) || 1);
    const blocks = Array.from(preview.querySelectorAll("[data-source-line]"));
    if (!blocks.length) return;
    const target = blocks.reduce((best, block) => {
      const distance = Math.abs(Number(block.dataset.sourceLine) - targetLine);
      if (!best || distance < best.distance) return { block, distance };
      return best;
    }, null).block;
    preview.querySelectorAll(".jump-highlight").forEach((block) => block.classList.remove("jump-highlight"));
    target.classList.add("jump-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => target.classList.remove("jump-highlight"), 1200);
  }

  function renderMarkdown(source, sourceForLinks = source) {
    const prepared = protectDisplayMath(source);
    let html;
    const fullRendererAvailable = typeof window.marked?.parse === "function" && typeof window.DOMPurify?.sanitize === "function";
    if (fullRendererAvailable) {
      html = window.marked.parse(prepared.source, { gfm: true, breaks: false, headerIds: false, mangle: false });
      html = window.DOMPurify.sanitize(html, {
        ADD_ATTR: ["target", "rel", "loading"],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|callto|cid|xmpp|attachment):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
      });
    } else {
      html = fallbackMarkdown(prepared.source);
    }
    preview.innerHTML = html || `<div class="diagnostic-empty">左侧还没有内容。</div>`;
    restoreDisplayMath(preview, prepared.blocks);
    renderMath(preview);
    if (window.hljs) preview.querySelectorAll("pre code").forEach((block) => window.hljs.highlightElement(block));
    enhanceLinks(preview);
    attachSourceLinks(preview, sourceForLinks);
    void hydrateWorkspaceImages();
    engineStatus.textContent = fullRendererAvailable ? "GFM · KaTeX · 安全 HTML" : "基础兼容模式";
  }

  function updateLineGutter(value) {
    const lineCount = Math.max(1, value.split("\n").length);
    lineGutter.innerHTML = Array.from({ length: lineCount }, (_, index) => `<button class="line-number" type="button" data-line="${index + 1}" title="跳转到渲染结果">${index + 1}<span>→</span></button>`).join("");
  }

  function updateStats(value) {
    const lines = value ? value.split("\n").length : 0;
    sourceStats.textContent = `${value.length} 字符 · ${lines} 行`;
  }

  function updateDiagnostics(source) {
    const notices = analyzeSource(source);
    diagnosticsList.innerHTML = notices.map((notice) => {
      const symbol = notice.type === "warn" ? "!" : notice.type === "ok" ? "✓" : "i";
      return `<article class="diagnostic-item ${notice.type}"><div class="diag-title"><span class="diag-icon">${symbol}</span>${escapeHtml(notice.title)}</div><p>${escapeHtml(notice.body)}</p></article>`;
    }).join("");
  }

  function update(options = {}) {
    const raw = sourceInput.value;
    const normalized = normalizeAiMarkdown(raw, compatToggle.checked);
    renderMarkdown(normalized, raw);
    updateLineGutter(raw);
    updateStats(raw);
    updateDiagnostics(raw);
    if (options.persist !== false) saveDraftDebounced(raw);
    renderState.innerHTML = '<i class="status-dot"></i>实时渲染';
  }

  async function writeCurrentFile(value, requestPermission = false) {
    if (!currentWorkspace?.handle && !currentWorkspace?.nativePath) return false;
    if (!await workspacePermission(currentWorkspace, true, requestPermission)) return false;
    try {
      const fileName = currentNoteName.endsWith(".md") ? currentNoteName : `${currentNoteName}.md`;
      if (currentWorkspace.nativePath) {
        const response = await nativeRequest("writeFile", { root: currentWorkspace.nativePath, relativePath: fileName, text: value });
        if (!response.ok) return false;
        currentNoteHandle = null;
        return true;
      }
      const handle = currentNoteHandle || await currentWorkspace.handle.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(value);
      await writable.close();
      currentNoteHandle = handle;
      return true;
    } catch (error) {
      return false;
    }
  }

  async function saveCurrentNote(showMessage = false) {
    const value = sourceInput.value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      // The local file remains the source of truth when browser storage is full.
    }
    if (currentWorkspace) {
      const saved = await writeCurrentFile(value, showMessage);
      if (saved) {
        saveState.textContent = "已保存到工作区";
        document.querySelector(".autosave-state").classList.remove("saving");
        if (showMessage) showToast(`已保存到 ${workspaceLabel(currentWorkspace)}/${currentNoteName}`);
      } else if (showMessage) {
        showToast("没有写入权限，请重新选择工作区文件夹");
      }
      return saved;
    }
    saveState.textContent = "已保存";
    document.querySelector(".autosave-state").classList.remove("saving");
    if (showMessage) showToast("草稿已保存到浏览器");
    return true;
  }

  function saveDraftDebounced(value) {
    window.clearTimeout(saveTimer);
    saveState.textContent = "正在保存…";
    document.querySelector(".autosave-state").classList.add("saving");
    saveTimer = window.setTimeout(() => {
      void (async () => {
        try {
          localStorage.setItem(STORAGE_KEY, value);
        } catch (error) {
          saveState.textContent = "浏览器存储空间不足";
        }
        if (currentWorkspace && currentNoteHandle) {
          const saved = await writeCurrentFile(value, false);
          saveState.textContent = saved ? "已自动保存到工作区" : "等待工作区权限";
        } else if (!currentWorkspace) {
          saveState.textContent = "已自动保存";
        }
        document.querySelector(".autosave-state").classList.remove("saving");
      })();
    }, 450);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2300);
  }

  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(message);
    } catch (error) {
      const helper = document.createElement("textarea");
      helper.value = value;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
      showToast(message);
    }
  }

  function downloadFile(filename, content, type) {
    if (hasNativeBridge()) {
      void nativeRequest("saveFile", { filename, content, mimeType: type })
        .then((response) => { if (!response.cancelled) showToast("文件已保存"); })
        .catch(() => showToast("保存文件失败"));
      return;
    }
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function inlineImagesForExport(root) {
    const images = Array.from(root.querySelectorAll("img"));
    for (const image of images) {
      const source = image.getAttribute("src") || "";
      if (!source || source.startsWith("data:")) continue;
      try {
        const response = await fetch(source);
        if (response.ok) image.src = await blobToDataUrl(await response.blob());
      } catch (error) {
        // Keep remote URLs when they cannot be embedded.
      }
    }
    return root;
  }

  async function exportHtml() {
    await hydrateWorkspaceImages();
    const clone = preview.cloneNode(true);
    await inlineImagesForExport(clone);
    const body = clone.innerHTML;
    const documentHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(currentNoteName)} · MarkNote</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css"><style>body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.8 system-ui,sans-serif;color:#1e293b}img{max-width:100%}pre{padding:16px;background:#0f172a;color:#e2e8f0;overflow:auto;border-radius:8px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#eff6ff}.katex-display{overflow:auto}</style></head><body>${body}</body></html>`;
    downloadFile(`${currentNoteName.replace(/[^\w\u4e00-\u9fff-]+/g, "-") || "marknote"}.html`, documentHtml, "text/html;charset=utf-8");
    showToast("HTML 已导出");
  }

  async function exportPdf() {
    await hydrateWorkspaceImages();
    const previousTitle = document.title;
    document.title = `${currentNoteName} · MarkNote`;
    document.body.classList.add("printing");
    showToast("已打开打印窗口，请选择“存储为 PDF”");
    const restorePrintState = () => {
      document.title = previousTitle;
      document.body.classList.remove("printing");
    };
    if (hasNativeBridge()) {
      void nativeRequest("print")
        .catch(() => showToast("无法打开打印窗口"))
        .finally(restorePrintState);
    } else {
      window.setTimeout(() => window.print(), 80);
      window.addEventListener("afterprint", restorePrintState, { once: true });
    }
  }

  async function createNewNote() {
    if (sourceInput.value && !window.confirm("新建笔记会替换当前内容，确定继续吗？")) return;
    if (!currentWorkspace) {
      currentNoteHandle = null;
      currentNoteName = "当前草稿";
      sourceInput.value = "";
      updateWorkspaceIdentity();
      update();
      sourceInput.focus();
      return;
    }
    const suggested = `未命名笔记-${new Date().toISOString().slice(0, 10)}`;
    const requested = window.prompt("新笔记名称（不需要输入 .md）", suggested);
    if (requested === null) return;
    const safeName = requested.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.md$/i, "") || "未命名笔记";
    const fileName = `${safeName}.md`;
    if (!await workspacePermission(currentWorkspace, true, true)) {
      showToast("没有工作区写入权限");
      return;
    }
    try {
      currentNoteHandle = currentWorkspace.nativePath ? null : await currentWorkspace.handle.getFileHandle(fileName, { create: true });
      currentNoteName = fileName;
      sourceInput.value = "";
      localStorage.setItem(SELECTED_NOTE_KEY, fileName);
      await writeCurrentFile("");
      updateWorkspaceIdentity();
      await listWorkspaceNotes();
      update();
      sourceInput.focus();
      showToast(`已创建 ${fileName}`);
    } catch (error) {
      showToast("创建笔记失败，请检查文件夹权限");
    }
  }

  function handleAction(action) {
    if (action === "focus-editor") {
      sourceInput.focus();
      sourceInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (action === "new-note") void createNewNote();
    if (action === "clear-editor") {
      if (!sourceInput.value || window.confirm("确定清空当前内容吗？")) {
        sourceInput.value = "";
        update();
        sourceInput.focus();
      }
    }
    if (action === "load-sample") {
      sourceInput.value = DEFAULT_MARKDOWN;
      update();
      sourceInput.focus();
      showToast("已载入渲染示例");
    }
    if (action === "save-note") void saveCurrentNote(true);
    if (action === "download-md") {
      downloadFile("marknote-note.md", sourceInput.value, "text/markdown;charset=utf-8");
      showToast("Markdown 已导出");
    }
    if (action === "copy-fixed") {
      copyText(normalizeAiMarkdown(sourceInput.value, true), "兼容后的 Markdown 已复制");
    }
    if (action === "export-html") void exportHtml();
    if (action === "export-pdf") void exportPdf();
    if (action === "open-file") fileInput.click();
    if (action === "select-workspace") void selectWorkspace();
    if (action === "paste-image-help") {
      sourceInput.focus();
      showToast("直接把剪贴板中的图片粘贴到左侧；连接工作区后会保存到 assets 文件夹");
    }
    if (action === "toggle-theme") {
      document.body.classList.toggle("light");
      localStorage.setItem(THEME_KEY, document.body.classList.contains("light") ? "light" : "dark");
    }
  }

  function init() {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "light") document.body.classList.add("light");

    const savedDraft = localStorage.getItem(STORAGE_KEY);
    sourceInput.value = savedDraft || DEFAULT_MARKDOWN;

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });

    sourceInput.addEventListener("input", update);
    sourceInput.addEventListener("paste", (event) => { void handleImagePaste(event); });
    sourceInput.addEventListener("scroll", () => { lineGutter.scrollTop = sourceInput.scrollTop; });
    lineGutter.addEventListener("click", (event) => {
      const button = event.target.closest("[data-line]");
      if (button) jumpToPreview(button.dataset.line);
    });
    preview.addEventListener("dblclick", (event) => {
      const block = event.target.closest("[data-source-line]");
      if (block) jumpToSource(block.dataset.sourceLine);
    });
    compatToggle.addEventListener("change", update);
    workspaceSelect.addEventListener("change", () => {
      const record = workspaceRecords.find((item) => item.id === workspaceSelect.value);
      localStorage.setItem(SELECTED_WORKSPACE_KEY, record?.id || "");
      void activateWorkspace(record || null, true);
    });
    notesList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-note-name]");
      if (button) void openWorkspaceNote(button.dataset.noteName);
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      sourceInput.value = await file.text();
      currentWorkspace = null;
      currentNoteHandle = null;
      currentNoteName = file.name;
      updateWorkspaceIdentity();
      renderWorkspaceOptions();
      renderNotes([]);
      update();
      void compactInlineImagesInSource();
      showToast(`已打开 ${file.name}`);
      fileInput.value = "";
    });
    update();
    void compactInlineImagesInSource();
    void initializeWorkspaces();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
