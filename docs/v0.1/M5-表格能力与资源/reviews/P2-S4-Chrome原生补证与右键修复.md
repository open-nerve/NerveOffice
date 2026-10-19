# P2-S4 Chrome 原生补证与右键修复

2026-10-19。基线 `ed3f82fb`，仍在同一 P2 分支；主目录 main 保持不动。本次落实“先验证正式宿主，再补 Finder”的接续要求。**Chrome 正式宿主的 PNG 按键输入、Finder 拖入、复制到第二文档和外部接收方、右键成功/拒绝/重试已有有效证据。S4/P2 未完成，生产图片入口仍关闭。**

## 原件与来源

以下 `B4` 指主目录 `.codex/handoffs/m5-p2-20261019/s4/`。新增 `native-actions02` 保存修复前的原生动作，`native-actions03` 保存修复后的右键验证；不覆盖 `native-actions01`。

`native-actions02/build-before-context-fix/` 冻结原测试构建、锁文件与补丁清单，240 份构建文件逐一等于 `native-ready-manifest01`。新构建身份见 `native-actions03/build-identity.json`；测试页面显式导航到 native03，编辑器记录 pageId 为 `29a376c4-7175-43fa-8316-8df7550adb1c`。默认 SDK/外部接收页仍使用独立冻结的 `cb48da3cde49…` 构建。

来源仅为自制 `spikes/m5-assets/fixtures/sample.png`：1145 字节、160×96，SHA-256 `c38d9b030b0952e4446cdde399d6cd1f764d525bcd278987efa77b442c8081b2`。浏览器复制和平台上传会重编码，不能要求压缩字节相等；P1 资源契约本来就会剥离元数据并重编码。逐像素 RGBA SHA-256 为 `4b022ca33be513bc0a2aea58423874b37a938ed8205497058fb075e911a81658`，比较没有容差。首次误要求字节相等的辅助检查失败原件保留，修正见 `host-keyboard-verification02.json`，没有修改产品转换器。

## Chrome 正式宿主结果

| 路径 | 实际输入和保存结果 | 原件 |
|---|---|---|
| 网页原生“复制图片”→ 宿主 ⌘V | 可信 paste，PNG 1590 字节，摘要 `09262bc67ecb8d2b…`；插入 A1，保存为规范资源地址，尺寸与全部像素相等 | native02 `host-keyboard-record.json`、`host-keyboard-verification02.json` |
| 选中 A1 浮图 → ⌘C → 外部接收区 ⌘V | 选中 ID `34d0425b-0eaf-4c23-9d22-3b7dba25a231`；可信接收事件，实际 DOM 图片 1824 字节、摘要 `f3ecd781ca7456f2…`；与选中资源逐像素相等 | native02 `host-copy-selection.json`、`external-receiver-dom.json`、`external-copy-verification.json` |
| 同一选中图 → 第二份文档 C2 | 可信 paste 的文件摘要与外部接收相同；保存后只有新增的一张规范资源图片，位置、尺寸和像素与记录一致 | native02 `second-document-record.json`、`saved-paths-verification.json` |
| Finder → 宿主 G15 | 工具的三次跨窗口尝试均未送达，不算产品失败。用户按明确指示手工拖入唯一 `sample.png`；13:19:51.281Z、13:20:04.751Z 收到两次可信 drop，均为原文件摘要，同步 defaultPrevented=true；图片由 2 张变为 4 张，两张落于 G15，保存像素通过 | native02 `finder-manual-drop-record02.json`、`finder-source-identity.json`、`saved-paths-verification.json` |

手工窗口收到的是两次 drop，不能写成“一次手势只插入一张”的证明。原页面身份、地址和测试标签保持；图片保存为平台资源，不能将 `complete:true` 当作功能成功。该字段只表示记录器没有已知待处理或丢失项。

本轮没有运行 Safari；既有 Safari 失效轮次未重新纳入。Chrome Finder 的 PNG 宿主结果不替代两浏览器默认/宿主完整矩阵，也不证明所有格式或拒绝分支。

## 真实右键缺陷与修复

修复前，D10 的 SDK 右键粘贴在拒绝读取后没有显示本次失败，产生未处理的 NotAllowedError；获准并重新复制受控 PNG 后仍未插图。同一来源随后用 ⌘V 可以插入，排除了图片内容或上传服务不工作。原件为 native02 `host-context-denied-record02.json`、`host-context-approved-record.json`、`host-approved-keyboard-control-record.json`。

固定 SDK 的 DesktopContextMenu 先 executeCommand、后 layout.focus。菜单按钮位于编辑器容器外，平台 gridFocused 正确拒绝，命令因而落到原 SDK。只测直接 executeCommand 的旧回归未经过这个焦点时序。

按已有 [ADR-022](../../../adr/ADR-022-图片实例与SDK修复.md) 的依赖修复流程新增 `@univerjs/ui@1.0.1` 最小 ES 补丁：先同步恢复该菜单 scope 的编辑器焦点，再执行同一命令，顺序与原移动菜单一致。参数、scope、焦点保护、权限和异步目标取消均保持；没有全局放宽对外部按钮的接管，也没有改 SDK 版本或持久化格式。pnpm patch 编辑目录在 B4，原件/ES/CJS/patch 摘要及锁文件齐全；CJS 未修改、不声称支持。

真实菜单 E2E 先在 `context-menu-red01` 失败：宿主拒绝提示不存在且抛出 NotAllowedError。修复后的 `green01` 通过拒绝和图片重试，但在原本 await 命令 Promise 的断言位置过早读取表格；改成等同一个 B12 文本实际出现，不变更期望。`context-menu-green02` 三浏览器 3 项全部通过、无跳过/重试。

native03 再使用原生复制图片和实际菜单点击：F8 成功插入，拒绝此测试地址的读取后 F13 显示“浏览器未允许访问剪贴板”，恢复本轮已授权的同地址权限并重新复制 PNG 后，F13 重试成功。三个状态的图片数为 5/5/6、changeSeq 为 1/1/2；拒绝前后的图片和单元格正文相等。`saved-pixels-verification.json` 核对修订 7、6 张保存图片、模型位置和所有像素一致。右键走 Clipboard.read，不产生 DOM paste 事件；此段依赖原生 UI 回执、权限状态、实际结果和保存内容，没有虚构 isTrusted 事件。

## 审查、回归与清理

同模型独立代码审查未发现 Critical/Important/Minor；核对了同步焦点恢复、菜单关闭、scope、异步取消、真实反例以及补丁/锁文件/安装后摘要。随后独立复核 native02/native03 的实际 UI 回执、文件来源、保存正文、逐像素输出与构建身份，确认可以单独关闭 Chrome 右键前置项；两处历史状态混入当前交接的 Minor 已修正并复核关闭。证据报告为 native03 `native-review.md`，当前未关闭 C/I/M 均为 0。

`context-menu-regression01` 三浏览器图片、普通粘贴、图片来源、只读与快捷键故事共 234 项通过（每个浏览器 78 项），0 失败、0 跳过、0 flaky，耗时 33.1 分钟。随后快速门禁的 lint/类型通过，单元为 10,770 通过、1 失败，因此构建/产物检查未执行。该失败来自本轮辅助脚本向每一步都传入 `PLAYWRIGHT_JSON_OUTPUT_FILE`：CI 配置自检的 JSON 被写进报告文件，stdout 只剩“Listing tests”，JSON 解析失败。`context-menu-final01` 保留相同环境变量的反例及移除后同一 10 项自检全过的对照；仅修正外部辅助脚本的传参范围，未改项目代码或测试断言。

`context-menu-final01` 的 `pnpm verify --fast`、`pnpm build`、`pnpm gate deps licenses artifacts budgets` 最终均退出 0。全仓 lint/类型、538 文件 10,771 项单元和静态门禁通过；依赖、许可、产物与预算全部通过。`final-audit.json` 复核了浏览器报告及退出状态，回归开始时记录的 4,323 份仓库文件只有文档有变化；native03 的 240 份测试构建文件保持原摘要，9 份已安装 ES、未改 CJS 与 patch 摘要匹配。测试及生产构建都采用 ui ES，未引入 Univer CJS，公式 Worker 无 ui/其他 Univer UI 模块，生产构建没有原生记录器或 editor/testing 模块。

最终同模型只读复核为 `context-menu-final01/final-review.md`：独立重算 234 项单次通过、源码/构建/安装摘要，核对辅助环境失败的反例与完整门禁原件，确认未改断言、未减检查；C/I/M 均无未关闭发现。本地关键证据索引为 `chrome-native-evidence-index01.json`，不将包含继承环境的原始报告作为公开附件。

本轮 `127.0.0.1:49860` 的临时剪贴板权限已恢复默认“可以询问 / off”，见 native03 `permission-final-reset-full.ax.txt` 与截图。原生宿主与探针均已正常退出 0，宿主 `native-host-04/exit.json` 为 14:02:27.340Z，独立测试库随服务生命周期清理。Chrome 窗口大小先前已恢复；Finder 与测试标签的最后清理曾因锁屏中断，用户解锁后于 2026-10-19 22:33（北京时间）补完：仅关闭三个任务标签，用户其他两个标签保留；Finder 通过“恢复上一个大小”回到原窗口大小，再返回 `spikes/m5-assets/fixtures` 和列表视图。回执为 native03 `cleanup-completed.json`、`cleanup-finder-final.ax.txt` 与截图。现场清理已完成，不改变原生验收的剩余条件。

UI 工具重试保存时，地址栏仍获焦，⌘S 打开了浏览器“另存为”；已取消且未写文件，随后用页面“保存”按钮和实际 API 再核对。`host-context-retry-record.json`/截图为中间记录，最终使用 `host-context-retry-record02.json`、`host-context-retry02.png`；不把误开的系统对话框算作产品保存证据。控制台保留了 native02 的旧拒绝错误，时间为 13:02:31Z，不能归到 native03。

## 剩余条件

真实 Excel 桌面 App 仍不可用；Safari 原生输入/复制及 Finder 默认/宿主剩余矩阵继续挂账。Chrome 右键成功/拒绝/重试的输入分支已有闭环，仍须与其他原生条件一起验收。不能据此进入 S5、开放生产入口或合并 P2；S6 的完整 verify、容器与同 SHA CI 不在本次结论内。
