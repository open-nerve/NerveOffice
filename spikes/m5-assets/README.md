# M5 图片路径前置探针

这是 DEF-004 的表格部分诊断工程，不进入生产构建。使用工作区 `apps/web` 的精确 Univer 1.0.1，原生 Chrome/Safari 的系统剪贴板与 Finder 操作才可用于真实路径结论。默认 SDK 与诊断 IO 两种模式使用相同核心、公式、数字格式、绘图插件；不加载平台入口守卫。它不是生产编辑器的完整注册表。

样本为本任务自制的 160×96 几何图片，PNG/JPEG/WebP 及两帧 GIF；`fixtures/manifest.json` 保存摘要，`generate-fixtures.py` 是来源。不要把用户原剪贴板或业务文档用于这个探针。原生页必须先准备受控样本，再点击开始记录；程序不会在启动时读取剪贴板。

## 运行

在 P1 worktree，使用项目规定的 Node/pnpm：

```sh
node --test spikes/m5-assets/record.test.ts
M5_PROBE_OUTPUT=<本轮绝对路径>/builds pnpm exec vite build --config spikes/m5-assets/vite.config.ts
node spikes/m5-assets/server.ts --build <构建输出的绝对路径> --output <新的原件目录> --port 0
node spikes/m5-assets/calibrate.ts --origin http://127.0.0.1:<分配端口> --output <新的校准目录>
```

服务器只监听 127.0.0.1，使用现有产品 CSP/安全头。`/probe-images` 保存本次受控测试字节，最多 5 MiB/个、32 MiB/次运行，**不是生产图片处理服务**；不接生产用户、凭据或数据库，不解码或重编码。端口会影响 Safari 的权限状态，每轮都要登记。专用 Cookie 只用于验证同源读取携带 Cookie，原件只保存有无该 Cookie，不输出值。

每份构建含源码、锁文件、SDK 包摘要的 `build-identity.json`，使用摘要目录。改源码后必须重新构建并用新运行目录；不覆盖失败原件。自动校准在 Chromium、Chrome、Playwright WebKit 分别验证事件、字节摘要、实际 drawing 插入、drop 开关和 CSP；这些结果标为 synthetic，Playwright WebKit 不等于真实 Safari。

## 原生运行

页面参数例：`/?run=native-chrome-01&case=web-png&mode=default&method=native-ui`。另一种 `mode=diagnostic` 使用同源临时图片 IO。`role=receiver` 只保留接收区；`drop=1` 开启诊断拖放，`copy=1` 开启 SDK 复制后 350ms 的实验补救。所有开关显示在页头，默认模式不可启用。

图库的“插入”按钮只准备已知表格图片，直接调用 facade 插入，不可用其成功证明 SDK 文件选择/粘贴格式支持。网页图片应使用浏览器原生“复制图片”；文件复制和拖放使用 Finder；粘贴使用系统快捷键或原生/SDK 右键菜单，分别标记。HTML 受控表格不是 Excel；缺少 Excel 时必须记录环境缺口。

浮动图片复制要等 SDK 的延迟写入之后，在另一页接收区实际粘贴。诊断的延迟补救和显式按钮是两个实验：Clipboard API 返回成功不能替代后续粘贴证据。SDK 快捷键可直接调用 Clipboard API，不保证产生 DOM copy；探针同时观察画布的复制按键与 copy 事件，并去重定时。350ms 是观察原 SDK 200ms 行为的实验定时，不是生产方案。右键异步粘贴也可能没有 DOM paste，须凭 UI 动作、系统粘贴提示和前后状态记录，不能伪造输入事件或通过事件资格函数替它背书。

`records.ndjson` 为追加原件，捕获时先发送事件，摘要异步另发 `file-digests`（关联 `inputSequence`），默认行为结束后另发 `event-settled`。页面跳转导致摘要来不及写入时保留这一缺口，不能臆测文件内容。事件序号与页面身份一起唯一；`state` 中包含 drawing 来源与样本单元格。

原生动作回执按 `src/record.ts` 的 `NativeActionReceipt` 保存，引用 CUA 动作原件、受控来源、开始/结束时间和确切输入序号。`nativeEvidenceOf` 只校准原生证据资格，不判功能是否成功，也不代替核对被引用的原件。Safari 开始前按 CLAUDE.md 核对屏幕解锁和至少 120 秒用户空闲，真实动作经电脑操作工具完成。

当前计划与最终原件路径见 `docs/v0.1/M5-表格能力与资源/plans/P1-S1-真实图片路径前置复核.md`。本轮原件根为主目录 `.codex/handoffs/m5-p1-20261018/s1/`；真实矩阵在当前 Phase 的 `reviews/`，没有矩阵之前不得声称 DEF-004 通过。
