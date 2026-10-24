// Synthetic syntax fixtures, not live calls to any model vendor.
window.runMarkNoteCompatibilityTests = function () {
  const editor = document.getElementById("sourceInput");
  const preview = document.getElementById("preview");
  const cases = [
    { name: "GFM headings, table, lists and dollar math", source: "# 合并笔记\n\n**重点**与 $a_i^2$\n\n| 输入 | 输出 |\n| --- | --- |\n| 文本 | 结果 |\n\n- 第一项\n- 第二项", expect: { h1: 1, table: 1, ".katex": 1, strong: 1, li: 2 } },
    { name: "Backslash inline math", source: String.raw`行内公式：\(a_i + b_i = c_i\)。`, expect: { ".katex": 1 } },
    { name: "Backslash multiline display math", source: String.raw`\[
\begin{cases}1, & x>0\\0, & x\le 0\end{cases}
\]`, expect: { ".katex-display": 1 } },
    { name: "Backslash single-line display math", source: String.raw`\[\frac{a_i}{b_i}\]`, expect: { ".katex-display": 1 } },
    { name: "Dollar single-line display math", source: String.raw`$$\frac{a_i}{b_i}$$`, expect: { ".katex-display": 1 } },
    { name: "Display math adjacent to prose without blank lines", source: "前面的说明\n$$\na_i = b_i\n$$\n后面的说明", expect: { ".katex-display": 1 } },
    { name: "Bare bracket AI math", source: String.raw`[
P\_{ij}=\begin{cases}1,&i\sim j\\0,&otherwise\end{cases}
]`, expect: { ".katex-display": 1 } },
    { name: "Bare aligned environment", source: String.raw`\begin{aligned}
a &= b+c\\
d &= e+f
\end{aligned}`, expect: { ".katex-display": 1 } },
    { name: "Triple-backtick code keeps math literal", source: '```latex\n\\[x_i^2\\]\n```', expect: { "pre code": 1, ".katex": 0 }, code: "\\[x_i^2\\]" },
    { name: "Four-backtick code keeps bare environments literal", source: '````text\n\\begin{aligned}\na &= b\n\\end{aligned}\n````', expect: { "pre code": 1, ".katex": 0 }, code: "\\begin{aligned}\na &= b\n\\end{aligned}" },
    { name: "Tilde code fence", source: '~~~python\nvalue = "$a_i$"\n~~~', expect: { "pre code": 1, ".katex": 0 }, code: 'value = "$a_i$"' },
    { name: "Browser code syntax highlighting", source: "```python\ndef encode(graph):\n    return graph\n```", expect: { "pre code.hljs": 1, ".hljs-keyword": 2, ".hljs-title": 1 } },
    { name: "Inline code stays literal", source: '输入 `\\(a_i\\)` 和 `$b_i$`。', expect: { code: 2, ".katex": 0 } },
    { name: "Math in table cells", source: String.raw`| 量 | 公式 |
| --- | --- |
| 概率 | $P(A\mid B)$ |`, expect: { table: 1, ".katex": 1 } },
    { name: "Task lists and nested lists", source: "- [x] 已融合\n- [ ] 待编辑\n  - 子项", expect: { 'input[type="checkbox"]': 2, li: 3 } },
    { name: "Embedded pasted image", source: "![测试图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=)", expect: { img: 1 } },
    { name: "Unsafe HTML is removed", source: '<script>window.__unsafeFixture = true</script>\n<img src="x" onerror="window.__unsafeFixture = true">\n[坏链接](javascript:alert(1))', expect: { script: 0, "[onerror]": 0, 'a[href^="javascript:"]': 0 } },
    { name: "Mermaid remains code (diagram rendering not supported)", source: "```mermaid\ngraph LR\nA-->B\n```", expect: { "pre code": 1 }, code: "graph LR\nA-->B" },
  ];
  const mixed = ["GFM headings, table, lists and dollar math", "Backslash inline math", "Backslash multiline display math", "Triple-backtick code keeps math literal", "Math in table cells"].map((name) => cases.find((fixture) => fixture.name === name).source).join("\n\n---\n\n");
  cases.push({ name: "Mixed outputs edited into one document", source: mixed, expect: { table: 2, ".katex": 4, "pre code": 1, hr: 4 } });
  const original = editor.value;
  const reports = cases.map((fixture) => {
    editor.value = fixture.source;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const checks = Object.fromEntries(Object.entries(fixture.expect).map(([selector, count]) => [selector, preview.querySelectorAll(selector).length === count]));
    checks.noMathErrors = !preview.querySelector(".katex-error");
    checks.noInternalMarkers = !/MARKNOTE-(DISPLAY|INLINE|CODE)/.test(preview.textContent);
    checks.sourceUnchanged = editor.value === fixture.source;
    if (fixture.code) checks.codePreserved = preview.querySelector("pre code")?.textContent.trimEnd() === fixture.code;
    return { name: fixture.name, ok: Object.values(checks).every(Boolean), checks };
  });
  editor.value = original;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  return reports;
};

window.runMarkNoteWorkspaceTests = async function () {
  const api = window.marknoteWorkspaceTesting;
  const editor = document.getElementById("sourceInput");
  const preview = document.getElementById("preview");
  const checks = {};
  const edit = (value) => { editor.value = value; editor.dispatchEvent(new Event("input", { bubbles: true })); };
  const blank = () => editor.value === "" && preview.textContent === "" && !preview.children.length;
  const root = api.getDefault();
  try { await api.registerProject("没有路径", null); checks.projectRequiresLocation = false; }
  catch (_) { checks.projectRequiresLocation = true; }
  await api.createNewNote();
  checks.newRootNoteIsBlank = blank() && api.getCurrent().record.id === root.id;
  const firstRoot = api.getCurrent().name;
  edit("# 独立笔记 A\n\n切换工程前必须保存。");
  const folder = await api.testFolder();
  const project = await api.registerProject("自定义工程名", { nativePath: folder.path });
  await api.createNewNote(project);
  const projectNote = api.getCurrent().name;
  checks.projectNoteIsBlank = blank() && api.getCurrent().record.nativePath === folder.path;
  checks.pendingRootEditSaved = (await api.readNote(root, firstRoot)).text === "# 独立笔记 A\n\n切换工程前必须保存。";
  edit("# 工程笔记 A\n\n只属于工程文件夹。");
  document.querySelector('[data-action="new-note"]').click();
  await api.whenIdle();
  checks.rootButtonNeverCreatesInsideProject = blank() && api.getCurrent().record.id === root.id;
  checks.projectEditSavedBeforeNavigation = (await api.readNote(project, projectNote)).text === "# 工程笔记 A\n\n只属于工程文件夹。";
  checks.noSameNameCrossFolderOverwrite = (await api.readNote(root, firstRoot)).text.startsWith("# 独立笔记 A");
  const rootNames = await api.getWorkspaceNoteNames(root);
  checks.uniqueNamesDoNotOverwrite = new Set(rootNames).size === rootNames.length && rootNames.includes(firstRoot) && rootNames.length >= 3;
  await api.openWorkspaceNote(projectNote, project);
  checks.reopenCorrectProjectNote = editor.value === "# 工程笔记 A\n\n只属于工程文件夹。";
  const group = document.querySelector('[data-workspace-id="' + project.id + '"]');
  checks.twoLevelTree = !!group?.querySelector('.project-notes [data-note-name="' + projectNote + '"]') && group.querySelector('.project-title').textContent.includes("自定义工程名");
  checks.projectMetadataDurable = (await api.getStoredProjects()).some((item) => item.id === project.id && item.name === "自定义工程名" && item.nativePath === folder.path);
  const before = api.getCurrent();
  const missing = { id: "missing-test", kind: "project", name: "无效路径", nativePath: folder.path + "/missing/folder" };
  await api.createNewNote(missing);
  checks.failedCreationKeepsCurrentDocument = api.getCurrent().name === before.name && api.getCurrent().record.id === before.record.id && editor.value.startsWith("# 工程笔记 A");
  try { await api.registerProject("重复文件夹", { nativePath: folder.path }); checks.duplicateProjectFolderRejected = false; }
  catch (_) { checks.duplicateProjectFolderRejected = true; }
  await Promise.all([api.createNewNote(root), api.createNewNote(root)]);
  const afterRapid = await api.getWorkspaceNoteNames(root);
  checks.rapidNewNotesSerialized = blank() && afterRapid.length === rootNames.length + 2;
  const lastRoot = api.getCurrent().name;
  const local = { id: "browser-local-test", kind: "default", name: "浏览器本地测试", browserLocal: true };
  await api.createNewNote(local);
  checks.browserNewNoteIsBlank = blank();
  const localName = api.getCurrent().name;
  edit("浏览器独立笔记也要独立保存");
  await api.openWorkspaceNote(lastRoot, root);
  checks.browserStoragePreservesNotes = (await api.readNote(local, localName)).text === "浏览器独立笔记也要独立保存" && blank();
  await api.reloadWorkspace();
  checks.reloadRestoresSelectionAndTree = api.getCurrent().record.id === root.id && api.getCurrent().name === lastRoot && !!document.querySelector('[data-workspace-id="' + project.id + '"] .project-title') && (await api.getWorkspaceNoteNames(root)).length === afterRapid.length;
  await api.openWorkspaceNote(projectNote, project);
  edit("# 重命名前待保存的内容\n\n![图片](assets/test.png)");
  checks.renameActive = await api.changeNote(project, projectNote, "重命名测试.md") && api.getCurrent().name === "重命名测试.md";
  checks.renameFlushesPendingEdits = (await api.readNote(project, "重命名测试.md")).text.includes("重命名前待保存") && !(await api.getWorkspaceNoteNames(project)).includes(projectNote);
  await api.createNewNote(project);
  const other = api.getCurrent().name;
  checks.renameCollisionSafe = !await api.changeNote(project, "重命名测试.md", other) && (await api.readNote(project, "重命名测试.md")).text.includes("重命名前待保存");
  checks.rejectPathTraversal = !await api.changeNote(project, other, "../escaped.md");
  await api.openWorkspaceNote("重命名测试.md", project);
  edit("# 移除前也应保存");
  checks.trashActive = await api.changeNote(project, "重命名测试.md") && api.getCurrent().name === other;
  await api.flushBeforeNavigation();
  checks.noDeletedFileResurrection = !(await api.getWorkspaceNoteNames(project)).includes("重命名测试.md");
  checks.deleteLastNoteClearsEditor = await api.changeNote(project, other) && blank() && editor.readOnly && api.getCurrent().name === "";
  await api.openWorkspaceNote(lastRoot, root);
  checks.browserRename = await api.changeNote(local, localName, "浏览器重命名.md") && (await api.readNote(local, "浏览器重命名.md")).text.includes("独立笔记");
  checks.browserArchive = await api.changeNote(local, "浏览器重命名.md") && !(await api.getWorkspaceNoteNames(local)).length;
  const menuNote = document.querySelector('.note-list-item');
  menuNote.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 150 }));
  const menu = document.querySelector('.note-context-menu');
  checks.rightClickMenu = !menu.hidden && menu.querySelectorAll('[role="menuitem"]').length === 3;
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  checks.escapeClosesMenu = menu.hidden;
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
  canvas.getContext('2d').fillRect(0, 0, 32, 24);
  const imageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const image = await api.savePastedImage(imageBlob);
  edit('![本地图片测试](' + image.source + ')');
  checks.relativeImageSourceSurvivesSanitizer = preview.querySelector('img').getAttribute('src') === image.source;
  await api.hydrateWorkspaceImages();
  const renderedImage = preview.querySelector('img');
  try { await renderedImage.decode(); checks.savedPNGLoads = renderedImage.naturalWidth === 32; }
  catch (_) { checks.savedPNGLoads = false; }
  await api.hydrateWorkspaceImages();
  try { await renderedImage.decode(); checks.rehydrateKeepsImage = renderedImage.naturalWidth === 32; }
  catch (_) { checks.rehydrateKeepsImage = false; }
  edit('![上一轮图片](' + image.source + ')');
  // Re-render while the previous native file read is still pending.
  edit('![第一张](' + image.source + ')\n\n![第二张](' + image.source + ')\n\n后续编辑');
  await Promise.all([api.hydrateWorkspaceImages(), api.hydrateWorkspaceImages()]);
  const twoImages = [...preview.querySelectorAll('img')];
  checks.multipleImagesSurviveEditing = twoImages.length === 2 && twoImages.every(img => img.naturalWidth === 32);
  await api.openWorkspaceNote(firstRoot, root);
  await api.openWorkspaceNote(lastRoot, root);
  await api.hydrateWorkspaceImages();
  checks.imagesReopenFromDisk = [...preview.querySelectorAll('img')].length === 2 && [...preview.querySelectorAll('img')].every(img => img.naturalWidth === 32);
  edit('[危险](javascript:alert(1))\n\n![危险图片](javascript:alert(1))\n\n![本地图片](' + image.source + ')');
  checks.unsafeImageURLsStillBlocked = !preview.querySelector('[src^="javascript:"], [href^="javascript:"]') && !!preview.querySelector('img[src^="assets/"]');
  await api.hydrateWorkspaceImages();
  await api.createNewNote(local);
  const attachment = await api.savePastedImage(imageBlob);
  edit('![本地附件](' + attachment.source + ')');
  await api.hydrateWorkspaceImages();
  checks.browserAttachmentLoads = attachment.kind === 'attachment' && preview.querySelector('img').naturalWidth === 32;
  await api.hydrateWorkspaceImages();
  checks.browserAttachmentSurvivesRehydrate = preview.querySelector('img').naturalWidth === 32;
  await api.openWorkspaceNote(lastRoot, root);
  await api.createNewNote(root);
  const pasteNote = api.getCurrent().name;
  let pastePrevented = false;
  const pasting = api.handleImagePaste({ clipboardData: {items: [{type: 'image/png', getAsFile: () => imageBlob}]}, preventDefault: () => { pastePrevented = true; } });
  const switching = api.openWorkspaceNote(firstRoot, root);
  await Promise.all([pasting, switching]);
  checks.pasteIsSavedBeforeSwitch = pastePrevented && (await api.readNote(root, pasteNote)).text.includes('assets/pasted-image-') && !(await api.readNote(root, firstRoot)).text.includes('assets/pasted-image-');
  await api.openWorkspaceNote(pasteNote, root);
  await api.hydrateWorkspaceImages();
  checks.pastedImageReopens = preview.querySelector('img')?.naturalWidth === 32;
  return { checks, root: root.nativePath, project: folder.path, ok: Object.values(checks).every(Boolean) };
};
