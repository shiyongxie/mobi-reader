# Mobi Reader · 个人 MOBI 在线阅读器（HTML 模式）

纯前端的 MOBI 电子书阅读器：**零构建、零 npm 依赖**，所有代码可直接静态托管
或本地打开运行。支持语音朗读、高亮标注、笔记、目录跳转、阅读进度记忆与
离线使用，数据全部保存在浏览器 IndexedDB 中。

## 一、如何运行

方式一：直接双击 `index.html` 用 Chrome 打开即可（解析模块会自动降级到主线程）。

方式二（推荐，启用 Worker 与 PWA）——用任意静态服务器：

```powershell
# 任选其一，在本目录执行：
python -m http.server 8080
# 或
npx serve .
```

然后访问 <http://localhost:8080>。

> 说明：Chrome 在 `file://` 协议下禁止创建 Web Worker 和注册 Service Worker，
> 项目对此做了自动降级；想体验完整能力请走 http://localhost。

## 二、功能清单（对照验收标准）

| 验收项 | 实现 |
| --- | --- |
| 上传无 DRM MOBI 正确显示文本和图片 | ✅ 解析文本 + 提取内嵌图片（JPEG/PNG/GIF，`recindex` 还原） |
| 点击朗读、速度可调 | ✅ 工具栏「▶ 朗读」从当前视口位置开始；控制条可调语速 0.5–2x |
| 高亮/笔记，刷新后仍在 | ✅ 全部存 IndexedDB，按书籍关联 |
| 重新上传同一文件跳过解析 | ✅ 文件名+大小 哈希为书籍 ID，缓存命中直接加载（含进度提示） |
| 目录跳转、进度保存 | ✅ 目录侧栏点击锚点跳转；滚动比例节流保存、打开时恢复 |
| 移动端可用 | ✅ 工具栏折叠、触摸选择标注、分页按钮均适配 |

附加能力：四种护眼主题（含夜间）、衬线/无衬线切换、滚动/CSS columns 分页双模式、
标注导出/导入 JSON、书架管理（封面/作者/最近阅读时间/删除）、可选 PWA 离线。

## 三、项目结构

```
mobi-reader/
├── index.html              # 单页应用入口（书架 + 阅读器两个视图）
├── styles/
│   ├── main.css            # 壳层样式：书架、工具栏、侧栏、弹窗、Toast、TTS 条
│   └── reader.css          # 阅读区排版、主题、分页模式、高亮 mark 样式
├── js/
│   ├── app.js              # 主入口：书架渲染、导入、拖拽、PWA 注册
│   ├── mobiParser.js       # 解析封装：书籍ID哈希、Worker 调度、缓存优先加载
│   ├── reader.js           # 阅读器核心：渲染/设置/目录/进度/分页
│   ├── tts.js              # 语音朗读：分块预取缓冲、语速声音、同步假加粗高亮
│   ├── annotations.js      # 标注笔记：偏移定位、mark 包裹、列表、导入导出
│   ├── storage.js          # IndexedDB 封装（books / annotations / settings）
│   └── ui.js               # Toast、模态弹窗、面板开关等通用组件
├── worker/
│   └── parseWorker.js      # MOBI 二进制解析（可在 Worker 或主线程降级运行）
├── assets/icon.svg         # 应用图标（也用作书架 logo）
├── scripts/                # 测试脚本（可选，与运行时零依赖）
│   ├── test-parse.mjs          # 构造最小 MOBI 的解析器自测：node scripts/test-parse.mjs
│   ├── verify-real-file.mjs    # 真实 .mobi 全链路验证：node scripts/verify-real-file.mjs [文件]
│   └── e2e-chrome.mjs          # 真实 Chrome(file://) 端到端测试（需临时
│                               #   `npm i --no-save puppeteer-core`，跑完可删 node_modules）
├── manifest.json           # PWA 清单
└── sw.js                   # Service Worker：应用壳缓存，配合 IndexedDB 离线
```

## 四、关键实现说明

### MOBI 解析（worker/parseWorker.js）

自实现的 MOBI6 / PalmDOC 解析器（PDB 记录表 → PalmDOC LZ77 解压 →
MOBI 头/EXTH 元数据 → trailing bytes 剔除 → UTF-8/Latin1 解码 →
按 `<mbp:pagebreak>` 切章 → h1~h4 生成 TOC → 图片记录提取）。

> 为什么不用 CDN 上的 `mobi.js`？该类库没有稳定可靠的浏览器 CDN 构建，
> 而本项目要求"无需构建步骤、直接可运行"，故按 ReadMe 中约定的产物格式
> （title/author/content/toc）在 Worker 内自行实现，无任何外部依赖。

**已支持的输入**：无 DRM 的旧版 MOBI（compression=1），以及一类常见的
转换器产物——头部错误声明 HUFF/CDIC 压缩但实际正文仍是 PalmDOC 的文件
（自动检测压缩表是否存在并降级纠正，实测《乌合之众》cnepub 版即属此类）。
目录生成支持两级策略：优先 h1~h4 标题；没有标题级结构时用内联目录的
`filepos` 链接按字节偏移反推章节归属。

**不支持**：DRM 加密文件、带有效 HUFF 压缩表的真 HUFF/CDIC 文件、
AZW3/KF8 主体（遇到时都会给出明确错误提示而不是静默失败）。

### 存储设计（IndexedDB，库名 `mobi-reader`）

- `books`（keyPath=id）：id=SHA-256(文件名+大小)；值含元数据、各章节 HTML、
  TOC、图片 ArrayBuffer、封面 base64、阅读进度。
- `annotations`（keyPath=id 自增，bookId 索引）：secId + 节内字符偏移定位。
- `settings`（keyPath=key）：阅读偏好与 TTS 偏好键值对。

### 标注定位

每条标注 = 章节 `<section id="sec-N">` + 该章节内的扁平字符偏移区间。
由于高亮包裹使用不改变文本内容的 `<mark>`，重新遍历文本节点得到的坐标系
与原始 HTML 完全一致，因此偏移长期稳定；修改标注时用缓存的原始章节 HTML
整节重建后统一重套所有 mark，避免 unwrapping 的边界问题。

### 朗读缓冲与同步高亮

**分块预取播放**：若逐句创建 utterance，即使提前入队，合成器在每次
utterance 结束时仍有引擎级"换挡"延迟，句间卡顿明显。因此把连续句子
合并为 ~350 字的朗读块整块播报，并维持深度 2 的预取队列 —— 引擎约
每分钟才"换挡"一次，听感近乎连续；块内句间停顿由标点韵律自然产生，
节奏不受影响。跳上一句/下一句、改语速、换声音都会清空队列并从目标句
所在位置重建缓冲（含"块中途切入"的半块处理）。

**双层同步高亮**（不修改 DOM，两套通道自动选择）：

- 首选 **CSS Custom Highlight API**：把句子/词的 Range 注册进
  `CSS.highlights`，浏览器原生渲染。当前句用双层 `text-shadow`
  做加粗观感 —— 刻意不用 `font-weight`，因为真加粗会改变字形前进
  宽度导致阅读区版面随朗读持续跳动；描边只增粗笔画、宽度零变化。
  词层为变色强调；滚动无需任何重绘逻辑。
- 降级通道：`Range.getClientRects()` 矩形贴片覆盖层（背景色高亮），
  兼容不支持 Highlight API 的浏览器。

两者都通过 TreeWalker 建立的「文本节点 ↔ 全局偏移」映射定位，天然
跨节点、跨行，不会破坏标注所依赖的文本结构。

## 五、部署到手机

项目是纯静态文件，任选其一：

**方式一 · 局域网直连（最快，适合随手看）**

1. 电脑与手机连接同一 Wi-Fi；
2. 在项目目录运行：
   ```powershell
   python -m http.server 8080        # 默认监听所有网卡
   ```
3. 放行 Windows 防火墙（管理员 PowerShell，一次性）：
   ```powershell
   netsh advfirewall firewall add rule name="MOBI Reader" dir=in action=allow protocol=TCP localport=8080
   ```
4. 查电脑内网 IP（`ipconfig` 看 IPv4 地址），手机浏览器访问
   `http://192.168.x.x:8080`。

局限：http 下 PWA 的 Service Worker / 安装到主屏不可用（仅 localhost
豁免），IndexedDB 数据存在手机本地。

**方式二 · 静态托管（推荐长期使用）**

把整个目录（保持相对结构）上传到任一免费静态平台：

| 平台 | 方式 |
| --- | --- |
| Cloudflare Pages | 网页拖拽上传目录即可，自带 https + CDN |
| Vercel / Netlify | 同上，网页或 CLI 上传 |
| GitHub Pages | 推送到仓库后在 Settings 开启 Pages |

这些平台自动提供 https，Worker、PWA 离线缓存、"添加到主屏幕"
全部可用，手机和电脑访问同一地址共享同一套代码。

**移动端使用提示**

- 书籍从文件 App 中通过页面「导入」按钮或拖拽区选取 `.mobi/.prc` 文件，
  解析与缓存均在手机本地完成，不上传任何数据；
- iOS Safari：词级 `onboundary` 可能不触发，自动降级为整句假加粗高亮，
  功能不受影响；Android Chrome：全部能力可用；
- 阅读进度、标注、设置按浏览器存储隔离 —— 换设备时用「标注导出/导入」
  迁移标注。

## 六、已知限制

- HUFF/CDIC 压缩与 DRM 文件不支持（有友好报错）；
- 分页模式下进度按横向翻页比例恢复，切回滚动模式时会近似还原；
- MOBI 内部 `filepos` 式目录跳转链接未做映射（正文中的书内链接不可点），
  但章节级目录功能完整；
- Windows Chrome 对 `speechSynthesis.pause()` 的兼容性一般，个别版本
  暂停恢复可能不如预期，可用停止后再次播放代替。
