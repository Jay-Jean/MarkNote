# MarkNote

MarkNote 是一个面向 GPT、Claude 等大模型输出的 Markdown 笔记工作台。它把常被分散处理的几件事放到同一条渲染链中：

- CommonMark / GFM Markdown
- GFM 表格
- KaTeX 行内与块级公式
- 代码块高亮
- 图片、链接和安全 HTML
- 面向模型常见格式偏差的兼容修复与诊断
- 图片剪贴板粘贴与工作区 `assets/` 素材目录
- 无工作区时的本地附件库，避免把 Base64 长串写进原文
- 原文行号 ↔ 预览块双向定位
- HTML 导出与系统打印/PDF 导出

## 运行

双击 `MarkNote.app` 即可运行独立版，不需要启动 Codex、Python 或浏览器。Markdown、公式、代码高亮和图标都已经放进应用包，正常使用时不依赖网络。应用使用 macOS 自带的 WebKit，当前 ZIP 约 4 MB，并同时包含 Apple Silicon 和 Intel 版本。

如果需要调试网页版本，也可以双击 `MarkNote.command`，或者直接打开 `index.html`。网页版本联网时会加载 `marked`、`DOMPurify`、`KaTeX` 和 `highlight.js`；当前项目也已保留本地 `vendor/` 依赖。

也可以在当前目录启动一个静态文件服务后访问 `index.html`。

## 本地工作区

点击左侧“选择或创建本地文件夹”，选择一个主题对应的文件夹。之后：

- 文件夹里的 `.md`、`.markdown` 和 `.txt` 文件会显示在笔记列表中。
- 新建笔记会写入当前文件夹，内容自动保存为 Markdown 文件。
- 直接粘贴图片会保存到当前文件夹的 `assets/` 子目录，并自动插入相对路径。
- 没有选择工作区时，草稿保存在浏览器本地；图片会以内嵌 Data URL 保存。

浏览器不会把完整的本地路径暴露给网页，所以侧栏显示的是文件夹名称；实际笔记文件仍然写入你选择的文件夹。

如果没有选择工作区，粘贴的图片会保存在浏览器的本地附件库中，原文只保留类似 `attachment://pasted-image-...` 的短引用；已有的 Base64 图片也会尝试自动压缩成这种引用。

## 双向定位与 PDF

预览区域中的标题、段落、表格、代码块和公式都带有对应的原文行号：

- 双击预览块，编辑器会选中并滚动到对应原文。
- 鼠标移到编辑器左侧行号，点击出现的 `→`，预览会滚动到对应内容。
- 点击“导出 PDF”会打开系统打印窗口，在其中选择“存储为 PDF”。这样可以保留浏览器的 KaTeX 公式排版和图片。

## 分享给别人

最方便的方式是把整个项目文件夹上传到 GitHub，而不是只上传 `index.html`。建议保留以下结构：

```text
MarkNote/
├── index.html
├── app.js
├── styles.css
├── vendor/
├── native/
├── scripts/
├── MarkNote.app/
└── README.md
```

有两种分享方式：

1. **分享网页版本**：在 GitHub 仓库的 Settings → Pages 中选择从 `main` 分支的根目录发布。之后把 GitHub Pages 地址发给别人即可。网页版本支持 Markdown、公式、图片粘贴和 PDF 打印；本地工作区需要使用支持文件夹访问的 Chrome 或 Edge。
2. **分享 macOS 版本**：运行 `scripts/build_macos_app.sh`，得到 `dist/MarkNote-macOS-standalone.zip`。这个 ZIP 里是完整的独立 `.app`，接收者解压后直接双击即可，不需要保持旁边有网页文件，也不需要安装 Python。由于应用目前没有 Apple 开发者签名，macOS 第一次可能需要右键应用并选择“打开”。

GitHub 网页登录状态不会自动把项目上传到 GitHub；需要先新建一个仓库，再上传整个文件夹，或者在本地使用 Git 提交并推送。公开分享前，请确认工作区笔记、图片附件和个人信息没有放在项目目录中。

## 为什么很多笔记软件显示不对

Markdown 本身并没有统一规定数学公式语法。AI 聊天界面通常实际使用的是：

```text
Markdown / GFM → 数学公式扩展（KaTeX 或 MathJax）→ 代码高亮 → 安全过滤 → 富文本展示
```

而不少笔记软件只实现了其中的 Markdown 部分，或者只支持某一种公式定界符。

例如下面这段看起来像公式，但对 Markdown 和 KaTeX 来说，单独的方括号不是公式定界符：

```text
[
P_{ij} =
\begin{cases}
1, & i \sim j\\
0, & \text{otherwise}
\end{cases}
]
```

更稳妥的写法是：

```text
$$
P_{ij} =
\begin{cases}
1, & i \sim j\\
0, & \text{otherwise}
\end{cases}
$$
```

另外，表格的每一个单元格都必须用 `|` 分隔。如果第一行标题被复制成一个长单元格，渲染器通常只能忠实地显示为一格，无法猜出原本想要的列名。

## 设计原则

MarkNote 不把“粘贴后看起来不对”简单归因于用户操作，而是把问题拆成两层：

1. 尽可能兼容模型常见的 Markdown / LaTeX 写法。
2. 对不能安全猜测的内容给出可读的诊断，告诉用户需要补什么定界符或竖线。

草稿默认保存在浏览器的 `localStorage`，不会自动上传内容。
