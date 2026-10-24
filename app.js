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
  const imageLoads = new WeakMap();
  let imageRenderVersion = 0;
  let defaultWorkspace = null;
  let projectFolder = null;
  let documentVersion = 0;
  let documentDirty = false;
  let saveChain = Promise.resolve();
  let navigationChain = Promise.resolve();
  const workspaceNoteNames = new Map();
  const workspaceReadErrors = new Map();
  const collapsedProjects = new Set(JSON.parse(localStorage.getItem("marknote-collapsed-projects-v1") || "[]"));
  let pdfStyle = localStorage.getItem("marknote-pdf-style-v1") === "simple" ? "simple" : "cool";
  let sourceLineOffsets = [0];

  const LAYOUT_KEY = "marknote-layout-v1";
  const layout = { sidebarWidth: 248, editorShare: 0.455, sidebarCollapsed: false, previewCollapsed: false, diagnosticsCollapsed: false };

  function applyLayout(persist = true) {
    document.body.classList.toggle("sidebar-collapsed", layout.sidebarCollapsed);
    document.body.classList.toggle("preview-collapsed", layout.previewCollapsed);
    document.body.classList.toggle("diagnostics-collapsed", layout.diagnosticsCollapsed);
    const diagnosticsToggle = document.getElementById("diagnosticsToggle");
    diagnosticsToggle.textContent = layout.diagnosticsCollapsed ? "展开诊断 ⌄" : "收起诊断 ⌃";
    diagnosticsToggle.setAttribute("aria-expanded", String(!layout.diagnosticsCollapsed));
    document.documentElement.style.setProperty("--sidebar-width", `${layout.sidebarWidth}px`);
    document.documentElement.style.setProperty("--editor-track", `${layout.editorShare}fr`);
    document.documentElement.style.setProperty("--preview-track", `${1 - layout.editorShare}fr`);
    document.getElementById("sidebarSplitter").setAttribute("aria-valuenow", String(Math.round(layout.sidebarWidth)));
    document.getElementById("previewSplitter").setAttribute("aria-valuenow", String(Math.round(layout.editorShare * 100)));
    if (persist) {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) { /* Layout persistence must not interrupt editing. */ }
    }
  }

  function initializeLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
      if (saved) {
        if (Number.isFinite(saved.sidebarWidth)) layout.sidebarWidth = Math.max(160, Math.min(480, saved.sidebarWidth));
        if (Number.isFinite(saved.editorShare)) layout.editorShare = Math.max(0.15, Math.min(0.85, saved.editorShare));
        layout.sidebarCollapsed = saved.sidebarCollapsed === true;
        layout.previewCollapsed = saved.previewCollapsed === true;
        layout.diagnosticsCollapsed = saved.diagnosticsCollapsed === true;
      }
    } catch (_) { /* Ignore an invalid saved layout. */ }
    applyLayout(false);
    for (const kind of ["sidebar", "preview"]) {
      const splitter = document.getElementById(`${kind}Splitter`);
      let drag = null;
      function adjust(clientX) {
        if (!drag) return;
        if (kind === "sidebar") {
          layout.sidebarWidth = Math.max(160, Math.min(480, window.innerWidth * 0.4, drag.width + clientX - drag.x));
        } else {
          const rect = document.querySelector(".workspace-grid").getBoundingClientRect();
          const available = rect.width - splitter.offsetWidth;
          const minimum = Math.min(220, available * 0.3);
          layout.editorShare = Math.max(minimum / available, Math.min(1 - minimum / available, (clientX - rect.left - splitter.offsetWidth / 2) / available));
        }
        applyLayout(false);
      }
      function finish(event) {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        drag = null;
        document.body.classList.remove("resizing-layout");
        applyLayout();
      }
      splitter.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag = { x: event.clientX, width: document.getElementById("sidebar").getBoundingClientRect().width, id: event.pointerId };
        try { splitter.setPointerCapture(event.pointerId); } catch (_) { /* Synthetic test events have no pointer capture. */ }
        document.body.classList.add("resizing-layout");
      });
      splitter.addEventListener("pointermove", (event) => { if (event.pointerId === drag?.id) adjust(event.clientX); });
      splitter.addEventListener("pointerup", finish);
      splitter.addEventListener("pointercancel", finish);
      splitter.addEventListener("lostpointercapture", finish);
      window.addEventListener("blur", () => finish());
      splitter.addEventListener("dblclick", () => {
        if (kind === "sidebar") layout.sidebarWidth = 248;
        else layout.editorShare = 0.455;
        applyLayout();
      });
      splitter.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (kind === "sidebar") layout.sidebarWidth = event.key === "Home" ? 248 : Math.max(160, Math.min(480, layout.sidebarWidth + direction * 16));
        else layout.editorShare = event.key === "Home" ? 0.455 : Math.max(0.15, Math.min(0.85, layout.editorShare + direction * 0.03));
        applyLayout();
      });
    }
  }

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
      const request = window.indexedDB.open(WORKSPACE_DB, 3);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(WORKSPACE_STORE)) {
          request.result.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE)) {
          request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains("localNotes")) request.result.createObjectStore("localNotes", { keyPath: "id" });
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
      const transaction = db.transaction(WORKSPACE_STORE, "readwrite");
      transaction.objectStore(WORKSPACE_STORE).put(record);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
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
    return record?.kind === "default" ? "独立笔记" : (record?.name || record?.handle?.name || "工程");
  }

  function updateWorkspaceIdentity() {
    breadcrumbWorkspace.textContent = currentWorkspace ? workspaceLabel(currentWorkspace) : "工作区";
    breadcrumbNote.textContent = currentNoteName || "尚未选择笔记";
    workspaceStatusDot.classList.toggle("connected", Boolean(currentWorkspace));
    workspacePath.textContent = currentWorkspace?.nativePath
      || (currentWorkspace?.handle ? "当前文件夹：" + currentWorkspace.handle.name
      : "浏览器草稿；桌面版默认保存至 Documents/MarkNote");
    workspacePath.title = workspacePath.textContent;
  }

  function renderWorkspaceOptions() { renderWorkspaceTree(); }

  function renderNotes(noteNames = [], record = currentWorkspace) {
    if (record) workspaceNoteNames.set(record.id, noteNames);
    renderWorkspaceTree();
  }

  function renderWorkspaceTree() {
    notesList.replaceChildren();
    const records = [defaultWorkspace, ...workspaceRecords.filter((record) => record.kind === "project")].filter(Boolean);
    for (const record of records) {
      const group = document.createElement("section");
      group.className = "workspace-group";
      group.dataset.workspaceId = record.id;
      const heading = document.createElement("div");
      heading.className = "project-heading";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "project-title";
      toggle.dataset.toggleProject = record.id;
      const expanded = !collapsedProjects.has(record.id);
      toggle.textContent = (expanded ? "▾ " : "▸ ") + (record.kind === "default" ? "独立笔记" : "▱ " + record.name);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.title = record.nativePath || record.handle?.name || "浏览器本地存储";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "mini-button project-add";
      add.dataset.createIn = record.id;
      add.textContent = "＋";
      add.setAttribute("aria-label", record.kind === "default" ? "新建独立笔记" : "在工程“" + record.name + "”中新建笔记");
      heading.append(toggle, add);
      group.append(heading);
      const children = document.createElement("div");
      children.className = "project-notes";
      children.hidden = !expanded;
      const names = workspaceNoteNames.get(record.id) || [];
      for (const name of names) {
        const note = document.createElement("button");
        note.type = "button";
        note.className = "note-list-item" + (currentWorkspace?.id === record.id && currentNoteName === name ? " active" : "");
        note.dataset.noteName = name;
        note.dataset.workspaceId = record.id;
        note.textContent = name.replace(/\.md$/i, "");
        note.title = (record.nativePath || record.handle?.name || "浏览器") + "/" + name;
        children.append(note);
      }
      if (!names.length) {
        const hint = document.createElement("div");
        hint.className = "note-list-empty";
        hint.textContent = workspaceReadErrors.get(record.id) || "暂无笔记，点击 ＋ 新建";
        children.append(hint);
      }
      group.append(children);
      notesList.append(group);
    }
  }

  function resolveWorkspace(id) { return workspaceRecords.find((record) => record.id === id) || (defaultWorkspace?.id === id ? defaultWorkspace : null); }

  async function localNoteTransaction(mode, operation) {
    const db = await getWorkspaceDb();
    if (!db) throw new Error("浏览器存储不可用，请使用桌面 App");
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("localNotes", mode);
      let value;
      const request = operation(transaction.objectStore("localNotes"));
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || request.error || new Error("保存失败"));
      transaction.onabort = () => reject(transaction.error || request.error || new Error("保存已中断"));
    });
  }

  function changeNote(record, name, newName = null) {
    return workspaceTransition(async () => {
      if (!record.nativePath && !record.browserLocal) throw new Error("请在桌面 App 中管理本地文件，以便安全移到废纸篓");
      if (newName !== null) {
        newName = newName.trim();
        if (!/\.(md|markdown|txt)$/i.test(newName)) newName += ".md";
        if (/[/\\:\x00-\x1f]/.test(newName) || newName.startsWith(".") || newName.length > 200) throw new Error("请输入有效笔记名称（不能包含路径符号）");
        if (newName === name) return true;
        if ((await getWorkspaceNoteNames(record)).includes(newName)) throw new Error("同名笔记已存在，未覆盖任何文件");
      }
      const active = currentWorkspace?.id === record.id && currentNoteName === name;
      if (record.nativePath) {
        await nativeRequest(newName === null ? "trashNote" : "renameNote", { root: record.nativePath, relativePath: name, newName });
      } else {
        const oldId = record.id + "/" + name;
        const note = await localNoteTransaction("readonly", (store) => store.get(oldId));
        if (!note || note.trashed) throw new Error("笔记不存在");
        await localNoteTransaction("readwrite", (store) => {
          const request = newName === null
            ? store.add({ ...note, id: oldId + "/trash/" + Date.now(), trashed: true })
            : store.add({ ...note, id: record.id + "/" + newName, name: newName });
          request.addEventListener("success", () => store.delete(oldId));
          return request;
        });
      }
      if (active) {
        // Retarget immediately so no queued autosave can recreate the old file.
        setActiveNote(record, newName || "", newName ? sourceInput.value : "");
        if (!newName) sourceInput.readOnly = true;
      }
      const names = await listWorkspaceNotes(record);
      if (active && !newName && names.length) await openNoteDirect(record, names[0]);
      if (active && !newName && !names.length) saveState.textContent = "暂无笔记，点击 ＋ 新建";
      showToast(newName ? "已重命名为：" + newName : record.nativePath ? "笔记已移到废纸篓，可在 Finder 中恢复；图片未删除" : "笔记已归档到浏览器存储，未永久删除");
      return true;
    });
  }

  function initializeNoteMenu() {
    const menu = document.createElement("div");
    menu.className = "note-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "笔记操作");
    menu.hidden = true;
    document.body.append(menu);
    let origin;
    function close() { menu.hidden = true; }
    function ask(record, name, rename) {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", rename ? "重命名笔记" : "移到废纸篓");
      const form = document.createElement("form");
      form.className = "modal-card";
      const heading = document.createElement("h2");
      heading.textContent = rename ? "重命名笔记" : "移到废纸篓？";
      const detail = document.createElement("p");
      detail.textContent = rename ? "仅修改文件名，不改动笔记内容和图片。" : "“" + name + "”将移到废纸篓，可从 Finder 恢复。引用的图片会保留，不会删除工程文件夹。";
      const input = document.createElement("input");
      input.value = name;
      input.required = true;
      input.maxLength = 200;
      input.setAttribute("aria-label", "笔记名称");
      const error = document.createElement("p");
      error.className = "form-error";
      error.setAttribute("role", "alert");
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "ghost-button"; cancel.textContent = "取消";
      const submit = document.createElement("button");
      submit.type = "submit"; submit.className = "primary-button"; submit.textContent = rename ? "保存名称" : "移到废纸篓";
      const dismiss = () => { overlay.remove(); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
      cancel.onclick = dismiss;
      overlay.addEventListener("keydown", (event) => { if (event.key === "Escape" && !submit.disabled) dismiss(); });
      form.append(heading, detail);
      if (rename) form.append(input);
      actions.append(cancel, submit); form.append(error, actions); overlay.append(form); document.body.append(overlay);
      (rename ? input : cancel).focus();
      if (rename) input.setSelectionRange(0, name.lastIndexOf("."));
      form.onsubmit = async (event) => {
        event.preventDefault(); submit.disabled = true; cancel.disabled = true;
        const ok = await changeNote(record, name, rename ? input.value : null);
        if (ok) dismiss();
        else { error.textContent = "操作未完成，请检查名称、保存位置或权限。原笔记未被强制覆盖。"; submit.disabled = false; cancel.disabled = false; }
      };
    }
    function open(button, x, y) {
      close(); origin = button;
      const record = resolveWorkspace(button.dataset.workspaceId), name = button.dataset.noteName;
      menu.replaceChildren();
      const entries = [
        ["在 Finder 中显示", !record.nativePath, () => nativeRequest("revealNote", { root: record.nativePath, relativePath: name }).catch((error) => showToast(error.message))],
        ["重命名…", !record.nativePath && !record.browserLocal, () => ask(record, name, true)],
        [record.browserLocal ? "归档笔记…" : "移到废纸篓…", !record.nativePath && !record.browserLocal, () => ask(record, name, false)]
      ];
      for (const [label, disabled, run] of entries) {
        const item = document.createElement("button"); item.type = "button"; item.setAttribute("role", "menuitem");
        item.textContent = label; item.disabled = disabled;
        item.onclick = () => { close(); run(); }; menu.append(item);
      }
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + "px";
      menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    }
    notesList.addEventListener("contextmenu", (event) => {
      const button = event.target.closest("[data-note-name]");
      if (button) { event.preventDefault(); open(button, event.clientX, event.clientY); }
    });
    notesList.addEventListener("keydown", (event) => {
      const button = event.target.closest("[data-note-name]");
      if (button && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault(); const rect = button.getBoundingClientRect(); open(button, rect.left, rect.bottom);
      }
    });
    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const index = items.indexOf(document.activeElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
      if (event.key === "Escape") { close(); origin?.focus({ preventScroll: true }); }
    });
    document.addEventListener("pointerdown", (event) => { if (!menu.contains(event.target)) close(); });
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
  }

  async function getWorkspaceNoteNames(record, ask = false) {
    if (record.browserLocal) {
      const notes = await localNoteTransaction("readonly", (store) => store.getAll());
      return notes.filter((note) => note.workspaceId === record.id && !note.trashed).map((note) => note.name).sort((a, b) => a.localeCompare(b, "zh-CN"));
    }
    if (record.nativePath) {
      const result = await nativeRequest("listNotes", { root: record.nativePath });
      return result.names || [];
    }
    if (!await workspacePermission(record, false, ask)) throw new Error("请点击工程并授权文件夹读取");
    const names = [];
    for await (const [name, handle] of record.handle.entries()) {
      if (handle.kind === "file" && /\.(md|markdown|txt)$/i.test(name)) names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  async function listWorkspaceNotes(record = currentWorkspace) {
    if (!record) return [];
    try {
      const names = await getWorkspaceNoteNames(record);
      workspaceReadErrors.delete(record.id);
      renderNotes(names, record);
      return names;
    } catch (error) {
      workspaceReadErrors.set(record.id, error.message);
      renderWorkspaceTree();
      return workspaceNoteNames.get(record.id) || [];
    }
  }

  async function writeNoteTo(record, name, value, exclusive = false, handle = null) {
    if (record.browserLocal) {
      const note = { id: record.id + "/" + name, workspaceId: record.id, name, text: value };
      await localNoteTransaction("readwrite", (store) => exclusive ? store.add(note) : store.put(note));
      return null;
    }
    if (!await workspacePermission(record, true, true)) throw new Error("没有文件夹写入权限");
    if (record.nativePath) {
      await nativeRequest(exclusive ? "createNote" : "writeFile", { root: record.nativePath, relativePath: name, text: value });
      return null;
    }
    if (exclusive) {
      try { await record.handle.getFileHandle(name); throw new Error("同名笔记已存在"); }
      catch (error) { if (error.name !== "NotFoundError") throw error; }
    }
    const fileHandle = handle || await record.handle.getFileHandle(name, { create: true });
    const writer = await fileHandle.createWritable();
    await writer.write(value);
    await writer.close();
    return fileHandle;
  }

  function setActiveNote(record, name, text, handle = null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    currentWorkspace = record;
    currentNoteName = name;
    currentNoteHandle = handle;
    documentVersion += 1;
    documentDirty = false;
    sourceInput.readOnly = false;
    sourceInput.value = text;
    localStorage.setItem(SELECTED_WORKSPACE_KEY, record?.id || "");
    localStorage.setItem(SELECTED_NOTE_KEY, name || "");
    localStorage.setItem(STORAGE_KEY, text);
    updateWorkspaceIdentity();
    renderWorkspaceTree();
    update({ persist: false });
    saveState.textContent = record?.browserLocal ? "已保存到浏览器" : "已保存到文件夹";
    document.querySelector(".autosave-state").classList.remove("saving");
  }

  async function flushBeforeNavigation() {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    await saveChain;
    if (!documentDirty) return true;
    const ok = await saveCurrentNote(false);
    if (!ok) showToast("当前笔记保存失败，已保留编辑内容，请先检查保存位置");
    return ok;
  }

  function workspaceTransition(operation) {
    const next = navigationChain.then(async () => {
      if (!await flushBeforeNavigation()) return false;
      return operation();
    });
    navigationChain = next.catch((error) => { showToast(error.message || "操作失败，当前内容已保留"); return false; });
    return navigationChain;
  }

  async function readNote(record, name) {
    if (record.browserLocal) {
      const note = await localNoteTransaction("readonly", (store) => store.get(record.id + "/" + name));
      if (!note) throw new Error("笔记不存在");
      return { text: note.text, handle: null };
    }
    if (record.nativePath) {
      const result = await nativeRequest("readFile", { root: record.nativePath, relativePath: name });
      return { text: result.text || "", handle: null };
    }
    if (!await workspacePermission(record, false, true)) throw new Error("请授予工程文件夹读取权限");
    const handle = await record.handle.getFileHandle(name);
    return { text: await (await handle.getFile()).text(), handle };
  }

  async function openNoteDirect(record, name) {
    const note = await readNote(record, name);
    setActiveNote(record, name, note.text, note.handle);
    collapsedProjects.delete(record.id);
    await listWorkspaceNotes(record);
    void compactInlineImagesInSource();
    return true;
  }

  function openWorkspaceNote(name, record = currentWorkspace) {
    if (!record) return Promise.resolve(false);
    return workspaceTransition(() => openNoteDirect(record, name));
  }

  async function activateWorkspace(record, askPermission = false) {
    if (!record) record = defaultWorkspace;
    if (!record) return false;
    const names = await getWorkspaceNoteNames(record, askPermission);
    renderNotes(names, record);
    const preferred = localStorage.getItem(SELECTED_NOTE_KEY);
    if (names.length) return openNoteDirect(record, names.includes(preferred) ? preferred : names[0]);
    return createNoteDirect(record);
  }

  async function chooseFolder() {
    if (hasNativeBridge()) {
      const result = await nativeRequest("chooseWorkspace");
      if (result.cancelled) return null;
      return { nativePath: result.path, folderName: result.name };
    }
    if (typeof window.showDirectoryPicker === "function") {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      return { handle, folderName: handle.name };
    }
    throw new Error("此浏览器不能选择本地文件夹，请在 MarkNote 桌面 App 中创建工程。独立笔记仍可在浏览器中使用。");
  }

  function openProjectDialog() {
    projectFolder = null;
    document.getElementById("projectForm").reset();
    document.getElementById("projectFolderPath").textContent = "必须选择存储文件夹；工程内的笔记会直接保存在该文件夹。";
    document.getElementById("projectFormError").textContent = "";
    document.getElementById("projectDialog").hidden = false;
    document.getElementById("projectNameInput").focus();
  }

  function closeProjectDialog() {
    document.getElementById("projectDialog").hidden = true;
    document.querySelector('[data-action="new-project"]').focus();
  }

  async function chooseProjectFolder() {
    try {
      const chosen = await chooseFolder();
      if (!chosen) return;
      projectFolder = chosen;
      document.getElementById("projectFolderPath").textContent = chosen.nativePath || chosen.handle.name;
      const name = document.getElementById("projectNameInput");
      if (!name.value.trim()) name.value = chosen.folderName;
      document.getElementById("projectFormError").textContent = "";
    } catch (error) {
      if (error.name !== "AbortError") document.getElementById("projectFormError").textContent = error.message;
    }
  }

  async function registerProject(name, folder) {
    if (!name.trim()) throw new Error("请填写工程名称");
    if (!folder?.nativePath && !folder?.handle) throw new Error("必须为工程选择存储文件夹");
    if (folder.nativePath && workspaceRecords.some((record) => record.nativePath === folder.nativePath)) throw new Error("该文件夹已经在工作区中，请使用已有工程的 ＋ 新建笔记");
    if (folder.handle) {
      for (const record of workspaceRecords) {
        if (record.handle && await record.handle.isSameEntry(folder.handle)) throw new Error("该文件夹已经在工作区中");
      }
    }
    const record = { id: "project-" + Date.now() + "-" + Math.random().toString(16).slice(2), kind: "project", name: name.trim(), ...folder };
    if (!await putWorkspaceRecord(record)) throw new Error("工程信息保存失败，未创建工程");
    workspaceRecords.push(record);
    await listWorkspaceNotes(record);
    return record;
  }

  async function submitProject(event) {
    event.preventDefault();
    const button = document.getElementById("createProjectButton");
    const errorBox = document.getElementById("projectFormError");
    button.disabled = true;
    errorBox.textContent = "";
    try {
      const name = document.getElementById("projectNameInput").value.trim();
      if (!projectFolder) throw new Error("必须先选择工程存储文件夹");
      const ok = await workspaceTransition(async () => {
        const record = await registerProject(name, projectFolder);
        const names = await getWorkspaceNoteNames(record, true);
        if (names.length) await openNoteDirect(record, names[0]);
        else await createNoteDirect(record);
        return true;
      });
      if (ok) { closeProjectDialog(); showToast("工程已创建，笔记将保存到所选文件夹"); }
    } catch (error) { errorBox.textContent = error.message; }
    finally {
      if (!document.getElementById("projectDialog").hidden && !errorBox.textContent) errorBox.textContent = "未创建工程，请检查保存位置或当前笔记的保存状态";
      button.disabled = false;
    }
  }

  async function chooseDefaultFolder() {
    try {
      const folder = await chooseFolder();
      if (!folder) return;
      for (const record of workspaceRecords) {
        const same = folder.nativePath ? record.nativePath === folder.nativePath : record.handle && await record.handle.isSameEntry(folder.handle);
        if (same && record.id === defaultWorkspace?.id) return;
        if (same) throw new Error("该文件夹已经是一个工程，请为独立笔记选择另一个保存位置");
      }
      await workspaceTransition(async () => {
        const record = { id: "default-" + Date.now() + "-" + Math.random().toString(16).slice(2), kind: "default", name: "独立笔记", ...folder };
        if (!await putWorkspaceRecord(record)) throw new Error("默认位置保存失败");
        for (const item of workspaceRecords) {
          if (item.kind === "default") { item.kind = "project"; item.name = item.name || "旧独立笔记"; await putWorkspaceRecord(item); }
        }
        workspaceRecords = workspaceRecords.filter((item) => item.id !== record.id);
        workspaceRecords.push(record);
        defaultWorkspace = record;
        localStorage.setItem("marknote-default-workspace-v2", record.id);
        await activateWorkspace(record, true);
        return true;
      });
    } catch (error) { if (error.name !== "AbortError") showToast(error.message); }
  }

  async function initializeWorkspaces() {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    workspaceRecords = await getWorkspaceRecords();
    const selectedId = localStorage.getItem(SELECTED_WORKSPACE_KEY);
    const defaultId = localStorage.getItem("marknote-default-workspace-v2");
    defaultWorkspace = workspaceRecords.find((record) => record.id === defaultId)
      || workspaceRecords.find((record) => record.kind === "default");
    if (!defaultWorkspace && hasNativeBridge()) {
      const folder = await nativeRequest("defaultWorkspace", { migratePreviousDefault: selectedId === "native-default-markdown" });
      defaultWorkspace = workspaceRecords.find((record) => record.nativePath === folder.path)
        || { id: "native-default-marknote", nativePath: folder.path };
      defaultWorkspace.kind = "default";
      defaultWorkspace.name = "独立笔记";
      if (!workspaceRecords.some((record) => record.id === defaultWorkspace.id)) workspaceRecords.push(defaultWorkspace);
    }
    if (!defaultWorkspace) {
      defaultWorkspace = { id: "browser-default", kind: "default", name: "独立笔记", browserLocal: true };
      workspaceRecords.push(defaultWorkspace);
    }
    defaultWorkspace.kind = "default";
    defaultWorkspace.name = "独立笔记";
    await putWorkspaceRecord(defaultWorkspace);
    localStorage.setItem("marknote-default-workspace-v2", defaultWorkspace.id);
    for (const record of workspaceRecords) {
      if (record.id !== defaultWorkspace.id && !record.kind) {
        record.kind = "project";
        await putWorkspaceRecord(record);
      }
      await listWorkspaceNotes(record);
    }
    // Recover old single-draft versions without overwriting any existing file.
    const legacyDraft = localStorage.getItem(STORAGE_KEY);
    if (!localStorage.getItem("marknote-projects-migrated-v2") && legacyDraft) {
      const record = resolveWorkspace(selectedId) || defaultWorkspace;
      const name = localStorage.getItem(SELECTED_NOTE_KEY);
      const names = workspaceNoteNames.get(record.id) || [];
      let recover = !name || !names.includes(name);
      if (!recover) recover = (await readNote(record, name)).text !== legacyDraft;
      if (recover) {
        const recoveryName = "恢复的草稿-" + Date.now() + ".md";
        await writeNoteTo(record, recoveryName, legacyDraft, true);
        await listWorkspaceNotes(record);
        localStorage.setItem(SELECTED_NOTE_KEY, recoveryName);
      }
    }
    localStorage.setItem("marknote-projects-migrated-v2", "1");
    const selected = resolveWorkspace(selectedId) || defaultWorkspace;
    try { await activateWorkspace(selected, false); }
    catch (error) {
      saveState.textContent = "文件夹不可用，未覆盖原笔记";
      sourceInput.value = legacyDraft || "";
      update({ persist: false });
      showToast(error.message);
    }
    renderWorkspaceTree();
  }

  async function writeBlobToWorkspace(relativePath, blob, record = currentWorkspace) {
    if (!record?.handle) return false;
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    let directory = record.handle;
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

  async function savePastedImage(blob, record = currentWorkspace) {
    const extension = imageExtension(blob.type);
    const base = `pasted-image-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 7)}`;
    const fileName = `${base}.${extension}`;
    if (record && !record.browserLocal && await workspacePermission(record, true, false)) {
      try {
        if (record.nativePath) {
          const response = await nativeRequest("writeAsset", {
            root: record.nativePath,
            relativePath: `assets/${fileName}`,
            dataUrl: await blobToDataUrl(blob)
          });
          if (!response.ok) throw new Error("图片写入失败");
        } else {
          if (!await writeBlobToWorkspace(`assets/${fileName}`, blob, record)) throw new Error("图片目录不可写");
        }
        return { source: `assets/${fileName}`, persistent: true, kind: "workspace" };
      } catch (error) {
        // Fall back to an embedded image if the folder cannot be written.
      }
    }
    const attachmentId = `${base}-${extension}`;
    // Some WKWebView stores reject Blob values; strings are durable there too.
    const dataUrl = await blobToDataUrl(blob);
    const stored = await putAttachment({ id: attachmentId, name: fileName, type: blob.type, dataUrl, createdAt: Date.now() });
    if (stored) return { source: `attachment://${attachmentId}`, persistent: true, kind: "attachment" };
    return { source: dataUrl, persistent: false, kind: "data" };
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
    const original = sourceInput.value;
    const snapshot = noteSnapshot(original);
    const imagePattern = /!\[([^\]]*)\]\((data:image\/[^)]+)\)/gi;
    const matches = Array.from(sourceInput.value.matchAll(imagePattern));
    if (!matches.length) return;
    let compacted = sourceInput.value;
    let changed = false;
    for (const match of matches) {
      const blob = dataUrlToBlob(match[2]);
      if (!blob) continue;
      const saved = await savePastedImage(blob, snapshot.record);
      if (saved.kind === "data") continue;
      compacted = compacted.replace(match[0], `![${match[1]}](${saved.source})`);
      changed = true;
    }
    if (changed && documentVersion === snapshot.version && sourceInput.value === original && compacted !== original) {
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
    return workspaceTransition(async () => {
      const image = await savePastedImage(blob);
      const alt = currentWorkspace ? "粘贴图片" : "内嵌图片";
      insertAtCursor(`![${alt}](${image.source})`);
      update();
      await hydrateWorkspaceImages();
      if (!await flushBeforeNavigation()) return false;
      if (image.kind === "workspace") showToast("图片已保存到工作区的 assets 文件夹");
      else if (image.kind === "attachment") showToast("图片已保存为本地附件，原文只保留简短引用");
      else showToast("图片已以内嵌方式插入；选择工作区可长期保存");
      return true;
    });
  }

  async function getWorkspaceFile(relativePath, record = currentWorkspace) {
    if (!record?.handle) return null;
    const parts = decodeURIComponent(relativePath).replace(/^\.\//, "").split("/").filter(Boolean);
    let directory = record.handle;
    try {
      for (let index = 0; index < parts.length - 1; index += 1) {
        directory = await directory.getDirectoryHandle(parts[index]);
      }
      return await directory.getFileHandle(parts[parts.length - 1]);
    } catch (error) {
      return null;
    }
  }

  async function hydrateWorkspaceImages() {
    const record = currentWorkspace;
    const version = imageRenderVersion;
    const images = Array.from(preview.querySelectorAll("img"));
    await Promise.all(images.map((image) => {
      const pending = imageLoads.get(image);
      if (pending) return pending;
      const source = image.getAttribute("src") || "";
      if (!source || /^(?:https?:|data:|blob:|#)/i.test(source)) return;
      image.dataset.assetSource = source;
      const load = (async () => {
        try {
          let url;
          let blob;
          if (/^attachment:\/\//i.test(source)) {
            const attachment = await getAttachment(source.slice("attachment://".length));
            url = attachment?.dataUrl;
            blob = attachment?.blob;
          } else if (record?.nativePath) {
            const response = await nativeRequest("readAsset", { root: record.nativePath, relativePath: decodeURIComponent(source) });
            url = response.dataUrl;
          } else if (record) {
            const handle = await getWorkspaceFile(source, record);
            if (handle) blob = await handle.getFile();
          }
          // A late result from another document must not touch the new preview.
          if (version !== imageRenderVersion || !preview.contains(image)) return;
          if (!url && blob) {
            url = await blobToDataUrl(blob);
          }
          if (version !== imageRenderVersion || !preview.contains(image)) return;
          if (!url) throw new Error("找不到图片文件，或文件夹尚未授权");
          image.src = url;
          await image.decode();
          image.classList.remove("image-load-error");
          image.removeAttribute("title");
        } catch (error) {
          if (version === imageRenderVersion && preview.contains(image)) {
            image.classList.add("image-load-error");
            image.title = "图片加载失败：" + source + "（" + (error.message || "无法解码") + "）";
            imageLoads.delete(image);
            // Retain the original reference so a later retry can read it again.
            image.setAttribute("src", source);
          }
        }
      })();
      imageLoads.set(image, load);
      return load;
    }));
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
    const lines = source.split("\n");
    const result = [];
    for (let index = 0; index < lines.length; index += 1) {
      const opening = lines[index].match(/^\s{0,3}(`{3,}|~{3,})/);
      if (!opening) { result.push(lines[index]); continue; }
      const block = [lines[index]];
      const close = new RegExp(`^\\s{0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
      while (++index < lines.length) {
        block.push(lines[index]);
        if (close.test(lines[index])) break;
      }
      result.push(`\u0000MARKNOTE_CODE_${blocks.length}\u0000`);
      blocks.push(block.join("\n"));
    }
    const protectedSource = result.join("\n");
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
    const codeSpans = [];
    const inlineMath = [];
    const codeProtected = protectedCode.source.replace(/(`+)[\s\S]*?\1(?!`)/g, (whole) => {
      codeSpans.push(whole);
      return `MARKNOTE-CODESPAN-${codeSpans.length - 1}-END`;
    });
    const displayPattern = /(^|\n)([ \t]*)(\$\$|\\\[)[ \t]*\n([\s\S]*?)\n\2(\$\$|\\\])[ \t]*(?=\n|$)/g;
    let replaced = codeProtected.replace(displayPattern, (whole, prefix, indent, open, body) => {
      const token = `MARKNOTE-DISPLAY-${blocks.length}`;
      blocks.push(repairMathBody(body));
      return `${prefix}\n${indent}${token}\n`;
    });
    // Protect delimiters before Markdown consumes backslashes or underscores.
    replaced = replaced.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^\n$]+?)\$/g, (whole, parens, brackets, dollars, inline, offset, text) => {
      if (whole.startsWith("$") && text[offset - 1] === "\\") return whole;
      inlineMath.push({ body: repairMathBody(parens ?? brackets ?? dollars ?? inline), display: brackets !== undefined || dollars !== undefined });
      return `MARKNOTE-INLINE-${inlineMath.length - 1}-END`;
    });
    replaced = replaced.replace(/MARKNOTE-CODESPAN-(\d+)-END/g, (_, index) => codeSpans[Number(index)]);
    return { source: protectedCode.restore(replaced), blocks, inlineMath };
  }

  function restoreInlineMath(root, formulas) {
    if (!formulas.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest("pre, code, script, style, textarea") && node.textContent.includes("MARKNOTE-INLINE-")) nodes.push(node);
    }
    nodes.forEach((node) => {
      const fragment = document.createDocumentFragment();
      let start = 0;
      for (const match of node.textContent.matchAll(/MARKNOTE-INLINE-(\d+)-END/g)) {
        const formula = formulas[Number(match[1])];
        if (!formula) continue;
        fragment.append(document.createTextNode(node.textContent.slice(start, match.index)));
        const span = document.createElement("span");
        if (window.katex?.render) window.katex.render(formula.body, span, { displayMode: formula.display, throwOnError: false, strict: "ignore", trust: false });
        else span.textContent = `${formula.display ? "$$" : "$"}${formula.body}${formula.display ? "$$" : "$"}`;
        fragment.append(span);
        start = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(node.textContent.slice(start)));
      node.replaceWith(fragment);
    });
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
      if (element.matches("pre") && line > 0 && /^\s*(`{3,}|~{3,})/.test(sourceLines[line - 1])) line -= 1;
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
    sourceInput.focus({ preventScroll: true });
    sourceInput.setSelectionRange(start, end);
    updateLineGutter(sourceInput.value);
    sourceInput.scrollTop = Math.max(0, (sourceLineOffsets[line - 1] || 0) - sourceInput.clientHeight * 0.35);
    lineGutter.scrollTop = sourceInput.scrollTop;
    const gutterButton = lineGutter.querySelector(`[data-line="${line}"]`);
    if (gutterButton) gutterButton.classList.add("jump-highlight");
    window.setTimeout(() => gutterButton?.classList.remove("jump-highlight"), 900);
  }

  function jumpToPreview(lineNumber) {
    if (layout.previewCollapsed) { layout.previewCollapsed = false; applyLayout(); }
    const targetLine = Math.max(1, Number(lineNumber) || 1);
    const blocks = Array.from(preview.querySelectorAll("[data-source-line]"));
    if (!blocks.length) return;
    // A line inside a paragraph/code/table belongs to the preceding block,
    // not whichever next heading happens to be closer.
    const ordered = blocks.sort((a, b) => Number(a.dataset.sourceLine) - Number(b.dataset.sourceLine));
    const target = ordered.filter((block) => Number(block.dataset.sourceLine) <= targetLine).pop() || ordered[0];
    preview.querySelectorAll(".jump-highlight").forEach((block) => block.classList.remove("jump-highlight"));
    target.classList.add("jump-highlight");
    const previewBox = preview.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    preview.scrollTo({ top: Math.max(0, preview.scrollTop + targetBox.top - previewBox.top - Math.min(preview.clientHeight * 0.3, 100)), behavior: window.__MARKNOTE_SELFTEST__ ? "instant" : "smooth" });
    window.setTimeout(() => target.classList.remove("jump-highlight"), 1200);
  }

  function renderMarkdown(source, sourceForLinks = source) {
    imageRenderVersion += 1;
    const prepared = protectDisplayMath(source);
    let html;
    const fullRendererAvailable = typeof window.marked?.parse === "function" && typeof window.DOMPurify?.sanitize === "function";
    if (fullRendererAvailable) {
      html = window.marked.parse(prepared.source, { gfm: true, breaks: false, headerIds: false, mangle: false });
      html = window.DOMPurify.sanitize(html, {
        ADD_ATTR: ["target", "rel", "loading"],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|callto|cid|xmpp|attachment):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
      });
    } else {
      html = fallbackMarkdown(prepared.source);
    }
    preview.innerHTML = html || "";
    restoreDisplayMath(preview, prepared.blocks);
    restoreInlineMath(preview, prepared.inlineMath);
    renderMath(preview);
    if (window.hljs) preview.querySelectorAll("pre code").forEach((block) => window.hljs.highlightElement(block));
    enhanceLinks(preview);
    attachSourceLinks(preview, sourceForLinks);
    void hydrateWorkspaceImages();
    engineStatus.textContent = fullRendererAvailable ? "GFM · KaTeX · 安全 HTML" : "基础兼容模式";
  }

  function updateLineGutter(value) {
    const lines = value.split("\n");
    const style = getComputedStyle(sourceInput);
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, { position: "fixed", left: "-100000px", top: "0", visibility: "hidden", pointerEvents: "none", boxSizing: "border-box", width: sourceInput.clientWidth + "px", paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, tabSize: style.tabSize, whiteSpace: "pre-wrap", overflowWrap: style.overflowWrap, wordBreak: style.wordBreak });
    for (const line of lines) {
      const row = document.createElement("div"); row.textContent = line || "\u200b"; mirror.append(row);
    }
    document.body.append(mirror);
    const heights = [...mirror.children].map((row) => row.getBoundingClientRect().height || parseFloat(style.lineHeight));
    mirror.remove();
    sourceLineOffsets = [];
    let offset = parseFloat(style.paddingTop) || 0;
    heights.forEach((height) => { sourceLineOffsets.push(offset); offset += height; });
    lineGutter.style.paddingTop = style.paddingTop;
    lineGutter.style.paddingBottom = style.paddingBottom;
    lineGutter.innerHTML = lines.map((_, index) => `<button class="line-number" type="button" data-line="${index + 1}" style="height:${heights[index]}px;line-height:${style.lineHeight}" aria-label="第 ${index + 1} 行：定位预览" title="第 ${index + 1} 行：定位渲染结果">${index + 1}<span aria-hidden="true">→</span></button>`).join("");
    lineGutter.scrollTop = sourceInput.scrollTop;
  }

  function jumpCurrentLineToPreview() {
    jumpToPreview(sourceInput.value.slice(0, sourceInput.selectionStart).split("\n").length);
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
    if (options.persist !== false) { documentDirty = true; saveDraftDebounced(raw); }
    renderState.innerHTML = '<i class="status-dot"></i>实时渲染';
  }

  function noteSnapshot(value = sourceInput.value) {
    return { record: currentWorkspace, name: currentNoteName, handle: currentNoteHandle, version: documentVersion, value };
  }

  async function writeCurrentFile(value, requestPermission = false, snapshot = noteSnapshot(value)) {
    if (!snapshot.record || !snapshot.name) return false;
    try {
      const handle = await writeNoteTo(snapshot.record, snapshot.name, value, false, snapshot.handle);
      if (documentVersion === snapshot.version) currentNoteHandle = handle;
      return true;
    } catch (error) {
      if (documentVersion === snapshot.version) {
        saveState.textContent = "保存失败：" + error.message;
        showToast("保存失败，编辑内容仍保留：" + error.message);
      }
      return false;
    }
  }

  async function saveCurrentNote(showMessage = false, snapshot = noteSnapshot()) {
    try { localStorage.setItem(STORAGE_KEY, snapshot.value); } catch (_) {}
    const task = saveChain.then(() => writeCurrentFile(snapshot.value, showMessage, snapshot));
    saveChain = task.catch(() => false);
    const saved = await saveChain;
    if (documentVersion === snapshot.version && sourceInput.value === snapshot.value) {
      if (saved) {
        documentDirty = false;
        saveState.textContent = snapshot.record?.browserLocal ? "已保存到浏览器" : "已保存到文件夹";
      }
      document.querySelector(".autosave-state").classList.remove("saving");
    }
    if (saved) {
      await listWorkspaceNotes(snapshot.record);
      if (showMessage) showToast(snapshot.record.browserLocal ? "笔记已保存到浏览器" : "已保存：" + (snapshot.record.nativePath || snapshot.record.handle.name) + "/" + snapshot.name);
    }
    return saved;
  }

  function saveDraftDebounced(value) {
    window.clearTimeout(saveTimer);
    const snapshot = noteSnapshot(value);
    saveState.textContent = "正在保存…";
    document.querySelector(".autosave-state").classList.add("saving");
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void saveCurrentNote(false, snapshot);
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

  function applyRenderStyle() {
    document.body.classList.toggle("pdf-simple", pdfStyle === "simple");
    document.body.classList.toggle("pdf-cool", pdfStyle === "cool");
    const button = document.getElementById("pdfStyleToggle");
    button.textContent = "风格：" + (pdfStyle === "simple" ? "简明" : "炫酷");
    button.setAttribute("aria-pressed", String(pdfStyle === "simple"));
  }

  async function exportPdf() {
    await hydrateWorkspaceImages();
    await Promise.all(Array.from(preview.querySelectorAll("img"), (image) => image.decode().catch(() => {})));
    if (document.fonts?.ready) await document.fonts.ready;
    const previousTitle = document.title;
    document.title = `${currentNoteName} · MarkNote`;
    applyRenderStyle();
    document.body.classList.add("printing");
    const restorePrintState = () => {
      document.title = previousTitle;
      document.body.classList.remove("printing");
      applyRenderStyle();
    };
    if (hasNativeBridge()) {
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = await nativeRequest("print", { filename: `${currentNoteName.replace(/\.(md|markdown|txt)$/i, "") || "MarkNote"}.pdf` });
        if (result.ok) showToast("PDF 已导出");
      } catch (error) {
        showToast(`PDF 导出失败：${error.message}`);
      } finally {
        restorePrintState();
      }
    } else {
      showToast("已打开打印窗口，请选择“存储为 PDF”");
      window.setTimeout(() => window.print(), 80);
      window.addEventListener("afterprint", restorePrintState, { once: true });
    }
  }

  async function createNoteDirect(record) {
    if (!record) throw new Error("默认位置尚未就绪，请稍后再试");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const names = await getWorkspaceNoteNames(record, true);
      let index = 1;
      let name = "未命名笔记.md";
      while (names.includes(name)) { index += 1; name = "未命名笔记 " + index + ".md"; }
      let handle;
      try { handle = await writeNoteTo(record, name, "", true); }
      catch (error) {
        if ((await getWorkspaceNoteNames(record)).includes(name)) continue;
        throw error;
      }
      setActiveNote(record, name, "", handle);
      collapsedProjects.delete(record.id);
      await listWorkspaceNotes(record);
      sourceInput.focus();
      showToast("已创建空白笔记：" + name);
      return true;
    }
    throw new Error("文件名发生冲突，请重试");
  }

  function createNewNote(record = defaultWorkspace) {
    return workspaceTransition(() => createNoteDirect(record));
  }

  function handleAction(action) {
    if (action === "jump-preview") jumpCurrentLineToPreview();
    if (action === "new-project") openProjectDialog();
    if (action === "choose-project-folder") void chooseProjectFolder();
    if (action === "cancel-project") closeProjectDialog();
    if (action === "choose-default-folder") void chooseDefaultFolder();
    if (action === "toggle-pdf-style") {
      pdfStyle = pdfStyle === "cool" ? "simple" : "cool";
      localStorage.setItem("marknote-pdf-style-v1", pdfStyle);
      applyRenderStyle();
      showToast("预览和 PDF 风格已切换为" + (pdfStyle === "simple" ? "简明" : "炫酷"));
    }
    if (action === "toggle-diagnostics") {
      layout.diagnosticsCollapsed = !layout.diagnosticsCollapsed;
      applyLayout();
    }
    if (action === "toggle-sidebar" || action === "toggle-preview") {
      const key = action === "toggle-sidebar" ? "sidebarCollapsed" : "previewCollapsed";
      layout[key] = !layout[key];
      applyLayout();
      if (layout[key]) document.querySelector(action === "toggle-sidebar" ? ".restore-sidebar" : ".restore-preview").focus();
    }
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
    initializeLayout();
    initializeNoteMenu();
    sourceInput.readOnly = true;
    applyRenderStyle();
    document.getElementById("projectForm").addEventListener("submit", submitProject);
    document.getElementById("projectDialog").addEventListener("keydown", (event) => { if (event.key === "Escape") closeProjectDialog(); });
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "light") document.body.classList.add("light");

    const savedDraft = localStorage.getItem(STORAGE_KEY);
    sourceInput.value = savedDraft || DEFAULT_MARKDOWN;

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });

    sourceInput.addEventListener("input", update);
    sourceInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault(); jumpCurrentLineToPreview();
      }
    });
    let gutterFrame;
    const refreshGutter = () => { cancelAnimationFrame(gutterFrame); gutterFrame = requestAnimationFrame(() => updateLineGutter(sourceInput.value)); };
    if (window.ResizeObserver) new ResizeObserver(refreshGutter).observe(sourceInput);
    window.addEventListener("resize", refreshGutter);
    document.fonts?.ready.then(refreshGutter);
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
    notesList.addEventListener("click", (event) => {
      const add = event.target.closest("[data-create-in]");
      if (add) { void createNewNote(resolveWorkspace(add.dataset.createIn)); return; }
      const toggle = event.target.closest("[data-toggle-project]");
      if (toggle) {
        const id = toggle.dataset.toggleProject;
        if (collapsedProjects.has(id)) collapsedProjects.delete(id);
        else collapsedProjects.add(id);
        localStorage.setItem("marknote-collapsed-projects-v1", JSON.stringify([...collapsedProjects]));
        renderWorkspaceTree();
        if (!collapsedProjects.has(id)) void listWorkspaceNotes(resolveWorkspace(id));
        return;
      }
      const button = event.target.closest("[data-note-name]");
      if (button) void openWorkspaceNote(button.dataset.noteName, resolveWorkspace(button.dataset.workspaceId));
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      await workspaceTransition(async () => {
        const names = await getWorkspaceNoteNames(defaultWorkspace);
        const name = names.includes(file.name) ? "导入-" + Date.now() + "-" + file.name : file.name;
        const handle = await writeNoteTo(defaultWorkspace, name, text, true);
        setActiveNote(defaultWorkspace, name, text, handle);
        await listWorkspaceNotes(defaultWorkspace);
        showToast("已导入为独立笔记：" + name);
      });
      fileInput.value = "";
    });
    update({ persist: false });
    window.marknoteReady = false;
    void initializeWorkspaces().catch((error) => { saveState.textContent = "加载失败，请检查保存位置"; showToast(error.message); }).finally(() => { window.marknoteReady = true; });
    if (window.__MARKNOTE_SELFTEST__) window.marknoteWorkspaceTesting = { handleImagePaste, savePastedImage, hydrateWorkspaceImages, changeNote, createNewNote, registerProject, openWorkspaceNote, flushBeforeNavigation, readNote, getWorkspaceNoteNames, reloadWorkspace: initializeWorkspaces, getStoredProjects: getWorkspaceRecords, testFolder: () => nativeRequest("testWorkspace"), getDefault: () => defaultWorkspace, getCurrent: () => ({ record: currentWorkspace, name: currentNoteName }), whenIdle: () => navigationChain };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
